import { describe, expect, it } from "vitest";
import { DockerSandbox, dockerRunArgs, dockerStartArgs, LocalSubprocessSandbox, NoSandbox, sandboxFromEnv } from "../src/sandbox";

describe("dockerRunArgs (isolation flags)", () => {
  const argv = dockerRunArgs("alpine:3.20", "echo", ["hi"]);
  const has = (...seq: string[]) => {
    const i = argv.indexOf(seq[0]!);
    return i >= 0 && seq.every((s, k) => argv[i + k] === s);
  };

  it("is ephemeral, internet-enabled, read-only, capability-stripped, non-root, limited", () => {
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--rm");
    // Track 8: outbound internet by default; the boundary is credential-freedom.
    expect(has("--network", "bridge")).toBe(true);
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

  it("supports a strict egress-denied sandbox via network: none", () => {
    const strict = dockerRunArgs("img", "ls", [], { network: "none" });
    const i = strict.indexOf("--network");
    expect(strict[i + 1]).toBe("none");
  });
});

describe("dockerStartArgs (persistent container)", () => {
  const argv = dockerStartArgs("alpine:3.20", { workspaceDir: "/host/ws" });
  const has = (...seq: string[]) => {
    const i = argv.indexOf(seq[0]!);
    return i >= 0 && seq.every((s, k) => argv[i + k] === s);
  };
  it("runs detached, hardened, with the workspace mounted, kept alive", () => {
    expect(has("run", "-d", "--rm")).toBe(true);
    expect(has("--network", "bridge")).toBe(true);
    expect(argv).toContain("--read-only");
    expect(has("--cap-drop", "ALL")).toBe(true);
    expect(has("-v", "/host/ws:/workspace:rw")).toBe(true);
    expect(has("-w", "/workspace")).toBe(true);
    expect(argv.slice(-4)).toEqual(["alpine:3.20", "tail", "-f", "/dev/null"]);
  });
  it("passes no env/secrets", () => {
    expect(argv).not.toContain("-e");
    expect(argv).not.toContain("--env");
  });
});

describe("dockerStartArgs readonlyWorkspace (chat-repo.md §3.4)", () => {
  const roArgv = dockerStartArgs("alpine:3.20", { workspaceDir: "/host/ws", readonlyWorkspace: true });
  const has = (...seq: string[]) => {
    const i = roArgv.indexOf(seq[0]!);
    return i >= 0 && seq.every((s, k) => roArgv[i + k] === s);
  };
  it("mounts /workspace read-only with a writable .marathon-home layered over it", () => {
    // Each mount value is preceded by a `-v` flag.
    const mountValues = roArgv.filter((_, i) => roArgv[i - 1] === "-v");
    expect(mountValues).toContain("/host/ws:/workspace:ro");
    expect(mountValues).toContain("/host/ws/.marathon-home:/workspace/.marathon-home:rw");
    // The read-write workspace mount from the default posture must NOT appear.
    expect(roArgv).not.toContain("/host/ws:/workspace:rw");
  });
  it("stays hardened and kept alive", () => {
    expect(roArgv).toContain("--read-only");
    expect(has("--cap-drop", "ALL")).toBe(true);
    expect(roArgv.slice(-4)).toEqual(["alpine:3.20", "tail", "-f", "/dev/null"]);
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
