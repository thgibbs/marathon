/** Configuration + a minimal secret-store abstraction (env-backed for dev). */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface Config {
  databaseUrl: string;
  /** Master key used to encrypt secrets at rest (provisioned by the operator). */
  secretKey: string | undefined;
  /** Directory of YAML agent definitions (Track 14; design §6.2), default `agents/`. */
  agentsDir: string;
  /**
   * Deployment tenant name (§2b #14). When set, every live app binds its
   * surface (Slack team, GitHub owner) to this ONE tenant, so cross-surface
   * lookups (doc artifacts, tasks, memory) see each other's work. Unset →
   * each surface bootstraps its own tenant (demo/test behavior).
   */
  tenant: string | undefined;
}

const DEFAULT_DATABASE_URL = "postgres://marathon:marathon@localhost:5432/marathon";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    secretKey: env.MARATHON_SECRET_KEY,
    agentsDir: env.MARATHON_AGENTS_DIR ?? "agents",
    tenant: env.MARATHON_TENANT?.trim() || undefined,
  };
}

/**
 * Secret store. Refs look like "secret/<name>" (e.g. "secret/anthropic").
 * Production will back this with an encrypted store; for dev we resolve from env.
 */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
}

export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(ref: string): Promise<string | undefined> {
    const name = ref.startsWith("secret/") ? ref.slice("secret/".length) : ref;
    const key = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return this.env[key] ?? this.env[`${key}_API_KEY`] ?? this.env[`${key}_TOKEN`];
  }
}

/** Which agent harness runs the in-task loop (design §7.5; claude-code lands with K7). */
export type AgentHarness = "pi" | "claude-code";

/**
 * One tool grant in an agent spec. For the brokered exec tools
 * (`github.exec` / `git.exec`), `families` narrows the allowed command
 * families (e.g. `"pr view"`, `"push"`); omitted means the tool's defaults.
 */
export interface AgentToolGrant {
  tool: string;
  families?: string[];
}

/** BUILD-sandbox settings: internet-enabled by default, never any company secrets. */
export interface AgentSandboxConfig {
  /** Docker network for BUILD containers: "bridge" (internet, default) or "none". */
  network: "bridge" | "none";
}

/** Role -> "provider:model" mapping (design §7.10); structurally a ModelPolicy. */
export interface AgentModelPolicy {
  default: string;
  [role: string]: string;
}

/** Hard per-task spend cap (design §7.11); structurally a BudgetPolicy. */
export interface AgentBudget {
  limitUsd: number;
  /** Warn when spend crosses this fraction of the limit (0..1]. */
  warnRatio?: number;
}

/**
 * The default plans branch (§29.1a): where design-doc PRs merge (the approval).
 * Deliberately OUTSIDE the agent-owned `marathon/*` push namespace — rulesets
 * are the final enforcement on the brokered push path, so the approval
 * boundary must not live in the prefix agents push to.
 */
export const DEFAULT_PLANS_BRANCH = "marathon-plans";

/** Plan-document settings (§29.1a): where doc PRs merge. */
export interface AgentPlansConfig {
  /** The plans branch; must NOT be under `marathon/` (the agent push namespace). */
  branch: string;
}

/**
 * A YAML-defined agent (design §6.2 / §21.0; Track 14): identity +
 * instructions plus the full runtime config — harness, the ONE configured
 * repo, tool grants (including brokered `gh`/`git` command families), sandbox
 * network mode, model policy, and budget caps. Grants are enforced by
 * construction (§7.8); the instructions just explain them.
 */
export interface AgentSpec {
  name: string;
  displayName?: string;
  description?: string;
  instructions: string;
  /** Harness for this agent's loop; default "pi" (claude-code is K7). */
  harness: AgentHarness;
  /** The ONE configured target repo, "owner/repo" (§0.4). */
  repo?: string;
  /** Tool grants (empty = no gateway tools). */
  tools: AgentToolGrant[];
  /** Sandbox settings; default internet-enabled ("bridge"), credential-free. */
  sandbox: AgentSandboxConfig;
  /** Plans-branch settings (§29.1a); default `marathon-plans`. */
  plans: AgentPlansConfig;
  /** Model routing; when omitted the deployment default policy applies. */
  models?: AgentModelPolicy;
  /** Hard spend cap; when omitted no budget is enforced. */
  budget?: AgentBudget;
  /** Keywords used for default-agent selection on multi-agent deployments. */
  keywords?: string[];
}

