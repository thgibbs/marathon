import type { DockerContainer } from "@marathon/tools";
import { describe, expect, it } from "vitest";
import {
  buildDockerSandboxTools,
  buildSandboxGrepTool,
  dockerBashOperations,
  dockerFindOperations,
  dockerLsOperations,
  dockerReadOperations,
  dockerWriteOperations,
  GUEST_WORKSPACE,
  resolveWithinWorkspace,
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

describe("resolveWithinWorkspace (workspace containment, review §2b #2)", () => {
  const ws = "/workspace";
  it("resolves relative paths under the workspace", () => {
    expect(resolveWithinWorkspace(ws, ".")).toBe("/workspace");
    expect(resolveWithinWorkspace(ws, "src")).toBe("/workspace/src");
    expect(resolveWithinWorkspace(ws, "src/../lib")).toBe("/workspace/lib");
    expect(resolveWithinWorkspace(ws, "/workspace/src")).toBe("/workspace/src");
  });
  it("refuses absolute escapes and `../` traversal", () => {
    expect(() => resolveWithinWorkspace(ws, "/etc/passwd")).toThrow(/escapes the workspace/);
    expect(() => resolveWithinWorkspace(ws, "../../etc")).toThrow(/escapes the workspace/);
    expect(() => resolveWithinWorkspace(ws, "src/../../etc")).toThrow(/escapes the workspace/);
    // A sibling that merely shares the prefix is not "under" the workspace.
    expect(() => resolveWithinWorkspace(ws, "/workspace-evil")).toThrow(/escapes the workspace/);
  });
});

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

describe("dockerLsOperations (§2b #2)", () => {
  it("readdir lists a directory in ONE exec and stat serves entries from that cache", async () => {
    const { container, calls } = fakeContainer((argv) => {
      if (argv[0] === "sh") return { exitCode: 0, stdout: "src/\nREADME.md\n.hidden\n" };
      return { exitCode: 0 };
    });
    const ops = dockerLsOperations(container);
    const entries = await ops.readdir("/workspace");
    expect(entries).toEqual(["src", "README.md", ".hidden"]);
    expect(calls).toHaveLength(1);
    // Per-entry stats hit the cache — no further execs.
    const dirStat = await ops.stat("/workspace/src");
    const fileStat = await ops.stat("/workspace/README.md");
    expect(dirStat.isDirectory()).toBe(true);
    expect(fileStat.isDirectory()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("stat falls back to a container exec for an unlisted path and throws when missing", async () => {
    const { container } = fakeContainer((argv) => {
      const p = argv[argv.length - 1];
      if (p === "/workspace/dir") return { exitCode: 0, stdout: "d\n" };
      return { exitCode: 2 };
    });
    const ops = dockerLsOperations(container);
    expect((await ops.stat("/workspace/dir")).isDirectory()).toBe(true);
    await expect(ops.stat("/workspace/missing")).rejects.toThrow(/not found in sandbox/);
  });

  it("exists maps `test -e` exit codes", async () => {
    const { container, calls } = fakeContainer((argv) => ({ exitCode: argv[2] === "/workspace/yes" ? 0 : 1 }));
    const ops = dockerLsOperations(container);
    expect(await ops.exists("/workspace/yes")).toBe(true);
    expect(await ops.exists("/workspace/no")).toBe(false);
    expect(calls[0]?.argv).toEqual(["test", "-e", "/workspace/yes"]);
  });

  it("readdir surfaces a listing failure", async () => {
    const { container } = fakeContainer(() => ({ exitCode: 2, stderr: "cd: no such dir" }));
    const ops = dockerLsOperations(container);
    await expect(ops.readdir("/workspace/nope")).rejects.toThrow(/ls failed/);
  });

  it("refuses paths that escape the workspace before touching the container", async () => {
    const { container, calls } = fakeContainer(() => ({ exitCode: 0 }));
    const ops = dockerLsOperations(container);
    await expect(ops.exists("/etc")).rejects.toThrow(/escapes the workspace/);
    await expect(ops.stat("/etc/passwd")).rejects.toThrow(/escapes the workspace/);
    await expect(ops.readdir("/workspace/../../etc")).rejects.toThrow(/escapes the workspace/);
    expect(calls).toHaveLength(0); // rejected before any exec
  });
});

describe("dockerFindOperations (§2b #2)", () => {
  it("globs via `rg --files` in the container and returns absolute guest paths", async () => {
    const { container, calls } = fakeContainer((argv) =>
      argv[0] === "rg" ? { exitCode: 0, stdout: "src/a.ts\nsrc/b.ts\n" } : { exitCode: 0 },
    );
    const ops = dockerFindOperations(container);
    const results = await ops.glob("*.ts", "/workspace", { ignore: ["**/node_modules/**"], limit: 10 });
    expect(results).toEqual(["/workspace/src/a.ts", "/workspace/src/b.ts"]);
    expect(calls[0]?.argv).toEqual([
      "rg",
      "--files",
      "--hidden",
      "--glob",
      "*.ts",
      "--glob",
      "!**/node_modules/**",
    ]);
    expect(calls[0]?.opts.cwd).toBe("/workspace");
  });

  it("treats rg exit 1 as no matches and applies the limit", async () => {
    const empty = fakeContainer(() => ({ exitCode: 1 }));
    expect(await dockerFindOperations(empty.container).glob("*.rs", "/workspace", { ignore: [], limit: 5 })).toEqual([]);

    const many = fakeContainer(() => ({ exitCode: 0, stdout: "a\nb\nc\n" }));
    expect(await dockerFindOperations(many.container).glob("*", "/workspace", { ignore: [], limit: 2 })).toEqual([
      "/workspace/a",
      "/workspace/b",
    ]);
  });

  it("throws on a real rg failure", async () => {
    const { container } = fakeContainer(() => ({ exitCode: 127, stderr: "rg: not found" }));
    await expect(dockerFindOperations(container).glob("*", "/workspace", { ignore: [], limit: 5 })).rejects.toThrow(
      /find failed/,
    );
  });

  it("refuses a search root that escapes the workspace", async () => {
    const { container, calls } = fakeContainer(() => ({ exitCode: 0 }));
    const ops = dockerFindOperations(container);
    await expect(ops.glob("*", "/etc", { ignore: [], limit: 5 })).rejects.toThrow(/escapes the workspace/);
    await expect(ops.exists("/etc")).rejects.toThrow(/escapes the workspace/);
    expect(calls).toHaveLength(0);
  });
});

/** Grab the definition object out of a fake `pi.defineTool`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function grepToolWith(responder: Parameters<typeof fakeContainer>[0]): { def: any; calls: ExecCall[] } {
  const { container, calls } = fakeContainer(responder);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pi = { defineTool: (d: any) => d };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def: any = buildSandboxGrepTool(pi, container, GUEST_WORKSPACE);
  return { def, calls };
}

describe("buildSandboxGrepTool (§2b #2)", () => {
  it("runs ripgrep INSIDE the container against the guest workspace", async () => {
    const { def, calls } = grepToolWith(() => ({ exitCode: 0, stdout: "src/a.ts:3:const x = 1\n" }));
    const result = await def.execute("id", { pattern: "const" });
    expect(result.content[0].text).toContain("src/a.ts:3:const x = 1");
    expect(calls[0]?.argv.slice(0, 1)).toEqual(["rg"]);
    expect(calls[0]?.argv).toContain("/workspace");
    expect(calls[0]?.argv).toContain("const");
  });

  it("maps the optional flags onto rg args and resolves a relative search path", async () => {
    const { def, calls } = grepToolWith(() => ({ exitCode: 0, stdout: "" }));
    await def.execute("id", {
      pattern: "x",
      path: "src",
      glob: "*.ts",
      ignoreCase: true,
      literal: true,
      context: 2,
    });
    const argv = calls[0]!.argv;
    expect(argv).toContain("--ignore-case");
    expect(argv).toContain("--fixed-strings");
    expect(argv).toContain("--glob");
    expect(argv).toContain("*.ts");
    expect(argv).toContain("--context");
    expect(argv[argv.length - 1]).toBe("/workspace/src");
  });

  it("refuses an absolute or `../`-escaping search path (never spawns rg)", async () => {
    const abs = grepToolWith(() => ({ exitCode: 0, stdout: "secret" }));
    await expect(abs.def.execute("id", { pattern: "x", path: "/etc/passwd" })).rejects.toThrow(/escapes the workspace/);
    expect(abs.calls).toHaveLength(0);

    const trav = grepToolWith(() => ({ exitCode: 0, stdout: "secret" }));
    await expect(trav.def.execute("id", { pattern: "x", path: "../../etc" })).rejects.toThrow(/escapes the workspace/);
    expect(trav.calls).toHaveLength(0);
  });

  it("exit 1 means no matches; other failures throw", async () => {
    const none = grepToolWith(() => ({ exitCode: 1 }));
    const result = await none.def.execute("id", { pattern: "zzz" });
    expect(result.content[0].text).toBe("No matches found");

    const broken = grepToolWith(() => ({ exitCode: 127, stderr: "rg: not found" }));
    await expect(broken.def.execute("id", { pattern: "x" })).rejects.toThrow(/grep failed/);
  });

  it("truncates by match count, keeping context lines with their match", async () => {
    const lines = [
      "a.ts:1:match one",
      "a.ts-2- context line",
      "a.ts:3:match two",
      "a.ts:4:match three",
    ].join("\n");
    const { def } = grepToolWith(() => ({ exitCode: 0, stdout: lines }));
    const result = await def.execute("id", { pattern: "match", limit: 2 });
    const text: string = result.content[0].text;
    expect(text).toContain("match one");
    expect(text).toContain("context line");
    expect(text).toContain("match two");
    expect(text).not.toContain("match three");
    expect(text).toContain("[Truncated");
  });
});

describe("buildDockerSandboxTools", () => {
  it("builds bash/read/write/edit/grep/find/ls definitions rooted at the guest workspace", () => {
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
      createFindToolDefinition: mk("find"),
      createLsToolDefinition: mk("ls"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defineTool: (d: any) => d,
    };
    const { tools, names } = buildDockerSandboxTools(pi, container);
    expect(names).toEqual(["bash", "read", "write", "edit", "grep", "find", "ls"]);
    expect(tools).toHaveLength(7);
    // Factory-built tools (bash/read/write/edit/find/ls) all take docker-backed ops.
    expect(factoryCalls.map((c) => c.kind)).toEqual(["bash", "read", "write", "edit", "find", "ls"]);
    expect(factoryCalls.every((c) => c.cwd === GUEST_WORKSPACE && c.hasOps)).toBe(true);
  });
});
