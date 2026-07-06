import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSecretStore, loadAgentSpecs, loadConfig, warnUnknownMarathonEnv } from "@marathon/config";
import { makeAgentRuntime, withChatWorkspace, workspaceSandboxFromSpec } from "@marathon/agent";
import { ensureBranch, githubAuthFromEnv, governedToolDefsFor, HttpGithubClient, httpGithubClientFactory, makeDocumentTools, makeGithubReadTools } from "@marathon/connector-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { OpenAIEmbedder, PgVectorMemoryStore } from "@marathon/memory";
import { DEFAULT_MODEL_POLICY, resolveModelRef } from "@marathon/model-gateway";
import { DEFAULT_JOB_KIND, Queue } from "@marathon/queue";
import { DeliveryFanout } from "@marathon/surface";
import { RealSlackClient, SlackDelivery, SocketModeClient } from "@marathon/surface-slack";
import { InMemorySourceLedger, ToolGateway, ToolRegistry, toolPolicyFromSpec } from "@marathon/tools";
import {
  InvocationRouter,
  makeAgentTaskStepRunner,
  makeDocumentPrRecorder,
  makeWaitingNotifier,
  Orchestrator,
  Worker,
} from "@marathon/worker";
import { bootstrapSlackApp } from "./bootstrap";
import { dispatchEnvelope, type AppDeps } from "./handlers";

// Pi definitions for the governed tools this app can register live in
// @marathon/connector-github (governedToolDefsFor): the list actually exposed
// to the model is `spec.tools ∩ that catalog` — the YAML grants drive the
// surface, and a granted tool this surface cannot serve (e.g. the BUILD
// broker) is simply not exposed.

