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
 * commits, pushes, and opens the PR itself through the brokered `git`/`gh`
 * commands — GitHub's own controls (branch protection, rulesets, CODEOWNERS,
 * secret scanning, CI) police the content. `delivery.report_pr` is the narrow
 * final step Marathon keeps: bind the task to the PR it delivered, record it
 * on the `CodeChange`, and fan the link out to every delivery target. It never
 * reads or rewrites the diff.
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
      "Report the pull request you opened for this task. Call this exactly once, after `git push` and " +
      "`gh pr create` succeed: pass the PR URL, a short summary, and the verification commands you ran " +
      "(with honest exit codes). Marathon records the PR on the task and delivers the link to every " +
      "waiting surface (the Slack thread, the plan PR). It does not re-read your diff.",
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
        throw new Error(`delivery.report_pr: ${parsed.repo} has no PR #${parsed.number} — did the gh pr create succeed?`);
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

      // 3. record on the CodeChange (create-on-first-report: the agent-driven
      // path has no prior submit).
      const verification = inputVerification(input);
      const green = verification.length > 0 && isVerificationGreen(verification);
      const state = pr.draft || !green ? "submitted_draft" : "submitted_ready";
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
        content: `recorded PR #${pr.number} ${pr.url} (${state}); delivered to ${delivered} target(s)`,
        details: {
          pr_url: pr.url,
          pr_number: pr.number,
          repo: parsed.repo,
          branch: pr.headRef,
          state: change.state,
          verified: green,
          delivered,
        },
      };
    },
  };
}
