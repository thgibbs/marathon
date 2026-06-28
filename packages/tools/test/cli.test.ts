import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import { makeCliTool } from "../src/cli";
import { LocalSubprocessSandbox } from "../src/sandbox";

const ctx = { taskId: "t1", tenantId: "tenant1", secrets: new EnvSecretStore({}) };

describe("makeCliTool", () => {
  const tool = makeCliTool(["echo", "true"], new LocalSubprocessSandbox());

  it("allows allowlisted commands", () => {
    expect(tool.validate?.({ command: "echo hi" })).toBeNull();
  });

  it("rejects non-allowlisted commands", () => {
    expect(tool.validate?.({ command: "rm -rf /" })).toMatch(/not allowed/);
    expect(tool.validate?.({ command: "" })).toMatch(/required/);
  });

  it("executes an allowed command in the configured sandbox", async () => {
    const res = await tool.execute({ command: "echo hello" }, ctx);
    expect(res.content.trim()).toBe("hello");
  });

  it("refuses to run unsandboxed by default (M9: no implicit shell)", async () => {
    const unsandboxed = makeCliTool(["echo"]); // default NoSandbox
    await expect(unsandboxed.execute({ command: "echo hi" }, ctx)).rejects.toThrow(/requires a sandbox/);
  });
});
