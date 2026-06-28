import type { SecretStore } from "@marathon/config";
import type { Embedder } from "./types";

/** Matches OpenAI text-embedding-3-small so Fake↔OpenAI share the pgvector column. */
export const EMBED_DIM = 1536;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

// FNV-1a 32-bit
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-words hashing embedder for tests/CI/demos: texts that share
 * tokens get high cosine similarity, with no network/keys. NOT semantic — only for
 * deterministic ranking. Production uses {@link OpenAIEmbedder}.
 */
export class FakeEmbedder implements Embedder {
  readonly dimensions = EMBED_DIM;
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const tok of tokenize(text)) {
      const i = hash(tok) % this.dimensions;
      v[i] = (v[i] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

/** Real embeddings via the OpenAI embeddings API (text-embedding-3-small). */
export class OpenAIEmbedder implements Embedder {
  readonly dimensions = EMBED_DIM;
  constructor(
    private readonly secrets: SecretStore,
    private readonly model = "text-embedding-3-small",
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {}

  async embed(text: string): Promise<number[]> {
    const key = await this.secrets.get("secret/openai");
    if (!key) throw new Error("no OpenAI key for embeddings (OPENAI_API_KEY)");
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return j.data[0]!.embedding;
  }
}
