import { makeAgentRuntime, workspaceSandboxFromSpec, type WorkspaceSandboxOptions } from "@marathon/agent";
import { CodeTaskRegistry } from "@marathon/code-handoff";
import {
  agentSubscribesTo,
  grantFamilies,
  resolveEffectiveBudget,
  type AgentSpec,
  type ResolvedPosture,
  type SecretStore,
} from "@marathon/config";
import {
  ghFamiliesForNames,
  makeDeliveryReportTool,
  makeGitExecTool,
  makeGithubExecTool,
  type GithubClientFactory,
} from "@marathon/connector-github";
import { parseCheckpoint, type StepRunner, type Task } from "@marathon/core";
import { Database, dbToolRecorder } from "@marathon/db";
import { DEFAULT_MODEL_POLICY, resolveModelRef } from "@marathon/model-gateway";
import type { DeliveryFanout } from "@marathon/surface";
import { InMemorySourceLedger, ToolGateway, toolPolicyFromSpec, ToolRegistry, type Tool } from "@marathon/tools";
import { makeBuildStepRunner, resolveBuildBinding } from "@marathon/worker";

/**
 * The coherent BUILD loop from one agent spec (code-migration.md Track 15):
 * sandboxed shell/file tools (internet-enabled, credential-free — the network
 * mode comes from the YAML `sandbox:`), the brokered `gh`/`git` commands
 * (families from the YAML grants, credential injected host-side only), and
 * `delivery.report_pr` as the narrow final step — one Pi runtime, one gateway
 * chokepoint, model + budget from the spec.
 */

const argvParam = {
  type: "object",
  properties: {
    argv: { type: "array", items: { type: "string" }, description: "Structured arguments (no shell)." },
  },
  required: ["argv"],
};

/** Pi-facing definitions for the BUILD tool surface (grants pick from these). */
export const BUILD_TOOL_DEFS: Record<string, { name: string; description: string; parameters: Record<string, unknown> }> = {
  "github.exec": {
    name: "github.exec",
    description:
      'Run an allowlisted `gh` command with the credential injected host-side, e.g. { "argv": ["pr", "create", "--repo", "owner/repo", "--title", "…"] }.',
    parameters: argvParam,
  },
  "git.exec": {
    name: "git.exec",
    description:
      'Brokered network git (push/fetch) on this task\'s workspace, e.g. { "argv": ["push", "owner/repo", "HEAD:refs/heads/marathon/my-branch"] }. Local git runs in your sandbox.',
    parameters: argvParam,
  },
  "delivery.report_pr": {
    name: "delivery.report_pr",
    description:
      "Report the PR you opened for this task (call exactly once, after push + pr create succeed).",
    parameters: {
      type: "object",
      properties: {
        pr_url: { type: "string", description: "https://github.com/<owner>/<repo>/pull/<n>" },
        summary: { type: "string", description: "Short summary of the change." },
        verification: {
          type: "array",
          description: "The verification commands you actually ran, with honest exit codes.",
          items: {
            type: "object",
            properties: {
              command: { type: "string" },
              exit_code: { type: "number" },
              summary: { type: "string" },
            },
            required: ["command", "exit_code"],
          },
        },
      },
      required: ["pr_url", "summary"],
    },
  },
};

export interface BuildWiringOptions {
  db: Database;
  /** The agent spec (Track 14 YAML); `repo` must be configured. */
  spec: AgentSpec;
  secrets: SecretStore;
  getClient: GithubClientFactory;
  /** Cross-surface fan-out for the delivery report (Slack thread + plan PR). */
  fanout?: DeliveryFanout;
  /**
   * Host-side clone source for the configured repo — a local path or a
   * (possibly credentialed) URL. It never reaches the sandbox (§29.2).
   */
  source: string | ((task: Task) => string | Promise<string>);
  /** Per-task Pi session JSONL dir (K4 resume). */
  sessionDir?: string;
  /** Container overrides (image, limits); network comes from the spec. */
  sandbox?: WorkspaceSandboxOptions;
  /**
   * Claude Code harness (K7): an **optional** model proxy endpoint
   * (`ANTHROPIC_BASE_URL`) for the `harness: claude-code` path. On `network:
   * bridge` (the default) it is opt-in — direct key injection is the default
   * (model-proxy decision, §4.1). When set it MUST be reachable from inside the
   * sandbox container (not a host-loopback address). Defaults to
   * `MARATHON_MODEL_PROXY_URL`.
   */
  modelProxyUrl?: string;
  defaultBranch?: string;
  diffDir?: string;
  /**
   * The deployment's resolved trust posture (§30). When set, the gateway reads
   * the internal egress mode and an omitted `budget:` falls back to the profile
   * default cap (floor #7). Optional so non-live callers (demos/tests) keep the
   * bare-spec behavior.
   */
  posture?: ResolvedPosture;
}

