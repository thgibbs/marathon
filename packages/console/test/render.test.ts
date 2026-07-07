import { describe, expect, it } from "vitest";
import type { Database } from "@marathon/db";
import { getTaskReport } from "@marathon/observability";
import { renderCommandsListPage, renderTaskDetailPage, triggerLink } from "../src/render";
import type { RecentCommand, RelatedTasks } from "../src/queries";
import { makeTask } from "./fixtures";

const PLANTED_SECRET = "sk-abcdefghijklmnopqrstuvwx";

function makeCommand(overrides: Partial<RecentCommand> = {}): RecentCommand {
  return {
    toolInvocationId: "ti-1",
    toolId: "github.read_file",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    status: "ok",
    error: null,
    inputSummary: "repo=o/r",
    outputSummary: "120 lines",
    taskId: "task-1",
    taskStatus: "completed",
    ...overrides,
  };
}

const NO_RELATED: RelatedTasks = { ancestors: [], latestDescendant: null, descendantCount: 0, siblings: [] };

describe("renderCommandsListPage", () => {
  it("redacts a planted secret in input_summary/output_summary", () => {
    const html = renderCommandsListPage(
      [makeCommand({ inputSummary: `token=${PLANTED_SECRET}`, outputSummary: `key: ${PLANTED_SECRET}` })],
      "tenant-1",
    );
    expect(html).not.toContain(PLANTED_SECRET);
    expect(html).toContain("[REDACTED]");
  });

  it("links the owning task to its detail page, carrying the active tenant", () => {
    const html = renderCommandsListPage([makeCommand({ taskId: "task-42" })], "tenant-1");
    expect(html).toContain('href="/tasks/task-42?tenantId=tenant-1"');
  });
});

describe("renderTaskDetailPage", () => {
  it("redacts a planted secret in input_text (Prompt section)", async () => {
    const task = makeTask({ inputText: `please use ${PLANTED_SECRET} to log in` });
    const db = emptyTimelineDb();
    const report = (await getTaskReport(db, task.tenantId, task.id))!;
    const html = renderTaskDetailPage(task, report, NO_RELATED, task.tenantId);
    expect(html).not.toContain(PLANTED_SECRET);
    expect(html).toContain("[REDACTED]");
  });

  it("timeline rendering matches getTaskTimeline/getTaskReport output for a fixture task", async () => {
    const task = makeTask({ id: "task-1", tenantId: "tenant-1" });
    const db = {
      getTask: async (id: string) => (id === task.id ? task : null),
      getTaskSteps: async () => [{ created_at: new Date("2026-01-01T00:00:01Z"), status: "ok", step_type: "load_context", retry_count: 0 }],
      getModelInvocations: async () => [
        { created_at: new Date("2026-01-01T00:00:02Z"), status: "ok", provider: "openai", model: "gpt-4o-mini", cost_usd: 0.002, input_tokens: 100, output_tokens: 20, prompt_version: "bruce@1" },
      ],
      getToolInvocations: async () => [
        { created_at: new Date("2026-01-01T00:00:03Z"), status: "ok", tool_id: "github.read_file", input_summary: "repo=o/r", output_summary: "120 lines" },
      ],
      listApprovalsForTask: async () => [],
      getTaskAuditEvents: async () => [],
      getCodeChangeByTask: async () => null,
      sumModelCostUsd: async () => 0.002,
    } as unknown as Database;

    const report = (await getTaskReport(db, "tenant-1", task.id))!;
    const html = renderTaskDetailPage(task, report, NO_RELATED, "tenant-1");
    for (const event of report.timeline) {
      expect(html).toContain(event.type);
      expect(html).toContain(event.at.toISOString());
    }
    expect(html).toContain("github.read_file");
    expect(html).toContain("gpt-4o-mini");
  });

  it("renders the related-tasks section: ancestors, descendant count, and siblings", async () => {
    const task = makeTask({ id: "task-1" });
    const db = emptyTimelineDb();
    const report = (await getTaskReport(db, task.tenantId, task.id))!;
    const related: RelatedTasks = {
      ancestors: [makeTask({ id: "ancestor-1" })],
      latestDescendant: makeTask({ id: "descendant-1" }),
      descendantCount: 2,
      siblings: [makeTask({ id: "sibling-1" })],
    };
    const html = renderTaskDetailPage(task, report, related, "tenant-1");
    expect(html).toContain('href="/tasks/ancestor-1?tenantId=tenant-1"');
    expect(html).toContain('href="/tasks/descendant-1?tenantId=tenant-1"');
    expect(html).toContain("2 total");
    expect(html).toContain('href="/tasks/sibling-1?tenantId=tenant-1"');
  });
});

describe("triggerLink", () => {
  it("builds a GitHub PR/issue comment link when the source_ref carries enough", () => {
    const task = makeTask({ sourceType: "github", sourceRef: { repo: "o/r", number: 7, comment_id: 99, kind: "pr" } });
    expect(triggerLink(task)).toEqual({ label: "o/r#7", href: "https://github.com/o/r/pull/7#issuecomment-99" });
  });

  it("falls back to a plain label for Slack (no workspace domain to build a permalink)", () => {
    const task = makeTask({ sourceType: "slack", sourceRef: { channel: "C1", thread_ts: "1.0" } });
    expect(triggerLink(task)).toEqual({ label: "slack C1/1.0" });
  });
});

function emptyTimelineDb(): Database {
  return {
    getTask: async () => makeTask(),
    getTaskSteps: async () => [],
    getModelInvocations: async () => [],
    getToolInvocations: async () => [],
    listApprovalsForTask: async () => [],
    getTaskAuditEvents: async () => [],
    getCodeChangeByTask: async () => null,
    sumModelCostUsd: async () => 0,
  } as unknown as Database;
}
