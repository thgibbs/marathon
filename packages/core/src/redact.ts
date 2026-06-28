/** Secret redaction for traces. On by default; toggle off per call. */

const DEFAULT_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI/Anthropic-style API keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub PATs
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
];

export interface RedactOptions {
  /** Redaction is on by default; set false to disable. */
  enabled?: boolean;
  patterns?: RegExp[];
}

export function redactSecrets(text: string, opts: RedactOptions = {}): string {
  if (opts.enabled === false) return text;
  let out = text;
  for (const pattern of opts.patterns ?? DEFAULT_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