export interface BuildWiring {
  /** The BUILD-stage step runner (implementation + code-revision tasks). */
  stepRunner: StepRunner;
  registry: CodeTaskRegistry;
  gateway: ToolGateway;
  /** The spec-resolved model for the BUILD role (role `build`, else default). */
  modelRef: string;
}

/** Assemble the BUILD loop for the spec's ONE configured repo. */
export function makeBuildWiring(opts: BuildWiringOptions): BuildWiring {
  const { db, spec, secrets } = opts;
  const repo = spec.repo;
  if (!repo) throw new Error(`agent '${spec.name}': BUILD wiring requires the ONE configured repo (spec.repo)`);
  // Floor #7 (§30.3): with a posture, an omitted `budget:` becomes the profile
  // default cap (never unlimited); without one, keep the bare-spec value.
  const effectiveBudget = opts.posture ? resolveEffectiveBudget(spec.budget, opts.posture) : spec.budget;
  // codex-impl.md §A.3/§A.4: an agent whose `on:` excludes `build` doesn't run
  // the BUILD loop at all — refuse to wire it rather than silently ignoring
  // the subscription list.
  if (!agentSubscribesTo(spec, "build")) {
    throw new Error(`agent '${spec.name}': 'on' does not include 'build' — refusing to wire the BUILD loop`);
  }

  const registry = new CodeTaskRegistry();
  const allowedRepos = [repo];

  // The brokered tool surface follows the YAML grants: an ungranted tool is
  // not even registered, and gh families are narrowed to the granted names.
  const granted = (name: string) => spec.tools.some((t) => (typeof t === "string" ? t : t.tool) === name);
  const tools: Tool[] = [];
  if (granted("github.exec")) {
    const familyNames = grantFamilies(spec, "github.exec");
    tools.push(makeGithubExecTool({ allowedRepos, families: familyNames ? ghFamiliesForNames(familyNames) : undefined }));
  }
  if (granted("git.exec")) {
    tools.push(
      makeGitExecTool({
        allowedRepos,
        resolveWorkspaceDir: (taskId) => registry.get(taskId)?.workspace.dir,
      }),
    );
  }
  if (granted("delivery.report_pr")) {
    tools.push(
      makeDeliveryReportTool({
        getClient: opts.getClient,
        registry,
        store: db,
        fanout: opts.fanout,
        getDeliveryTargets: async (taskId) => (await db.getTask(taskId))?.deliveryTargets ?? [],
        // Silent cost footer on the delivery report (Track 16, §13.3).
        getCostUsd: (taskId) => db.sumModelCostUsd(taskId),
      }),
    );
  }

  const gateway = new ToolGateway({
    registry: new ToolRegistry(tools),
    policy: toolPolicyFromSpec(spec),
    secrets,
    recorder: dbToolRecorder(db),
    sourceLedger: new InMemorySourceLedger(),
    // §7.8 / §30.4: the gateway reads the profile's internal egress mode.
    internalEgressMode: opts.posture?.internalEgressMode,
  });

  const governedTools = tools
    .map((t) => BUILD_TOOL_DEFS[t.name])
    .filter((d): d is NonNullable<typeof d> => d !== undefined);

  // Harness from the spec (K7): Pi routes tools into the container; Claude Code
  // runs the whole CLI inside it. The factory cross-validates `claude-code` fail
  // closed (Anthropic model + proxy, §13.1) before building a runtime.
  const proxyUrl = opts.modelProxyUrl ?? process.env.MARATHON_MODEL_PROXY_URL;
  if (spec.harness === "claude-code" && spec.sandbox.network === "none") {
    // Locked-down claude-code needs an internal Docker network whose sole
    // reachable endpoint is the proxy (§7.1). `network: none` severs the proxy
    // too, so the model call cannot exit — fail closed until that spike lands.
    throw new Error(
      `agent '${spec.name}': locked-down claude-code (sandbox.network: none) needs the internal-network model-proxy wiring (K7 spike, §7.1) — not yet available; use 'bridge'`,
    );
  }
  const runtime = makeAgentRuntime(spec, {
    secrets,
    sessionDir: opts.sessionDir,
    // Per-agent sandbox network from the YAML (Track 15 closes the Track 14
    // note); containers stay credential-free by construction.
    sandbox: workspaceSandboxFromSpec(spec, opts.sandbox),
    governed: { gateway, tools: governedTools },
    // Claude Code only (ignored by Pi): the OPTIONAL model proxy endpoint (unset
    // → direct key injection, the bridge default, §4.1), locked-down egress
    // posture from the YAML network mode, the image's managed settings, and a
    // mid-invocation budget kill against this task's accrued spend (§4.3).
    proxy: spec.harness === "claude-code" ? (proxyUrl ? { baseUrl: proxyUrl } : undefined) : undefined,
    lockedDownEgress: spec.sandbox.network === "none",
    cli: { settingsPath: "/etc/marathon/claude-settings.json" },
    // TCP broker for macOS Docker Desktop (§3.1): set MARATHON_BROKER_HOST=host.docker.internal.
    brokerHost: process.env.MARATHON_BROKER_HOST?.trim() || undefined,
    getRemainingBudgetUsd: effectiveBudget
      ? async (ctx) => effectiveBudget.limitUsd - (await db.sumModelCostUsd(ctx.request.taskId))
      : undefined,
  });

  // Model from the spec (codex-impl.md §A.4 item 2/3): the `build` role for a
  // fresh implementation, `code-review` for a code_revision task — resolved
  // PER TASK since one BUILD step runner serves both (§A.4 item 3).
  const models = spec.models ?? DEFAULT_MODEL_POLICY;
  const modelRef = resolveModelRef(models, "build");
  const perTaskModelRef = (task: Task) =>
    resolveModelRef(models, (task.sourceRef as { kind?: unknown })?.kind === "code_revision" ? "code-review" : "build");

  const stepRunner = makeBuildStepRunner({
    db,
    runtime,
    registry,
    source: opts.source,
    modelRef: perTaskModelRef,
    instructions: spec.instructions,
    // Hard per-task cost cap (fails closed — Track 15): the spec's `budget:` or,
    // under a posture, the profile default (floor #7, §30.3).
    taskBudget: effectiveBudget,
    // §29.1a (combined-PR flow): the workspace IS the doc-PR branch, checked
    // out at `approvedSha` (the pinned doc-PR head), so the plan doc is ALREADY
    // in the tree at its doc_path — no materialization needed. This hook stays
    // as a defensive fallback (e.g. a shallow clone that somehow lacks the doc)
    // and reads at the commit SHA, which resolves regardless of branch; the
    // fresh-provision write is a no-op when the identical content is already
    // present, so it never dirties the diff.
    loadPlanDoc: async (task, { planRef }) => {
      const client = await opts.getClient({ taskId: task.id, tenantId: task.tenantId, secrets });
      const file = await client.readFileWithSha(planRef.repo, planRef.docPath, planRef.approvedSha);
      return { path: planRef.docPath, content: file.content };
    },
    defaultBranch: opts.defaultBranch,
    diffDir: opts.diffDir,
  });

  return { stepRunner, registry, gateway, modelRef };
}

/** Is this task a BUILD-stage task (implementation or code revision)? */
export function isBuildTask(task: Task): boolean {
  return resolveBuildBinding(task, parseCheckpoint(task.checkpoint)) !== null;
}

/**
 * Route BUILD-stage tasks to the BUILD runner and everything else to the
 * general agent runner — one worker can serve the whole loop.
 */
export function makeLoopStepRunner(db: Database, runners: { build: StepRunner; agent: StepRunner }): StepRunner {
  return async (ctx) => {
    const task = await db.getTask(ctx.taskId);
    if (task && isBuildTask(task)) return runners.build(ctx);
    return runners.agent(ctx);
  };
}
