import { computeGithubSignature } from "@marathon/surface-github";
import { describe, expect, it, vi } from "vitest";
import { handleWebhookRequest } from "../src/webhook";

const SECRET = "whsec";

// Minimal deps stub: dispatch is exercised via classify; we stub db.claim and the
// agents list, and spy that a mention reaches the router.
function makeDeps(claimResults: boolean[] = [true]) {
  let i = 0;
  const route = vi.fn(async () => ({ task: { id: "t1" }, agentName: "quill", deduped: false }));
  return {
    deps: {
      db: { claim: async () => claimResults[i++] ?? true },
      router: { route },
      agents: [{ name: "quill" }],
      // these are only reached if a mention dispatches; we make route throw-free and
      // stop early by having the gateway/delivery be no-ops:
      gateway: { run: async () => ({ content: "ok", details: { number: 1 } }) },
      delivery: { acknowledge: async () => {}, postProgress: async () => {}, deliverResult: async () => {} },
      runtime: { nextTurn: async () => ({ text: "# doc", done: true }) },
      recordDocumentArtifact: async () => {},
      tenantId: "tn1",
      agentIdByName: { quill: "a1" },
      // db methods used by handlers:
    } as never,
    route,
  };
}

function signed(body: string) {
  return { signature: computeGithubSignature(SECRET, body), rawBody: body };
}

describe("handleWebhookRequest", () => {
  it("rejects an invalid signature", async () => {
    const { deps } = makeDeps();
    const res = await handleWebhookRequest(deps, SECRET, { eventType: "ping", rawBody: "{}", signature: "sha256=bad" });
    expect(res.status).toBe(401);
  });

  it("dedupes a repeated delivery id", async () => {
    const { deps } = makeDeps([false]); // claim returns false => already seen
    const body = JSON.stringify({ zen: "hi" });
    const res = await handleWebhookRequest(deps, SECRET, { eventType: "ping", deliveryId: "d1", ...signed(body) });
    expect(res).toMatchObject({ status: 200, note: "duplicate delivery" });
  });

  it("accepts a valid signed non-mention event (ignored) with 200", async () => {
    const { deps, route } = makeDeps();
    const body = JSON.stringify({ action: "created", comment: { body: "no mention" }, issue: { number: 1 }, repository: { full_name: "o/r" } });
    const res = await handleWebhookRequest(deps, SECRET, { eventType: "issue_comment", deliveryId: "d2", ...signed(body) });
    expect(res.status).toBe(200);
    expect(route).not.toHaveBeenCalled(); // no @marathon mention -> ignored
  });

  it("rejects malformed json", async () => {
    const { deps } = makeDeps();
    const res = await handleWebhookRequest(deps, SECRET, { eventType: "ping", deliveryId: "d3", ...signed("not json{") });
    expect(res.status).toBe(400);
  });
});
