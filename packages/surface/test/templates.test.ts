import { describe, expect, it } from "vitest";
import { isDocTemplate, renderDocument } from "../src/templates";

describe("renderDocument", () => {
  it("generic returns the body under a title", () => {
    const out = renderDocument("generic", "My Doc", "Hello body.");
    expect(out).toContain("# My Doc");
    expect(out).toContain("Hello body.");
    expect(out).not.toContain("## Summary");
  });

  it("postmortem scaffolds sections with the body in the first one", () => {
    const out = renderDocument("postmortem", "Incident 42", "It broke at 09:42.");
    expect(out).toContain("# Incident 42");
    for (const s of ["## Summary", "## Impact", "## Timeline", "## Root cause", "## Resolution", "## Action items"]) {
      expect(out).toContain(s);
    }
    expect(out.indexOf("It broke at 09:42.")).toBeGreaterThan(out.indexOf("## Summary"));
    expect(out.indexOf("It broke at 09:42.")).toBeLessThan(out.indexOf("## Impact"));
  });

  it("prd and release_notes have their own sections", () => {
    expect(renderDocument("prd", "T", "b")).toContain("## Non-goals");
    expect(renderDocument("release_notes", "T", "b")).toContain("## Upgrade notes");
  });

  it("isDocTemplate guards unknown values", () => {
    expect(isDocTemplate("postmortem")).toBe(true);
    expect(isDocTemplate("nope")).toBe(false);
    expect(isDocTemplate(undefined)).toBe(false);
  });
});
