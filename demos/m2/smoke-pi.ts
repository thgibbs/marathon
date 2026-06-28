/**
 * LOCAL-ONLY smoke test for the real Pi adapter (NOT run in CI).
 *
 * Requires @earendil-works/pi-coding-agent installed and a real model key
 * (e.g. ANTHROPIC_API_KEY in the env or ~/.pi/agent/auth.json). Makes a tiny
 * live model call to verify the PiAgentRuntime wiring end-to-end.
 *
 *   make smoke-pi   (or: pnpm --filter @marathon/demo-m2 smoke)
 */
import { EnvSecretStore } from "@marathon/config";
import { PiAgentRuntime } from "@marathon/agent";
import { emptyCheckpoint } from "@marathon/core";

async function main(): Promise<void> {
  // Use a real Pi model id. Override with SMOKE_MODEL=provider:model.
  const modelRef = process.env.SMOKE_MODEL ?? "openai:gpt-4o-mini";
  const runtime = new PiAgentRuntime({ secrets: new EnvSecretStore() });

  console.log(`[smoke-pi] calling ${modelRef} ...`);
  const turn = await runtime.nextTurn({
    request: {
      taskId: "smoke",
      instructions: "Reply with exactly: OK",
      input: "Reply with exactly: OK",
      modelRef,
    },
    checkpoint: emptyCheckpoint(),
  });

  console.log(`[smoke-pi] text: ${JSON.stringify(turn.text)}`);
  console.log(`[smoke-pi] usage:`, turn.modelInvocation);
  if (!turn.text) throw new Error("no text returned from model");
  console.log("smoke-pi OK");
}

main().catch((err) => {
  console.error("smoke-pi FAILED:", err);
  process.exit(1);
});
