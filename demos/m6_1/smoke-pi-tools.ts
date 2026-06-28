/**
 * LOCAL-ONLY smoke for M6.1 — a real Pi run that uses a Marathon-GOVERNED tool.
 *
 * Exposes github.read_file to the agent via the Tool Gateway (policy + creds +
 * audit), then asks the model to read a file and summarize it. Needs a model key
 * (OPENAI_API_KEY) and GITHUB_TOKEN in env.
 *
 *   make smoke-pi-tools
 */
import { PiAgentRuntime } from "@marathon/agent";
import { EnvSecretStore } from "@marathon/config";
import { httpGithubClientFactory, makeGithubReadTools } from "@marathon/connector-github";
import { emptyCheckpoint } from "@marathon/core";
import { ToolGateway, ToolRegistry } from "@marathon/tools";

async function main(): Promise<void> {
  const repo = process.env.SMOKE_REPO ?? "thgibbs/agentp-demo";
  const secrets = new EnvSecretStore();

  const gateway = new ToolGateway({
    registry: new ToolRegistry(makeGithubReadTools(httpGithubClientFactory())),
    policy: { grants: [{ tool: "github.read_file" }, { tool: "github.list_contents" }] },
    secrets,
  });

  const runtime = new PiAgentRuntime({
    secrets,
    governed: {
      gateway,
      tools: [
        {
          name: "github.read_file",
          description: "Read a file from a GitHub repository.",
          parameters: {
            type: "object",
            properties: { repo: { type: "string" }, path: { type: "string" } },
            required: ["repo", "path"],
          },
        },
      ],
    },
  });

  console.log(`[smoke-pi-tools] asking the model to read ${repo}/.gitignore via a governed tool ...`);
  const turn = await runtime.nextTurn({
    request: {
      taskId: "smoke",
      tenantId: "smoke", // per-call ctx for governed tool execution + audit
      instructions: "Use the github.read_file tool to read files when asked. Be brief.",
      input: `Read the file .gitignore from the repo ${repo} and tell me the first line.`,
      modelRef: process.env.SMOKE_MODEL ?? "openai:gpt-4o-mini",
    },
    checkpoint: emptyCheckpoint(),
  });

  console.log(`[smoke-pi-tools] reply: ${turn.text.slice(0, 300)}`);
  if (!turn.text) throw new Error("no reply from model");
  console.log("smoke-pi-tools OK");
}

main().catch((err) => {
  console.error("smoke-pi-tools FAILED:", err);
  process.exit(1);
});
