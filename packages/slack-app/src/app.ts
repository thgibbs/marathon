import { EnvSecretStore, loadAgentSpecs, loadConfig, type AgentSpec } from "@marathon/config";
import { PiAgentRuntime } from "@marathon/agent";
import { httpGithubClientFactory, makeDocumentTools, makeGithubReadTools } from "@marathon/connector-github";
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

const repoProp = { repo: { type: "string", description: 'Repository as "owner/name".' } };

/**
 * Pi definitions for the tools this app can register. The list actually
 * exposed to the model is `spec.tools ∩ this catalog` — the YAML grants drive
 * the surface, and a granted tool this surface cannot serve (e.g. the BUILD
 * broker) is simply not exposed here.
 */
const GOVERNED_TOOL_DEFS: Record<string, { name: string; description: string; parameters: Record<string, unknown> }> = {
  "github.read_file": {
    name: "github.read_file",
    description: "Read a file from a GitHub repository.",
    parameters: { type: "object", properties: { ...repoProp, path: { type: "string" } }, required: ["repo", "path"] },
  },
  "github.list_contents": {
    name: "github.list_contents",
    description: "List files/directories at a path in a GitHub repository.",
    parameters: { type: "object", properties: { ...repoProp, path: { type: "string" } }, required: ["repo"] },
  },
  "document.read_region": {
    name: "document.read_region",
    description: "Read a markdown file (optionally a line range) from the repo.",
    parameters: {
      type: "object",
      properties: { ...repoProp, path: { type: "string" }, ref: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } },
      required: ["repo", "path"],
    },
  },
  "document.create": {
    name: "document.create",
    description: "Create a markdown design document by opening a pull request (a human merging it is the approval).",
    parameters: {
      type: "object",
      properties: { ...repoProp, path: { type: "string" }, content: { type: "string" }, title: { type: "string" }, base: { type: "string" } },
      required: ["repo", "path", "content"],
    },
  },
  "document.update": {
    name: "document.update",
    description: "Update a markdown document via a pull request (pass the file's current git sha).",
    parameters: {
      type: "object",
      properties: { ...repoProp, path: { type: "string" }, content: { type: "string" }, sha: { type: "string" }, base: { type: "string" } },
      required: ["repo", "path", "content", "sha"],
    },
  },
  "document.revise": {
    name: "document.revise",
    description: "Revise an existing document by committing to its open PR branch.",
    parameters: {
      type: "object",
      properties: { ...repoProp, path: { type: "string" }, content: { type: "string" }, branch: { type: "string" } },
      required: ["repo", "path", "content", "branch"],
    },
  },
};

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

  // Governed tools, exposed to the agent through the Tool Gateway (policy +
  // credential injection + source ledger + audit + redaction). GitHub reads
  // ground answers; document tools make the kernel's first step — a design-doc
  // PR from a Slack ask — actually possible from this surface. The grants (and
  // the one-repo constraint from `repo:`) come from the agent's YAML, and the
  // Pi-visible tool list is derived from those same grants.
  const clientFactory = httpGithubClientFactory();
  const toolGateway = new ToolGateway({
    registry: new ToolRegistry([...makeGithubReadTools(clientFactory), ...makeDocumentTools(clientFactory)]),
    policy: toolPolicyFromSpec(flagship),
    secrets,
    recorder: dbToolRecorder(db),
    sourceLedger: new InMemorySourceLedger(),
  });
  const governedTools = flagship.tools
    .map((t) => GOVERNED_TOOL_DEFS[t.tool])
    .filter((d): d is NonNullable<typeof d> => d !== undefined);
  const runtime = new PiAgentRuntime({
    secrets,
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
