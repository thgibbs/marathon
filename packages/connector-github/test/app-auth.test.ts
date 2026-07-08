import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppJwt,
  githubAuthFromEnv,
  InstallationTokenProvider,
  normalizePrivateKey,
  resolveAppPrivateKey,
  withInstallationToken,
} from "../src/app-auth";
import { HttpGithubClient } from "../src/client";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("createAppJwt (§2b #15)", () => {
  it("mints an RS256 JWT with backdated iat and a 9-minute expiry", () => {
    const now = 1_700_000_000;
    const jwt = createAppJwt("12345", PRIVATE_PEM, now);
    const [h, p, s] = jwt.split(".");
    expect(decodeSegment(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(p!)).toEqual({ iat: now - 60, exp: now + 540, iss: "12345" });
    const ok = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      publicKey,
      Buffer.from(s!, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("normalizes env-mangled PEM keys (literal \\n escapes)", () => {
    const mangled = PRIVATE_PEM.replace(/\n/g, "\\n");
    expect(normalizePrivateKey(mangled)).toBe(PRIVATE_PEM);
    expect(normalizePrivateKey(PRIVATE_PEM)).toBe(PRIVATE_PEM);
    // The signer accepts the mangled form via normalization inside createAppJwt.
    expect(() => createAppJwt("1", mangled)).not.toThrow();
  });
});

interface FakeCall {
  url: string;
  method: string;
  auth: string;
}

function fakeGithub(opts: { orgInstall?: boolean; tokens?: string[]; expiresInMs?: number; now?: () => number }) {
  const calls: FakeCall[] = [];
  const tokens = opts.tokens ?? ["tok-1", "tok-2", "tok-3"];
  let minted = 0;
  const now = opts.now ?? Date.now;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
    });
    if (url.includes("/orgs/")) {
      return opts.orgInstall === false
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify({ id: 777 }), { status: 200 });
    }
    if (url.includes("/users/")) return new Response(JSON.stringify({ id: 888 }), { status: 200 });
    if (url.includes("/access_tokens")) {
      const token = tokens[minted++] ?? "tok-overflow";
      const expires = new Date(now() + (opts.expiresInMs ?? 60 * 60 * 1000)).toISOString();
      return new Response(JSON.stringify({ token, expires_at: expires }), { status: 201 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls, mintedCount: () => minted };
}

describe("InstallationTokenProvider (§2b #15)", () => {
  it("resolves the org installation, mints once, and serves from cache", async () => {
    const gh = fakeGithub({});
    const provider = new InstallationTokenProvider({
      appId: "1",
      privateKey: PRIVATE_PEM,
      owner: "acme",
      fetchImpl: gh.fetchImpl,
    });
    expect(await provider.getToken()).toBe("tok-1");
    expect(await provider.getToken()).toBe("tok-1");
    expect(gh.mintedCount()).toBe(1);
    expect(gh.calls[0]!.url).toContain("/orgs/acme/installation");
    expect(gh.calls[1]!.url).toContain("/app/installations/777/access_tokens");
    // The mint path authenticates with the App JWT, not any token.
    expect(gh.calls[1]!.auth).toMatch(/^Bearer eyJ/);
  });

  it("falls back to the user installation when the owner is not an org", async () => {
    const gh = fakeGithub({ orgInstall: false });
    const provider = new InstallationTokenProvider({
      appId: "1",
      privateKey: PRIVATE_PEM,
      owner: "tanton",
      fetchImpl: gh.fetchImpl,
    });
    await provider.getToken();
    expect(gh.calls.some((c) => c.url.includes("/users/tanton/installation"))).toBe(true);
    expect(gh.calls.at(-1)!.url).toContain("/app/installations/888/access_tokens");
  });

  it("re-mints when the cached token nears expiry", async () => {
    let clock = 1_700_000_000_000;
    const gh = fakeGithub({ expiresInMs: 60 * 60 * 1000, now: () => clock });
    const provider = new InstallationTokenProvider({
      appId: "1",
      privateKey: PRIVATE_PEM,
      owner: "acme",
      fetchImpl: gh.fetchImpl,
      now: () => clock,
    });
    expect(await provider.getToken()).toBe("tok-1");
    clock += 56 * 60 * 1000; // inside the 5-minute refresh margin
    expect(await provider.getToken()).toBe("tok-2");
    expect(gh.mintedCount()).toBe(2);
  });

  it("forceRefresh discards the cache (the 401-retry path)", async () => {
    const gh = fakeGithub({});
    const provider = new InstallationTokenProvider({
      appId: "1",
      privateKey: PRIVATE_PEM,
      owner: "acme",
      fetchImpl: gh.fetchImpl,
    });
    expect(await provider.getToken()).toBe("tok-1");
    expect(await provider.getToken(true)).toBe("tok-2");
  });

  it("single-flights concurrent mints", async () => {
    const gh = fakeGithub({});
    const provider = new InstallationTokenProvider({
      appId: "1",
      privateKey: PRIVATE_PEM,
      owner: "acme",
      fetchImpl: gh.fetchImpl,
    });
    const [a, b] = await Promise.all([provider.getToken(), provider.getToken()]);
    expect(a).toBe("tok-1");
    expect(b).toBe("tok-1");
    expect(gh.mintedCount()).toBe(1);
  });

  it("reports a missing installation clearly", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const provider = new InstallationTokenProvider({
      appId: "1",
      privateKey: PRIVATE_PEM,
      owner: "ghost",
      fetchImpl,
    });
    await expect(provider.getToken()).rejects.toThrow(/not installed on 'ghost'/);
  });
});

describe("withInstallationToken (§2b #15 — the secret-store seam)", () => {
  it("serves secret/github from the token source and delegates everything else", async () => {
    const inner = { get: async (ref: string) => (ref === "secret/openai" ? "sk-x" : undefined) };
    const store = withInstallationToken(inner, { getToken: async () => "app-tok" });
    expect(await store.get("secret/github")).toBe("app-tok");
    expect(await store.get("secret/openai")).toBe("sk-x");
  });
});

describe("resolveAppPrivateKey (key source: inline or .pem path)", () => {
  it("reads inline GITHUB_APP_PRIVATE_KEY (trimmed)", () => {
    expect(resolveAppPrivateKey({ GITHUB_APP_PRIVATE_KEY: PRIVATE_PEM } as NodeJS.ProcessEnv)).toBe(PRIVATE_PEM.trim());
  });

  it("reads GITHUB_APP_PRIVATE_KEY_PATH and lets it win over inline", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-key-"));
    const file = join(dir, "app.pem");
    writeFileSync(file, `${PRIVATE_PEM}\n`);
    const key = resolveAppPrivateKey({
      GITHUB_APP_PRIVATE_KEY_PATH: file,
      GITHUB_APP_PRIVATE_KEY: "SHA256:ignored-because-path-wins",
    } as NodeJS.ProcessEnv);
    expect(key).toBe(PRIVATE_PEM.trim());
  });

  it("returns undefined when neither is set", () => {
    expect(resolveAppPrivateKey({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("rejects the SHA256 fingerprint with a clear message (the common mistake)", () => {
    expect(() =>
      resolveAppPrivateKey({ GITHUB_APP_PRIVATE_KEY: "SHA256:z8wH5zg/SVvBJ1Gd/WGoZCCkoDYisoqwkVN6zQ" } as NodeJS.ProcessEnv),
    ).toThrow(/not a PEM private key.*fingerprint/s);
  });

  it("reports an unreadable key path clearly", () => {
    expect(() =>
      resolveAppPrivateKey({ GITHUB_APP_PRIVATE_KEY_PATH: "/no/such/key.pem" } as NodeJS.ProcessEnv),
    ).toThrow(/cannot read '\/no\/such\/key\.pem'/);
  });
});

describe("githubAuthFromEnv (§2b #15)", () => {
  it("selects App auth when both App vars are set, PAT mode otherwise", () => {
    const inner = { get: async () => undefined };
    const app = githubAuthFromEnv(inner, "acme", {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: PRIVATE_PEM,
    } as NodeJS.ProcessEnv);
    expect(app.mode).toBe("app");
    expect(app.tokenSource).toBeDefined();

    const pat = githubAuthFromEnv(inner, "acme", { GITHUB_TOKEN: "ghp_x" } as NodeJS.ProcessEnv);
    expect(pat.mode).toBe("token");
    expect(pat.tokenSource).toBeUndefined();
    expect(pat.secrets).toBe(inner);
  });

  it("selects App auth from a .pem path too", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-key-"));
    const file = join(dir, "app.pem");
    writeFileSync(file, PRIVATE_PEM);
    const app = githubAuthFromEnv({ get: async () => undefined }, "acme", {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY_PATH: file,
    } as NodeJS.ProcessEnv);
    expect(app.mode).toBe("app");
    expect(app.tokenSource).toBeDefined();
  });

  it("fails loud when an App ID is set with a bogus (fingerprint) key", () => {
    expect(() =>
      githubAuthFromEnv({ get: async () => undefined }, "acme", {
        GITHUB_APP_ID: "1",
        GITHUB_APP_PRIVATE_KEY: "SHA256:z8wH5zg/SVvBJ1Gd/WGoZCCkoDYisoqwkVN6zQ",
      } as NodeJS.ProcessEnv),
    ).toThrow(/not a PEM private key/);
  });
});

describe("HttpGithubClient with a token source (§2b #15)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves the token per request and force-refreshes + retries ONCE on 401", async () => {
    const seenAuth: string[] = [];
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      (async (_url: string | URL | Request, init?: RequestInit) => {
        requests++;
        seenAuth.push(String((init?.headers as Record<string, string>)?.Authorization));
        if (requests === 1) return new Response("bad credentials", { status: 401 });
        return new Response(JSON.stringify({ id: 1, number: 5, html_url: "u" }), { status: 200 });
      }) as typeof fetch,
    );
    const forced: boolean[] = [];
    const client = new HttpGithubClient({
      getToken: async (force = false) => {
        forced.push(force);
        return force ? "tok-fresh" : "tok-stale";
      },
    });
    await client.createIssue("o/r", "t");
    expect(seenAuth).toEqual(["Bearer tok-stale", "Bearer tok-fresh"]);
    expect(forced).toEqual([false, true]);
  });

  it("a static-token client does NOT retry on 401", async () => {
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      (async () => {
        requests++;
        return new Response("bad credentials", { status: 401 });
      }) as typeof fetch,
    );
    const client = new HttpGithubClient("ghp_static");
    await expect(client.createIssue("o/r", "t")).rejects.toThrow(/github 401/);
    expect(requests).toBe(1);
  });
});