/** Start the live Marathon Slack app (Socket Mode). Long-running. */
export async function startSlackApp(): Promise<void> {
  // §2b #13: a misspelled MARATHON_* variable fails silently otherwise.
  warnUnknownMarathonEnv();
  const cfg = loadConfig();
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  if (!botToken) throw new Error("SLACK_BOT_TOKEN (xoxb-) is required");
  if (!appToken) throw new Error("SLACK_APP_TOKEN (xapp-) is required");

  await migrate(cfg.databaseUrl);
  const db = new Database(cfg.databaseUrl);
  const queue = new Queue(cfg.databaseUrl);
  const envSecrets = new EnvSecretStore();

  // identify the workspace
  const authRes = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const auth = (await authRes.json()) as { ok: boolean; team?: string; team_id?: string; error?: string };
  if (!auth.ok) throw new Error(`auth.test failed: ${auth.error}`);
  const teamId = auth.team_id ?? auth.team ?? "unknown";

  // Configured agents (Track 14): YAML specs from the agents dir; the first
  // file is the deployment default (the flagship — agents/forge.yaml). The
  // spec drives everything below: persona (via AgentVersion), tool policy,
  // model policy, and the budget cap.
  const specs = await loadAgentSpecs(cfg.agentsDir);
  const flagship = specs[0]!;
  const boot = await bootstrapSlackApp(db, { teamId, teamName: auth.team, tenantName: cfg.tenant, specs });

  // GitHub auth (§2b #15): App installation tokens when GITHUB_APP_ID +
  // GITHUB_APP_PRIVATE_KEY are set, so doc PRs drafted from Slack are also
  // App-authored; PAT fallback otherwise. Owner comes from the configured repo.
  const ghOwner = flagship.repo?.split("/")[0] ?? process.env.GITHUB_OWNER?.trim();
  const ghAuth = ghOwner
    ? githubAuthFromEnv(envSecrets, ghOwner)
    : { secrets: envSecrets, tokenSource: undefined, mode: "token" as const };
  const secrets = ghAuth.secrets;

  const modelRef = resolveModelRef(flagship.models ?? DEFAULT_MODEL_POLICY);
  const memory = new PgVectorMemoryStore(cfg.databaseUrl, new OpenAIEmbedder(secrets));

  // §29.1a: doc PRs branch FROM the plans branch — this app can draft plans
  // without the GitHub app running, so it must ensure the branch exists too
  // (operators should branch-protect it like main; see docs/quickstart.md §3).
  const ghToken = await secrets.get("secret/github");
  if (flagship.repo && ghToken) {
    await ensureBranch(new HttpGithubClient(ghToken), flagship.repo, flagship.plans.branch, "main");
  }

  // Governed tools, exposed to the agent through the Tool Gateway (policy +
  // credential injection + source ledger + audit + redaction). GitHub reads
  // ground answers; document tools make the kernel's first step — a design-doc
  // PR from a Slack ask — actually possible from this surface. The grants (and
  // the one-repo constraint from `repo:`) come from the agent's YAML, and the
  // Pi-visible tool list is derived from those same grants.
  const clientFactory = httpGithubClientFactory();
  const toolGateway = new ToolGateway({
    // Doc PRs target the configured plans branch (§29.1a) — authoritative,
    // so the model cannot retarget them at the default branch. The recorder
    // persists the DocumentArtifact + doc-PR delivery target the merge
    // webhook needs — without it, a plan drafted from Slack would merge and
    // be silently ignored (no artifact → no implementation task).
    registry: new ToolRegistry([
      ...makeGithubReadTools(clientFactory),
      ...makeDocumentTools(clientFactory, {
        docBase: flagship.plans.branch,
        onDocumentPr: makeDocumentPrRecorder(db),
      }),
    ]),
    policy: toolPolicyFromSpec(flagship),
    secrets,
    recorder: dbToolRecorder(db),
    sourceLedger: new InMemorySourceLedger(),
  });
  const governedTools = governedToolDefsFor(flagship.tools.map((t) => t.tool));
  // Harness from the spec (§2b #17): the chat surface now runs EITHER harness
  // through the shared factory. Claude Code runs its loop inside a per-task
  // container; chat tasks have no code workspace, so `withChatWorkspace`
  // binds an ephemeral scratch dir per task — governed tools flow over the
  // broker identically on either harness. The factory cross-validates
  // `claude-code` fail closed (Anthropic model + proxy, §13.1).
  if (flagship.harness === "claude-code" && flagship.sandbox.network === "none") {
    // Same guard as the BUILD wiring: `network: none` severs the model proxy
    // too — fail closed until the internal-network proxy wiring lands (§7.1).
    throw new Error(
      `agent '${flagship.name}': locked-down claude-code (sandbox.network: none) needs the internal-network model-proxy wiring (K7 spike, §7.1) — not yet available; use 'bridge'`,
    );
  }
  const chatProxyUrl = process.env.MARATHON_MODEL_PROXY_URL?.trim();
  const runtime = withChatWorkspace(
    makeAgentRuntime(flagship, {
      secrets,
      // Durable per-task sessions (Track 12/K4): a resumed turn — answering a
      // clarifying question, a later turn — re-opens the SAME session, so the
      // agent keeps its context. Without this, sessions are in-memory and every
      // turn starts amnesiac.
      sessionDir: join(tmpdir(), "marathon-sessions"),
      // Track 12: the agent may ask ONE clarifying question and park the task.
      clarification: true,
      governed: { gateway: toolGateway, tools: governedTools },
      // Claude Code only (ignored by Pi — chat Pi keeps running containerless
      // with governed tools only): the per-task container factory, the
      // container-reachable proxy (required — undefined fails closed), the
      // image's managed settings, and the mid-invocation budget kill (§4.3).
      sandbox: flagship.harness === "claude-code" ? workspaceSandboxFromSpec(flagship) : undefined,
      proxy: flagship.harness === "claude-code" ? (chatProxyUrl ? { baseUrl: chatProxyUrl } : undefined) : undefined,
      lockedDownEgress: flagship.sandbox.network === "none",
      cli: { settingsPath: "/etc/marathon/claude-settings.json" },
      getRemainingBudgetUsd: flagship.budget
        ? async (ctx) => flagship.budget!.limitUsd - (await db.sumModelCostUsd(ctx.request.taskId))
        : undefined,
    }),
    { root: join(tmpdir(), "marathon-chat-workspaces") },
  );
  const delivery = new SlackDelivery(new RealSlackClient(botToken));
  const fanout = new DeliveryFanout({ slack: delivery }, db);
  const worker = new Worker(queue, db, {
    stepRunner: makeAgentTaskStepRunner(db, runtime, {
      modelRef,
      memory,
      // Persona comes from the seeded AgentVersion (the YAML instructions);
      // this is only the fallback for tasks without an agent.
      instructions: flagship.instructions,
      // Hard per-agent spend cap from the YAML (fails closed when exceeded).
      budget: flagship.budget ? { policy: flagship.budget } : undefined,
      // The same limit as a hard per-task cap (Track 15, §0.4): one runaway
      // task cannot spend the whole agent budget.
      taskBudget: flagship.budget,
      // Track 12: thread history rides into the prompt, fenced as untrusted.
      loadContext: (task) => delivery.loadContext(task.sourceRef, { limit: 30 }),
      // Doc-task mode (§2b #16): "@marathon draft …" tasks get the doc-tool
      // contract + the deterministic no-op evidence check — only meaningful
      // when the agent can actually call document.create against a repo.
      docTasks:
        flagship.repo && flagship.tools.some((t) => t.tool === "document.create")
          ? { repo: flagship.repo }
          : undefined,
    }),
    // Track 12: clarifying questions publish durably BEFORE the task parks.
    onWaiting: makeWaitingNotifier(db, fanout),
    // Partitioned dequeue (Track 15): this worker owns general agent jobs;
    // BUILD-kind jobs belong to the github-app's BUILD worker.
    kinds: [DEFAULT_JOB_KIND],
    visibilityMs: 120_000,
  });
  const orchestrator = new Orchestrator(db, queue);
  const router = new InvocationRouter(db, orchestrator);

  // Identity linking (§2b #10): `/marathon link github` needs the shared
  // master secret (the GitHub app verifies the link token with the same key)
  // and the public base URL of the GitHub app's HTTP server.
  const linkBaseUrl = process.env.MARATHON_LINK_BASE_URL?.trim();
  const identityLink =
    cfg.secretKey && linkBaseUrl ? { signingKey: cfg.secretKey, baseUrl: linkBaseUrl } : undefined;
  console.log(
    identityLink
      ? `[slack-app] identity linking enabled (/marathon link github → ${identityLink.baseUrl})`
      : "[slack-app] identity linking not configured (set MARATHON_SECRET_KEY + MARATHON_LINK_BASE_URL to enable /marathon link github)",
  );

  const deps: AppDeps = {
    db,
    router,
    worker,
    queue,
    orchestrator,
    delivery,
    tenantId: boot.tenantId,
    agents: boot.agents,
    agentIdByName: boot.agentIdByName,
    defaultAgent: boot.defaultAgent,
    identityLink,
  };

  // §2b #13: state the effective inbound-event mode explicitly at startup.
  console.log("[slack-app] inbound events via Socket Mode (outbound websocket — no public endpoint needed)");
  const socket = new SocketModeClient(appToken, {
    onConnected: () =>
      console.log(`[slack-app] connected (team ${auth.team}); model=${modelRef}. Mention @marathon in a channel.`),
    onError: (e) => console.error("[slack-app] error:", e),
  });

  await socket.start((env) =>
    dispatchEnvelope(deps, env).catch((e) => console.error("[slack-app] dispatch error:", e)),
  );
  console.log("[slack-app] listening (Ctrl-C to stop)…");
}
