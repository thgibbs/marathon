import type { Task } from "@marathon/core";
import type { RepoAccessResult } from "@marathon/worker";
import { describe, expect, it } from "vitest";
import { resolveChatAccessWiring } from "../src/chat-access";

const task = { sourceType: "slack", sourceRef: {} } as unknown as Task;

describe("resolveChatAccessWiring (chat-repo.md §3.1)", () => {
  it("trusted deployment → ok + internal_confirmed for everyone (skips the per-user check)", async () => {
    let identityCalled = false;
    const identityChecker = async (): Promise<RepoAccessResult> => {
      identityCalled = true;
      return "no_access";
    };
    const { checkAccess, audienceTrust } = resolveChatAccessWiring(true, identityChecker);
    expect(await checkAccess("t", "u", "o/r")).toBe("ok");
    expect(audienceTrust?.(task)).toBe("internal_confirmed"); // grounds private repos in channels too
    expect(identityCalled).toBe(false); // the identity checker is bypassed entirely
  });

  it("default → delegates to the identity checker, no audience override", async () => {
    const identityChecker = async (): Promise<RepoAccessResult> => "no_access";
    const { checkAccess, audienceTrust } = resolveChatAccessWiring(false, identityChecker);
    expect(await checkAccess("t", "u", "o/r")).toBe("no_access"); // the real per-user verdict
    expect(audienceTrust).toBeUndefined(); // provider's default DM→internal / channel→unknown gate
  });

  it("default with no identity checker (master secret unset) → fails closed to no_link", async () => {
    const { checkAccess, audienceTrust } = resolveChatAccessWiring(false, undefined);
    expect(await checkAccess("t", "u", "o/r")).toBe("no_link");
    expect(audienceTrust).toBeUndefined();
  });
});
