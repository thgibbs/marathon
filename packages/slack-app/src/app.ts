import { EnvSecretStore, loadConfig } from "@marathon/config";
import { PiAgentRuntime } from "@marathon/agent";
import { httpGithubClientFactory, makeGithubReadTools } from "@marathon/connector-github";
import { Database, dbToolRecorder, migrate } from "@marathon/db";
import { OpenAIEmbedder, PgVectorMemoryStore } from "@marathon/memory";
import { DEFAULT_MODEL_POLICY, resolveModelRef } from "@marathon/model-gateway";
import { Queue } from "@marathon/queue";
import { RealSlackClient, SlackDelivery, SocketModeClient } from "@marathon/surface-slack";
import { ToolGateway, ToolRegistry } from "@marathon/tools";
import { InvocationRouter, makeAgentTaskStepRunner, Orchestrator, Worker } from "@marathon/worker";

const SLACK_AGENT_PERSONA =
  "You are Marathon, a concise engineering assistant in Slack. You can read GitHub " +
  "repositories with the github_read_file and github_list_contents tools — pass `repo` as " +
  "\"owner/name\". Use them to ground answers in real code before making claims. Be brief and " +
  "state uncertainty clearly.";
import { bootstrapSlackApp } from "./bootstrap";
import { dispatchEnvelope, type AppDeps } from "./handlers";

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

  const boot = await bootstrapSlackApp(db, { teamId, teamName: auth.team });

  const modelRef = resolveModelRef(DEFAULT_MODEL_POLICY);
  const memory = new PgVectorMemoryStore(cfg.databaseUrl, new OpenAIEmbedder(secrets));

  // Governed GitHub read tools, exposed to the agent through the Tool Gateway
  // (policy + credential injection + audit + redaction). Read-only for now — write
  // tools need the in-thread approval flow (roadmap §2b #1).
  const toolGateway = new ToolGateway({
    registry: new ToolRegistry(makeGithubReadTools(httpGithubClientFactory())),
    policy: { grants: [{ tool: "github.read_file" }, { tool: "github.list_contents" }] },
    secrets,
    recorder: dbToolRecorder(db),
  });
  const runtime = new PiAgentRuntime({
    secrets,
    governed: {
      gateway: toolGateway,
      tools: [
        { name: "github.read_file", description: "Read a file from a GitHub repository.", parameters: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" } }, required: ["repo", "path"] } },
        { name: "github.list_contents", description: "List files/directories at a path in a GitHub repository.", parameters: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" } }, required: ["repo"] } },
      ],
    },
  });
  const worker = new Worker(queue, db, {
    stepRunner: makeAgentTaskStepRunner(db, runtime, { modelRef, memory, instructions: SLACK_AGENT_PERSONA }),
    visibilityMs: 120_000,
  });
  const router = new InvocationRouter(db, new Orchestrator(db, queue));
  const delivery = new SlackDelivery(new RealSlackClient(botToken));

  const deps: AppDeps = {
    db,
    router,
    worker,
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
