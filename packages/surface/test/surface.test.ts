import { describe, expect, it } from "vitest";
import { selectAgent } from "../src/agent-select";
import { renderResultText } from "../src/render";
import type { AgentDescriptor } from "../src/types";

const agents: AgentDescriptor[] = [
  { name: "bruce", keywords: ["error", "incident", "deploy"] },
  { name: "grace", keywords: ["funnel", "conversion", "data"] },
  { name: "ada", keywords: ["review", "pr", "diff"] },
];

describe("selectAgent", () => {
  it("uses the explicitly named agent", () => {
    expect(selectAgent({ agentName: "grace", text: "x" }, agents)?.name).toBe("grace");
  });
  it("picks the best keyword match when none named", () => {
    expect(selectAgent({ agentName: null, text: "why did checkout errors spike?" }, agents)?.name).toBe("bruce");
    expect(selectAgent({ agentName: null, text: "compare paid conversion" }, agents)?.name).toBe("grace");
  });
  it("falls back to the default agent when nothing matches", () => {
    expect(selectAgent({ agentName: null, text: "hi there" }, agents, "ada")?.name).toBe("ada");
  });
});

describe("renderResultText", () => {
  it("renders summary, recommendation, evidence, and a cost footer", () => {
    const text = renderResultText({
      summary: "Likely cause: PR #4812",
      recommendation: "Roll back checkout-api",
      evidence: ["error spike after deploy", "stack trace points to parse()"],
      costUsd: 0.0123,
    });
    expect(text).toContain("Likely cause: PR #4812");
    expect(text).toContain("*Recommendation:* Roll back checkout-api");
    expect(text).toContain("• error spike after deploy");
    expect(text).toContain("_cost: $0.0123_");
  });
});
