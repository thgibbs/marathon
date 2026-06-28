/**
 * M6 automated demo (roadmap.md M6 exit criteria) — GitHub document surface +
 * the document-driven workflow, deterministic (fixtures, no network/keys):
 *
 *   - a PR/issue comment mentioning @marathon -> route -> agent drafts a design
 *     doc -> document.create opens a PR -> a reply comment links it (task waits)
 *   - a merged pull_request webhook -> find the produced doc -> resume/execute ->
 *     progress + result comments
 *   - document.update with a stale SHA is rejected
 *
 * Requires Postgres at DATABASE_URL.
 */
import { FakeAgentRuntime } from "@marathon/agent";
import { EnvSecretStore } from "@marathon/config";
import { FixturesGithubClient, GithubDelivery, makeDocumentTools } from "@marathon/connector-github";
import { emptyCheckpoint } from "@marathon/core";
import { Database, migrate } from "@marathon/db";
import { Queue } from "@marathon/queue";
import { classifyGithubEvent } from "@marathon/surface-github";
import { ToolBlockedError, ToolGateway, ToolRegistry, type ToolPolicy } from "@marathon/tools";
import { InvocationRouter, Orchestrator } from "@marathon/worker";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const REPO = "thgibbs/agentp-demo";
const DOC_PATH = "docs/rate-limiting.md";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://marathon:marathon@localhost:5432/marathon";
  const applied = await migrate(url);
  console.log(`[m6] migrations: ${applied.length ? applied.join(", ") : "up to date"}`);

  const db = new Database(url);
  const queue = new Queue(url);
  try {
    const tenant = await db.createTenant({ name: `demo-m6-${Date.now()}` });
    const quill = await db.createAgent({ tenantId: tenant.id, name: "quill" });

    const gh = new FixturesGithubClient({});
    const gateway = new ToolGateway({
      registry: new ToolRegistry(makeDocumentTools(() => gh)),
      policy: { grants: [{ tool: "document.create" }, { tool: "document.update" }, { tool: "document.comment" }, { tool: "document.read_region" }] } as ToolPolicy,
      secrets: new EnvSecretStore({}),
      recorder: {
        onInvocation: (r) => db.recordToolInvocation({ taskId: r.taskId, toolId: r.toolName, status: r.status, riskLevel: r.riskLevel, inputSummary: r.inputSummary, outputSummary: r.outputSummary, error: r.error }),
        onAudit: (e) => void db.write({ tenantId: e.tenantId, eventType: e.eventType, summary: e.summary, targetType: e.targetType, targetId: e.targetId }),
      },
    });
    const delivery = new GithubDelivery(gh);
    const router = new InvocationRouter(db, new Orchestrator(db, queue));
    const fakeAgent = new FakeAgentRuntime({ turns: [{ text: "# Rate limiting design\n\n## Plan\n1. token bucket per API key\n2. 429 on exceed" }] });

    // --- 1. inbound: @marathon mention on an issue ---
    const mentionAction = classifyGithubEvent(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: REPO, owner: { login: "thgibbs" } },
        issue: { number: 12 },
        comment: { id: 9001, body: "@marathon quill draft a plan to add rate limiting", user: { login: "thgibbs" } },
      },
      { knownAgents: ["quill"] },
    );
    assert(mentionAction.kind === "mention", "should classify as mention");
    const invocation = mentionAction.kind === "mention" ? mentionAction.invocation : undefined!;

    const { task } = await router.route(invocation, {
      tenantId: tenant.id,
      agents: [{ name: "quill" }],
      agentIdByName: { quill: quill.id },
      defaultAgent: "quill",
    });
    const ctx = { taskId: task.id, tenantId: tenant.id, agentId: quill.id };

    // --- 2. agent drafts the doc body, then document.create opens a PR ---
    const draft = await fakeAgent.nextTurn({
      request: { taskId: task.id, instructions: "draft a design doc", input: invocation.text, modelRef: "openai:gpt-4o-mini" },
      checkpoint: emptyCheckpoint(),
    });
    const created = await gateway.run("document.create", { repo: REPO, path: DOC_PATH, content: draft.text, base: "main", title: "Design: rate limiting" }, ctx);
    const prNumber = Number((created.details as { number: number }).number);
    assert(prNumber > 0, "document.create should return a PR number");

    await db.recordDocumentArtifact({
      tenantId: tenant.id,
      location: { repo: REPO, prNumber, path: DOC_PATH },
      title: "Design: rate limiting",
      role: "produced",
      owningTaskId: task.id,
      owningAgentId: quill.id,
    });

    // reply on the originating issue, then wait for review/merge
    await delivery.deliverResult(invocation.sourceRef, { summary: `Drafted design doc: PR #${prNumber} — review & merge to execute.` });
    // task is 'queued' after routing; move running -> waiting_for_approval (waiting for the merge)
    await db.transitionTask(task.id, "running");
    await db.transitionTask(task.id, "waiting_for_approval");

    assert(gh.writes.some((w) => w.op === "createPullRequest"), "a PR should be opened");
    assert((await db.countDocumentArtifacts(tenant.id)) === 1, "a document artifact should be recorded");
    assert((await db.getTask(task.id))!.status === "waiting_for_approval", "task should wait for merge");
    console.log(`[m6] mention -> drafted design doc PR #${prNumber}; task waiting for merge`);

    // --- 3. merge webhook -> execute the approved plan ---
    const mergeAction = classifyGithubEvent("pull_request", {
      action: "closed",
      repository: { full_name: REPO },
      pull_request: { number: prNumber, merged: true, merge_commit_sha: "abc123" },
    });
    assert(mergeAction.kind === "merge", "should classify as merge");

    const artifact = await db.findDocumentArtifactByPr(tenant.id, REPO, prNumber);
    assert(artifact?.owningTaskId === task.id, "merge should resolve to the producing task");
    await db.transitionTask(task.id, "running");
    const prRef = { repo: REPO, number: prNumber };
    await delivery.postProgress(prRef, "Merged — executing the approved plan…");
    const exec = await fakeAgent.nextTurn({
      request: { taskId: task.id, instructions: "execute", input: "execute the plan", modelRef: "openai:gpt-4o-mini" },
      checkpoint: emptyCheckpoint(),
    });
    await delivery.deliverResult(prRef, { summary: `Done: ${exec.text.split("\n")[0]}` });
    await db.transitionTask(task.id, "completed");

    assert((await db.getTask(task.id))!.status === "completed", "task should complete after execute");
    const comments = gh.writes.filter((w) => w.op === "commentIssue").length;
    assert(comments >= 3, `expected >=3 comments (draft reply, progress, result), got ${comments}`);
    console.log("[m6] merge -> executed; progress + result posted to the PR");

    // --- 4. stale-SHA rejection on document.update ---
    let staleRejected = false;
    try {
      await gateway.run("document.update", { repo: REPO, path: DOC_PATH, content: "# v2", sha: "stale-sha" }, ctx);
    } catch (e) {
      staleRejected = e instanceof Error && /stale|409/.test(e.message) && !(e instanceof ToolBlockedError);
    }
    assert(staleRejected, "document.update with a stale sha should be rejected");
    console.log("[m6] document.update with stale sha -> rejected");

    console.log(`[m6] tenant=${tenant.id} pr=#${prNumber} artifacts=${await db.countDocumentArtifacts(tenant.id)} comments=${comments}`);
    console.log("demo-m6 OK");
  } finally {
    await db.close();
    await queue.close();
  }
}

main().catch((err) => {
  console.error("demo-m6 FAILED:", err);
  process.exit(1);
});
