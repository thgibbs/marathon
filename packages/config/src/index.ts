/** Configuration + a minimal secret-store abstraction (env-backed for dev). */

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
    return this.env[key] ?? this.env[`${key}_API_KEY`];
  }
}
