import { FakeAgentRuntime, type AgentRequest, type AgentRuntime, type AgentTurnContext } from "@marathon/agent";
import { emptyCheckpoint, type Task } from "@marathon/core";
import type { Database } from "@marathon/db";
import { describe, expect, it, vi } from "vitest";
import { makeAgentStepRunner, makeAgentTaskStepRunner } from "../src/agent-step";

const request: AgentRequest = {
  taskId: "t1",
  instructions: "be brief",
  input: "hello",
  modelRef: "anthropic:claude-haiku",
};

describe("makeAgentStepRunner (Pi-turn -> TaskStep mapping)", () => {
  it("maps each turn to a turn:N step and records a model invocation", async () => {
    const rt = new FakeAgentRuntime({ turns: [{ text: "a" }, { text: "b" }] });
    const run = makeAgentStepRunner(rt, request);

    const r0 = await run({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(r0.stepType).toBe("turn:0");
    expect(r0.checkpoint.completedSteps).toEqual(["turn:0"]);
    expect(r0.checkpoint.findings).toEqual(["a"]);
    expect(r0.done).toBe(false);
    expect(r0.modelInvocations).toHaveLength(1);
    expect(r0.modelInvocations?.[0]?.provider).toBe("anthropic");

    // resume from the prior checkpoint -> next turn
    const r1 = await run({ taskId: "t1", checkpoint: r0.checkpoint });
    expect(r1.stepType).toBe("turn:1");
    expect(r1.done).toBe(true);
  });

  it("persists the session pointer across a durable wait, so the resume re-opens the SAME session", async () => {
    // A runtime that reports a session ref and asks a question; the resumed
    // turn must receive that ref back through the checkpoint (Track 12 — the
    // continuity the live Slack app depends on; without it the resumed turn
    // is amnesiac and re-asks what the task was).
    const seenRefs: Array<string | undefined> = [];
    const rt: AgentRuntime = {
      async nextTurn(ctx: AgentTurnContext) {
        seenRefs.push(ctx.checkpoint.sessionRef);
        return ctx.checkpoint.sessionRef
          ? { text: "done, with context", done: true, sessionRef: ctx.checkpoint.sessionRef, turnIndex: 1 }
          : { text: "asking", done: false, waiting: { question: "which env?" }, sessionRef: "/sessions/t1/turn-0.jsonl", turnIndex: 0 };
      },
    };
    const run = makeAgentStepRunner(rt, request);

    const asked = await run({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(asked.waiting).toEqual({ kind: "input", question: "which env?" });
    expect(asked.checkpoint.sessionRef).toBe("/sessions/t1/turn-0.jsonl");
    expect(asked.checkpoint.turnIndex).toBe(0);

    // Resume with the staged answer: the runtime sees the checkpointed ref.
    const resumed = await run({
      taskId: "t1",
      checkpoint: { ...asked.checkpoint, pendingUserInput: "staging" },
    });
    expect(seenRefs).toEqual([undefined, "/sessions/t1/turn-0.jsonl"]);
    expect(resumed.done).toBe(true);
    expect(resumed.checkpoint.sessionRef).toBe("/sessions/t1/turn-0.jsonl");
  });

  it("redacts secrets from findings by default, and can be toggled off", async () => {
    const secretText = "token sk-abcdef0123456789ABCDEF";
    const rt = new FakeAgentRuntime({ turns: [{ text: secretText }] });

    const redacted = await makeAgentStepRunner(rt, request)({
      taskId: "t1",
      checkpoint: emptyCheckpoint(),
    });
    expect(redacted.checkpoint.findings[0]).toContain("[REDACTED]");

    const raw = await makeAgentStepRunner(rt, request, { redactTrace: false })({
      taskId: "t1",
      checkpoint: emptyCheckpoint(),
    });
    expect(raw.checkpoint.findings[0]).toContain("sk-abcdef");
  });
});

/** §2b #16 — the Slack doc-task shape: contract in, evidence-checked footer out. */
describe("makeAgentTaskStepRunner doc-task mode (§2b #16)", () => {
  function makeTask(sourceRef: Record<string, unknown>): Task {
    return {
      id: "t1",
      tenantId: "tn1",
      agentId: "a1",
      agentVersionId: null,
      invokingUserId: null,
      sourceTaskId: null,
      sourceType: "slack",
      sourceRef,
      deliveryTargets: null,
      status: "running",
      inputText: "draft a plan for rate limiting",
      summary: null,
      checkpoint: null,
      costUsd: 0,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      lastError: null,
    };
  }

  // Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
  function makeDb(opts: { docTask?: boolean; artifact?: { location: Record<string, unknown> } | null }) {
    const artifactLookups: string[] = [];
    const db = {
      getTask: async () =>
        makeTask({
          channel: "C1",
          thread_ts: "1.1",
          ...(opts.docTask ? { kind: "doc_draft" } : {}),
        }),
      getLatestAgentVersion: async () => null,
      findDocumentArtifactByTask: async (_tenant: string, taskId: string) => {
        artifactLookups.push(taskId);
        return opts.artifact ?? null;
      },
    } as never as Database;
    return { db, artifactLookups };
  }

  function recordingRuntime(turn: { text: string; done?: boolean; waiting?: { question: string } }) {
    const requests: AgentRequest[] = [];
    const rt: AgentRuntime = {
      async nextTurn(ctx: AgentTurnContext) {
        requests.push(ctx.request);
        return { done: true, ...turn };
      },
    };
    return { rt, requests };
  }

  const stepOpts = { modelRef: "openai:gpt-4o-mini", docTasks: { repo: "o/r" } };

  it("injects the shared doc contract and appends the drafted-PR footer on artifact evidence", async () => {
    const { db } = makeDb({ docTask: true, artifact: { location: { prNumber: 7 } } });
    const { rt, requests } = recordingRuntime({ text: "Drafted a token-bucket design." });
    const result = await makeAgentTaskStepRunner(db, rt, stepOpts)({ taskId: "t1", checkpoint: emptyCheckpoint() });

    // Contract rides in the TRUSTED instructions: tool, repo, suggested path.
    expect(requests[0]!.instructions).toContain("document_create");
    expect(requests[0]!.instructions).toContain('repo "o/r"');
    expect(requests[0]!.instructions).toContain("docs/draft-a-plan-for-rate-limiting.md");

    // The delivered summary (last finding) carries the deterministic outcome.
    expect(result.checkpoint.findings.at(-1)).toContain("Drafted a token-bucket design.");
    expect(result.checkpoint.findings.at(-1)).toContain("Drafted design doc: PR #7");
  });

  it("reports a visible no-op when the turn produced no artifact — text is never evidence", async () => {
    const { db } = makeDb({ docTask: true, artifact: null });
    const { rt } = recordingRuntime({ text: "I drafted it!\n```markdown\n# Plan\n```" });
    const result = await makeAgentTaskStepRunner(db, rt, stepOpts)({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(result.checkpoint.findings.at(-1)).toContain("No design document was produced by this run — nothing was committed");
  });

  it("leaves non-doc tasks untouched (no contract, no footer, no artifact lookup)", async () => {
    const { db, artifactLookups } = makeDb({ docTask: false });
    const { rt, requests } = recordingRuntime({ text: "Just an answer." });
    const result = await makeAgentTaskStepRunner(db, rt, stepOpts)({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(requests[0]!.instructions).not.toContain("document_create");
    expect(result.checkpoint.findings.at(-1)).toBe("Just an answer.");
    expect(artifactLookups).toHaveLength(0);
  });

  it("adds no footer on a durable wait — the outcome check runs when the task finishes", async () => {
    const { db, artifactLookups } = makeDb({ docTask: true });
    const { rt } = recordingRuntime({ text: "One question first.", done: false, waiting: { question: "which service?" } });
    const result = await makeAgentTaskStepRunner(db, rt, stepOpts)({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(result.waiting).toEqual({ kind: "input", question: "which service?" });
    expect(result.checkpoint.findings.at(-1)).toBe("One question first.");
    expect(artifactLookups).toHaveLength(0);
  });

  it("requires the docTasks wiring — a doc-shaped task without it behaves generically", async () => {
    const { db, artifactLookups } = makeDb({ docTask: true });
    const { rt, requests } = recordingRuntime({ text: "reply" });
    await makeAgentTaskStepRunner(db, rt, { modelRef: "openai:gpt-4o-mini" })({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(requests[0]!.instructions).not.toContain("document_create");
    expect(artifactLookups).toHaveLength(0);
  });
});

/** chat-repo.md §3.2 — repo grounding threaded through the step runner. */
describe("makeAgentTaskStepRunner repo grounding (chat-repo.md §3.2)", () => {
  const chatTask: Task = {
    id: "t1",
    tenantId: "tn1",
    agentId: "a1",
    agentVersionId: null,
    invokingUserId: "u1",
    sourceTaskId: null,
    sourceType: "slack",
    sourceRef: { channel: "C1", thread_ts: "1.1" },
    deliveryTargets: null,
    status: "running",
    inputText: "what does the limiter do?",
    summary: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    lastError: null,
  };
  // Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
  const db = { getTask: async () => chatTask, getLatestAgentVersion: async () => null } as never as Database;

  function workspaceRuntime() {
    const seen: Array<{ dir: string; baseSha: string } | undefined> = [];
    const rt: AgentRuntime = {
      async nextTurn(ctx: AgentTurnContext) {
        seen.push(ctx.workspace);
        return { text: "grounded reply", done: true };
      },
    };
    return { rt, seen };
  }

  it("passes the resolved read-only workspace into the turn, pins the sha, and disposes after", async () => {
    const { rt, seen } = workspaceRuntime();
    let disposed = 0;
    const resolveWorkspace = vi.fn(async (_t: Task, o: { pinnedSha?: string }) => ({
      workspace: { dir: "/tmp/ws", baseSha: "sha-abc" },
      sha: "sha-abc",
      dispose: async () => void disposed++,
      _pinnedIn: o.pinnedSha,
    }));
    const result = await makeAgentTaskStepRunner(db, rt, { modelRef: "openai:gpt-4o-mini", resolveWorkspace })({
      taskId: "t1",
      checkpoint: emptyCheckpoint(),
    });
    expect(seen[0]).toEqual({ dir: "/tmp/ws", baseSha: "sha-abc" });
    expect(disposed).toBe(1);
    // The resolved commit is pinned on the checkpoint for a later resume.
    expect(result.checkpoint.groundedSha).toBe("sha-abc");
  });

  it("passes the pinned sha from the checkpoint into the provider on resume", async () => {
    const { rt } = workspaceRuntime();
    const resolveWorkspace = vi.fn(async () => ({
      workspace: { dir: "/tmp/ws", baseSha: "sha-pinned" },
      sha: "sha-pinned",
      dispose: async () => {},
    }));
    await makeAgentTaskStepRunner(db, rt, { modelRef: "openai:gpt-4o-mini", resolveWorkspace })({
      taskId: "t1",
      checkpoint: { ...emptyCheckpoint(), groundedSha: "sha-pinned" },
    });
    expect(resolveWorkspace).toHaveBeenCalledWith(chatTask, { pinnedSha: "sha-pinned" });
  });

  it("disposes the workspace even when the turn throws", async () => {
    let disposed = 0;
    const rt: AgentRuntime = { async nextTurn() { throw new Error("model boom"); } };
    const resolveWorkspace = async () => ({
      workspace: { dir: "/tmp/ws", baseSha: "s" },
      sha: "s",
      dispose: async () => void disposed++,
    });
    await expect(
      makeAgentTaskStepRunner(db, rt, { modelRef: "openai:gpt-4o-mini", resolveWorkspace })({
        taskId: "t1",
        checkpoint: emptyCheckpoint(),
      }),
    ).rejects.toThrow(/model boom/);
    expect(disposed).toBe(1);
  });

  it("runs ungrounded (no workspace) when the provider declines", async () => {
    const { rt, seen } = workspaceRuntime();
    const resolveWorkspace = async () => undefined;
    const result = await makeAgentTaskStepRunner(db, rt, { modelRef: "openai:gpt-4o-mini", resolveWorkspace })({
      taskId: "t1",
      checkpoint: emptyCheckpoint(),
    });
    expect(seen[0]).toBeUndefined();
    expect(result.checkpoint.groundedSha).toBeUndefined();
  });
});

/** §A.4 — one worker, many agents: the step runner resolves the runtime per task. */
describe("makeAgentTaskStepRunner multi-agent dispatch (§A.4)", () => {
  function dbForAgent(agentId: string | null) {
    // Stubs are `as never` at the test boundary (see AGENTS.md rule 1).
    return {
      getTask: async () => ({
        id: "t1",
        tenantId: "tn1",
        agentId,
        sourceType: "slack",
        sourceRef: { channel: "C1", thread_ts: "1.1" },
        inputText: "hello",
        status: "running",
        costUsd: 0,
        createdAt: new Date(),
      }),
      getLatestAgentVersion: async () => null,
    } as never as Database;
  }
  function label(id: string): AgentRuntime {
    return { async nextTurn() { return { text: id, done: true }; } };
  }

  it("runs each task on the runtime for its owning agent id", async () => {
    const seen: Array<string | undefined> = [];
    const resolver = (id: string | undefined) => {
      seen.push(id);
      return id === "reviewer" ? label("reviewer-ran") : label("forge-ran");
    };
    const rev = await makeAgentTaskStepRunner(dbForAgent("reviewer"), resolver, { modelRef: "m" })({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(rev.checkpoint.findings.at(-1)).toBe("reviewer-ran");
    const forge = await makeAgentTaskStepRunner(dbForAgent("forge"), resolver, { modelRef: "m" })({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(forge.checkpoint.findings.at(-1)).toBe("forge-ran");
    expect(seen).toEqual(["reviewer", "forge"]);
  });

  it("still accepts a plain runtime (single-agent behavior unchanged)", async () => {
    const res = await makeAgentTaskStepRunner(dbForAgent("a1"), label("single"), { modelRef: "m" })({ taskId: "t1", checkpoint: emptyCheckpoint() });
    expect(res.checkpoint.findings.at(-1)).toBe("single");
  });
});
