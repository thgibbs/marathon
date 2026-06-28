/**
 * LOCAL-ONLY smoke for the Mem0 memory backend (the first external adapter).
 * Skips gracefully if MEM0_API_KEY isn't set.
 *
 *   make smoke-mem0
 */
import { Mem0MemoryStore } from "@marathon/memory";

async function main(): Promise<void> {
  const key = process.env.MEM0_API_KEY?.trim();
  if (!key) {
    console.warn("smoke-mem0 SKIPPED: set MEM0_API_KEY (and optionally MEM0_BASE_URL) to run.");
    return;
  }
  const store = new Mem0MemoryStore(key, process.env.MEM0_BASE_URL ?? undefined);
  const scope = { tenantId: `marathon-smoke-${Date.now()}`, agentId: "bruce" };
  const marker = `checkout errors trace to PR-${Date.now()}`;

  console.log("[smoke-mem0] remember ...");
  const item = await store.remember({ scope, level: "agent", term: "long", kind: "correction", text: marker });
  console.log(`  stored id=${item.id}`);

  console.log("[smoke-mem0] recall ...");
  const hits = await store.recall({ query: "why did checkout errors happen", scope, limit: 5 });
  console.log(`  recalled ${hits.length} item(s)`);
  if (!hits.some((h) => h.text.includes("checkout"))) throw new Error("expected to recall the stored memory");

  console.log("smoke-mem0 OK");
}

main().catch((err) => {
  console.error("smoke-mem0 FAILED:", err);
  process.exit(1);
});