const AGENT_NAME_RE = /^[a-z][a-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const HARNESSES: AgentHarness[] = ["pi", "claude-code"];
const NETWORKS: AgentSandboxConfig["network"][] = ["bridge", "none"];

function parseToolGrant(entry: unknown, source: string, i: number): AgentToolGrant {
  if (typeof entry === "string" && entry.trim()) return { tool: entry.trim() };
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    const tool = e.tool ?? e.name;
    if (typeof tool !== "string" || !tool.trim()) {
      throw new Error(`${source}: tools[${i}] needs a 'tool' name`);
    }
    const grant: AgentToolGrant = { tool: tool.trim() };
    if (e.families !== undefined) {
      if (!Array.isArray(e.families) || !e.families.every((f) => typeof f === "string" && f.trim())) {
        throw new Error(`${source}: tools[${i}].families must be a list of command families`);
      }
      grant.families = (e.families as string[]).map((f) => f.trim());
    }
    return grant;
  }
  throw new Error(`${source}: tools[${i}] must be a tool name or a { tool, families? } mapping`);
}

/** Validate a parsed YAML value into an AgentSpec; throws with a precise reason. */
export function parseAgentSpec(value: unknown, source = "agent spec"): AgentSpec {
  if (!value || typeof value !== "object") throw new Error(`${source}: expected a YAML mapping`);
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !AGENT_NAME_RE.test(v.name)) {
    throw new Error(`${source}: 'name' must match ${AGENT_NAME_RE} (got ${JSON.stringify(v.name)})`);
  }
  if (typeof v.instructions !== "string" || !v.instructions.trim()) {
    throw new Error(`${source}: 'instructions' (non-empty string) is required`);
  }
  const spec: AgentSpec = {
    name: v.name,
    instructions: v.instructions.trim(),
    harness: "pi",
    tools: [],
    sandbox: { network: "bridge" },
    plans: { branch: DEFAULT_PLANS_BRANCH },
  };
  if (typeof v.display_name === "string") spec.displayName = v.display_name;
  if (typeof v.description === "string") spec.description = v.description;

  if (v.harness !== undefined) {
    if (!HARNESSES.includes(v.harness as AgentHarness)) {
      throw new Error(`${source}: 'harness' must be one of ${HARNESSES.join(" | ")}`);
    }
    spec.harness = v.harness as AgentHarness;
  }
  if (v.repo !== undefined) {
    if (typeof v.repo !== "string" || !REPO_RE.test(v.repo)) {
      throw new Error(`${source}: 'repo' must be "owner/repo"`);
    }
    spec.repo = v.repo;
  }
  if (v.tools !== undefined) {
    if (!Array.isArray(v.tools)) throw new Error(`${source}: 'tools' must be a list`);
    spec.tools = v.tools.map((t, i) => parseToolGrant(t, source, i));
  }
  if (v.sandbox !== undefined) {
    if (!v.sandbox || typeof v.sandbox !== "object") {
      throw new Error(`${source}: 'sandbox' must be a mapping`);
    }
    const s = v.sandbox as Record<string, unknown>;
    if (s.network !== undefined) {
      if (!NETWORKS.includes(s.network as AgentSandboxConfig["network"])) {
        throw new Error(`${source}: 'sandbox.network' must be one of ${NETWORKS.join(" | ")}`);
      }
      spec.sandbox.network = s.network as AgentSandboxConfig["network"];
    }
  }
  if (v.plans !== undefined) {
    if (!v.plans || typeof v.plans !== "object") {
      throw new Error(`${source}: 'plans' must be a mapping`);
    }
    const p = v.plans as Record<string, unknown>;
    if (p.branch !== undefined) {
      if (typeof p.branch !== "string" || !p.branch.trim()) {
        throw new Error(`${source}: 'plans.branch' must be a non-empty branch name`);
      }
      const branch = p.branch.trim();
      // §29.1a: the plans branch is an approval boundary — it must sit OUTSIDE
      // the agent-owned push namespace, or rulesets that open marathon/* to
      // agent pushes would open the approval boundary too. Refuse at boot.
      if (branch === "marathon" || branch.startsWith("marathon/")) {
        throw new Error(
          `${source}: 'plans.branch' must not be under the agent push namespace 'marathon/' (got "${branch}") — §29.1a`,
        );
      }
      spec.plans.branch = branch;
    }
  }
  if (v.models !== undefined) {
    if (!v.models || typeof v.models !== "object" || Array.isArray(v.models)) {
      throw new Error(`${source}: 'models' must be a mapping of role -> "provider:model"`);
    }
    const m = v.models as Record<string, unknown>;
    if (typeof m.default !== "string" || !m.default.includes(":")) {
      throw new Error(`${source}: 'models.default' ("provider:model") is required`);
    }
    const models: AgentModelPolicy = { default: m.default };
    for (const [role, ref] of Object.entries(m)) {
      if (typeof ref !== "string" || !ref.includes(":")) {
        throw new Error(`${source}: 'models.${role}' must be "provider:model"`);
      }
      models[role] = ref;
    }
    spec.models = models;
  }
  if (v.budget !== undefined) {
    if (!v.budget || typeof v.budget !== "object") {
      throw new Error(`${source}: 'budget' must be a mapping`);
    }
    const b = v.budget as Record<string, unknown>;
    const limit = b.limit_usd ?? b.limitUsd;
    if (typeof limit !== "number" || !(limit > 0)) {
      throw new Error(`${source}: 'budget.limit_usd' must be a positive number`);
    }
    spec.budget = { limitUsd: limit };
    const warn = b.warn_ratio ?? b.warnRatio;
    if (warn !== undefined) {
      if (typeof warn !== "number" || !(warn > 0) || warn > 1) {
        throw new Error(`${source}: 'budget.warn_ratio' must be in (0, 1]`);
      }
      spec.budget.warnRatio = warn;
    }
  }
  if (v.keywords !== undefined) {
    if (!Array.isArray(v.keywords) || !v.keywords.every((k) => typeof k === "string" && k.trim())) {
      throw new Error(`${source}: 'keywords' must be a list of strings`);
    }
    spec.keywords = (v.keywords as string[]).map((k) => k.trim());
  }
  return spec;
}

