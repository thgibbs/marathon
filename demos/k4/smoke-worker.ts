/**
 * The killable child of the K4 live smoke: leases the implementation task and
 * runs the REAL Pi BUILD stage until the parent SIGKILLs it mid-run. Its only
 * job is to leave durable per-turn checkpoints behind.
 */
import { makeSmokeWorker, smokeEnvFromProcess } from "./smoke-shared";

const { worker, db, queue } = makeSmokeWorker(smokeEnvFromProcess(), 60_000);
try {
  const outcome = await worker.runOnce();
  // Normally unreachable — the parent kills us mid-BUILD. Reaching here means
  // the kill came too late; the parent detects that via task state.
  console.log(`[k4-child] outcome: ${outcome}`);
} finally {
  await db.close();
  await queue.close();
}
