import { describe, expect, it } from "vitest";
import type { Database } from "@marathon/db";
import { getRelatedTasks, listRecentCommands } from "../src/queries";
import { makeTask } from "./fixtures";

describe("listRecentCommands", () => {
  it("maps raw tool_invocation rows and passes tenant + limit through", async () => {
    let seen: [string, number] | undefined;
    const db = {
      listRecentToolInvocations: async (tenantId: string, limit: number) => {
        seen = [tenantId, limit];
        return [
          {
            id: "ti-1",
            tool_id: "github.read_file",
            created_at: new Date("2026-01-01T00:00:00Z"),
            status: "ok",
            error: null,
            input_summary: "repo=o/r path=README.md",
            output_summary: "120 lines",
            task_id: "task-1",
            task_status: "completed",
          },
        ];
      },
    } as unknown as Database;

    const commands = await listRecentCommands(db, "tenant-1", 50);
    expect(seen).toEqual(["tenant-1", 50]);
    expect(commands).toEqual([
      {
        toolInvocationId: "ti-1",
        toolId: "github.read_file",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        status: "ok",
        error: null,
        inputSummary: "repo=o/r path=README.md",
        outputSummary: "120 lines",
        taskId: "task-1",
        taskStatus: "completed",
      },
    ]);
  });
});

describe("getRelatedTasks", () => {
  it("walks chain ancestry up via source_task_id, stopping at a cross-tenant ancestor", async () => {
    const grandparent = makeTask({ id: "gp", tenantId: "other-tenant", sourceTaskId: null });
    const parent = makeTask({ id: "p", tenantId: "tenant-1", sourceTaskId: "gp" });
    const task = makeTask({ id: "task-1", tenantId: "tenant-1", sourceTaskId: "p" });
    const db = {
      getTask: async (id: string) => ({ p: parent, gp: grandparent }[id] ?? null),
      findTaskBySourceTask: async () => null,
      countTasksBySourceTask: async () => 0,
    } as unknown as Database;

    const related = await getRelatedTasks(db, "tenant-1", task);
    // grandparent belongs to another tenant — the walk stops before including it.
    expect(related.ancestors.map((t) => t.id)).toEqual(["p"]);
  });

  it("reports the latest descendant and total descendant count", async () => {
    const descendant = makeTask({ id: "child", sourceTaskId: "task-1" });
    const task = makeTask({ id: "task-1" });
    const db = {
      getTask: async () => null,
      findTaskBySourceTask: async (sourceTaskId: string) => (sourceTaskId === "task-1" ? descendant : null),
      countTasksBySourceTask: async (sourceTaskId: string) => (sourceTaskId === "task-1" ? 3 : 0),
    } as unknown as Database;

    const related = await getRelatedTasks(db, "tenant-1", task);
    expect(related.latestDescendant?.id).toBe("child");
    expect(related.descendantCount).toBe(3);
  });

  it("finds Slack thread siblings, excluding the task itself", async () => {
    const task = makeTask({ id: "task-1", sourceType: "slack", sourceRef: { channel: "C1", thread_ts: "1.0" } });
    const sibling = makeTask({ id: "task-2", sourceType: "slack", sourceRef: { channel: "C1", thread_ts: "1.0" } });
    const db = {
      getTask: async () => null,
      findTaskBySourceTask: async () => null,
      countTasksBySourceTask: async () => 0,
      listTasksByThread: async () => [task, sibling],
    } as unknown as Database;

    const related = await getRelatedTasks(db, "tenant-1", task);
    expect(related.siblings.map((t) => t.id)).toEqual(["task-2"]);
  });

  it("finds GitHub PR-revision siblings, excluding the task itself", async () => {
    const sourceRef = { kind: "code_revision", repo: "o/r", prNumber: 7 };
    const task = makeTask({ id: "task-1", sourceType: "github", sourceRef });
    const sibling = makeTask({ id: "task-2", sourceType: "github", sourceRef });
    const db = {
      getTask: async () => null,
      findTaskBySourceTask: async () => null,
      countTasksBySourceTask: async () => 0,
      listTasksByRevisionPr: async () => [sibling, task],
    } as unknown as Database;

    const related = await getRelatedTasks(db, "tenant-1", task);
    expect(related.siblings.map((t) => t.id)).toEqual(["task-2"]);
  });
});
