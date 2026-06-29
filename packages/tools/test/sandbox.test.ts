import { describe, expect, it } from "vitest";
import { DockerSandbox, dockerRunArgs, LocalSubprocessSandbox, NoSandbox, sandboxFromEnv } from "../src/sandbox";

describe("dockerRunArgs (isolation flags)", () => {
  const argv = dockerRunArgs("alpine:3.20", "echo", ["hi"]);
  const has = (...seq: string[]) => {
    const i = argv.indexOf(seq[0]!);
    return i >= 0 && seq.every((s, k) => argv[i + k] === s);
  };

  it("is ephemeral, network-denied, read-only, capability-stripped, non-root, limited", () => {
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--rm");
    expect(has("--network", "none")).toBe(true);
    expect(argv).toContain("--read-only");
    expect(has("--cap-drop", "ALL")).toBe(true);
    expect(has("--security-opt", "no-new-privileges")).toBe(true);
    expect(has("--user", "1000:1000")).toBe(true);
    expect(argv).toContain("--pids-limit");
    expect(argv).toContain("--memory");
    expect(argv).toContain("--cpus");
  });

  it("passes NO env/secrets into the container", () => {
    expect(argv).not.toContain("-e");
    expect(argv).not.toContain("--env");
  });

  it("ends with image then the command, and runs in a tmpfs workdir by default", () => {
    expect(has("-w", "/tmp")).toBe(true);
    expect(argv.slice(-3)).toEqual(["alpine:3.20", "echo", "hi"]);
  });

  it("mounts a workspace read-write when given (and only then)", () => {
    const ws = dockerRunArgs("img", "ls", [], { workspaceDir: "/host/work" });
    expect(ws).toContain("-v");
    expect(ws).toContain("/host/work:/workspace:rw");
    expect(ws).toContain("/workspace");
    expect(dockerRunArgs("img", "ls", [])).not.toContain("-v");
  });
});

describe("sandboxFromEnv", () => {
  it("defaults to NoSandbox (fail closed)", () => {
    expect(sandboxFromEnv({}).name).toBe("none");
    expect(sandboxFromEnv({ MARATHON_SANDBOX: "none" })).toBeInstanceOf(NoSandbox);
  });
  it("selects local and docker backends", () => {
    expect(sandboxFromEnv({ MARATHON_SANDBOX: "local" })).toBeInstanceOf(LocalSubprocessSandbox);
    expect(sandboxFromEnv({ MARATHON_SANDBOX: "docker" })).toBeInstanceOf(DockerSandbox);
  });
});
