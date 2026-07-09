import {
  CodeHandoffError,
  isVerificationGreen,
  type CodeChangeStore,
  type CodeTaskRegistry,
} from "@marathon/code-handoff";
import type { DeliveryTarget, VerificationResult } from "@marathon/core";
import type { DeliveryFanout } from "@marathon/surface";
import type { EgressTarget, Tool, ToolInput } from "@marathon/tools";
import type { GithubClientFactory } from "./tools";

/**
 * The agent-driven delivery report (code-migration.md Track 7). The agent
 * commits and pushes through the brokered `git`/`gh` commands — GitHub's own
 * controls (branch protection, rulesets, CODEOWNERS, secret scanning, CI)
 * police the content. `delivery.report_pr` is the narrow final step Marathon
 * keeps, and it enforces two invariants the prompt alone cannot (§29.1a):
 *  - the SAME-PR invariant: a task bound to a PR (the doc PR an implementation
 *    updates in place; the code PR a revision revises) may report only that
 *    PR, on its own head branch;
 *  - the draft-tracks-verification invariant: this tool is the single
 *    authority for the PR's draft/ready state — green verification marks it
 *    ready, red/missing converts it (back) to draft.
 * It records the PR on the `CodeChange` and fans the link out to every
 * delivery target. It never reads or rewrites the diff.
 */
export interface DeliveryReportOptions {
  getClient: GithubClientFactory;
  /** BUILD-stage binding: the plan/base/repo this task is implementing (§29.1). */
  registry: CodeTaskRegistry;
  store: CodeChangeStore;
  /** Cross-surface fan-out (K2); when absent, recording still happens. */
  fanout?: DeliveryFanout;
  /** The task's delivery targets (wire to `db.getTask(...).deliveryTargets`). */
  getDeliveryTargets?(taskId: string): Promise<DeliveryTarget[]>;
  /**
   * The task's model spend so far (wire to `db.sumModelCostUsd`) — rendered as
   * the silent cost footer on the fanned-out result (Track 16, §13.3).
   */
  getCostUsd?(taskId: string): Promise<number | null>;
  /** Post-report hook (e.g. task bookkeeping/audit) after record + fan-out. */
  onReported?(info: { taskId: string; repo: string; prNumber: number; prUrl: string }): Promise<void> | void;
}

