import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import {
  ToolBlockedError,
  ToolGateway,
  ToolRegistry,
  checkEgress,
  type AuditRecord,
  type ToolInvocationRecord,
} from "../src/gateway";
import { InMemorySourceLedger } from "../src/ledger";
import type { Tool } from "../src/types";

const ctx = { taskId: "t1", tenantId: "tenant1", agentId: "a1" };

function makeRecorder() {
  const invocations: ToolInvocationRecord[] = [];
  const audits: AuditRecord[] = [];
  return {
    invocations,
    audits,
    recorder: {
      onInvocation: (r: ToolInvocationRecord) => void invocations.push(r),
      onAudit: (e: AuditRecord) => void audits.push(e),
    },
  };
}

const AXES = { reversible: true, crossesTrustBoundary: false, audience: "private", costly: false } as const;

const echoTool: Tool = {
  name: "echo",
  description: "echo",
  riskAxes: AXES,
  defaultMode: "autonomous",
  async execute(input) {
    return { content: String(input.text ?? "") };
  },
};

const secretLeakTool: Tool = {
  name: "leaky",
  description: "returns a secret-looking string",
  riskAxes: AXES,
  defaultMode: "autonomous",
  async execute() {
    return { content: "here is a key sk-abcdef0123456789ABCDEF stay safe" };
  },
};

function gw(tools: Tool[], opts: Partial<ConstructorParameters<typeof ToolGateway>[0]> = {}) {
  return new ToolGateway({
    registry: new ToolRegistry(tools),
    policy: { grants: tools.map((t) => ({ tool: t.name })) },
    secrets: new EnvSecretStore({}),
    ...opts,
  });
}

