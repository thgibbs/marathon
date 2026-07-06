import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSecretStore, loadAgentSpecs, loadConfig, type AgentSpec } from "@marathon/config";
import { PiAgentRuntime } from "@marathon/agent";
import { ensureBranch, governedToolDefsFor, HttpGithubClient, httpGithubClientFactory, makeDocumentTools, makeGithubReadTools } from "@marathon/connector-github";
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

/**
 * The chat/general-agent surface runs the Pi harness only. The Claude Code
 * harness (K7) is wired for BUILD tasks (github-app), which have a per-task code
 * container; chat tasks have no such workspace, so `claude-code` is rejected here.
 */
function assertSupportedHarness(spec: AgentSpec): void {
  if (spec.harness !== "pi") {
    throw new Error(`agent '${spec.name}': harness '${spec.harness}' is not supported on the chat surface — chat runs 'pi' (claude-code is BUILD-only, K7)`);
  }
}

// Pi definitions for the governed tools this app can register live in
// @marathon/connector-github (governedToolDefsFor): the list actually exposed
// to the model is `spec.tools ∩ that catalog` — the YAML grants drive the
// surface, and a granted tool this surface cannot serve (e.g. the BUILD
// broker) is simply not exposed.

/** Start the live Marathon Slack app (Socket Mode). Long-running. */
export async function startSlackApp(): Promise<void> {
  const cfg = loadConfig();
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  if (!botToken) throw new Error("SLACK_BOT_TOKEN (xoxb-) is required");
  if (!appToken) throw new Error("SLACK_APP_TOKEN (xapp-) is required");

  await migrate(cfg.databaseUrl);
  const db = new Database(cfg.databaseUrl);
  const queue = new Queue(cfg.databaseUrl);
  const secrets = new EnvSecretStore();

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
  assertSupportedHarness(flagship);
  const boot = await bootstrapSlackApp(db, { teamId, teamName: auth.team, tenantName: cfg.tenant, specs });

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
  // Chat/general-agent tasks run on Pi. The Claude Code harness (K7) is wired
  // only for BUILD tasks (github-app), since it runs its whole loop inside a
  // per-task code container and chat tasks have no such workspace binding;
  // `assertSupportedHarness` above rejects `claude-code` on this surface.
  const runtime = new PiAgentRuntime({
    secrets,
    // Durable per-task sessions (Track 12/K4): a resumed turn — answering a
    // clarifying question, a later turn — re-opens the SAME session, so the
    // agent keeps its context. Without this, sessions are in-memory and every
    // turn starts amnesiac.
    sessionDir: join(tmpdir(), "marathon-sessions"),
    // Track 12: the agent may ask ONE clarifying question and park the task.
    clarification: true,
    governed: { gateway: toolGateway, tools: governedTools },
  });
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
  };

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
