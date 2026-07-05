/**
 * Run the LIVE Marathon GitHub document app — a webhook receiver (node:http).
 *
 * Needs: GITHUB_TOKEN (Contents+PR write), GITHUB_WEBHOOK_SECRET, a model key
 * (OPENAI_API_KEY), Postgres at DATABASE_URL, and inbound events one of two
 * ways (configure the GitHub App/webhook to send issue_comment,
 * pull_request_review_comment, pull_request):
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
import { PiAgentRuntime } from "@marathon/agent";
import { EnvSecretStore, loadAgentSpecs, loadConfig, type AgentSpec } from "@marathon/config";
import { ensureBranch, GithubDelivery, governedToolDefsFor, HttpGithubClient, httpGithubClientFactory, makeDocumentTools, makeGithubReadTools } from "@marathon/connector-github";
import { WebhookProxyClient } from "@marathon/surface-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { bootstrapGithubApp, handleWebhookRequest, makeBuildWiring, type GithubAppDeps } from "@marathon/github-app";
import { OpenAIEmbedder, PgVectorMemoryStore } from "@marathon/memory";
import { DEFAULT_MODEL_POLICY, resolveModelRef } from "@marathon/model-gateway";
import { Queue } from "@marathon/queue";
import { DeliveryFanout } from "@marathon/surface";
import { InMemorySourceLedger, ToolGateway, toolPolicyFromSpec, ToolRegistry } from "@marathon/tools";
import { BUILD_JOB_KIND, InvocationRouter, makeDocumentPrRecorder, Orchestrator, Worker } from "@marathon/worker";

/** The kernel runs the Pi harness; `claude-code` is a config value reserved for K7. */
function assertSupportedHarness(spec: AgentSpec): void {
  if (spec.harness !== "pi") {
    throw new Error(`agent '${spec.name}': harness '${spec.harness}' is not available yet (K7) — use 'pi'`);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  const owner = process.env.GITHUB_OWNER?.trim();
  const port = Number(process.env.PORT ?? 8787);
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is required");
  if (!owner) throw new Error("GITHUB_OWNER is required (repo owner for the tenant)");

  await migrate(cfg.databaseUrl);
  const db = new Database(cfg.databaseUrl);
  const queue = new Queue(cfg.databaseUrl);
  const secrets = new EnvSecretStore();
  const token = await secrets.get("secret/github");
  if (!token) throw new Error("GITHUB_TOKEN is required");

  // Configured agents (Track 14): YAML specs; the first file is the default.
  // Its grants (with the ONE configured repo as every grant's allowlist)
  // become the gateway policy below — editing the YAML narrows the surface.
  const specs = await loadAgentSpecs(cfg.agentsDir);
  const flagship = specs[0]!;
  assertSupportedHarness(flagship);
  const boot = await bootstrapGithubApp(db, { owner, tenantName: cfg.tenant, specs });
  const client = new HttpGithubClient(token);
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
  });
  const deps: GithubAppDeps = {
    db,
    client,
    memory: new PgVectorMemoryStore(cfg.databaseUrl, new OpenAIEmbedder(secrets)),
    router: new InvocationRouter(db, orchestrator),
    orchestrator,
    delivery,
    fanout,
    runtime: new PiAgentRuntime({
      secrets,
      // Durable per-task sessions (K4) — same location the BUILD side uses.
      sessionDir: join(tmpdir(), "marathon-sessions"),
      governed: { gateway: toolGateway, tools: governedToolDefsFor(flagship.tools.map((t) => t.tool)) },
    }),
    tenantId: boot.tenantId,
    agents: boot.agents,
    agentIdByName: boot.agentIdByName,
    defaultAgent: boot.defaultAgent,
    // Model policy from the spec (Track 15) — no hardcoded fallback here.
    modelRef: resolveModelRef(flagship.models ?? DEFAULT_MODEL_POLICY),
    plansBranch,
    defaultBranch: "main",
  };

  // The BUILD side of the loop (Track 15): a worker that consumes the
  // merge-spawned implementation/revision tasks with the coherent BUILD
  // runtime — sandboxed tools (network from the YAML), brokered gh/git
  // (families from the YAML), delivery.report_pr — model + hard per-task
  // budget from the same spec. The clone source carries the credential
  // host-side only; the sandbox never sees it.
  const build = makeBuildWiring({
    db,
    spec: flagship,
    secrets,
    getClient: httpGithubClientFactory(),
    fanout,
    source: (task) => {
      const repo = flagship.repo!;
      void task;
      return `https://x-access-token:${token}@github.com/${repo}.git`;
    },
    sessionDir: join(tmpdir(), "marathon-sessions"),
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

  const server = createServer((req, res) => {
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
  }
}

main().catch((err) => {
  console.error("github-app FAILED:", err);
  process.exit(1);
});