describe("ToolGateway", () => {
  it("executes a granted tool and records ok + audit", async () => {
    const { invocations, audits, recorder } = makeRecorder();
    const res = await gw([echoTool], { recorder }).run("echo", { text: "hi" }, ctx);
    expect(res.content).toBe("hi");
    expect(invocations[0]?.status).toBe("ok");
    expect(invocations[0]?.riskAxes).toEqual(AXES);
    expect(audits.map((a) => a.eventType)).toContain("tool.called");
  });

  it("blocks an ungranted tool and audits policy.denied with a typed code", async () => {
    const { invocations, audits, recorder } = makeRecorder();
    const g = gw([echoTool], { recorder, policy: { grants: [] } });
    const err = await g.run("echo", {}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ToolBlockedError);
    expect((err as ToolBlockedError).code).toBe("not_granted");
    expect(invocations[0]?.status).toBe("blocked");
    expect(audits.map((a) => a.eventType)).toContain("policy.denied");
  });

  it("routes a proposed_effect tool to requires_proposal", async () => {
    const highRisk: Tool = { ...echoTool, name: "danger", defaultMode: "proposed_effect" };
    const err = await gw([highRisk]).run("danger", {}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ToolBlockedError);
    expect((err as ToolBlockedError).decision).toBe("requires_proposal");
    expect((err as ToolBlockedError).code).toBe("requires_proposal");
  });

  it("records reads in the source ledger", async () => {
    const ledger = new InMemorySourceLedger();
    const reader: Tool = {
      ...echoTool,
      name: "repo.read",
      sources: () => [{ source: "github:o/r", sensitivity: "company_viewable" }],
    };
    await gw([reader], { sourceLedger: ledger }).run("repo.read", {}, ctx);
    expect(ledger.list("t1")).toEqual([{ source: "github:o/r", sensitivity: "company_viewable" }]);
  });

  it("blocks tenant-external egress (must be a Proposed Effect)", async () => {
    const { audits, recorder } = makeRecorder();
    const poster: Tool = {
      ...echoTool,
      name: "post.external",
      egress: () => ({ destination: "slack-connect:C1", audience: "external", external: true }),
    };
    const err = await gw([poster], { recorder }).run("post.external", {}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ToolBlockedError);
    expect((err as ToolBlockedError).code).toBe("egress_blocked");
    expect(audits.map((a) => a.eventType)).toContain("egress.denied");
  });

  it("records the effective internal egress mode (§30.4) on the egress audit", async () => {
    const { audits, recorder } = makeRecorder();
    const poster: Tool = {
      ...echoTool,
      name: "post.external",
      egress: () => ({ destination: "slack-connect:C1", audience: "external", external: true }),
    };
    await gw([poster], { recorder, internalEgressMode: "audience" }).run("post.external", {}, ctx).catch((e) => e);
    const egress = audits.find((a) => a.eventType === "egress.denied");
    expect(egress?.summary).toContain("[egress audience]");
  });

  it("blocks internal egress after reading a restricted source; allows company_viewable", async () => {
    const ledger = new InMemorySourceLedger();
    const reader: Tool = {
      ...echoTool,
      name: "repo.read",
      sources: () => [{ source: "github:o/secret", sensitivity: "restricted" }],
    };
    const poster: Tool = {
      ...echoTool,
      name: "post.internal",
      egress: () => ({ destination: "github:o/r", audience: "tenant", external: false }),
    };
    const g = gw([reader, poster], { sourceLedger: ledger });

    // Before any restricted read, internal egress flows.
    await expect(g.run("post.internal", {}, ctx)).resolves.toBeTruthy();

    await g.run("repo.read", {}, ctx);
    const err = await g.run("post.internal", {}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ToolBlockedError);
    expect((err as ToolBlockedError).code).toBe("egress_blocked");
    expect((err as ToolBlockedError).reason).toContain("github:o/secret");
  });

  it("blocks a tool that reads a restricted source and egresses in the same call", async () => {
    const ledger = new InMemorySourceLedger();
    const readAndPost: Tool = {
      ...echoTool,
      name: "summarize.to_channel",
      sources: () => [{ source: "github:o/secret", sensitivity: "restricted" }],
      egress: () => ({ destination: "slack:C1", audience: "tenant", external: false }),
    };
    // First call, empty ledger: the call's OWN declared read must trip the check.
    const err = await gw([readAndPost], { sourceLedger: ledger }).run("summarize.to_channel", {}, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(ToolBlockedError);
    expect((err as ToolBlockedError).code).toBe("egress_blocked");
    // The blocked call never executed, so nothing was recorded as read.
    expect(ledger.list("t1")).toEqual([]);
  });

  it("never writes credential-looking material to recorded summaries", async () => {
    const { invocations, recorder } = makeRecorder();
    await gw([secretLeakTool], { recorder }).run("leaky", { token: "sk-abcdef0123456789ABCDEF" }, ctx);
    const rec = invocations[0]!;
    expect(rec.inputSummary).not.toContain("sk-abcdef0123456789ABCDEF");
    expect(rec.outputSummary).not.toContain("sk-abcdef0123456789ABCDEF");
    expect(rec.outputSummary).toContain("[REDACTED]");
  });

  it("rejects invalid input via the tool validator", async () => {
    const validated: Tool = {
      ...echoTool,
      validate: (input) => (typeof input.text === "string" ? null : "text required"),
    };
    await expect(gw([validated]).run("echo", {}, ctx)).rejects.toThrow(/invalid input/);
  });
});

describe("checkEgress", () => {
  it("passes internal egress over public/company_viewable sources", () => {
    expect(
      checkEgress({ destination: "github:o/r", audience: "tenant", external: false }, [
        { source: "github:o/r", sensitivity: "company_viewable" },
        { source: "web:docs", sensitivity: "public" },
      ]),
    ).toBeNull();
  });

  it("always blocks external/public destinations", () => {
    expect(checkEgress({ destination: "x", audience: "public", external: false }, [])).toMatch(/Proposed Effect/);
    expect(checkEgress({ destination: "x", audience: "team", external: true }, [])).toMatch(/Proposed Effect/);
  });
});
