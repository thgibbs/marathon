/**
 * K1 demo (roadmap §2c): a fake merged plan against a local fixture repo →
 * workspace edits → verify runs → `github.submit_code_changes` handoff →
 * branch + PR on a fake git host (design §29).
 *
 * Asserts:
 *  - the workspace is credential-free (remotes + credential helpers stripped);
 *  - the recorded trace has no secrets;
 *  - a diff touching .github/workflows/ is REFUSED;
 *  - a re-submit with the same tree is a NO-OP;
 *  - a red-verify run yields a DRAFT PR labeled marathon:unverified.
 *
 * The agent's edits are scripted here (the real BUILD stage drives them through
 * Pi's sandboxed bash/read/write/edit — K1 runtime wiring); the handoff path
 * itself — workspace diff capture, gateway checks, commit, branch, PR — is the
 * real machinery.
 */
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CodeTaskRegistry,
  CodeWorkspace,
  discoverVerifyCommands,
  InMemoryCodeChangeStore,
} from "@marathon/code-handoff";
import { FixturesGithubClient, makeGithubCodeTools } from "@marathon/connector-github";
import type { VerificationResult } from "@marathon/core";
import {
  ToolGateway,
  ToolRegistry,
  type AuditRecord,
  type ToolInvocationRecord,
} from "@marathon/tools";

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

// --- 1. A local fixture repo whose HEAD is the "merged plan" commit. ---
const REPO = "acme/service";
const origin = await mkdtemp(join(tmpdir(), "marathon-k1-origin-"));
await execFileAsync("git", ["init", "--quiet", origin]);
await git(origin, "config", "user.name", "Fixture");
await git(origin, "config", "user.email", "fixture@test");
await writeFile(join(origin, "greet.mjs"), `export const greet = () => "hi";\n`);
await writeFile(
  join(origin, "test.mjs"),
  `import { greet } from "./greet.mjs";\nif (greet("Ada") !== "hi Ada") { console.error("greet must include the name"); process.exit(1); }\nconsole.log("ok");\n`,
);
await execFileAsync("mkdir", ["-p", join(origin, ".marathon"), join(origin, "docs")]);
await writeFile(join(origin, ".marathon", "config.yml"), "verify:\n  - node test.mjs\n");
await writeFile(
  join(origin, "docs", "plan.md"),
  "# Plan: greet by name\n\nMake greet() include the caller's name.\n\n## Verification\n\n```sh\nnode test.mjs\n```\n",
);
await git(origin, "add", "-A");
await git(origin, "commit", "--quiet", "-m", "plan: greet by name (merged)");
const mergeCommitSha = (await git(origin, "rev-parse", "HEAD")).trim();
const planRef = { repo: REPO, docPath: "docs/plan.md", mergeCommitSha };

// --- 2. Implementation task: workspace pinned to the plan's merge commit (§29.1-2). ---
const TASK = "k1-task";
const ws = await CodeWorkspace.materialize({ source: origin, baseSha: mergeCommitSha });
assert((await ws.remotes()).length === 0, "workspace has no remotes (credential-free)");
assert((await ws.credentialHelpers()).filter(Boolean).length === 0, "credential helpers stripped");

const client = new FixturesGithubClient({});
const store = new InMemoryCodeChangeStore();
const registry = new CodeTaskRegistry();
registry.set(TASK, { workspace: ws, planRef, repo: REPO, baseSha: mergeCommitSha });

const invocations: ToolInvocationRecord[] = [];
const audits: AuditRecord[] = [];
const gateway = new ToolGateway({
  registry: new ToolRegistry(makeGithubCodeTools({ getClient: () => client, registry, store })),
  policy: { grants: [{ tool: "github.submit_code_changes" }] },
  secrets: { get: async () => "ghp_" + "s".repeat(36) } as never, // host-side only; must never reach trace
  recorder: {
    onInvocation: (r) => void invocations.push(r),
    onAudit: (e) => void audits.push(e),
  },
});

