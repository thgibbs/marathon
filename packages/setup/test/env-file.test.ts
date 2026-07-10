import { describe, expect, it } from "vitest";
import { upsertEnvValues } from "../src/env-file.js";

describe("upsertEnvValues", () => {
  it("fills empty template values in place", () => {
    const input = "# comment\nGITHUB_APP_ID=\nGITHUB_WEBHOOK_SECRET=\n";
    const out = upsertEnvValues(input, { GITHUB_APP_ID: "42" });
    expect(out).toBe("# comment\nGITHUB_APP_ID=42\nGITHUB_WEBHOOK_SECRET=\n");
  });

  it("replaces already-set values", () => {
    const out = upsertEnvValues("GITHUB_APP_ID=old\n", { GITHUB_APP_ID: "new" });
    expect(out).toBe("GITHUB_APP_ID=new\n");
  });

  it("matches whole keys only — GITHUB_APP_PRIVATE_KEY must not swallow _PATH", () => {
    const input = "GITHUB_APP_PRIVATE_KEY_PATH=\nGITHUB_APP_PRIVATE_KEY=\n";
    const out = upsertEnvValues(input, { GITHUB_APP_PRIVATE_KEY: "pem" });
    expect(out).toBe("GITHUB_APP_PRIVATE_KEY_PATH=\nGITHUB_APP_PRIVATE_KEY=pem\n");
  });

  it("appends keys missing from the file", () => {
    const out = upsertEnvValues("A=1\n", { MARATHON_WEBHOOK_PROXY: "https://smee.io/x" });
    expect(out).toBe("A=1\nMARATHON_WEBHOOK_PROXY=https://smee.io/x\n");
  });

  it("appends with a separating newline when the content lacks one", () => {
    const out = upsertEnvValues("A=1", { B: "2" });
    expect(out).toBe("A=1\nB=2\n");
  });

  it("leaves comments and unrelated lines byte-for-byte untouched", () => {
    const input = "# keep me\n\nOTHER=x\nTARGET=\n# trailing\n";
    const out = upsertEnvValues(input, { TARGET: "v" });
    expect(out).toBe("# keep me\n\nOTHER=x\nTARGET=v\n# trailing\n");
  });

  it("replaces only the first matching line", () => {
    const out = upsertEnvValues("K=\nK=\n", { K: "v" });
    expect(out).toBe("K=v\nK=\n");
  });
});
