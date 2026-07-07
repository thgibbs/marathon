import { describe, expect, it } from "vitest";
import { summarizeTaskFailure } from "../src/handlers";

describe("summarizeTaskFailure (design/30-task-failure-reporting.md)", () => {
  it("renders a friendly budget-exhausted message for a BudgetExceededError-style lastError", () => {
    // worker.ts persists `String(err)`, which stringifies as "ErrorName: message".
    const summary = summarizeTaskFailure("BudgetExceededError: budget exceeded: spent $5.0000 of $5.00");
    expect(summary.toLowerCase()).toContain("budget exhausted");
  });

  it("renders a generic non-empty failure message for a non-budget lastError", () => {
    const summary = summarizeTaskFailure("unexpected: tool schema rejected the call");
    expect(summary).not.toBe("(no response)");
    expect(summary).toContain("unexpected: tool schema rejected the call");
  });

  it("still avoids a silent (no response) when no error detail was recorded", () => {
    const summary = summarizeTaskFailure(null);
    expect(summary).not.toBe("(no response)");
  });
});