/** `https://<host>/<owner>/<repo>/pull/<n>` -> { repo, number }. */
export function parsePrUrl(prUrl: string): { repo: string; number: number } | null {
  const m = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(prUrl.trim());
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

function inputVerification(input: ToolInput): VerificationResult[] {
  if (!Array.isArray(input.verification)) return [];
  // Validated in validate(); tool inputs arrive as unknown records by design.
  return (input.verification as Array<{ command: string; exit_code: number; summary?: string }>).map((v) => ({
    command: v.command,
    exitCode: v.exit_code,
    summary: v.summary ?? "",
  }));
}

export function makeDeliveryReportTool(opts: DeliveryReportOptions): Tool {
  return {
    name: "delivery.report_pr",
    description:
      "Report the pull request this task delivers. Call this exactly once, after `git push` succeeds: " +
      "pass the PR URL, a short summary, and the verification commands you ran (with honest exit codes). " +
      "Marathon records the PR on the task, sets its draft/ready state from your verification (green = " +
      "ready for review, red or missing = draft), and delivers the link to every waiting surface " +
      "(the Slack thread, the PR). It does not re-read your diff.",
    riskAxes: { reversible: true, crossesTrustBoundary: false, audience: "tenant", costly: false },
    defaultMode: "autonomous",
    // The report lands on the task's surfaces inside the tenant (Slack thread,
    // plan PR) — internal egress, routed against the source ledger (§7.8).
    egress(input): EgressTarget | null {
      const parsed = typeof input.pr_url === "string" ? parsePrUrl(input.pr_url) : null;
      return parsed ? { destination: `github:${parsed.repo}`, audience: "tenant", external: false } : null;
    },
    validate(input) {
      if (typeof input.pr_url !== "string" || !input.pr_url.trim()) return "pr_url is required";
      if (!parsePrUrl(input.pr_url)) return "pr_url must look like https://github.com/<owner>/<repo>/pull/<number>";
      if (typeof input.summary !== "string" || !input.summary.trim()) return "summary is required";
      if (input.verification !== undefined) {
        if (!Array.isArray(input.verification)) return "verification must be an array of { command, exit_code, summary }";
        for (const v of input.verification as Array<Record<string, unknown>>) {
          if (typeof v?.command !== "string" || typeof v?.exit_code !== "number")
            return "each verification entry needs { command, exit_code, summary }";
        }
      }
      return null;
    },
    async execute(input, ctx) {
      const parsed = parsePrUrl(String(input.pr_url));
      if (!parsed) throw new Error("delivery.report_pr: invalid pr_url"); // unreachable after validate()

      // 1. binding: the task is in its BUILD stage and the PR is in *its* repo.
      const binding = opts.registry.get(ctx.taskId);
      if (!binding) {
        throw new CodeHandoffError(
          "NO_WORKSPACE",
          `no code workspace is bound to task ${ctx.taskId} — delivery.report_pr is only available during a BUILD stage`,
        );
      }
      if (parsed.repo !== binding.repo) {
        throw new CodeHandoffError(
          "PLAN_REF_MISMATCH",
          `the reported PR is in ${parsed.repo}, but this task's configured repo is ${binding.repo}`,
        );
      }

      // 2. the PR must actually exist — its head branch and draft state come
      // from GitHub, never from the model.
      const client = await opts.getClient(ctx);
      const pr = await client.getPullRequest(parsed.repo, parsed.number);
      if (!pr) {
        throw new Error(`delivery.report_pr: ${parsed.repo} has no PR #${parsed.number}`);
      }

      // 2a. the same-PR invariant, gateway-enforced (§29.1a): a BUILD task
      // bound to a PR (the doc PR for an implementation, the code PR for a
      // revision) may report ONLY that PR, on its own head branch. Without
      // this, an agent that opened a fresh same-repo PR would be recorded and
      // delivered as success while the approved draft doc PR sat
      // unimplemented — breaking the combined-PR atomic merge model. Typed +
      // actionable so the agent's retry self-corrects in-session.
      if (binding.expectedPrNumber !== undefined && pr.number !== binding.expectedPrNumber) {
        throw new CodeHandoffError(
          "PR_MISMATCH",
          `this task must deliver on PR #${binding.expectedPrNumber}` +
            (binding.expectedBranch ? ` (branch ${binding.expectedBranch})` : "") +
            ` — push your commits onto that branch and report that PR, not #${pr.number}`,
        );
      }
      if (binding.expectedBranch !== undefined && pr.headRef !== binding.expectedBranch) {
        throw new CodeHandoffError(
          "PR_MISMATCH",
          `PR #${pr.number}'s head branch is ${pr.headRef}, but this task is bound to ` +
            `${binding.expectedBranch} — deliver on the task's own branch`,
        );
      }

      // 2b. a task delivers ONE PR: retries with the same PR converge (fan-out
      // dedupes per target); reporting a *different* PR is refused so the
      // record can never silently diverge from what the surfaces heard.
      const prior = await opts.store.getCodeChangeByTask(ctx.taskId);
      if (prior?.prNumber != null && prior.prNumber !== pr.number) {
        throw new Error(
          `delivery.report_pr: task ${ctx.taskId} already reported PR #${prior.prNumber} (${prior.prUrl ?? ""}) — ` +
            `update that PR instead of opening a new one`,
        );
      }

      // 3. draft state tracks verification, ENFORCED on GitHub (§29.3): this
      // tool is the single authority for the draft/ready transition. Red or
      // missing verification converts the PR (back) to draft — a premature
      // `gh pr ready` cannot leave a red combined PR mergeable — and green
      // marks it ready, so Marathon's recorded state and GitHub's never
      // diverge.
      const verification = inputVerification(input);
      const green = verification.length > 0 && isVerificationGreen(verification);
      const draftEnforced = !green && !pr.draft;
      if (pr.draft === green) await client.setPullRequestDraft(parsed.repo, pr.number, !green);
      const state = green ? "submitted_ready" : "submitted_draft";
      await opts.store.createCodeChange({
        tenantId: ctx.tenantId,
        taskId: ctx.taskId,
        repo: binding.repo,
        planRef: binding.planRef,
        baseSha: binding.baseSha,
        branch: pr.headRef,
      });
      const change = await opts.store.recordCodeChangeReport(ctx.taskId, {
        prNumber: pr.number,
        prUrl: pr.url,
        branch: pr.headRef,
        state,
        verification,
      });

      // 4. deliver the link everywhere the task reports to (idempotent per
      // target — a retried call cannot double-post).
      const targets = (await opts.getDeliveryTargets?.(ctx.taskId)) ?? [];
      let delivered = 0;
      if (opts.fanout && targets.length > 0) {
        const outcomes = await opts.fanout.deliverResult(
          ctx.taskId,
          targets,
          {
            summary: String(input.summary),
            actionsTaken: [`Opened PR: ${pr.url}`],
            openQuestions: verification.length === 0 ? ["No verification results were reported."] : undefined,
            // Silent cost footer (Track 16, §13.3) — consistent with Slack delivery.
            costUsd: (await opts.getCostUsd?.(ctx.taskId)) ?? undefined,
          },
          "pr_reported",
        );
        delivered = outcomes.filter((o) => o.status === "delivered").length;
      }

      await opts.onReported?.({ taskId: ctx.taskId, repo: parsed.repo, prNumber: pr.number, prUrl: pr.url });

      return {
        content:
          `recorded PR #${pr.number} ${pr.url} (${state}); delivered to ${delivered} target(s)` +
          (draftEnforced ? "; PR converted back to draft — verification is not green" : ""),
        details: {
          pr_url: pr.url,
          pr_number: pr.number,
          repo: parsed.repo,
          branch: pr.headRef,
          state: change.state,
          verified: green,
          draft_enforced: draftEnforced,
          delivered,
        },
      };
    },
  };
}
