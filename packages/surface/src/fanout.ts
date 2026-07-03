import {
  deliveryTargetKey,
  runOnce,
  type DeliveryTarget,
  type IdempotencyStore,
  type SurfaceType,
} from "@marathon/core";
import type { StructuredResult, SurfaceAdapter } from "./types";

export type DeliveryStatus = "delivered" | "deduped" | "no_adapter";

export interface DeliveryOutcome {
  target: DeliveryTarget;
  status: DeliveryStatus;
}

/**
 * Human-readable pointer to a target, used to cross-link the surfaces a task
 * delivers to (K2): each place hears where else the update landed.
 */
export function describeTarget(target: DeliveryTarget): string {
  const ref = target.ref;
  if (target.surfaceType === "github" && ref.repo != null && ref.number != null) {
    const kind = ref.kind === "pr" ? "pull" : "issues";
    return `https://github.com/${String(ref.repo)}/${kind}/${String(ref.number)}`;
  }
  if (target.surfaceType === "slack" && ref.channel != null) {
    const thread = ref.thread_ts != null ? `, thread ${String(ref.thread_ts)}` : "";
    return `Slack channel ${String(ref.channel)}${thread}`;
  }
  return `${target.surfaceType} ${JSON.stringify(ref)}`;
}

/**
 * Fan-out delivery (design §10.8, K2): send progress and results to every
 * `delivery_target` of a task, exactly once per (task, target, message kind).
 * Targets whose surface has no adapter configured are skipped (reported as
 * `no_adapter`), so one deployment can run with any subset of surfaces.
 */
export class DeliveryFanout {
  constructor(
    private readonly adapters: Partial<Record<SurfaceType, SurfaceAdapter>>,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async postProgress(
    taskId: string,
    targets: DeliveryTarget[],
    message: string,
    messageKind: string,
  ): Promise<DeliveryOutcome[]> {
    return this.fanOut(taskId, targets, messageKind, (adapter, target) =>
      adapter.postProgress(target.ref, message),
    );
  }

  async deliverResult(
    taskId: string,
    targets: DeliveryTarget[],
    result: StructuredResult,
    messageKind = "result",
  ): Promise<DeliveryOutcome[]> {
    return this.fanOut(taskId, targets, messageKind, (adapter, target) => {
      const others = targets.filter((t) => t !== target);
      const linked: StructuredResult =
        others.length > 0 ? { ...result, crossLinks: others.map(describeTarget) } : result;
      return adapter.deliverResult(target.ref, linked);
    });
  }

  private async fanOut(
    taskId: string,
    targets: DeliveryTarget[],
    messageKind: string,
    send: (adapter: SurfaceAdapter, target: DeliveryTarget) => Promise<void>,
  ): Promise<DeliveryOutcome[]> {
    const outcomes: DeliveryOutcome[] = [];
    for (const target of targets) {
      const adapter = this.adapters[target.surfaceType];
      if (!adapter) {
        outcomes.push({ target, status: "no_adapter" });
        continue;
      }
      const key = deliveryTargetKey(taskId, target, messageKind);
      const { executed } = await runOnce(this.idempotency, key, () => send(adapter, target));
      outcomes.push({ target, status: executed ? "delivered" : "deduped" });
    }
    return outcomes;
  }
}
