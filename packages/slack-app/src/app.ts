import { EnvSecretStore, loadAgentSpecs, loadConfig, type AgentSpec } from "@marathon/config";
import { PiAgentRuntime } from "@marathon/agent";
import { httpGithubClientFactory, makeGithubReadTools } from "@marathon/connector-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { OpenAIEmbedder, PgVectorMemoryStore } from "@marathon/memory";
import { DEFAULT_MODEL_POLICY, resolveModelRef } from "@marathon/model-gateway";
import { Queue } from "@marathon/queue";
import { DeliveryFanout } from "@marathon/surface";
import { RealSlackClient, SlackDelivery, SocketModeClient } from "@marathon/surface-slack";
import { InMemorySourceLedger, ToolGateway, ToolRegistry, toolPolicyFromSpec } from "@marathon/tools";
import {
  InvocationRouter,
  makeAgentTaskStepRunner,
  makeWaitingNotifier,
  Orchestrator,
  Worker,
} from "@marathon/worker";
import { bootstrapSlackApp } from "./bootstrap";
import { dispatchEnvelope, type AppDeps } from "./handlers";

/** The kernel runs the Pi harness; `claude-code` is a config value reserved for K7. */
function assertSupportedHarness(spec: AgentSpec): void {
  if (spec.harness !== "pi") {
    throw new Error(`agent '${spec.name}': harness '${spec.harness}' is not available yet (K7) — use 'pi'`);
  }
}

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
  const boot = await bootstrapSlackApp(db, { teamId, teamName: auth.team, specs });

  const modelRef = resolveModelRef(flagship.models ?? DEFAULT_MODEL_POLICY);
  const memory = new PgVectorMemoryStore(cfg.databaseUrl, new OpenAIEmbedder(secrets));

  // Governed GitHub read tools, exposed to the agent through the Tool Gateway
  // (policy + credential injection + source ledger + audit + redaction). Read-only
  // for now; reads land in the per-task source ledger so egressing tools can be
  // routed deterministically when they are added (§7.8). The grants (and the
  // one-repo constraint, when `repo:` is set) come from the agent's YAML.
  const toolGateway = new ToolGateway({
    registry: new ToolRegistry(makeGithubReadTools(httpGithubClientFactory())),
    policy: toolPolicyFromSpec(flagship),
    secrets,
    recorder: dbToolRecorder(db),
    sourceLedger: new InMemorySourceLedger(),
  });
  const runtime = new PiAgentRuntime({
    secrets,
    // Track 12: the agent may ask ONE clarifying question and park the task.
    clarification: true,
    governed: {
      gateway: toolGateway,
      tools: [
        { name: "github.read_file", description: "Read a file from a GitHub repository.", parameters: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" } }, required: ["repo", "path"] } },
        { name: "github.list_contents", description: "List files/directories at a path in a GitHub repository.", parameters: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" } }, required: ["repo"] } },
      ],
    },
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
      // Track 12: thread history rides into the prompt, fenced as untrusted.
      loadContext: (task) => delivery.loadContext(task.sourceRef, { limit: 30 }),
    }),
    // Track 12: clarifying questions publish durably BEFORE the task parks.
    onWaiting: makeWaitingNotifier(db, fanout),
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
