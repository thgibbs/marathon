/**
 * K1 demo, corrected path (code-migration.md Tracks 6-9; §29.1a combined-PR
 * flow): agent-driven delivery through the credentialed `gh`/`git` broker
 * instead of the semantic `github.submit_code_changes` tool.
 *
 *   approved draft design PR -> workspace edits + local git (the sandbox's
 *   job) -> brokered `git push` onto the SAME doc branch (REAL git,
 *   credential-free workspace) -> `delivery.report_pr` on the SAME PR
 *   (enforced; green verification marks it ready) -> fan-out ->
 *   model-initiated merge = Proposed Effect -> human approves the EXACT
 *   payload -> non-model executor merges.
 *
 * Asserts:
 *  - the workspace has no remotes or credential helpers; the push credential
 *    exists only in the brokered child env — never in argv, trace, or results;
 *  - non-allowlisted gh families (pr merge, pr create, api POST) and foreign
 *    repos are refused before any command runs;
 *  - delivery.report_pr REFUSES any PR but the task's own doc PR (§29.1a),
 *    marks the draft PR ready when verification is green, records the
 *    CodeChange, and fans out idempotently to Slack + the doc PR;
 *  - a direct merge tool call returns a typed requires_proposal; approval
 *    binds to the payload hash (a tampered hash is void); the executor runs
 *    exactly once.
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodeTaskRegistry, CodeWorkspace, InMemoryCodeChangeStore } from "@marathon/code-handoff";
import { grantFamilies, loadAgentSpec } from "@marathon/config";
import {
  FixturesGithubClient,
  GITHUB_MERGE_EFFECT,
  ghFamiliesForNames,
  makeDeliveryReportTool,
  makeGithubExecTool,
  makeGithubMergeExecutor,
  makeGitExecTool,
  makeGithubWriteTools,
} from "@marathon/connector-github";
import { InMemoryIdempotencyStore, type DeliveryTarget } from "@marathon/core";
import { DeliveryFanout, type StructuredResult, type SurfaceAdapter } from "@marathon/surface";
import {
  EffectExecutorRegistry,
  ExecFileCommandRunner,
  FakeCommandRunner,
  ToolBlockedError,
  ToolGateway,
  toolPolicyFromSpec,
  ToolRegistry,
  type AuditRecord,
  type ToolInvocationRecord,
} from "@marathon/tools";
import { InMemoryProposedEffectStore, ProposedEffectService } from "@marathon/worker";

const execFileAsync = promisify(execFile);

function assert(cond: unknown, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
  return stdout;
}

const REPO = "acme/service";
const TASK = "k1b-task";
const TOKEN = "ghp_" + "s".repeat(36); // host-side only; must never reach trace/results
const secrets = { get: async () => TOKEN };

// Track 14: the tool surface comes from the flagship agent's YAML — grants and
// brokered gh command families — with the demo's fixture repo as the ONE
// configured repo. A family absent from the YAML (e.g. `pr merge`) is refused
// below, which proves the config actually narrows the broker.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const forge = { ...(await loadAgentSpec(join(repoRoot, "agents", "forge.yaml"))), repo: REPO };
const ghFamilies = ghFamiliesForNames(grantFamilies(forge, "github.exec") ?? []);

// --- 1. Fixture origin (the plan's merge commit) + a bare repo standing in for GitHub. ---
const origin = await mkdtemp(join(tmpdir(), "marathon-k1b-origin-"));
await execFileAsync("git", ["init", "--quiet", origin]);
await git(origin, "config", "user.name", "Fixture");
await git(origin, "config", "user.email", "fixture@test");
await writeFile(join(origin, "greet.mjs"), `export const greet = () => "hi";\n`);
await writeFile(
  join(origin, "test.mjs"),
  `import { greet } from "./greet.mjs";\nif (greet("Ada") !== "hi Ada") { console.error("greet must include the name"); process.exit(1); }\nconsole.log("ok");\n`,
);
await execFileAsync("mkdir", ["-p", join(origin, "docs")]);
await writeFile(join(origin, "docs", "plan.md"), "# Plan: greet by name\n");
await git(origin, "add", "-A");
await git(origin, "commit", "--quiet", "-m", "plan: greet by name (merged)");
const approvedSha = (await git(origin, "rev-parse", "HEAD")).trim();
const planRef = { repo: REPO, docPath: "docs/plan.md", approvedSha };

const bare = await mkdtemp(join(tmpdir(), "marathon-k1b-github-"));
await execFileAsync("git", ["init", "--bare", "--quiet", bare]);

// --- 2. Workspace pinned to the approved doc-branch tip; credential-free (§29.2). ---
const ws = await CodeWorkspace.materialize({ source: origin, baseSha: approvedSha });
assert((await ws.remotes()).length === 0, "workspace has no remotes (credential-free)");
assert((await ws.credentialHelpers()).filter(Boolean).length === 0, "credential helpers stripped");

// The draft design PR the approving review pinned (§29.1a): it already exists
// on the fixtures "GitHub" — the BUILD task is bound to it, and delivery
// happens ON it (no `pr create` anywhere in the BUILD grant).
const branch = `marathon/doc-${TASK}-plan`;
const fixtures = new FixturesGithubClient({});
const designPr = await fixtures.createPullRequest(REPO, "Plan: greet by name", branch, "main", "…", { draft: true });

const registry = new CodeTaskRegistry();
registry.set(TASK, {
  workspace: ws,
  planRef,
  repo: REPO,
  baseSha: approvedSha,
  expectedPrNumber: designPr.number,
  expectedBranch: branch,
});

// --- 3. Gateway with the brokered tool surface (Tracks 6-7). ---
const store = new InMemoryCodeChangeStore();

class RecordingAdapter implements SurfaceAdapter {
  public readonly results: StructuredResult[] = [];
  async acknowledge(): Promise<void> {}
  async postProgress(): Promise<void> {}
  async deliverResult(_ref: Record<string, unknown>, result: StructuredResult): Promise<void> {
    this.results.push(result);
  }
}
const slack = new RecordingAdapter();
const docPr = new RecordingAdapter();
const fanout = new DeliveryFanout({ slack, github: docPr }, new InMemoryIdempotencyStore());
const targets: DeliveryTarget[] = [
  { surfaceType: "slack", ref: { channel: "C1", thread_ts: "171.001" } },
  { surfaceType: "github", ref: { repo: REPO, number: 41, kind: "pr" } },
];

// The fake `gh` binary: reads return canned JSON. There is deliberately no
// `pr create` handler — the family is not in the kernel grant (§29.1a).
const ghRunner = new FakeCommandRunner(async (_bin, argv) => {
  if (argv[0] === "pr" && argv[1] === "view") {
    return { exitCode: 0, stdout: '{"title":"Greet by name","state":"OPEN"}', stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: `unexpected gh call: ${argv.join(" ")}` };
});

const invocations: ToolInvocationRecord[] = [];
const audits: AuditRecord[] = [];
const gateway = new ToolGateway({
  registry: new ToolRegistry([
    makeGithubExecTool({ allowedRepos: [REPO], families: ghFamilies, runner: ghRunner }),
    makeGitExecTool({
      allowedRepos: [REPO],
      resolveWorkspaceDir: (taskId) => registry.get(taskId)?.workspace.dir,
      runner: new ExecFileCommandRunner(),
      remoteUrl: () => bare, // the demo's "GitHub remote" is the local bare repo
    }),
    makeDeliveryReportTool({
      getClient: () => fixtures,
      registry,
      store,
      fanout,
      getDeliveryTargets: async () => targets,
    }),
    ...makeGithubWriteTools(() => fixtures), // includes github.merge_pull_request (proposed_effect)
  ]),
  // Grants (with the one-repo constraint) come from the YAML config; the
  // merge tool is granted on top so the demo can prove a direct call routes
  // to a Proposed Effect — Forge itself deliberately does not grant it.
  policy: {
    grants: [
      ...toolPolicyFromSpec(forge).grants,
      { tool: "github.merge_pull_request", constraints: { allowedRepos: [REPO] } },
    ],
  },
  secrets: secrets as never,
  recorder: {
    onInvocation: (r) => void invocations.push(r),
    onAudit: (e) => void audits.push(e),
  },
});
const ctx = { taskId: TASK, tenantId: "tenant-1" };

// --- 4. Broker policy: denied families never reach a child process (Track 6). ---
const merge = await gateway.run("github.exec", { argv: ["pr", "merge", "1", "--repo", REPO] }, ctx).catch((e: Error) => e);
assert(merge instanceof Error && /not in an allowlisted gh family/.test(String(merge)), "gh pr merge is not a brokered family");
// §29.1a: `pr create` is deliberately absent from the kernel BUILD grant — the
// build lands on the EXISTING design PR.
const create = await gateway
  .run("github.exec", { argv: ["pr", "create", "--repo", REPO, "--title", "rogue"] }, ctx)
  .catch((e: Error) => e);
assert(create instanceof Error && /not in an allowlisted gh family/.test(String(create)), "gh pr create is not granted to the BUILD agent");
const post = await gateway
  .run("github.exec", { argv: ["api", `repos/${REPO}/pulls`, "--method", "POST"] }, ctx)
  .catch((e: Error) => e);
assert(post instanceof Error && /read-only/.test(String(post)), "gh api mutations are refused");
const foreign = await gateway.run("github.exec", { argv: ["pr", "view", "1", "--repo", "evil/repo"] }, ctx).catch((e: Error) => e);
assert(foreign instanceof Error && /repo not allowed/.test(String(foreign)), "foreign repos are refused");
assert(ghRunner.calls.length === 0, "no denied command reached the runner");

// A brokered read works and the token stays in the child env only.
const view = await gateway.run("github.exec", { argv: ["pr", "view", "41", "--repo", REPO, "--json", "title,state"] }, ctx);
assert(view.content.includes("Greet by name"), "brokered gh pr view returns data");
assert(ghRunner.calls[0]?.opts.env?.GH_TOKEN === TOKEN, "credential injected into the brokered child env");

// --- 5. The agent implements the plan and drives normal git (the LLM's job now). ---
await ws.writeFile("greet.mjs", `export const greet = (name) => \`hi \${name}\`;\n`);
const verify = await execFileAsync("node", ["test.mjs"], { cwd: ws.dir }).then(
  (o) => ({ exitCode: 0, out: o.stdout }),
  (e: { code?: number }) => ({ exitCode: e.code ?? 1, out: "" }),
);
assert(verify.exitCode === 0, "verification is green after the fix");
await git(ws.dir, "add", "-A");
await git(ws.dir, "commit", "--quiet", "-m", "feat: greet by name\n\nMarathon-Task: " + TASK);

// --- 6. Brokered push onto the SAME doc branch: REAL git, no remotes/credentials
// in the workspace (Track 6, §29.1a). ---
const push = await gateway.run("git.exec", { argv: ["push", REPO, `HEAD:refs/heads/${branch}`] }, ctx);
assert((push.details as { ok?: boolean }).ok === true, "brokered git push succeeded");
const pushedSha = (await git(bare, "rev-parse", `refs/heads/${branch}`)).trim();
const localSha = (await git(ws.dir, "rev-parse", "HEAD")).trim();
assert(pushedSha === localSha, "the pushed branch matches the workspace HEAD");
assert((await ws.remotes()).length === 0, "push added no remote to the workspace");

// --- 7. delivery.report_pr on the SAME design PR (Track 7, §29.1a). ---
// The same-PR invariant is gateway-enforced: a rogue same-repo PR is refused.
const rogue = await fixtures.createPullRequest(REPO, "Rogue", "marathon/rogue-branch", "main");
const mismatch = await gateway
  .run("delivery.report_pr", { pr_url: rogue.url, summary: "rogue" }, ctx)
  .catch((e: Error) => e);
assert(
  mismatch instanceof Error && /PR_MISMATCH/.test(String(mismatch)),
  "delivery.report_pr refuses any PR but the task's own design PR",
);

const prUrl = designPr.url;
const report = await gateway.run(
  "delivery.report_pr",
  {
    pr_url: prUrl,
    summary: "greet() now includes the caller's name, per the approved plan.",
    verification: [{ command: "node test.mjs", exit_code: 0, summary: "ok" }],
  },
  ctx,
);
const reportDetails = report.details as Record<string, unknown>;
assert(reportDetails.state === "submitted_ready", "green verification → submitted_ready");
assert(reportDetails.branch === branch, "the recorded branch comes from GitHub, not the model");
assert(reportDetails.delivered === 2, "PR link fanned out to Slack + doc PR");
// The draft/ready transition is owned by report_pr: the draft design PR is now ready.
assert((await fixtures.getPullRequest(REPO, designPr.number))?.draft === false, "green report marked the draft design PR ready for review");
const change = await store.getCodeChangeByTask(TASK);
assert(change?.prUrl === prUrl && change.state === "submitted_ready", "CodeChange records the reported PR");

// Idempotency: a retried report cannot double-post.
const again = await gateway.run(
  "delivery.report_pr",
  { pr_url: prUrl, summary: "retry", verification: [{ command: "node test.mjs", exit_code: 0, summary: "ok" }] },
  ctx,
);
assert((again.details as { delivered?: number }).delivered === 0, "retried report is deduped per target");
assert(slack.results.length === 1 && docPr.results.length === 1, "each surface heard exactly once");

// A PR outside the task's repo is refused.
const wrongRepo = await gateway
  .run("delivery.report_pr", { pr_url: "https://github.com/evil/repo/pull/1", summary: "s" }, ctx)
  .catch((e: Error) => e);
assert(wrongRepo instanceof Error && /PLAN_REF_MISMATCH/.test(String(wrongRepo)), "reporting a foreign-repo PR is refused");

// --- 8. Model-initiated merge = Proposed Effect (Track 9). ---
const direct = await gateway
  .run("github.merge_pull_request", { repo: REPO, number: Number(reportDetails.pr_number) }, ctx)
  .catch((e: unknown) => e);
assert(
  direct instanceof ToolBlockedError && direct.code === "requires_proposal",
  "a direct merge tool call returns a typed requires_proposal",
);

const executors = new EffectExecutorRegistry();
executors.register(GITHUB_MERGE_EFFECT, makeGithubMergeExecutor(() => fixtures, { allowedRepos: [REPO] }));
const effectStore = new InMemoryProposedEffectStore();
const effects = new ProposedEffectService({ store: effectStore, executors, secrets: secrets as never });

const { effect } = await effects.propose({
  tenantId: "tenant-1",
  taskId: TASK,
  effectType: GITHUB_MERGE_EFFECT,
  target: { repo: REPO, number: Number(reportDetails.pr_number) },
  payload: { repo: REPO, number: Number(reportDetails.pr_number), method: "merge" },
});

const tampered = await effects.approve(effect.id, { payloadHash: "reviewed-something-else" }).catch((e: Error) => e);
assert(tampered instanceof Error && /approval is void/.test(String(tampered)), "approval binds to the exact payload hash");

await effects.approve(effect.id, { payloadHash: effect.payloadHash, byUserId: "user-1" });
const executed = await effects.execute(effect.id);
assert(executed.executed === true, "the non-model executor performed the approved merge");
assert(
  fixtures.writes.some((w) => w.op === "mergePullRequest"),
  "the merge hit GitHub via host credentials the model never held",
);
const rerun = await effects.execute(effect.id);
assert(rerun.executed === false, "a repeated execute is a no-op (at most once)");

// --- 9. The whole trace has no secrets. ---
const trace = JSON.stringify({ invocations, audits, effects: [...effectStore.audits] });
assert(!trace.includes(TOKEN), "trace contains no secrets");

// --- 10. Teardown. ---
await ws.dispose();
await execFileAsync("rm", ["-rf", origin, bare]);

console.log(`\nK1 brokered demo complete: ${change?.prUrl} (${change?.state}), branch ${change?.branch}`);
