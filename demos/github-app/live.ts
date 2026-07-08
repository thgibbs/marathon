/**
 * Run the LIVE Marathon GitHub document app — a webhook receiver (node:http).
 *
 * Needs: GITHUB_TOKEN (Contents+PR write), GITHUB_WEBHOOK_SECRET, a model key
 * (OPENAI_API_KEY), Postgres at DATABASE_URL, and inbound events one of two
 * ways (configure the GitHub App/webhook to send issue_comment,
 * pull_request_review_comment, pull_request_review, pull_request):
 *   - dev (§2b #12): MARATHON_WEBHOOK_PROXY=https://smee.io/<channel> — the
 *     app SUBSCRIBES outbound to the channel (no tunnel); point the App's
 *     webhook URL at the same channel once.
 *   - production shape: a public URL/tunnel to this server's /webhooks/github.
 *
 *   make github-app
 *   then comment "@marathon draft …" on a PR/issue in the repo (the default
 *   agent comes from the agents dir — agents/forge.yaml).
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertSubscriptionAckIfNeeded, makeAgentRuntime, resolveSandboxNetwork, withChatWorkspace, workspaceSandboxFromSpec } from "@marathon/agent";
import { agentSubscribesTo, EnvSecretStore, loadAgentSpecs, loadConfig, looseningAuditEvent, renderPostureBanner, renderSandboxResidualNote, resolveEffectiveBudget, resolvePosture, warnUnknownMarathonEnv } from "@marathon/config";
import { ensureBranch, githubAuthFromEnv, GithubDelivery, governedToolDefsFor, HttpGithubClient, httpGithubClientFactory, makeDocumentTools, makeGithubReadTools } from "@marathon/connector-github";
import { WebhookProxyClient } from "@marathon/surface-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { bootstrapGithubApp, handleIdentityRequest, handleWebhookRequest, makeBuildWiring, type GithubAppDeps, type IdentityLinkDeps } from "@marathon/github-app";
import { OpenAIEmbedder, PgVectorMemoryStore } from "@marathon/memory";
import { DEFAULT_MODEL_POLICY } from "@marathon/model-gateway";
import { Queue } from "@marathon/queue";
import { DeliveryFanout } from "@marathon/surface";
import { InMemorySourceLedger, installSandboxShutdownHandler, reapSandboxContainers, ToolGateway, toolPolicyFromSpec, ToolRegistry } from "@marathon/tools";
import { BUILD_JOB_KIND, InvocationRouter, makeDocumentPrRecorder, Orchestrator, Worker } from "@marathon/worker";

async function main(): Promise<void> {
  // §2b #13: a misspelled MARATHON_* variable fails silently otherwise.
  warnUnknownMarathonEnv();
  const cfg = loadConfig();
  // §30.5 startup posture banner: state the effective trust posture at boot.
  const posture = resolvePosture();
  for (const line of renderPostureBanner(posture)) console.log(`[github-app] ${line}`);
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  const owner = process.env.GITHUB_OWNER?.trim();
  const port = Number(process.env.PORT ?? 8787);
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is required");
  if (!owner) throw new Error("GITHUB_OWNER is required (repo owner for the tenant)");

  await migrate(cfg.databaseUrl);
  // Owner tag for this deployment: the reaper only touches containers stamped
  // with it, so booting here never kills a concurrent slack-app's live sandbox.
  const sandboxOwner = process.env.MARATHON_SANDBOX_OWNER?.trim() || "marathon-github-app";
  // Graceful shutdown: on Ctrl-C/SIGTERM, tear down this process's sandbox
  // containers before exiting (the primary anti-leak). The boot reaper below is
  // the backstop for SIGKILL/crashes, where no handler runs.
  installSandboxShutdownHandler((n, sig) => {
    if (n) console.log(`[github-app] stopped ${n} sandbox container(s) on ${sig}`);
  });
  // Reap OUR OWN orphans from a previous run that couldn't clean up
  // (SIGKILL/crash). Owner-scoped so a peer process is untouched. Safe at boot:
  // task containers are made on demand during processing, never here.
  const reaped = await reapSandboxContainers({ owner: sandboxOwner });
  if (reaped.length) console.log(`[github-app] reaped ${reaped.length} orphaned sandbox container(s)`);
  const db = new Database(cfg.databaseUrl);
  const queue = new Queue(cfg.databaseUrl);
  // GitHub auth (§2b #15): App installation tokens when GITHUB_APP_ID +
  // GITHUB_APP_PRIVATE_KEY are set (posts author as <app-slug>[bot]); PAT
  // fallback otherwise. The decorated store makes every `secret/github`
  // consumer — client factory, brokered gh/git, clone source — App-authored.
  const auth = githubAuthFromEnv(new EnvSecretStore(), owner);
  const secrets = auth.secrets;
  console.log(`[github-app] github auth mode: ${auth.mode === "app" ? "App installation token (posts as the app bot)" : "personal access token (set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY to post as the app)"}`);
  if (auth.mode === "token" && !(await secrets.get("secret/github"))) {
    throw new Error("GITHUB_TOKEN (or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) is required");
  }

  // Configured agents (Track 14): YAML specs; the first file is the default.
  // Its grants (with the ONE configured repo as every grant's allowlist)
  // become the gateway policy below — editing the YAML narrows the surface.
  const specs = await loadAgentSpecs(cfg.agentsDir);
  const flagship = specs[0]!;
  // Floor #7 (§30.3): the effective per-task cap — the agent's own `budget:` or,
  // when omitted, the trust profile's default (never unlimited). Applies to the
  // doc/chat runtime here AND is recomputed inside makeBuildWiring for BUILD.
  const effectiveBudget = resolveEffectiveBudget(flagship.budget, posture);
  // §30.3 fail-loud: state the one solo residual (bridge repo-text egress) at boot.
  for (const line of renderSandboxResidualNote(resolveSandboxNetwork(flagship.sandbox))) console.log(`[github-app] ${line}`);
  // Fail closed BEFORE building any runtime (same guard as makeBuildWiring and
  // the Slack app): locked-down claude-code needs an internal Docker network
  // whose sole reachable endpoint is the model proxy. `network: none` severs
  // the proxy too, so the model call cannot exit — the doc/chat runtime built
  // below would spin up a `--network none` container and hang at runtime even
  // though the config validated. Refuse until the internal-proxy spike lands (§7.1).
  if (flagship.harness === "claude-code" && flagship.sandbox.network === "none") {
    throw new Error(
      `agent '${flagship.name}': locked-down claude-code (sandbox.network: none) needs the internal-network model-proxy wiring (K7 spike, §7.1) — not yet available; use 'bridge'`,
    );
  }
  // State the effective Claude Code model-auth mode at startup (§4.1).
  if (flagship.harness === "claude-code") {
    assertSubscriptionAckIfNeeded(process.env.MARATHON_MODEL_PROXY_URL?.trim(), await secrets.get("secret/claude-code-oauth-token"));
    const mode = process.env.MARATHON_MODEL_PROXY_URL?.trim()
      ? "proxy (MARATHON_MODEL_PROXY_URL)"
      : (await secrets.get("secret/claude-code-oauth-token"))
        ? "subscription (CLAUDE_CODE_OAUTH_TOKEN — no per-token billing)"
        : (await secrets.get("secret/anthropic"))
          ? "api key (ANTHROPIC_API_KEY — per-token billing)"
          : "MISCONFIGURED — no model credential (set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)";
    console.log(`[github-app] claude-code model auth: ${mode}`);
  }
  const boot = await bootstrapGithubApp(db, { owner, tenantName: cfg.tenant, specs });
  // §30.5: persist an audit event for each acknowledged loosening so it survives
  // log rotation (the banner is transient; the acknowledgment is a security fact).
  for (const d of posture.loosenings) await db.write(looseningAuditEvent(boot.tenantId, posture.profile, d));
  // Dynamic auth keeps this long-running client valid across the ~1h
  // installation-token expiry (it refreshes per request + retries on 401).
  const client = new HttpGithubClient(auth.tokenSource ?? (await secrets.get("secret/github"))!);
  const orchestrator = new Orchestrator(db, queue);
  const delivery = new GithubDelivery(client);
  const fanout = new DeliveryFanout({ github: delivery }, db);
  // §29.1a: plan docs merge into the plans branch, never the default branch.
  // Create it when missing; operators should branch-protect it like main
  // (docs/quickstart.md §3) — it is an approval boundary.
  const plansBranch = flagship.plans.branch;
  if (flagship.repo) await ensureBranch(client, flagship.repo, plansBranch, "main");
  // Doc writes are tool calls, not committed chat text (§2b #16): the agent's
  // session gets the governed document tools (spec grants ∩ catalog), and the
  // doc body flows through this gateway as a schema-validated tool argument.
  // Wiring here is load-bearing for the handlers' post-turn checks:
  //  - dbToolRecorder persists ToolInvocations (the "did a doc write happen"
  //    evidence — without it every run reports a no-op);
  //  - makeDocumentPrRecorder persists the DocumentArtifact + doc-PR delivery
  //    target the merge webhook needs to recognize the plan.
  const toolGateway = new ToolGateway({
    // The configured plans branch is the AUTHORITATIVE doc-PR base (§29.1a).
    registry: new ToolRegistry([
      ...makeGithubReadTools(httpGithubClientFactory()),
      ...makeDocumentTools(httpGithubClientFactory(), {
        docBase: plansBranch,
        onDocumentPr: makeDocumentPrRecorder(db),
      }),
    ]),
    policy: toolPolicyFromSpec(flagship),
    secrets,
    recorder: dbToolRecorder(db),
    sourceLedger: new InMemorySourceLedger(),
    // §7.8 / §30.4: the doc/read gateway reads the profile's internal egress mode.
    internalEgressMode: posture.internalEgressMode,
  });
  const deps: GithubAppDeps = {
    db,
    client,
    memory: new PgVectorMemoryStore(cfg.databaseUrl, new OpenAIEmbedder(secrets)),
    router: new InvocationRouter(db, orchestrator),
    orchestrator,
    delivery,
    fanout,
    // Harness from the spec (§2b #17): the mention/doc flows run EITHER
    // harness through the shared factory. Claude Code needs a container +
    // workspace even for chat-shaped tasks — withChatWorkspace binds an
    // ephemeral scratch dir per task; Pi keeps running containerless.
    runtime: withChatWorkspace(
      makeAgentRuntime(flagship, {
        secrets,
        // Durable per-task sessions (K4) — same location the BUILD side uses.
        sessionDir: join(tmpdir(), "marathon-sessions"),
        governed: { gateway: toolGateway, tools: governedToolDefsFor(flagship.tools.map((t) => t.tool)) },
        sandbox: flagship.harness === "claude-code" ? workspaceSandboxFromSpec(flagship, { owner: sandboxOwner }) : undefined,
        proxy:
          flagship.harness === "claude-code"
            ? (process.env.MARATHON_MODEL_PROXY_URL?.trim() ? { baseUrl: process.env.MARATHON_MODEL_PROXY_URL.trim() } : undefined)
            : undefined,
        lockedDownEgress: flagship.sandbox.network === "none",
        cli: { settingsPath: "/etc/marathon/claude-settings.json" },
        // TCP broker for macOS Docker Desktop (§3.1): set MARATHON_BROKER_HOST=host.docker.internal.
        brokerHost: process.env.MARATHON_BROKER_HOST?.trim() || undefined,
        // Floor #7 (§30.3): an omitted `budget:` means the profile default cap,
        // never unlimited — so draft/design-review doc tasks are always capped.
        getRemainingBudgetUsd: async (ctx) => effectiveBudget.limitUsd - (await db.sumModelCostUsd(ctx.request.taskId)),
      }),
      { root: join(tmpdir(), "marathon-chat-workspaces") },
    ),
    tenantId: boot.tenantId,
    agents: boot.agents,
    agentIdByName: boot.agentIdByName,
    defaultAgent: boot.defaultAgent,
    // Model policy from the spec (codex-impl.md §A.3/§A.4): draft/design-review
    // resolve their own role at the call site — no hardcoded flat default.
    models: flagship.models ?? DEFAULT_MODEL_POLICY,
    on: flagship.on,
    plansBranch,
    defaultBranch: "main",
  };

  // The BUILD side of the loop (Track 15): a worker that consumes the
  // merge-spawned implementation/revision tasks with the coherent BUILD
  // runtime — sandboxed tools (network from the YAML), brokered gh/git
  // (families from the YAML), delivery.report_pr — model + hard per-task
  // budget from the same spec. The clone source carries the credential
  // host-side only; the sandbox never sees it.
  // codex-impl.md §A.3/§A.4: `makeBuildWiring` refuses to wire when `on:`
  // excludes `build` — skip starting the worker entirely rather than crash
  // boot for a valid doc-only configuration (e.g. `on: [draft, design-review]`).
  if (agentSubscribesTo(flagship, "build")) {
    const build = makeBuildWiring({
      db,
      spec: flagship,
      secrets,
      getClient: httpGithubClientFactory(),
      fanout,
      source: async (task) => {
        const repo = flagship.repo!;
        void task;
        // Resolved per task so a fresh installation token (§2b #15) rides each
        // clone; the credential stays host-side only (§29.2).
        const cloneToken = await secrets.get("secret/github");
        return `https://x-access-token:${cloneToken}@github.com/${repo}.git`;
      },
      // BUILD containers carry the same owner so the boot reaper covers them too.
      sandbox: { owner: sandboxOwner },
      sessionDir: join(tmpdir(), "marathon-sessions"),
      // §30: the gateway reads the egress mode; an omitted budget → profile default.
      posture,
    });
    const buildWorker = new Worker(queue, db, {
      stepRunner: build.stepRunner,
      // Partitioned dequeue (Track 15): this worker only LEASES BUILD-kind jobs,
      // so it can never consume the document-task jobs the webhook handlers
      // drive inline — those stay on the queue for whichever worker owns them.
      kinds: [BUILD_JOB_KIND],
      visibilityMs: 120_000,
    });
    const pollBuild = async (): Promise<void> => {
      try {
        await buildWorker.drain();
      } catch (e) {
        console.error("[github-app] build worker error:", e);
      }
      setTimeout(() => void pollBuild(), 2_000);
    };
    void pollBuild();
  } else {
    console.log("[github-app] 'on' excludes 'build' — BUILD worker not started (doc-only configuration)");
  }

  // Identity linking (§7.20 / §2b #10): the OAuth start/callback endpoints.
  // Needs the GitHub App's OAuth client credentials + the shared master
  // secret (the Slack app signs link tokens with the same key).
  const oauthClientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const oauthClientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
  const identity: IdentityLinkDeps | undefined =
    cfg.secretKey && oauthClientId && oauthClientSecret
      ? { db, masterSecret: cfg.secretKey, oauth: { clientId: oauthClientId, clientSecret: oauthClientSecret } }
      : undefined;
  console.log(
    identity
      ? "[github-app] identity linking enabled (/auth/github/start + /auth/github/callback)"
      : "[github-app] identity linking not configured (set MARATHON_SECRET_KEY + GITHUB_APP_CLIENT_ID + GITHUB_APP_CLIENT_SECRET to enable)",
  );

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (identity && req.method === "GET" && url.pathname.startsWith("/auth/github/")) {
      void handleIdentityRequest(identity, req.method, url)
        .then((r) => {
          if (!r) {
            res.writeHead(404).end();
          } else if (r.location) {
            res.writeHead(302, { location: r.location }).end();
          } else {
            res.writeHead(r.status, { "content-type": r.contentType ?? "text/plain; charset=utf-8" }).end(r.body ?? "");
          }
        })
        .catch((e) => {
          console.error("[github-app] identity-link error:", e);
          res.writeHead(500).end("identity link failed — check the app logs");
        });
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/webhooks/github")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void handleWebhookRequest(deps, secret, {
        eventType: String(req.headers["x-github-event"] ?? ""),
        deliveryId: String(req.headers["x-github-delivery"] ?? ""),
        signature: String(req.headers["x-hub-signature-256"] ?? ""),
        rawBody: body,
      })
        .then((result) => {
          res.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify({ ok: result.status < 400, note: result.note }));
        })
        .catch((e) => {
          console.error("[github-app] handler error:", e);
          res.writeHead(500).end();
        });
    });
  });

  server.listen(port, () => console.log(`[github-app] webhook receiver on :${port}/webhooks/github (owner ${owner})`));

  // Dev webhook proxy (§2b #12): subscribe outbound to a smee.io channel and
  // feed relayed deliveries through the SAME signature-verified handler —
  // no tunnel, no webhook-URL churn. Delivery-id dedupe makes it safe even if
  // a tunnel also points at the receiver above.
  const proxyUrl = process.env.MARATHON_WEBHOOK_PROXY?.trim();
  if (proxyUrl) {
    const proxy = new WebhookProxyClient(proxyUrl, {
      onConnected: () => console.log(`[github-app] webhook proxy subscribed to ${proxyUrl}`),
      onError: (e) => console.error("[github-app] webhook proxy error:", e),
    });
    void proxy.start(async (delivery) => {
      const result = await handleWebhookRequest(deps, secret, delivery);
      const note = result.note ? ` (${result.note})` : "";
      console.log(`[github-app] proxied ${delivery.eventType} ${delivery.deliveryId ?? ""}: ${result.status}${note}`);
    });
  } else {
    // §2b #13: state the effective inbound-event mode explicitly — without
    // this line a missing/misspelled MARATHON_WEBHOOK_PROXY boots a listener
    // that looks alive but never receives a delivery.
    console.log(
      `[github-app] no webhook proxy configured — inbound receiver only on :${port}/webhooks/github (GitHub must reach this address; dev alternative: MARATHON_WEBHOOK_PROXY)`,
    );
  }
}

main().catch((err) => {
  console.error("github-app FAILED:", err);
  process.exit(1);
});
