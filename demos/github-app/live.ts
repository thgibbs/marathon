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
import { assertCodexSubscriptionAckIfNeeded, assertSubscriptionAckIfNeeded, CODEX_AUTH_JSON_ENV, makeAgentRuntime, resolveSandboxNetwork, withChatWorkspace, workspaceSandboxFromSpec } from "@marathon/agent";
import { agentSubscribesTo, EnvSecretStore, isSubprocessHarness, loadAgentSpecs, loadConfig, looseningAuditEvent, renderPostureBanner, renderSandboxResidualNote, resolveEffectiveBudget, resolvePosture, warnUnknownMarathonEnv } from "@marathon/config";
import { githubAuthFromEnv, GithubDelivery, governedToolDefsFor, HttpGithubClient, httpGithubClientFactory, makeDocumentTools, makeGithubReadTools, makeReviewReportTool } from "@marathon/connector-github";
import { WebhookProxyClient } from "@marathon/surface-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { bootstrapGithubApp, handleIdentityRequest, handleWebhookRequest, makeBuildWiring, processDesignReviewJob, type AgentRuntimeEntry, type GithubAppDeps, type IdentityLinkDeps } from "@marathon/github-app";
import { OpenAIEmbedder, PgVectorMemoryStore } from "@marathon/memory";
import { DEFAULT_MODEL_POLICY } from "@marathon/model-gateway";
import { Queue } from "@marathon/queue";
import { DeliveryFanout } from "@marathon/surface";
import { InMemorySourceLedger, installSandboxShutdownHandler, reapSandboxContainers, ToolGateway, toolPolicyFromSpec, ToolRegistry } from "@marathon/tools";
import { BUILD_JOB_KIND, DESIGN_REVIEW_JOB_KIND, designReviewJobKey, InvocationRouter, makeDocumentPrRecorder, Orchestrator, Worker } from "@marathon/worker";

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
  if (flagship.harness === "codex" && flagship.sandbox.network === "none") {
    // Codex's distinct fail-closed: `network: none` would need an OpenAI
    // key-injecting proxy as the container's sole egress — not built
    // (codex-cli-impl.md §4.1), so the model call has no route out.
    throw new Error(
      `agent '${flagship.name}': locked-down codex (sandbox.network: none) needs the OpenAI key-injecting proxy component (codex-cli-impl.md §4.1) — not yet built; use 'bridge'`,
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
  // State the effective Codex model-auth mode at startup (§4.1), parallel to the
  // Claude Code block: fail closed on an unacknowledged ChatGPT-login auth.json
  // via the CODEX ack guard (never the claude one), then log the mode. The
  // credential is a FILE (staged into $CODEX_HOME per turn) — its path is
  // logged, never its contents. Checked whenever ANY configured spec runs on
  // codex (reviewer agents included), not just the flagship.
  const codexAuthJsonPath = process.env[CODEX_AUTH_JSON_ENV]?.trim() || undefined;
  if (specs.some((s) => s.harness === "codex")) {
    assertCodexSubscriptionAckIfNeeded(codexAuthJsonPath);
    const mode = codexAuthJsonPath
      ? `subscription (ChatGPT login via ${CODEX_AUTH_JSON_ENV} — no per-token billing)`
      : (await secrets.get("secret/openai-codex"))
        ? "api key (secret/openai-codex — per-token billing)"
        : `MISCONFIGURED — no model credential (set secret/openai-codex or ${CODEX_AUTH_JSON_ENV}=<path to auth.json>)`;
    console.log(`[github-app] codex model auth: ${mode}`);
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
  // §29.1a (combined-PR flow): design-doc PRs are DRAFTS against the default
  // branch — no dedicated plans branch to provision. An approving review is
  // the approval; merging the combined PR ships design + code together.
  const defaultBranch = "main";
  // Doc writes are tool calls, not committed chat text (§2b #16): the agent's
  // session gets the governed document tools (spec grants ∩ catalog), and the
  // doc body flows through this gateway as a schema-validated tool argument.
  // Wiring here is load-bearing for the handlers' post-turn checks:
  //  - dbToolRecorder persists ToolInvocations (the "did a doc write happen"
  //    evidence — without it every run reports a no-op);
  //  - makeDocumentPrRecorder persists the DocumentArtifact + doc-PR delivery
  //    target the approval handler needs to recognize the plan.
  // Per-agent doc/chat runtime (§A.4 multi-agent dispatch): each configured
  // spec gets its OWN gateway — its tool grants ∩ catalog, scoped to the ONE
  // repo — and its own runtime, so a task runs on the runtime for its owning
  // agent. Doc writes are tool calls, not committed chat text (§2b #16): the
  // doc body flows through this gateway as a schema-validated tool argument,
  // and dbToolRecorder + makeDocumentPrRecorder back the handlers' post-turn
  // checks (the "did a doc write happen" evidence + the DocumentArtifact the
  // approval handler needs).
  const buildDocRuntime = (spec: typeof flagship) => {
    // Fail closed per spec (same guard as flagship above / makeBuildWiring):
    // locked-down claude-code needs the internal model-proxy network (§7.1);
    // locked-down codex needs the OpenAI key-injecting proxy (§4.1). Both are
    // unbuilt, so `network: none` fails closed for either subprocess harness.
    if (spec.harness === "claude-code" && spec.sandbox.network === "none") {
      throw new Error(
        `agent '${spec.name}': locked-down claude-code (sandbox.network: none) needs the internal-network model-proxy wiring (K7 spike, §7.1) — not yet available; use 'bridge'`,
      );
    }
    if (spec.harness === "codex" && spec.sandbox.network === "none") {
      throw new Error(
        `agent '${spec.name}': locked-down codex (sandbox.network: none) needs the OpenAI key-injecting proxy component (codex-cli-impl.md §4.1) — not yet built; use 'bridge'`,
      );
    }
    // Floor #7 (§30.3): the effective per-task cap — the agent's own `budget:`
    // or, when omitted, the trust profile's default (never unlimited).
    const specBudget = resolveEffectiveBudget(spec.budget, posture);
    const gateway = new ToolGateway({
      // The default branch is the AUTHORITATIVE doc-PR base (§29.1a).
      registry: new ToolRegistry([
        ...makeGithubReadTools(httpGithubClientFactory()),
        ...makeDocumentTools(httpGithubClientFactory(), {
          docBase: defaultBranch,
          // §A.3a #19: (re-)enqueue the durable design-review job (idempotent per
          // PR) AFTER the artifact is committed — the review poller below leases
          // it. AWAITED, not fire-and-forget: an enqueue failure propagates and
          // fails the doc tool call (which retries and re-ensures the job) rather
          // than silently dropping the review. Race-free replacement for the
          // opened-webhook trigger.
          onDocumentPr: makeDocumentPrRecorder(db, {
            onProduced: async (e) => {
              await queue.enqueue({
                taskId: e.owningTaskId,
                kind: DESIGN_REVIEW_JOB_KIND,
                idempotencyKey: designReviewJobKey(e.repo, e.prNumber),
              });
            },
          }),
        }),
        // §A.3a: a reviewer agent's terminal step — post the verdict comment +
        // record the verdict/round for the kickback loop. Only agents granted
        // `review.report` (the reviewer specs) can call it; the policy gates the rest.
        makeReviewReportTool({
          getClient: httpGithubClientFactory(),
          onReviewed: async ({ taskId, repo, prNumber, verdict }) => {
            const t = await db.getTask(taskId);
            const kind = (t?.sourceRef as { kind?: string } | undefined)?.kind === "code_review" ? "code_review" : "design_review";
            await db.recordReviewVerdict(boot.tenantId, repo, prNumber, kind, verdict);
          },
        }),
      ]),
      policy: toolPolicyFromSpec(spec),
      secrets,
      recorder: dbToolRecorder(db),
      sourceLedger: new InMemorySourceLedger(),
      // §7.8 / §30.4: the doc/read gateway reads the profile's internal egress mode.
      internalEgressMode: posture.internalEgressMode,
    });
    // Harness from the spec (§2b #17): ANY harness through the shared factory.
    // A subprocess harness (claude-code or codex) needs a container + workspace
    // even for chat-shaped tasks — withChatWorkspace binds an ephemeral scratch
    // dir per task; Pi is containerless. Codex gets the sandbox factory exactly
    // as claude-code does (codex-cli-impl.md §6). The model proxy is CLAUDE-ONLY
    // (codex has no proxy component, §4.1).
    return withChatWorkspace(
      makeAgentRuntime(spec, {
        secrets,
        // Durable per-task sessions (K4) — same location the BUILD side uses.
        sessionDir: join(tmpdir(), "marathon-sessions"),
        governed: { gateway, tools: governedToolDefsFor(spec.tools.map((t) => t.tool)) },
        sandbox: isSubprocessHarness(spec.harness) ? workspaceSandboxFromSpec(spec, { owner: sandboxOwner }) : undefined,
        proxy:
          spec.harness === "claude-code"
            ? (process.env.MARATHON_MODEL_PROXY_URL?.trim() ? { baseUrl: process.env.MARATHON_MODEL_PROXY_URL.trim() } : undefined)
            : undefined,
        lockedDownEgress: spec.sandbox.network === "none",
        cli: { settingsPath: "/etc/marathon/claude-settings.json" },
        // TCP broker for macOS Docker Desktop (§3.1): set MARATHON_BROKER_HOST=host.docker.internal.
        brokerHost: process.env.MARATHON_BROKER_HOST?.trim() || undefined,
        // Codex subscription mode (dev-only, §4.1): the auth.json path, ack-gated above.
        subscriptionAuthJsonPath: spec.harness === "codex" ? codexAuthJsonPath : undefined,
        // An omitted `budget:` means the profile default cap, never unlimited.
        getRemainingBudgetUsd: async (ctx) => specBudget.limitUsd - (await db.sumModelCostUsd(ctx.request.taskId)),
      }),
      { root: join(tmpdir(), "marathon-chat-workspaces") },
    );
  };
  // One runtime entry per configured spec, keyed by agent id (§A.4). The
  // agentRegistry below routes each routed task to its owning agent's runtime.
  const runtimesByAgentId = new Map<string, AgentRuntimeEntry>();
  for (const spec of specs) {
    runtimesByAgentId.set(boot.agentIdByName[spec.name]!, {
      runtime: buildDocRuntime(spec),
      on: spec.on,
      models: spec.models ?? DEFAULT_MODEL_POLICY,
    });
  }
  const deps: GithubAppDeps = {
    db,
    client,
    memory: new PgVectorMemoryStore(cfg.databaseUrl, new OpenAIEmbedder(secrets)),
    router: new InvocationRouter(db, orchestrator),
    orchestrator,
    delivery,
    fanout,
    // Default runtime = the flagship's; agentRegistry routes each task to the
    // runtime for its owning agent (§A.4). Falls back to the default per resolveAgent.
    runtime: runtimesByAgentId.get(boot.agentIdByName[flagship.name]!)!.runtime,
    agentRegistry: (id) => (id ? runtimesByAgentId.get(id) : undefined),
    // §A.3a: the DEDICATED reviewer for a review event — a spec that subscribes
    // to it WITHOUT the paired producer (so Forge, which drafts+reviews its own,
    // is not picked). Undefined when none is configured → the auto review is a no-op.
    reviewerFor: (event) => {
      const producer = event === "design-review" ? "draft" : event === "code-review" ? "build" : undefined;
      const reviewer = specs.find(
        (s) => agentSubscribesTo(s, event) && (producer ? !agentSubscribesTo(s, producer) : true) && Boolean(s.repo),
      );
      return reviewer ? boot.agentIdByName[reviewer.name] : undefined;
    },
    tenantId: boot.tenantId,
    agents: boot.agents,
    agentIdByName: boot.agentIdByName,
    defaultAgent: boot.defaultAgent,
    // Deployment defaults (used when a task has no resolvable agent entry).
    models: flagship.models ?? DEFAULT_MODEL_POLICY,
    on: flagship.on,
    defaultBranch,
  };

  // §A.3a #19: the durable design-review poller. The drafting surface enqueues a
  // DESIGN_REVIEW_JOB_KIND job once the doc-PR artifact is committed (race-free);
  // this leases and runs the review, so a doc drafted from EITHER surface (this
  // app or a Slack worker) is reviewed exactly once, surviving a crash. A
  // dedicated loop, not the generic task Worker: the review is orchestration
  // (runReviewCycle + the inline kickback loop), not a single task step. Runs
  // unconditionally — with no reviewer configured, runReviewCycle is a no-op and
  // the job acks. `processDesignReviewJob` heartbeats the lease across the
  // multi-turn kickback loop and abandons (never double-acks) on lease loss.
  const reviewVisibilityMs = 300_000;
  const pollReview = async (): Promise<void> => {
    try {
      for (;;) {
        const job = await queue.dequeue(reviewVisibilityMs, { kinds: [DESIGN_REVIEW_JOB_KIND] });
        if (!job?.leaseToken) break;
        const outcome = await processDesignReviewJob(queue, deps, job, {
          visibilityMs: reviewVisibilityMs,
          heartbeatMs: 60_000,
        });
        if (outcome === "lease-lost") {
          console.error(`[github-app] design-review job ${job.id}: lease lost during run — abandoned to its current owner`);
        }
      }
    } catch (e) {
      console.error("[github-app] design-review poller error:", e);
    }
    setTimeout(() => void pollReview(), 2_000);
  };
  void pollReview();

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