/** Load an agent spec from a YAML file (e.g. `agents/forge.yaml`). */
export async function loadAgentSpec(path: string): Promise<AgentSpec> {
  const raw = await readFile(path, "utf8");
  const spec = parseAgentSpec(parseYaml(raw), path);
  // Fail closed at load if the harness/model pairing is invalid (§13.1); the
  // proxy check is deferred to the wiring site, which knows the endpoint.
  validateHarnessConfig(spec);
  return spec;
}

/**
 * Resolve the agents directory. Absolute paths are used as-is; a relative
 * path (the `MARATHON_AGENTS_DIR=agents` default) is searched UPWARD from
 * `from` — the live entrypoints run with a package directory as their cwd
 * (`pnpm --filter … live`), so "agents" must find the repo root's directory,
 * not `demos/<app>/agents`. Falls back to plain cwd resolution when nothing
 * is found, so the caller's readdir error names the path that was tried.
 */
export function resolveAgentsDir(dir: string, from = process.cwd()): string {
  if (isAbsolute(dir)) return dir;
  let cur = resolve(from);
  for (;;) {
    const candidate = join(cur, dir);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return resolve(from, dir);
    cur = parent;
  }
}

/**
 * Load every agent spec in a directory (`*.yaml` / `*.yml`, sorted by
 * filename — the first file is the deployment's default agent). This is how
 * the Slack/GitHub apps read their configured agents (Track 14): written by
 * the operator, versioned in git, applied by restart.
 */
export async function loadAgentSpecs(dir: string): Promise<AgentSpec[]> {
  dir = resolveAgentsDir(dir);
  const entries = await readdir(dir);
  const files = entries.filter((f) => /\.ya?ml$/.test(f)).sort();
  if (files.length === 0) throw new Error(`${dir}: no agent YAML files found`);
  const specs: AgentSpec[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const spec = await loadAgentSpec(join(dir, f));
    if (seen.has(spec.name)) throw new Error(`${dir}: duplicate agent name '${spec.name}' (${f})`);
    seen.add(spec.name);
    specs.push(spec);
  }
  return specs;
}

/** The command families granted to `tool` in a spec (e.g. for `github.exec`). */
export function grantFamilies(spec: AgentSpec, tool: string): string[] | undefined {
  return spec.tools.find((t) => t.tool === tool)?.families;
}

/**
 * Fail-closed cross-validation for the Claude Code harness (K7, design §13.1:
 * the harness choice constrains the provider). An agent with `harness:
 * claude-code` MUST route to an Anthropic model — Claude Code speaks only the
 * Anthropic API — so every model ref in its policy must be `anthropic:*`, and a
 * policy must be present (the deployment default is provider-agnostic and could
 * be OpenAI). `opts.proxyConfigured` additionally asserts the wiring supplies a
 * model proxy (the key-injecting endpoint); pass it from the wiring site.
 * A no-op for the Pi harness. Throws with a precise reason.
 */
export function validateHarnessConfig(spec: AgentSpec, opts: { proxyConfigured?: boolean } = {}): void {
  if (spec.harness !== "claude-code") return;
  const source = `agent '${spec.name}'`;
  if (!spec.models) {
    throw new Error(
      `${source}: harness 'claude-code' requires an Anthropic 'models' policy (§13.1) — the deployment default may not be Anthropic`,
    );
  }
  for (const [role, ref] of Object.entries(spec.models)) {
    const provider = ref.split(":")[0];
    if (provider !== "anthropic") {
      throw new Error(
        `${source}: harness 'claude-code' requires Anthropic models, but models.${role} is "${ref}" (§13.1)`,
      );
    }
  }
  if (opts.proxyConfigured === false) {
    throw new Error(`${source}: harness 'claude-code' requires a configured model proxy (§4.1)`);
  }
}
