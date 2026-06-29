import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import {
  ToolBlockedError,
  ToolGateway,
  ToolRegistry,
  type AuditRecord,
  type ToolInvocationRecord,
} from "../src/gateway";
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

const echoTool: Tool = {
  name: "echo",
  description: "echo",
  riskLevel: "low",
  destructive: false,
  async execute(input) {
    return { content: String(input.text ?? "") };
  },
};

const secretLeakTool: Tool = {
  name: "leaky",
  description: "returns a secret-looking string",
  riskLevel: "low",
  destructive: false,
  async execute() {
    return { content: "here is a key sk-abcdef0123456789ABCDEF stay safe" };
  },
};

describe("ToolGateway", () => {
  it("executes a granted tool and records ok + audit", async () => {
    const { invocations, audits, recorder } = makeRecorder();
    const gw = new ToolGateway({
      registry: new ToolRegistry([echoTool]),
      policy: { grants: [{ tool: "echo" }] },
      secrets: new EnvSecretStore({}),
      recorder,
    });
    const res = await gw.run("echo", { text: "hi" }, ctx);
    expect(res.content).toBe("hi");
    expect(invocations[0]?.status).toBe("ok");
    expect(audits.map((a) => a.eventType)).toContain("tool.called");
  });

  it("blocks an ungranted tool and audits policy.denied", async () => {
    const { invocations, audits, recorder } = makeRecorder();
    const gw = new ToolGateway({
      registry: new ToolRegistry([echoTool]),
      policy: { grants: [] },
      secrets: new EnvSecretStore({}),
      recorder,
    });
    await expect(gw.run("echo", {}, ctx)).rejects.toBeInstanceOf(ToolBlockedError);
    expect(invocations[0]?.status).toBe("blocked");
    expect(audits.map((a) => a.eventType)).toContain("policy.denied");
  });

  it("never writes credential-looking material to recorded summaries", async () => {
    const { invocations, recorder } = makeRecorder();
    const gw = new ToolGateway({
      registry: new ToolRegistry([secretLeakTool]),
      policy: { grants: [{ tool: "leaky" }] },
      secrets: new EnvSecretStore({}),
      recorder,
    });
    await gw.run("leaky", { token: "sk-abcdef0123456789ABCDEF" }, ctx);
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
    const gw = new ToolGateway({
      registry: new ToolRegistry([validated]),
      policy: { grants: [{ tool: "echo" }] },
      secrets: new EnvSecretStore({}),
    });
    await expect(gw.run("echo", {}, ctx)).rejects.toThrow(/invalid input/);
  });
});