const submit = (input: Record<string, unknown>) =>
  gateway.run(
    "github.submit_code_changes",
    {
      title: "Greet by name",
      summary: "greet() now includes the caller's name, per the merged plan.",
      plan_ref: { repo: REPO, doc_path: planRef.docPath, merge_commit_sha: mergeCommitSha },
      ...input,
    },
    { taskId: TASK, tenantId: "tenant-1" },
  );

// --- 3. Verify discovery (§29.3): repo config wins. ---
const discovery = await discoverVerifyCommands({
  readFile: (p) => ws.readFile(p).catch(() => null),
  planDocPath: planRef.docPath,
});
assert(discovery.source === "repo_config" && discovery.commands[0] === "node test.mjs", "verify commands come from .marathon/config.yml");

const runVerify = async (): Promise<VerificationResult[]> => {
  const results: VerificationResult[] = [];
  for (const command of discovery.commands) {
    // BUILD-stage runs this via sandboxed bash; the demo runs it directly.
    const [bin = "", ...args] = command.split(" ");
    const r = await execFileAsync(bin, args, { cwd: ws.dir }).then(
      (o) => ({ exitCode: 0, out: o.stdout }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({ exitCode: e.code ?? 1, out: e.stderr ?? "" }),
    );
    results.push({ command, exitCode: r.exitCode, summary: r.out.trim().slice(0, 200) });
  }
  return results;
};

// --- 4. Red run first: a wrong "fix" fails verify → draft PR + marathon:unverified (§29.3). ---
await ws.writeFile("greet.mjs", `export const greet = () => "hi there";\n`);
const redVerification = await runVerify();
assert(redVerification[0]?.exitCode !== 0, "verification is red for the wrong fix");
const red = await submit({ verification: redVerification.map((v) => ({ command: v.command, exit_code: v.exitCode, summary: v.summary })) });
const redDetails = red.details as Record<string, unknown>;
assert(redDetails.state === "submitted_draft", "red verify → draft PR");
assert(
  (client.labels.get(`${REPO}:${redDetails.pr_number}`) ?? []).includes("marathon:unverified"),
  "draft PR labeled marathon:unverified",
);

// --- 5. Fix properly: green verify → same branch/PR, now ready state recorded. ---
await ws.writeFile("greet.mjs", `export const greet = (name) => \`hi \${name}\`;\n`);
const greenVerification = await runVerify();
assert(greenVerification.every((v) => v.exitCode === 0), "verification is green after the fix");
const green = await submit({ verification: greenVerification.map((v) => ({ command: v.command, exit_code: v.exitCode, summary: v.summary })) });
const greenDetails = green.details as Record<string, unknown>;
assert(greenDetails.pr_number === redDetails.pr_number, "revision converges on the same PR");
assert(String(greenDetails.branch).startsWith("marathon/"), `branch is namespace-enforced: ${greenDetails.branch}`);
assert(greenDetails.state === "submitted_ready", "green verify → ready state");

// --- 6. Idempotency: re-submit with the same tree is a no-op (§29.4). ---
const writesBefore = client.writes.length;
const repeat = await submit({ verification: greenVerification.map((v) => ({ command: v.command, exit_code: v.exitCode, summary: v.summary })) });
assert((repeat.details as { noop?: boolean }).noop === true, "same tree re-submit is a no-op");
assert(client.writes.length === writesBefore, "no-op made no GitHub writes");

// --- 7. Protected path: .github/workflows/** is refused (§29.4). ---
await ws.writeFile(".github/workflows/ci.yml", "on: push\n");
const refusal = await submit({ verification: [] }).catch((e: Error) => e);
assert(refusal instanceof Error && /PROTECTED_PATH/.test(String(refusal)), "diff touching .github/workflows/ is refused");
await ws.deleteFile(".github/workflows/ci.yml");

// --- 8. The trace has no secrets. ---
const trace = JSON.stringify({ invocations, audits });
assert(!trace.includes("ghp_"), "trace contains no secrets");

// --- 9. Teardown destroys the workspace (§29.2). ---
await ws.dispose();
await execFileAsync("rm", ["-rf", origin]);

const change = await store.getCodeChangeByTask(TASK);
console.log(`\nK1 demo complete: ${change?.prUrl} (${change?.state}), branch ${change?.branch}`);
