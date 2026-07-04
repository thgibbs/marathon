import { DockerContainer, dockerStartArgs } from "@marathon/tools";
import { describe, expect, it } from "vitest";
import {
  KERNEL_TOOLCHAIN_IMAGE,
  resolveSandboxNetwork,
  workspaceContainerOptions,
  workspaceSandbox,
  workspaceSandboxFromSpec,
} from "../src/sandbox-factory";
import type { AgentRequest } from "../src/types";

const ws = { dir: "/host/task-ws", baseSha: "cafe1234" };
const req: AgentRequest = { taskId: "t1", instructions: "", input: "", modelRef: "openai:gpt-4o-mini" };

describe("workspaceContainerOptions (Track 11)", () => {
  it("binds the container to the task's workspace with the pinned toolchain image", () => {
    const opts = workspaceContainerOptions(ws, {}, {});
    expect(opts.workspaceDir).toBe("/host/task-ws");
    expect(opts.image).toBe(KERNEL_TOOLCHAIN_IMAGE);
    // Code tasks compile and test — sized above the CLI-tool defaults.
    expect(opts.memory).toBe("2g");
    expect(opts.cpus).toBe("2");
    expect(opts.pidsLimit).toBe(512);
  });

  it("prefers explicit options, then env, then the pinned default", () => {
    expect(workspaceContainerOptions(ws, { image: "custom:1" }, { MARATHON_SANDBOX_IMAGE: "env:1" }).image).toBe("custom:1");
    expect(workspaceContainerOptions(ws, {}, { MARATHON_SANDBOX_IMAGE: "env:1" }).image).toBe("env:1");
    expect(workspaceContainerOptions(ws, {}, {}).image).toBe(KERNEL_TOOLCHAIN_IMAGE);
    expect(workspaceContainerOptions(ws, { network: "none" }, {}).network).toBe("none");
    expect(workspaceContainerOptions(ws, {}, { MARATHON_SANDBOX_NETWORK: "none" }).network).toBe("none");
  });

  it("produces a hardened, credential-free, internet-enabled container", () => {
    const opts = workspaceContainerOptions(ws, {}, {});
    const argv = dockerStartArgs(opts.image ?? "", opts);
    // No env forwarding of any kind — the sandbox is credential-free (§12.6).
    expect(argv).not.toContain("-e");
    expect(argv).not.toContain("--env");
    // The workspace is the only host mount.
    expect(argv.filter((a) => a === "-v")).toHaveLength(1);
    expect(argv).toContain("/host/task-ws:/workspace:rw");
    // Internet-enabled by default (Track 8), still fully hardened.
    const net = argv.indexOf("--network");
    expect(argv[net + 1]).toBe("bridge");
    expect(argv).toContain("--read-only");
    expect(argv).toContain("--cap-drop");
  });
});

describe("workspaceSandbox (Track 11)", () => {
  it("creates a container from the task's workspace binding", () => {
    const sandbox = workspaceSandbox({}, {});
    const container = sandbox.createContainer(req, ws);
    expect(container).toBeInstanceOf(DockerContainer);
  });

  it("refuses to run without a workspace binding — no fallback sandbox", () => {
    const sandbox = workspaceSandbox({}, {});
    expect(() => sandbox.createContainer(req, undefined)).toThrow(/workspace binding/);
  });

  it("passes the shell through for the toolchain image", () => {
    expect(workspaceSandbox({ shellPath: "/bin/bash" }, {}).shellPath).toBe("/bin/bash");
    expect(workspaceSandbox({}, {}).shellPath).toBeUndefined();
  });
});

describe("per-agent sandbox network (Track 15)", () => {
  it("takes the network from the agent YAML when the env is silent", () => {
    expect(resolveSandboxNetwork({ network: "bridge" }, {}, {})).toBe("bridge");
    expect(resolveSandboxNetwork({ network: "none" }, {}, {})).toBe("none");
  });

  it('strictness composes: "none" from ANY source wins', () => {
    expect(resolveSandboxNetwork({ network: "bridge" }, {}, { MARATHON_SANDBOX_NETWORK: "none" })).toBe("none");
    expect(resolveSandboxNetwork({ network: "none" }, {}, { MARATHON_SANDBOX_NETWORK: "bridge" })).toBe("none");
    expect(resolveSandboxNetwork({ network: "bridge" }, { network: "none" }, {})).toBe("none");
    expect(resolveSandboxNetwork({ network: "bridge" }, {}, { MARATHON_SANDBOX_NETWORK: "bridge" })).toBe("bridge");
  });

  it("no caller can RELAX a strict env or spec (BUILD wiring exposes options)", () => {
    // An explicit bridge option must not loosen "none" from the YAML or env.
    expect(resolveSandboxNetwork({ network: "none" }, { network: "bridge" }, {})).toBe("none");
    expect(resolveSandboxNetwork({ network: "bridge" }, { network: "bridge" }, { MARATHON_SANDBOX_NETWORK: "none" })).toBe("none");
  });

  it("among non-strict values, options win over env over spec", () => {
    expect(resolveSandboxNetwork({ network: "bridge" }, { network: "host-custom" }, { MARATHON_SANDBOX_NETWORK: "env-net" })).toBe("host-custom");
    expect(resolveSandboxNetwork({ network: "bridge" }, {}, { MARATHON_SANDBOX_NETWORK: "env-net" })).toBe("env-net");
  });

  it("workspaceSandboxFromSpec builds spec-driven containers", () => {
    const sandbox = workspaceSandboxFromSpec({ sandbox: { network: "none" } }, {}, {});
    const container = sandbox.createContainer(req, ws);
    expect(container).toBeInstanceOf(DockerContainer);
  });
});
