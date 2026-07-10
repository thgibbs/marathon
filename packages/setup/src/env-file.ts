/**
 * Minimal `.env` value filler: replaces `KEY=…` lines in place and appends
 * keys that aren't present, leaving every other line — comments, blanks,
 * unrelated keys — byte-for-byte untouched. Deliberately NOT a full dotenv
 * parser: `.env.example` is the source of truth for structure and the
 * explanatory comments there must survive the edit.
 */
export function upsertEnvValues(content: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = content.split("\n").map((line) => {
    for (const [key, value] of remaining) {
      // `KEY=` is an exact key match: the "=" terminates it, so e.g.
      // GITHUB_APP_PRIVATE_KEY never swallows GITHUB_APP_PRIVATE_KEY_PATH.
      if (line.startsWith(`${key}=`)) {
        remaining.delete(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });
  let out = lines.join("\n");
  if (remaining.size > 0) {
    const appended = [...remaining].map(([k, v]) => `${k}=${v}`).join("\n");
    out = (out.endsWith("\n") ? out : `${out}\n`) + appended + "\n";
  }
  return out;
}
