import {
  branchForTask,
  buildPrBody,
  CodeHandoffError,
  DEFAULT_DIFF_CAPS,
  DEFAULT_PROTECTED_PATHS,
  isProtectedPath,
  isVerificationGreen,
  parseDiff,
  scanAddedLinesForSecrets,
  type CodeChangeStore,
  type CodeTaskRegistry,
  type DiffCaps,
} from "@marathon/code-handoff";
import type { PlanRef, VerificationResult } from "@marathon/core";
import type { Tool, ToolInput } from "@marathon/tools";
import type { GithubClientFactory } from "./tools";
import type { GithubClient, GitTreeEntry } from "./client";

export interface GithubCodeToolsOptions {
  getClient: GithubClientFactory;
  /** BUILD-stage task state: the host-side workspace + plan binding (§29.4 step 1-2). */
  registry: CodeTaskRegistry;
  store: CodeChangeStore;
  caps?: Partial<DiffCaps>;
  protectedPaths?: string[];
  /** PR base when the task context does not specify one. */
  defaultBranch?: string;
  unverifiedLabel?: string;
}

const UNVERIFIED_LABEL = "marathon:unverified";

/**
 * The single BUILD handoff tool (design §29.4): `github.submit_code_changes`.
 * The model passes metadata only — no diff, no file list, no patches; the
 * gateway reads the truth from the workspace. Opening/updating the PR is
 * autonomous because merge is the native approval (§29.9), so the tool is
 * non-destructive under the current policy model.
 */
export function makeGithubCodeTools(opts: GithubCodeToolsOptions): Tool[] {
  const caps: DiffCaps = { ...DEFAULT_DIFF_CAPS, ...opts.caps };
  const protectedPaths = opts.protectedPaths ?? DEFAULT_PROTECTED_PATHS;
  const unverifiedLabel = opts.unverifiedLabel ?? UNVERIFIED_LABEL;

  const submit: Tool = {
    name: "github.submit_code_changes",
    description:
      "End the BUILD stage: commit the workspace's changes to the task branch and open (or update) the code PR. " +
      "Pass title, summary, the plan_ref you are implementing, and the verification commands you ran — " +
      "the diff is read from the workspace, not from you.",
    riskLevel: "medium",
    destructive: false,
    validate(input) {
      if (typeof input.title !== "string" || !input.title.trim()) return "title is required";
      if (typeof input.summary !== "string" || !input.summary.trim()) return "summary is required";
      const planRef = input.plan_ref as Record<string, unknown> | undefined;
      if (!planRef || typeof planRef !== "object") return "plan_ref { repo, doc_path, merge_commit_sha } is required";
      if (typeof planRef.repo !== "string") return "plan_ref.repo is required";
      if (typeof planRef.doc_path !== "string") return "plan_ref.doc_path is required";
      if (typeof planRef.merge_commit_sha !== "string") return "plan_ref.merge_commit_sha is required";
      if (!Array.isArray(input.verification)) return "verification [{ command, exit_code, summary }] is required";
      for (const v of input.verification as Array<Record<string, unknown>>) {
        if (typeof v?.command !== "string" || typeof v?.exit_code !== "number")
          return "each verification entry needs { command, exit_code, summary }";
      }
      if (input.open_questions !== undefined && !Array.isArray(input.open_questions))
        return "open_questions must be an array of strings";
      return null;
    },
    async execute(input, ctx) {
      // 1. validate binding: task is in its BUILD stage and the echoed plan_ref matches.
      const taskCtx = opts.registry.get(ctx.taskId);
      if (!taskCtx) {
        throw new CodeHandoffError("NO_WORKSPACE", `no code workspace is bound to task ${ctx.taskId} — this tool is only available during a BUILD stage`);
      }
      const planRef = inputPlanRef(input);
      if (
        planRef.repo !== taskCtx.planRef.repo ||
        planRef.docPath !== taskCtx.planRef.docPath ||
        planRef.mergeCommitSha !== taskCtx.planRef.mergeCommitSha
      ) {
        throw new CodeHandoffError(
          "PLAN_REF_MISMATCH",
          `submitted plan_ref does not match this task's plan ` +
            `(expected ${taskCtx.planRef.docPath} @ ${taskCtx.planRef.mergeCommitSha})`,
        );
      }

      // 2. capture: the diff comes from the workspace, host-side.
      const ws = taskCtx.workspace;
      const diff = await ws.captureDiff();
      if (!diff.trim()) {
        throw new CodeHandoffError("EMPTY_DIFF", "the workspace has no changes relative to base_sha — nothing to submit");
      }

      // 3. check: caps, protected paths, secret scan.
      const stats = parseDiff(diff);
      if (stats.files.length > caps.maxFiles || stats.changedLineCount > caps.maxChangedLines || stats.bytes > caps.maxBytes) {
        throw new CodeHandoffError(
          "DIFF_TOO_LARGE",
          `diff exceeds caps (${stats.files.length} files / ${stats.changedLineCount} lines / ${stats.bytes} bytes; ` +
            `caps ${caps.maxFiles} / ${caps.maxChangedLines} / ${caps.maxBytes}) — narrow the scope or split the work`,
        );
      }
      const changedFiles = await ws.changedFiles();
      const protectedHit = changedFiles.find((f) => isProtectedPath(f, protectedPaths));
      if (protectedHit) {
        throw new CodeHandoffError("PROTECTED_PATH", `changes under a protected path are refused: ${protectedHit}`);
      }
      const [secretHit] = scanAddedLinesForSecrets(stats.addedLines);
      if (secretHit) {
        throw new CodeHandoffError(
          "SECRET_IN_DIFF",
          `potential secret (${secretHit.pattern}) at ${secretHit.file}:${secretHit.line} — remove it and resubmit`,
        );
      }

      // Draft is FORCED when verification isn't green (§29.3).
      const verification = inputVerification(input);
      const green = isVerificationGreen(verification);
      const draft = input.draft === true || !green;

      // Idempotency on (task_id, tree_hash): same tree twice is a no-op (§29.4 step 6).
      const treeHash = await ws.treeHash();
      const title = String(input.title);
      const existing = await opts.store.getCodeChangeByTask(ctx.taskId);
      if (existing?.treeHash === treeHash && existing.prNumber && existing.prUrl) {
        return {
          content: `no changes since the last submit — PR #${existing.prNumber} ${existing.prUrl} (${existing.state})`,
          details: { pr_url: existing.prUrl, pr_number: existing.prNumber, branch: existing.branch, state: existing.state, tree_hash: treeHash, noop: true },
        };
      }

      const repo = taskCtx.repo;
      const branch = existing?.branch ?? branchForTask(ctx.taskId, title);
      const change =
        existing ??
        (await opts.store.createCodeChange({
          tenantId: ctx.tenantId,
          taskId: ctx.taskId,
          repo,
          planRef: taskCtx.planRef,
          baseSha: taskCtx.baseSha,
          branch,
        }));

      // 4-5. commit host-side (bot-authored, Marathon-Task trailer) and push the
      // task branch with the tenant App credentials — never in the sandbox.
      const client = await opts.getClient(ctx);
      const message = `${title}\n\nPlan: ${planRef.docPath} @ ${planRef.mergeCommitSha}\n\nMarathon-Task: ${ctx.taskId}`;
      const commitSha = await commitWorkspace(client, repo, taskCtx.baseSha, changedFiles, ws, message);
      try {
        await client.createBranch(repo, branch, commitSha);
      } catch (e) {
        if (!/422|already exists/i.test(String(e))) throw e;
        await client.updateRef(repo, branch, commitSha, true);
      }

      // 6. PR: create-or-update against the default branch; draft per §29.3.
      const body = buildPrBody({
        summary: String(input.summary),
        planRef,
        verification,
        openQuestions: inputOpenQuestions(input),
        taskId: ctx.taskId,
      });
      const base = taskCtx.defaultBranch ?? opts.defaultBranch ?? "main";
      const existingPr = await client.findPullRequestByHead(repo, branch);
      let prNumber: number;
      let prUrl: string;
      if (existingPr) {
        await client.updatePullRequest(repo, existingPr.number, { title, body });
        // §29.3: the PR's review surface must track verification — a red draft
        // that turns green becomes a ready PR; a green PR that turns red re-drafts.
        if (existingPr.draft !== draft) await client.setPullRequestDraft(repo, existingPr.number, draft);
        prNumber = existingPr.number;
        prUrl = existingPr.url;
      } else {
        const pr = await client.createPullRequest(repo, title, branch, base, body, { draft });
        prNumber = pr.number;
        prUrl = pr.url;
      }
      if (green) await client.removeLabel(repo, prNumber, unverifiedLabel);
      else await client.addLabels(repo, prNumber, [unverifiedLabel]);

      // 7. record; the ToolGateway records the invocation + audit around this call.
      const state = draft ? "submitted_draft" : "submitted_ready";
      await opts.store.updateCodeChangeSubmission(ctx.taskId, { treeHash, prNumber, prUrl, state, verification });

      return {
        content: `${existingPr ? "updated" : "opened"} PR #${prNumber} ${prUrl} (${state})`,
        details: {
          pr_url: prUrl,
          pr_number: prNumber,
          branch,
          commit_sha: commitSha,
          state,
          tree_hash: treeHash,
          updated: Boolean(existingPr),
          verified: green,
        },
      };
    },
  };

  return [submit];
}

