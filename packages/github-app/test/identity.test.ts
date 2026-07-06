import { decryptSecret, encryptSecret, mintLinkToken, type NewAuditEvent, type UserIdentity } from "@marathon/core";
import { describe, expect, it } from "vitest";
import {
  handleIdentityRequest,
  handleLinkCallback,
  handleLinkStart,
  makeUserRepoAccessChecker,
  type IdentityDb,
  type IdentityLinkDeps,
} from "../src/identity";

const SECRET = "master-secret";
const OAUTH = { clientId: "cid", clientSecret: "csec" };

function token(overrides: Partial<{ tenantId: string; slackUserId: string; nonce: string; expiresAt: number }> = {}): string {
  return mintLinkToken(
    { tenantId: "tn1", slackUserId: "U123", nonce: "n-1", expiresAt: Date.now() + 60_000, ...overrides },
    SECRET,
  );
}

function identityRow(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    id: "ident-1",
    userId: "u1",
    tenantId: "tn1",
    surfaceType: "github",
    externalId: "octocat",
    verifiedAt: new Date(),
    verificationMethod: "oauth",
    status: "active",
    credentialRef: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface FakeDbOptions {
  claimResult?: boolean;
  identityByUser?: UserIdentity | null;
}

function fakeDb(opts: FakeDbOptions = {}) {
  const linked: Array<Record<string, unknown>> = [];
  const audits: NewAuditEvent[] = [];
  const statusChanges: Array<[string, string]> = [];
  const db: IdentityDb = {
    claim: async () => opts.claimResult ?? true,
    findOrCreateUserByIdentity: async () => ({ id: "u1" }),
    findUserIdentityByUser: async () => opts.identityByUser ?? null,
    linkUserIdentity: async (input) => {
      linked.push(input);
      return identityRow({ externalId: input.externalId, credentialRef: input.credentialRef ?? null });
    },
    setUserIdentityStatus: async (id, status) => void statusChanges.push([id, status]),
    write: async (event) => void audits.push(event),
  };
  return { db, linked, audits, statusChanges };
}

/** GitHub stand-in: OAuth exchange + /user + /repos/<repo>. */
function fakeGithubFetch(opts: { repoStatus?: number } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "ghu_tok" }), { status: 200 });
    }
    if (url.endsWith("/user")) {
      return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
    }
    if (url.includes("/repos/")) {
      return new Response("{}", { status: opts.repoStatus ?? 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function makeDeps(dbOpts: FakeDbOptions = {}, ghOpts: { repoStatus?: number } = {}) {
  const { db, linked, audits, statusChanges } = fakeDb(dbOpts);
  const deps: IdentityLinkDeps = {
    db,
    masterSecret: SECRET,
    oauth: { ...OAUTH, fetchImpl: fakeGithubFetch(ghOpts) },
  };
  return { deps, linked, audits, statusChanges };
}

describe("handleLinkStart (§2b #10)", () => {
  it("redirects a valid token to GitHub user authorization, carrying it as state", () => {
    const { deps } = makeDeps();
    const t = token();
    const r = handleLinkStart(deps, new URL(`http://x/auth/github/start?token=${encodeURIComponent(t)}`));
    expect(r.status).toBe(302);
    expect(r.location).toContain("https://github.com/login/oauth/authorize");
    expect(r.location).toContain(`client_id=cid`);
    expect(decodeURIComponent(r.location!)).toContain(t.slice(0, 20));
  });

  it("rejects a missing/expired/forged token with a fresh-link hint", () => {
    const { deps } = makeDeps();
    expect(handleLinkStart(deps, new URL("http://x/auth/github/start")).status).toBe(400);
    const expired = token({ expiresAt: Date.now() - 1 });
    const r = handleLinkStart(deps, new URL(`http://x/auth/github/start?token=${encodeURIComponent(expired)}`));
    expect(r.status).toBe(400);
    expect(r.body).toContain("/marathon link github");
  });
});

describe("handleLinkCallback (§2b #10)", () => {
  const callbackUrl = (t: string) => new URL(`http://x/auth/github/callback?code=c1&state=${encodeURIComponent(t)}`);

  it("proves the GitHub login and writes the verified UserIdentity onto the Slack-proven user", async () => {
    const { deps, linked, audits } = makeDeps();
    const r = await handleLinkCallback(deps, callbackUrl(token()));
    expect(r.status).toBe(200);
    expect(r.body).toContain("@octocat");

    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      tenantId: "tn1",
      userId: "u1",
      surfaceType: "github",
      externalId: "octocat",
      verificationMethod: "oauth",
    });
    // The user-to-server token is stored ENCRYPTED, recoverable only with the master secret.
    const ref = String(linked[0]!.credentialRef);
    expect(ref).toMatch(/^enc:v1:/);
    expect(ref).not.toContain("ghu_tok");
    expect(decryptSecret(ref, SECRET)).toBe("ghu_tok");

    expect(audits).toHaveLength(1);
    expect(audits[0]!.eventType).toBe("identity.linked");
  });

  it("is single-use: a replayed callback burns on the nonce and writes nothing", async () => {
    const { deps, linked } = makeDeps({ claimResult: false });
    const r = await handleLinkCallback(deps, callbackUrl(token()));
    expect(r.status).toBe(409);
    expect(linked).toHaveLength(0);
  });

  it("rejects a bad state or missing code before any effect", async () => {
    const { deps, linked } = makeDeps();
    expect((await handleLinkCallback(deps, new URL("http://x/auth/github/callback?code=c1&state=garbage"))).status).toBe(400);
    expect((await handleLinkCallback(deps, new URL(`http://x/auth/github/callback?state=${encodeURIComponent(token())}`))).status).toBe(400);
    expect(linked).toHaveLength(0);
  });
});

describe("handleIdentityRequest routing", () => {
  it("serves only the two GET auth routes; everything else is null (falls through)", async () => {
    const { deps } = makeDeps();
    expect(await handleIdentityRequest(deps, "GET", new URL("http://x/other"))).toBeNull();
    expect(await handleIdentityRequest(deps, "POST", new URL("http://x/auth/github/start"))).toBeNull();
    const started = await handleIdentityRequest(deps, "GET", new URL(`http://x/auth/github/start?token=${encodeURIComponent(token())}`));
    expect(started?.status).toBe(302);
  });
});

describe("makeUserRepoAccessChecker (§7.20 — ask GitHub as the user)", () => {
  const cred = encryptSecret("ghu_tok", SECRET);
  // The checker now lives in connector-github and takes `{ db, masterSecret, api }`;
  // adapt the IdentityLinkDeps fixture (which carries the fake fetch on `oauth`).
  const accessDeps = (deps: IdentityLinkDeps) => ({
    db: deps.db,
    masterSecret: SECRET,
    api: { fetchImpl: deps.oauth.fetchImpl },
  });

  it("answers ok / no_access from the live check", async () => {
    const ok = makeDeps({ identityByUser: identityRow({ credentialRef: cred }) }, { repoStatus: 200 });
    expect(await makeUserRepoAccessChecker(accessDeps(ok.deps))("tn1", "u1", "o/r")).toBe("ok");

    const denied = makeDeps({ identityByUser: identityRow({ credentialRef: cred }) }, { repoStatus: 404 });
    expect(await makeUserRepoAccessChecker(accessDeps(denied.deps))("tn1", "u1", "o/r")).toBe("no_access");
  });

  it("marks the link stale (audited) on a dead token and denies", async () => {
    const { deps, statusChanges, audits } = makeDeps({ identityByUser: identityRow({ credentialRef: cred }) }, { repoStatus: 401 });
    expect(await makeUserRepoAccessChecker(accessDeps(deps))("tn1", "u1", "o/r")).toBe("stale");
    expect(statusChanges).toEqual([["ident-1", "stale"]]);
    expect(audits[0]!.eventType).toBe("identity.stale");
  });

  it("denies with no_link when the user has no verified link, stale when already stale", async () => {
    const none = makeDeps({ identityByUser: null });
    expect(await makeUserRepoAccessChecker(accessDeps(none.deps))("tn1", "u1", "o/r")).toBe("no_link");

    const stale = makeDeps({ identityByUser: identityRow({ status: "stale", credentialRef: "enc:v1:x:y:z" }) });
    expect(await makeUserRepoAccessChecker(accessDeps(stale.deps))("tn1", "u1", "o/r")).toBe("stale");
  });
});
