import type { DockerContainer } from "@marathon/tools";
import { describe, expect, it } from "vitest";
import {
  buildDockerSandboxTools,
  dockerBashOperations,
  dockerReadOperations,
  dockerWriteOperations,
  GUEST_WORKSPACE,
} from "../src/sandbox-tools";

type ExecCall = { argv: string[]; opts: Record<string, unknown> };

/** A DockerContainer stand-in that records execStream calls and returns canned results. */
function fakeContainer(
  responder: (argv: string[], opts: Record<string, unknown>) => { exitCode: number | null; stdout?: string; stderr?: string },
): { container: DockerContainer; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const container = {
    async execStream(argv: string[], opts: Record<string, unknown> = {}) {
      calls.push({ argv, opts });
      const r = responder(argv, opts);
      return { exitCode: r.exitCode, stdout: Buffer.from(r.stdout ?? ""), stderr: Buffer.from(r.stderr ?? "") };
    },
  } as unknown as DockerContainer;
  return { container, calls };
}

describe("dockerReadOperations", () => {
  it("reads a file via `cat` and returns its bytes", async () => {
    const { container } = fakeContainer(() => ({ exitCode: 0, stdout: "hello" }));
    const ops = dockerReadOperations(container);
    const buf = await ops.readFile("/workspace/a.txt");
    expect(buf.toString()).toBe("hello");
  });

  it("throws on a non-zero `cat` exit", async () => {
    const { container } = fakeContainer(() => ({ exitCode: 1, stderr: "No such file" }));
    const ops = dockerReadOperations(container);
    await expect(ops.readFile("/workspace/missing")).rejects.toThrow(/read failed/);
  });

  it("access throws when the file is not readable", async () => {
    const { container, calls } = fakeContainer(() => ({ exitCode: 1 }));
    const ops = dockerReadOperations(container);
    await expect(ops.access("/workspace/x")).rejects.toThrow(/not readable/);
    expect(calls[0]?.argv).toEqual(["test", "-r", "/workspace/x"]);
  });
});

describe("dockerWriteOperations", () => {
  it("writes content via stdin to `cat > $1`", async () => {
    const { container, calls } = fakeContainer(() => ({ exitCode: 0 }));
    const ops = dockerWriteOperations(container);
    await ops.writeFile("/workspace/out.txt", "payload");
    expect(calls[0]?.argv).toEqual(["sh", "-c", 'cat > "$1"', "sh", "/workspace/out.txt"]);
    expect(calls[0]?.opts.input).toBe("payload");
  });

  it("mkdir -p creates directories", async () => {
    const { container, calls } = fakeContainer(() => ({ exitCode: 0 }));
    const ops = dockerWriteOperations(container);
    await ops.mkdir("/workspace/sub/dir");
    expect(calls[0]?.argv).toEqual(["mkdir", "-p", "--", "/workspace/sub/dir"]);
  });
});

describe("dockerBashOperations", () => {
  it("runs the command in a shell, passes cwd, maps timeout to ms, and drops env", async () => {
    const { container, calls } = fakeContainer(() => ({ exitCode: 7 }));
    const ops = dockerBashOperations(container, "/bin/bash");
    const collected: Buffer[] = [];
    const result = await ops.exec("echo hi", "/workspace/sub", {
      onData: (d) => collected.push(d),
      timeout: 3,
      env: { SECRET: "nope" } as NodeJS.ProcessEnv,
    });
    expect(result.exitCode).toBe(7);
    expect(calls[0]?.argv).toEqual(["/bin/bash", "-lc", "echo hi"]);
    expect(calls[0]?.opts.cwd).toBe("/workspace/sub");
    expect(calls[0]?.opts.timeoutMs).toBe(3000);
    // Host env must never cross into the sandbox.
    expect(JSON.stringify(calls[0]?.opts)).not.toContain("SECRET");
  });
});

describe("buildDockerSandboxTools", () => {
  it("builds bash/read/write/edit definitions rooted at the guest workspace", () => {
    const { container } = fakeContainer(() => ({ exitCode: 0 }));
    const factoryCalls: Array<{ kind: string; cwd: string; hasOps: boolean }> = [];
    const mk = (kind: string) => (cwd: string, options: { operations?: unknown }) => {
      factoryCalls.push({ kind, cwd, hasOps: !!options?.operations });
      return { name: kind };
    };
    const pi = {
      createBashToolDefinition: mk("bash"),
      createReadToolDefinition: mk("read"),
      createWriteToolDefinition: mk("write"),
      createEditToolDefinition: mk("edit"),
    };
    const { tools, names } = buildDockerSandboxTools(pi, container);
    expect(names).toEqual(["bash", "read", "write", "edit"]);
    expect(tools).toHaveLength(4);
    expect(factoryCalls.every((c) => c.cwd === GUEST_WORKSPACE && c.hasOps)).toBe(true);
  });
});
