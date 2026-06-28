import { EnvSecretStore } from "@marathon/config";
import { describe, expect, it } from "vitest";
import { makeCliTool } from "../src/cli";

const ctx = { taskId: "t1", tenantId: "tenant1", secrets: new EnvSecretStore({}) };

describe("makeCliTool", () => {
  const tool = makeCliTool(["echo", "true"]);

  it("allows allowlisted commands", () => {
    expect(tool.validate?.({ command: "echo hi" })).toBeNull();
  });

  it("rejects non-allowlisted commands", () => {
    expect(tool.validate?.({ command: "rm -rf /" })).toMatch(/not allowed/);
    expect(tool.validate?.({ command: "" })).toMatch(/required/);
  });

  it("executes an allowed command", async () => {
    const res = await tool.execute({ command: "echo hello" }, ctx);
    expect(res.content.trim()).toBe("hello");
  });
});
