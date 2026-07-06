import { verifyLinkToken } from "@marathon/core";
import { describe, expect, it } from "vitest";
import { classifyEnvelope, handleSlashCommand, isDocDraftAsk, isStatusAsk, type AppDeps, type SlackSlashCommand } from "../src/handlers";

describe("classifyEnvelope", () => {
  it("classifies an app_mention", () => {
    const action = classifyEnvelope({
      type: "events_api",
      envelope_id: "e1",
      payload: { event_id: "Ev1", event: { type: "app_mention", user: "U1", channel: "C1", ts: "1.1", text: "<@U0> hi" } },
    });
    expect(action.kind).toBe("mention");
    if (action.kind === "mention") {
      expect(action.eventId).toBe("Ev1");
      expect(action.event.channel).toBe("C1");
    }
  });

  it("classifies a reaction_added", () => {
    const action = classifyEnvelope({
      type: "events_api",
      payload: { event: { type: "reaction_added", user: "U1", reaction: "+1" } },
    });
    expect(action.kind).toBe("reaction");
  });

  it("ignores non-events_api or unknown events", () => {
    expect(classifyEnvelope({ type: "interactive", payload: {} }).kind).toBe("ignore");
    expect(classifyEnvelope({ type: "events_api", payload: { event: { type: "message" } } }).kind).toBe("ignore");
    expect(classifyEnvelope({ type: "events_api", payload: {} }).kind).toBe("ignore");
  });

  it("classifies a slash_commands envelope (§2b #10)", () => {
    const action = classifyEnvelope({
      type: "slash_commands",
      envelope_id: "e1",
      payload: {
        command: "/marathon",
        text: "link github",
        user_id: "U42",
        team_id: "T1",
        channel_id: "C1",
        response_url: "https://hooks.slack/x",
      },
    });
    expect(action.kind).toBe("command");
    if (action.kind === "command") {
      expect(action.command.user_id).toBe("U42");
      expect(action.command.text).toBe("link github");
      expect(action.command.response_url).toBe("https://hooks.slack/x");
    }
  });

  it("ignores a malformed slash command (missing command/user)", () => {
    expect(classifyEnvelope({ type: "slash_commands", payload: { text: "link github" } }).kind).toBe("ignore");
  });

  it("classifies a plain human thread reply (Track 12)", () => {
    const reply = (event: Record<string, unknown>) =>
      classifyEnvelope({ type: "events_api", payload: { event_id: "Ev2", event } });
    const base = { type: "message", user: "U1", channel: "C1", ts: "1.2", thread_ts: "1.1", text: "staging" };

    const action = reply(base);
    expect(action.kind).toBe("reply");
    if (action.kind === "reply") expect(action.eventId).toBe("Ev2");

    // Not replies: bot posts, subtypes, thread openers, mentions, non-threaded.
    expect(reply({ ...base, bot_id: "B1" }).kind).toBe("ignore");
    expect(reply({ ...base, subtype: "message_changed" }).kind).toBe("ignore");
    expect(reply({ ...base, ts: "1.1" }).kind).toBe("ignore"); // opener
    expect(reply({ ...base, text: "<@U0BOT> do more" }).kind).toBe("ignore"); // arrives as app_mention
    expect(reply({ ...base, thread_ts: undefined }).kind).toBe("ignore");
    expect(reply({ ...base, text: "  " }).kind).toBe("ignore");
  });
});

describe("isStatusAsk (Track 16, §15.3)", () => {
  it("matches a bare status ask, case- and whitespace-insensitively", () => {
    expect(isStatusAsk("status")).toBe(true);
    expect(isStatusAsk("  Status ")).toBe(true);
    expect(isStatusAsk("STATUS")).toBe(true);
  });

  it("does not swallow real work that merely mentions status", () => {
    expect(isStatusAsk("what's the status of the rollout?")).toBe(false);
    expect(isStatusAsk("status page is down")).toBe(false);
    expect(isStatusAsk("")).toBe(false);
  });
});

describe("isDocDraftAsk (§2b #16 — the deterministic doc-task shape)", () => {
  it("matches a mention that STARTS with the draft verb", () => {
    expect(isDocDraftAsk("draft a plan for rate limiting")).toBe(true);
    expect(isDocDraftAsk("  Draft the rollout design ")).toBe(true);
    expect(isDocDraftAsk("DRAFT it")).toBe(true);
  });

  it("is a keyword prefix, not a content classifier", () => {
    expect(isDocDraftAsk("please draft a plan")).toBe(false); // not leading
    expect(isDocDraftAsk("drafting rules?")).toBe(false); // word boundary
    expect(isDocDraftAsk("write a design doc")).toBe(false); // no interpretation
    expect(isDocDraftAsk("")).toBe(false);
  });
});

describe("handleSlashCommand — /marathon link github (§2b #10)", () => {
  const SECRET = "master-secret";

  function makeDeps(overrides: Partial<AppDeps> = {}) {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const deps = {
      tenantId: "tn1",
      identityLink: { signingKey: SECRET, baseUrl: "https://marathon.example/" },
      fetchImpl,
      ...overrides,
    } as never as AppDeps;
    return { deps, posts };
  }

  const cmd = (overrides: Partial<SlackSlashCommand> = {}): SlackSlashCommand => ({
    command: "/marathon",
    text: "link github",
    user_id: "U42",
    response_url: "https://hooks.slack/x",
    ...overrides,
  });

  it("replies ephemerally with a single-use signed URL bound to the Slack user", async () => {
    const { deps, posts } = makeDeps();
    await handleSlashCommand(deps, cmd());

    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.response_type).toBe("ephemeral");
    const text = String(posts[0]!.body.text);
    const match = text.match(/token=([^\s]+)/);
    expect(match).toBeTruthy();
    const payload = verifyLinkToken(decodeURIComponent(match![1]!), SECRET);
    expect(payload).toMatchObject({ tenantId: "tn1", slackUserId: "U42" });
    expect(payload!.nonce).toBeTruthy();
    expect(payload!.expiresAt).toBeGreaterThan(Date.now());
    // No double slash from the trailing baseUrl slash.
    expect(text).toContain("https://marathon.example/auth/github/start?token=");
  });

  it("gives usage help for anything other than `link github`", async () => {
    const { deps, posts } = makeDeps();
    await handleSlashCommand(deps, cmd({ text: "help" }));
    expect(String(posts[0]!.body.text)).toContain("Usage:");
    expect(String(posts[0]!.body.text)).not.toContain("/auth/github/start");
  });

  it("reports when identity linking isn't configured", async () => {
    const { deps, posts } = makeDeps({ identityLink: undefined });
    await handleSlashCommand(deps, cmd());
    expect(String(posts[0]!.body.text)).toContain("isn't configured");
  });
});
