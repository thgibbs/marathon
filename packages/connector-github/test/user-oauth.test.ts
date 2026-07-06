import { describe, expect, it } from "vitest";
import {
  checkRepoAsUser,
  exchangeOAuthCode,
  fetchGithubLogin,
  githubAuthorizeUrl,
} from "../src/user-oauth";

const CFG = { clientId: "cid", clientSecret: "csec" };

function fetchReturning(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

describe("githubAuthorizeUrl (§2b #10)", () => {
  it("builds the authorize URL with the client id and state, honoring an enterprise base", () => {
    expect(githubAuthorizeUrl(CFG, "STATE")).toBe(
      "https://github.com/login/oauth/authorize?client_id=cid&state=STATE",
    );
    expect(githubAuthorizeUrl({ ...CFG, webBaseUrl: "https://ghe.acme" }, "S")).toContain("https://ghe.acme/login/oauth/authorize");
  });
});

describe("exchangeOAuthCode (§2b #10)", () => {
  it("returns the access token on success", async () => {
    const fetchImpl = fetchReturning(() => new Response(JSON.stringify({ access_token: "ghu_x" }), { status: 200 }));
    expect(await exchangeOAuthCode({ ...CFG, fetchImpl }, "code")).toEqual({ accessToken: "ghu_x" });
  });

  it("throws on a non-2xx exchange and on a token-less body", async () => {
    const http500 = fetchReturning(() => new Response("boom", { status: 500 }));
    await expect(exchangeOAuthCode({ ...CFG, fetchImpl: http500 }, "c")).rejects.toThrow(/exchange failed \(500\)/);

    const denied = fetchReturning(() => new Response(JSON.stringify({ error: "bad_verification_code", error_description: "expired" }), { status: 200 }));
    await expect(exchangeOAuthCode({ ...CFG, fetchImpl: denied }, "c")).rejects.toThrow(/expired/);
  });
});

describe("fetchGithubLogin (§2b #10)", () => {
  it("returns the authenticated login", async () => {
    const fetchImpl = fetchReturning(() => new Response(JSON.stringify({ login: "octocat" }), { status: 200 }));
    expect(await fetchGithubLogin({ fetchImpl }, "tok")).toBe("octocat");
  });

  it("throws on a failed /user call and a login-less body", async () => {
    const http401 = fetchReturning(() => new Response("nope", { status: 401 }));
    await expect(fetchGithubLogin({ fetchImpl: http401 }, "tok")).rejects.toThrow(/\/user failed \(401\)/);

    const empty = fetchReturning(() => new Response("{}", { status: 200 }));
    await expect(fetchGithubLogin({ fetchImpl: empty }, "tok")).rejects.toThrow(/no login/);
  });
});

describe("checkRepoAsUser (§7.20 — ask GitHub as the user)", () => {
  it("maps status codes to access outcomes", async () => {
    const ok = fetchReturning(() => new Response("{}", { status: 200 }));
    expect(await checkRepoAsUser({ fetchImpl: ok }, "tok", "o/r")).toBe("ok");

    const unauthorized = fetchReturning(() => new Response("bad creds", { status: 401 }));
    expect(await checkRepoAsUser({ fetchImpl: unauthorized }, "tok", "o/r")).toBe("bad_token");

    // GitHub hides private repos the user can't see as 404 (and 403 for rate/forbidden).
    for (const status of [403, 404]) {
      const denied = fetchReturning(() => new Response("nope", { status }));
      expect(await checkRepoAsUser({ fetchImpl: denied }, "tok", "o/r")).toBe("no_access");
    }
  });

  it("sends the user token and targets the repo endpoint", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = fetchReturning((url, init) => {
      seenUrl = url;
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization);
      return new Response("{}", { status: 200 });
    });
    await checkRepoAsUser({ fetchImpl }, "tok-123", "acme/widgets");
    expect(seenUrl).toBe("https://api.github.com/repos/acme/widgets");
    expect(seenAuth).toBe("Bearer tok-123");
  });
});
