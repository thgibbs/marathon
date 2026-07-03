import { describe, expect, it } from "vitest";
import {
  capOutput,
  describeFamilies,
  ExecFileCommandRunner,
  FakeCommandRunner,
  flagValue,
  matchCommandFamily,
  type CommandFamily,
} from "../src/command-broker";

describe("matchCommandFamily", () => {
  const families: CommandFamily[] = [
    { prefix: ["pr", "view"], kind: "read" },
    { prefix: ["pr"], kind: "read" },
    { prefix: ["api"], kind: "read" },
  ];

  it("matches an exact prefix", () => {
    expect(matchCommandFamily(["api", "repos/a/b"], families)?.prefix).toEqual(["api"]);
  });

  it("prefers the longest matching prefix", () => {
    expect(matchCommandFamily(["pr", "view", "1"], families)?.prefix).toEqual(["pr", "view"]);
    expect(matchCommandFamily(["pr", "diff", "1"], families)?.prefix).toEqual(["pr"]);
  });

  it("returns null when nothing matches", () => {
    expect(matchCommandFamily(["repo", "delete"], families)).toBeNull();
    expect(matchCommandFamily([], families)).toBeNull();
  });

  it("requires the full prefix, not a partial one", () => {
    expect(matchCommandFamily(["pr"], [{ prefix: ["pr", "view"], kind: "read" }])).toBeNull();
  });
});

describe("flagValue", () => {
  it("reads --flag value, --flag=value, and short aliases", () => {
    expect(flagValue(["pr", "view", "--repo", "a/b"], "--repo", "-R")).toBe("a/b");
    expect(flagValue(["pr", "view", "--repo=a/b"], "--repo", "-R")).toBe("a/b");
    expect(flagValue(["pr", "view", "-R", "a/b"], "--repo", "-R")).toBe("a/b");
  });

  it("returns null when absent or valueless", () => {
    expect(flagValue(["pr", "view"], "--repo", "-R")).toBeNull();
    expect(flagValue(["pr", "view", "--repo"], "--repo")).toBeNull();
  });
});

describe("describeFamilies / capOutput", () => {
  it("renders a readable allowlist", () => {
    expect(
      describeFamilies([
        { prefix: ["pr", "view"], kind: "read" },
        { prefix: ["api"], kind: "read" },
      ]),
    ).toBe("pr view, api");
  });

  it("caps long output and marks the truncation", () => {
    expect(capOutput("short", 100)).toBe("short");
    const capped = capOutput("x".repeat(200), 100);
    expect(capped).toContain("… (output truncated)");
    expect(capped.startsWith("x".repeat(100))).toBe(true);
  });
});

describe("FakeCommandRunner", () => {
  it("records calls and replays scripted results", async () => {
    const runner = new FakeCommandRunner((bin, argv) => ({
      exitCode: argv.includes("fail") ? 1 : 0,
      stdout: `${bin} ok`,
      stderr: "",
    }));
    const ok = await runner.run("gh", ["pr", "view"], { env: { GH_TOKEN: "t" } });
    const bad = await runner.run("gh", ["fail"]);
    expect(ok).toEqual({ exitCode: 0, stdout: "gh ok", stderr: "" });
    expect(bad.exitCode).toBe(1);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.opts.env).toEqual({ GH_TOKEN: "t" });
  });
});

describe("ExecFileCommandRunner", () => {
  const runner = new ExecFileCommandRunner();

  it("returns stdout and exit code 0 on success", async () => {
    const res = await runner.run("sh", ["-c", "echo hello"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello");
  });

  it("resolves (not rejects) with a non-zero exit code", async () => {
    const res = await runner.run("sh", ["-c", "echo oops >&2; exit 3"]);
    expect(res.exitCode).toBe(3);
    expect(res.stderr.trim()).toBe("oops");
  });

  it("injects the provided env into the child", async () => {
    const res = await runner.run("sh", ["-c", "echo $BROKER_TEST_TOKEN"], { env: { BROKER_TEST_TOKEN: "tok-123" } });
    expect(res.stdout.trim()).toBe("tok-123");
  });

  it("does NOT inherit unrelated host env — only the base keys + injected entries", async () => {
    process.env.BROKER_TEST_UNRELATED_SECRET = "xoxb-leaky";
    try {
      const res = await runner.run("sh", ["-c", 'echo "[${BROKER_TEST_UNRELATED_SECRET}]"; env'], {
        env: { GH_TOKEN: "tok" },
      });
      expect(res.stdout).toContain("[]"); // the host secret is absent
      expect(res.stdout).not.toContain("xoxb-leaky");
      expect(res.stdout).toContain("GH_TOKEN=tok"); // injected credential is present
      expect(res.stdout).toContain("PATH="); // base keys survive
    } finally {
      delete process.env.BROKER_TEST_UNRELATED_SECRET;
    }
  });

  it("rejects on spawn failure and on timeout", async () => {
    await expect(runner.run("definitely-not-a-binary-xyz", [])).rejects.toThrow();
    await expect(runner.run("sleep", ["5"], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
});
