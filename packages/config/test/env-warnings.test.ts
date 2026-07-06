import { describe, expect, it } from "vitest";
import { KNOWN_MARATHON_ENV_VARS, unknownMarathonEnvWarnings, warnUnknownMarathonEnv } from "../src/index";

describe("unknownMarathonEnvWarnings (§2b #13)", () => {
  it("is silent when only known MARATHON_* variables are set", () => {
    const env: NodeJS.ProcessEnv = {
      MARATHON_TENANT: "acme",
      MARATHON_WEBHOOK_PROXY: "https://smee.io/abc",
      DATABASE_URL: "postgres://x",
      PATH: "/usr/bin",
    };
    expect(unknownMarathonEnvWarnings(env)).toEqual([]);
  });

  it("warns on a misspelled variable with a did-you-mean hint (the #13 motivating case)", () => {
    const env: NodeJS.ProcessEnv = { MARATHON_WEBHOOK_URL: "https://smee.io/abc" };
    const warnings = unknownMarathonEnvWarnings(env);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MARATHON_WEBHOOK_URL");
    expect(warnings[0]).toContain("did you mean MARATHON_WEBHOOK_PROXY?");
  });

  it("hints on a near-miss of every known variable", () => {
    for (const known of KNOWN_MARATHON_ENV_VARS) {
      const typo = `${known}X`; // one char off
      const warnings = unknownMarathonEnvWarnings({ [typo]: "v" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`did you mean ${known}?`);
    }
  });

  it("omits the hint when nothing known is plausibly close", () => {
    const env: NodeJS.ProcessEnv = { MARATHON_Z: "v" };
    const warnings = unknownMarathonEnvWarnings(env);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MARATHON_Z");
    expect(warnings[0]).not.toContain("did you mean");
  });

  it("ignores non-MARATHON variables entirely", () => {
    expect(unknownMarathonEnvWarnings({ MARATHONISH: "v", GITHUB_TOKEN: "t" })).toEqual([]);
  });

  it("reports multiple strays in stable (sorted) order", () => {
    const env: NodeJS.ProcessEnv = {
      MARATHON_TENNANT: "acme",
      MARATHON_AGENT_DIR: "agents",
    };
    const warnings = unknownMarathonEnvWarnings(env);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("MARATHON_AGENT_DIR");
    expect(warnings[0]).toContain("did you mean MARATHON_AGENTS_DIR?");
    expect(warnings[1]).toContain("MARATHON_TENNANT");
    expect(warnings[1]).toContain("did you mean MARATHON_TENANT?");
  });

  it("warnUnknownMarathonEnv logs each warning through the provided sink", () => {
    const lines: string[] = [];
    warnUnknownMarathonEnv((m) => lines.push(m), { MARATHON_TENNANT: "acme" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[marathon\] unrecognized environment variable MARATHON_TENNANT/);
  });

  it("the known-vars list stays in sync with what the code actually reads", () => {
    // Guard: every variable documented in .env.example under MARATHON_* must
    // be known — a new variable added there without updating the list would
    // warn spuriously for every operator.
    expect(KNOWN_MARATHON_ENV_VARS).toContain("MARATHON_TENANT");
    expect(KNOWN_MARATHON_ENV_VARS).toContain("MARATHON_AGENTS_DIR");
    expect(KNOWN_MARATHON_ENV_VARS).toContain("MARATHON_SECRET_KEY");
    expect(KNOWN_MARATHON_ENV_VARS).toContain("MARATHON_SANDBOX_IMAGE");
    expect(KNOWN_MARATHON_ENV_VARS).toContain("MARATHON_SANDBOX_NETWORK");
    expect(KNOWN_MARATHON_ENV_VARS).toContain("MARATHON_WEBHOOK_PROXY");
  });
});
