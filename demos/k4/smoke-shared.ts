/**
 * Shared wiring for the K4 live smoke: a REAL Pi BUILD run (sandboxed tools in
 * Docker, governed `github.submit_code_changes` host-side) driven by the durable
 * worker. Used by both the killable child worker and the resuming parent.
 */
import { PiAgentRuntime, workspaceSandbox } from "@marathon/agent";
import { CodeTaskRegistry, InMemoryCodeChangeStore } from "@marathon/code-handoff";
import { EnvSecretStore } from "@marathon/config";
import { FixturesGithubClient, makeGithubCodeTools } from "@marathon/connector-github";
import { Database } from "@marathon/db";
import { Queue } from "@marathon/queue";
import { ToolGateway, ToolRegistry } from "@marathon/tools";
import { makeBuildStepRunner, Worker } from "@marathon/worker";

export interface SmokeEnv {
  databaseUrl: string;
  /** Local fixture repo (clone source, host-side only). */
  origin: string;
  /** Sandbox toolchain image; needs node for the fixture's test. */
  image: string;
  /** Shared session dir so the resuming process can open the child's snapshots. */
  sessionDir: string;
  modelRef: string;
}

export const SMOKE_INSTRUCTIONS =
  "You are Marathon's implementation agent. The repository is checked out at /workspace " +
  "(your bash/read/write/edit tools run inside a sandbox mounted there). " +
  "Task: make greet() in greet.mjs include the caller's name so `node test.mjs` passes. " +
  "Work in small steps: read the files, edit greet.mjs, run `node test.mjs`, and once it is " +
  "green, call github_submit_code_changes EXACTLY ONCE with title, summary, " +
  "plan_ref { repo, doc_path, merge_commit_sha } exactly as given in the task, and the " +
  "verification commands you actually ran with their exit codes. Then stop.";

export function makeSmokeWorker(env: SmokeEnv, visibilityMs: number) {
  const db = new Database(env.databaseUrl);
  const queue = new Queue(env.databaseUrl);
  const client = new FixturesGithubClient({});
  const store = new InMemoryCodeChangeStore();
  const registry = new CodeTaskRegistry();
  const gateway = new ToolGateway({
    registry: new ToolRegistry(makeGithubCodeTools({ getClient: () => client, registry, store })),
    policy: { grants: [{ tool: "github.submit_code_changes" }] },
    secrets: new EnvSecretStore(),
  });

  const runtime = new PiAgentRuntime({
    secrets: new EnvSecretStore(),
    sessionDir: env.sessionDir,
    // Track 11: containers are a function of task workspace state — the shared
    // factory owns image pinning, limits, and the credential-free boundary.
    sandbox: workspaceSandbox({ image: env.image }),
    governed: {
      gateway,
      tools: [
        {
          name: "github.submit_code_changes",
          description:
            "Hand off your completed code work. The gateway reads the diff from the workspace; " +
            "pass only metadata. Call exactly once, after verification.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              plan_ref: {
                type: "object",
                properties: {
                  repo: { type: "string" },
                  doc_path: { type: "string" },
                  merge_commit_sha: { type: "string" },
                },
                required: ["repo", "doc_path", "merge_commit_sha"],
              },
              verification: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    command: { type: "string" },
                    exit_code: { type: "number" },
                    summary: { type: "string" },
                  },
                  required: ["command", "exit_code", "summary"],
                },
              },
              draft: { type: "boolean" },
            },
            required: ["title", "summary", "plan_ref", "verification"],
          },
        },
      ],
    },
  });

  const worker = new Worker(queue, db, {
    stepRunner: makeBuildStepRunner({
      db,
      runtime,
      registry,
      source: env.origin,
      modelRef: env.modelRef,
      instructions: SMOKE_INSTRUCTIONS,
    }),
    visibilityMs,
  });

  return { db, queue, worker, client, store };
}

export function smokeEnvFromProcess(): SmokeEnv {
  const databaseUrl = process.env.DATABASE_URL;
  const origin = process.env.K4_ORIGIN;
  const sessionDir = process.env.K4_SESSION_DIR;
  if (!databaseUrl || !origin || !sessionDir) {
    throw new Error("K4 smoke env missing (DATABASE_URL, K4_ORIGIN, K4_SESSION_DIR)");
  }
  return {
    databaseUrl,
    origin,
    sessionDir,
    image: process.env.MARATHON_SANDBOX_IMAGE ?? "node:22-alpine",
    modelRef: process.env.SMOKE_MODEL ?? "openai:gpt-4o-mini",
  };
}
