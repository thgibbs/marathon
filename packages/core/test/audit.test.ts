import { describe, expect, it } from "vitest";
import { InMemoryAuditWriter } from "../src/audit";
import { newId } from "../src/ids";

describe("InMemoryAuditWriter", () => {
  it("records events with generated id and timestamp", async () => {
    const writer = new InMemoryAuditWriter();
    const tenantId = newId();

    const ev = await writer.write({
      tenantId,
      eventType: "task.created",
      targetType: "task",
      targetId: "t1",
      summary: "created",
    });

    expect(ev.id).toBeTruthy();
    expect(ev.createdAt).toBeInstanceOf(Date);
    expect(writer.events).toHaveLength(1);
    expect(writer.events[0]?.eventType).toBe("task.created");
    expect(writer.events[0]?.tenantId).toBe(tenantId);
  });

  it("appends in order", async () => {
    const writer = new InMemoryAuditWriter();
    const tenantId = newId();
    await writer.write({ tenantId, eventType: "task.created" });
    await writer.write({ tenantId, eventType: "task.queued" });
    await writer.write({ tenantId, eventType: "task.completed" });
    expect(writer.events.map((e) => e.eventType)).toEqual([
      "task.created",
      "task.queued",
      "task.completed",
    ]);
  });
});
