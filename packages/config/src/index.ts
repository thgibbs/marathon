/** Configuration + a minimal secret-store abstraction (env-backed for dev). */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export interface Config {
  databaseUrl: string;
  /** Master key used to encrypt secrets at rest (provisioned by the operator). */
  secretKey: string | undefined;
}

const DEFAULT_DATABASE_URL = "postgres://marathon:marathon@localhost:5432/marathon";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    secretKey: env.MARATHON_SECRET_KEY,
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

/**
 * A YAML-defined agent (Track 12; design §21, Track 14 grows this toward the
 * full config — harness, repo, tool grants, model policy). For now: identity +
 * the instructions that flow through an AgentVersion into prompt assembly.
 */
export interface AgentSpec {
  name: string;
  displayName?: string;
  description?: string;
  instructions: string;
}

const AGENT_NAME_RE = /^[a-z][a-z0-9-]*$/;

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
  const spec: AgentSpec = { name: v.name, instructions: v.instructions.trim() };
  if (typeof v.display_name === "string") spec.displayName = v.display_name;
  if (typeof v.description === "string") spec.description = v.description;
  return spec;
}

/** Load an agent spec from a YAML file (e.g. `agents/forge.yaml`). */
export async function loadAgentSpec(path: string): Promise<AgentSpec> {
  const raw = await readFile(path, "utf8");
  return parseAgentSpec(parseYaml(raw), path);
}
