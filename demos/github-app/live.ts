/**
 * Run the LIVE Marathon GitHub document app — a webhook receiver (node:http).
 *
 * Needs: GITHUB_TOKEN (Contents+PR write), GITHUB_WEBHOOK_SECRET, a model key
 * (OPENAI_API_KEY), Postgres at DATABASE_URL, and a public tunnel pointing at
 * this server's /webhooks/github (configure the GitHub App/webhook to send
 * issue_comment, pull_request_review_comment, pull_request).
 *
 *   make github-app
 *   then comment "@marathon quill draft …" on a PR/issue in the repo.
 */
import { createServer } from "node:http";
import { PiAgentRuntime } from "@marathon/agent";
import { EnvSecretStore, loadConfig } from "@marathon/config";
import { GithubDelivery, HttpGithubClient, httpGithubClientFactory, makeDocumentTools } from "@marathon/connector-github";
import { Database, migrate } from "@marathon/db";
import { bootstrapGithubApp, handleWebhookRequest, type GithubAppDeps } from "@marathon/github-app";
import { Queue } from "@marathon/queue";
import { ToolGateway, ToolRegistry } from "@marathon/tools";
import { InvocationRouter, Orchestrator } from "@marathon/worker";

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

  const boot = await bootstrapGithubApp(db, { owner });
  const client = new HttpGithubClient(token);
  const deps: GithubAppDeps = {
    db,
    router: new InvocationRouter(db, new Orchestrator(db, queue)),
    gateway: new ToolGateway({
      registry: new ToolRegistry(makeDocumentTools(httpGithubClientFactory())),
      policy: { grants: [{ tool: "document.create" }, { tool: "document.update" }, { tool: "document.comment" }, { tool: "document.read_region" }] },
      secrets,
    }),
    delivery: new GithubDelivery(client),
    runtime: new PiAgentRuntime({ secrets }),
    tenantId: boot.tenantId,
    agents: boot.agents,
    agentIdByName: boot.agentIdByName,
    defaultAgent: boot.defaultAgent,
  };

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
}

main().catch((err) => {
  console.error("github-app FAILED:", err);
  process.exit(1);
});
