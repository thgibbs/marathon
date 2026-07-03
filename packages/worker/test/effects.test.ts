import type { SecretStore } from "@marathon/config";
import { payloadHashOf } from "@marathon/core";
import { EffectExecutorRegistry, type EffectExecutor } from "@marathon/tools";
import { describe, expect, it } from "vitest";
import {
  EffectApprovalError,
  InMemoryProposedEffectStore,
  ProposedEffectService,
} from "../src/effects";

const secrets: SecretStore = { get: async () => "tok" };

function service(executor?: EffectExecutor) {
  const store = new InMemoryProposedEffectStore();
  const executors = new EffectExecutorRegistry();
  if (executor) executors.register("github.merge_pull_request", executor);
  const svc = new ProposedEffectService({ store, executors, secrets });
  return { store, svc };
}

const PROPOSAL = {
  tenantId: "tenant-1",
  taskId: "task-1",
  agentId: "agent-1",
  effectType: "github.merge_pull_request",
  target: { repo: "acme/service", number: 12 },
  payload: { repo: "acme/service", number: 12, method: "squash" },
};

describe("ProposedEffectService (Track 9)", () => {
  it("propose records the immutable artifact, its approval, and pauses the task", async () => {
    const { store, svc } = service();
    const { effect, approval, deduped } = await svc.propose(PROPOSAL);

    expect(deduped).toBe(false);
    expect(effect.executionState).toBe("proposed");
    expect(effect.payloadHash).toBe(payloadHashOf(PROPOSAL.payload));
    expect(approval.proposedEffectId).toBe(effect.id);
    expect(approval.status).toBe("pending");
    expect(store.taskTransitions).toEqual([{ taskId: "task-1", to: "waiting_for_approval" }]);
    expect(store.audits.map((a) => a.eventType)).toContain("effect.proposed");
  });

  it("a duplicate proposal converges on the existing artifact and approval", async () => {
    const { store, svc } = service();
    const first = await svc.propose(PROPOSAL);
    const second = await svc.propose(PROPOSAL);
    expect(second.deduped).toBe(true);
    expect(second.effect.id).toBe(first.effect.id);
    expect(second.approval.id).toBe(first.approval.id);
    expect(store.approvals.size).toBe(1);
    // No duplicate pause: the task was transitioned once.
    expect(store.taskTransitions).toHaveLength(1);
  });

  it("approve binds to the exact payload hash — a mismatch voids the approval", async () => {
    const { svc } = service();
    const { effect } = await svc.propose(PROPOSAL);
    await expect(svc.approve(effect.id, { payloadHash: "not-the-reviewed-hash" })).rejects.toThrow(
      EffectApprovalError,
    );
    await expect(svc.approve(effect.id, { payloadHash: payloadHashOf({ tampered: true }) })).rejects.toThrow(
      /approval is void/,
    );
    // The right hash approves.
    const approved = await svc.approve(effect.id, { payloadHash: effect.payloadHash, byUserId: "user-1" });
    expect(approved.executionState).toBe("approved");
  });

  it("approve resolves the linked approval and resumes the task", async () => {
    const { store, svc } = service();
    const { effect, approval } = await svc.propose(PROPOSAL);
    await svc.approve(effect.id, { payloadHash: effect.payloadHash, byUserId: "user-1" });
    expect(store.approvals.get(approval.id)?.status).toBe("approved");
    expect(store.approvals.get(approval.id)?.resolvedByUserId).toBe("user-1");
    expect(store.taskTransitions.at(-1)).toEqual({ taskId: "task-1", to: "running" });
    expect(store.audits.map((a) => a.eventType)).toContain("effect.approved");
  });

  it("reject resolves everything without executing", async () => {
    const { store, svc } = service();
    const { effect, approval } = await svc.propose(PROPOSAL);
    const rejected = await svc.reject(effect.id, "user-2");
    expect(rejected.executionState).toBe("rejected");
    expect(store.approvals.get(approval.id)?.status).toBe("rejected");
    const exec = await svc.execute(effect.id);
    expect(exec.executed).toBe(false);
  });

  it("an expired proposal cannot be approved", async () => {
    const { store, svc } = service();
    const { effect } = await svc.propose({ ...PROPOSAL, expiresInMs: -1 });
    await expect(svc.approve(effect.id, { payloadHash: effect.payloadHash })).rejects.toThrow(/expired/);
    expect(store.effects.get(effect.id)?.executionState).toBe("expired");
    expect(store.taskTransitions.at(-1)).toEqual({ taskId: "task-1", to: "running" });
  });

  it("expire is a no-op on resolved proposals", async () => {
    const { svc } = service();
    const { effect } = await svc.propose(PROPOSAL);
    await svc.reject(effect.id);
    expect(await svc.expire(effect.id)).toBeNull();
    expect(await svc.expire("missing")).toBeNull();
  });

  it("execute runs the non-model executor exactly once", async () => {
    let runs = 0;
    const { store, svc } = service(async (effect, ctx) => {
      runs++;
      expect(await ctx.secrets.get("secret/github")).toBe("tok"); // credential arrives at execution, not via the model
      expect(effect.target).toEqual(PROPOSAL.target);
      return { summary: "merged acme/service#12" };
    });
    const { effect } = await svc.propose(PROPOSAL);
    await svc.approve(effect.id, { payloadHash: effect.payloadHash });

    const first = await svc.execute(effect.id);
    expect(first.executed).toBe(true);
    if (first.executed) expect(first.result.summary).toBe("merged acme/service#12");
    expect(store.effects.get(effect.id)?.executionState).toBe("executed");

    const second = await svc.execute(effect.id);
    expect(second.executed).toBe(false);
    expect(runs).toBe(1);
    expect(store.audits.map((a) => a.eventType)).toContain("effect.executed");
  });

  it("execute refuses an unapproved proposal (no skipping review)", async () => {
    const { svc } = service(async () => ({ summary: "x" }));
    const { effect } = await svc.propose(PROPOSAL);
    const out = await svc.execute(effect.id);
    expect(out.executed).toBe(false);
    if (!out.executed) expect(out.reason).toMatch(/proposed, not approved/);
    const missing = await svc.execute("nope");
    expect(missing.executed).toBe(false);
  });

  it("a failing executor marks the effect failed and rethrows", async () => {
    const { store, svc } = service(async () => {
      throw new Error("merge conflict");
    });
    const { effect } = await svc.propose(PROPOSAL);
    await svc.approve(effect.id, { payloadHash: effect.payloadHash });
    await expect(svc.execute(effect.id)).rejects.toThrow(/merge conflict/);
    expect(store.effects.get(effect.id)?.executionState).toBe("failed");
    expect(store.audits.map((a) => a.eventType)).toContain("effect.failed");
  });

  it("a missing executor fails the claimed effect", async () => {
    const { store, svc } = service(); // nothing registered
    const { effect } = await svc.propose(PROPOSAL);
    await svc.approve(effect.id, { payloadHash: effect.payloadHash });
    await expect(svc.execute(effect.id)).rejects.toThrow(/no executor registered/);
    expect(store.effects.get(effect.id)?.executionState).toBe("failed");
  });

  it("approve/reject on unknown or already-resolved proposals throw typed errors", async () => {
    const { svc } = service();
    await expect(svc.approve("nope", { payloadHash: "h" })).rejects.toThrow(/not found/);
    const { effect } = await svc.propose(PROPOSAL);
    await svc.reject(effect.id);
    await expect(svc.approve(effect.id, { payloadHash: effect.payloadHash })).rejects.toThrow();
    await expect(svc.reject(effect.id)).rejects.toThrow();
  });
});
