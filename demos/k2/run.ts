/**
 * demo-k2 (roadmap K2; code-migration.md Track 17): delivery targets fan out
 * to EVERY surface the task reports to — the originating Slack thread AND the
 * plan's doc PR — idempotently, with cross-links between the surfaces and the
 * silent cost footer (Track 16, §13.3) on the delivered result.
 *
 *   make demo-k2        (fully in-memory: no Postgres, no Docker, no keys)
 *
 * Proves:
 *   1. one result -> delivered once to each target, each copy cross-linking
 *      the other surfaces;
 *   2. redelivery (webhook/queue retry) -> deduped per (task, target, kind);
 *   3. a target with no wired adapter is reported, not silently dropped;
 *   4. the same fan-out serves `delivery.report_pr` — the BUILD stage's final
 *      step — including the cost footer on the rendered message.
 */
import { CodeTaskRegistry, InMemoryCodeChangeStore, type CodeWorkspace } from "@marathon/code-handoff";
import type { SecretStore } from "@marathon/config";
import { FixturesGithubClient, makeDeliveryReportTool } from "@marathon/connector-github";
import { InMemoryIdempotencyStore, type DeliveryTarget } from "@marathon/core";
import {
  DeliveryFanout,
  renderResultText,
  type StructuredResult,
  type SurfaceAdapter,
} from "@marathon/surface";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Records what a surface would post (the demo's stand-in for Slack/GitHub). */
class RecordingAdapter implements SurfaceAdapter {
  public readonly posts: Array<{ ref: Record<string, unknown>; text: string; result: StructuredResult }> = [];
  async acknowledge(): Promise<void> {}
  async postProgress(): Promise<void> {}
  async deliverResult(ref: Record<string, unknown>, result: StructuredResult): Promise<void> {
    this.posts.push({ ref, text: renderResultText(result), result });
  }
}

const REPO = "acme/service";
const TASK = "task-impl-1";
const PLAN = { repo: REPO, docPath: "docs/plan.md", mergeCommitSha: "abc123" };

async function main(): Promise<void> {
  const slack = new RecordingAdapter();
  const github = new RecordingAdapter();
  const fanout = new DeliveryFanout({ slack, github }, new InMemoryIdempotencyStore());

  // The task chain's inherited targets (K2): the originating Slack thread and
  // the merged plan's doc PR.
  const targets: DeliveryTarget[] = [
    { surfaceType: "slack", ref: { channel: "C_GENERAL", thread_ts: "1700000000.0001" } },
    { surfaceType: "github", ref: { repo: REPO, number: 41, kind: "pr" } },
  ];

  // 1. one result -> every target, cross-linked.
  const outcomes = await fanout.deliverResult(TASK, targets, { summary: "Implemented the plan." });
  assert(outcomes.every((o) => o.status === "delivered"), `expected all delivered, got ${JSON.stringify(outcomes)}`);
  assert(slack.posts.length === 1 && github.posts.length === 1, "each target heard the result exactly once");
  assert(
    slack.posts[0]!.result.crossLinks!.some((l) => l.includes("/pull/41")),
    "the Slack copy should cross-link the doc PR",
  );
  assert(
    github.posts[0]!.result.crossLinks!.some((l) => l.toLowerCase().includes("slack")),
    "the doc PR copy should cross-link the Slack thread",
  );
  console.log("[k2] one result -> Slack thread + doc PR, cross-linked ✓");

  // 2. redelivery converges: same task/target/kind is deduped, not re-posted.
  const retry = await fanout.deliverResult(TASK, targets, { summary: "Implemented the plan." });
  assert(retry.every((o) => o.status === "deduped"), "retried delivery must dedupe per target");
  assert(slack.posts.length === 1 && github.posts.length === 1, "no double-posts on retry");
  console.log("[k2] redelivery deduped per (task, target, kind) ✓");

  // 3. an unwired surface is reported as no_adapter — visible, not dropped.
  const partial = new DeliveryFanout({ slack }, new InMemoryIdempotencyStore());
  const partialOutcomes = await partial.deliverResult(TASK, targets, { summary: "s" });
  assert(
    partialOutcomes.some((o) => o.status === "no_adapter"),
    "a target without an adapter must surface as no_adapter",
  );
  console.log("[k2] unwired target reported (no_adapter), never silently dropped ✓");

  // 4. the BUILD stage's delivery.report_pr rides the same fan-out (Track 7)
  // and carries the cost footer (Track 16, §13.3).
  const client = new FixturesGithubClient({});
  const registry = new CodeTaskRegistry();
  registry.set(TASK, { workspace: {} as never as CodeWorkspace, planRef: PLAN, repo: REPO, baseSha: PLAN.mergeCommitSha });
  const reportFanout = new DeliveryFanout({ slack, github }, new InMemoryIdempotencyStore());
  const report = makeDeliveryReportTool({
    getClient: () => client,
    registry,
    store: new InMemoryCodeChangeStore(),
    fanout: reportFanout,
    getDeliveryTargets: async () => targets,
    getCostUsd: async () => 0.0173,
  });
  const pr = await client.createPullRequest(REPO, "Implement the plan", "marathon/task-impl-1-plan", "main");
  const secrets: SecretStore = { get: async () => "fixture-token" };
  const res = await report.execute!(
    { pr_url: pr.url, summary: "Opened the code PR.", verification: [{ command: "pnpm test", exit_code: 0 }] },
    { taskId: TASK, tenantId: "tenant-1", secrets },
  );
  assert((res.details as { delivered: number }).delivered === 2, "the PR link reached both targets");
  const slackPost = slack.posts.at(-1)!;
  assert(slackPost.text.includes(pr.url), "the Slack thread heard the PR link");
  assert(slackPost.text.includes("_cost: $0.0173_"), "the delivered message carries the silent cost footer");
  assert(github.posts.at(-1)!.text.includes(pr.url), "the doc PR heard the PR link");
  console.log("[k2] delivery.report_pr -> both surfaces, with the cost footer ✓");

  console.log("demo-k2 OK");
}

main().catch((err) => {
  console.error("demo-k2 FAILED:", err);
  process.exit(1);
});