/** Build the squashed bot commit from the workspace's changed files (§29.4 step 4). */
async function commitWorkspace(
  client: GithubClient,
  repo: string,
  baseSha: string,
  changedFiles: string[],
  ws: { readFileBase64(rel: string): Promise<string | null>; fileMode(rel: string): Promise<"100644" | "100755"> },
  message: string,
): Promise<string> {
  const base = await client.getCommit(repo, baseSha);
  const entries: GitTreeEntry[] = [];
  for (const path of changedFiles) {
    const content = await ws.readFileBase64(path);
    if (content === null) {
      entries.push({ path, mode: "100644", sha: null }); // deletion
    } else {
      const blob = await client.createBlob(repo, content);
      entries.push({ path, mode: await ws.fileMode(path), sha: blob.sha });
    }
  }
  const tree = await client.createTree(repo, base.treeSha, entries);
  const commit = await client.createCommit(repo, message, tree.sha, [baseSha]);
  return commit.sha;
}

function inputPlanRef(input: ToolInput): PlanRef {
  const p = input.plan_ref as { repo: string; doc_path: string; merge_commit_sha: string };
  return { repo: p.repo, docPath: p.doc_path, mergeCommitSha: p.merge_commit_sha };
}

function inputVerification(input: ToolInput): VerificationResult[] {
  return (input.verification as Array<{ command: string; exit_code: number; summary?: string }>).map((v) => ({
    command: v.command,
    exitCode: v.exit_code,
    summary: v.summary ?? "",
  }));
}

function inputOpenQuestions(input: ToolInput): string[] | undefined {
  return Array.isArray(input.open_questions)
    ? (input.open_questions as unknown[]).filter((q): q is string => typeof q === "string")
    : undefined;
}
