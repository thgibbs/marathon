import { describe, expect, it } from "vitest";
import {
  loadConfig,
  looseningAuditEvent,
  PROFILE_DEFAULTS,
  renderPostureBanner,
  renderSandboxResidualNote,
  resolveEffectiveBudget,
  resolveEffectiveTrustedDeployment,
  resolvePosture,
  resolveTrustProfile,
} from "../src";

describe("trust profiles (§30)", () => {
  describe("resolveTrustProfile", () => {
    it("defaults to solo when unset (the kernel posture, named)", () => {
      expect(resolveTrustProfile({})).toBe("solo");
      expect(loadConfig({}).trustProfile).toBe("solo");
    });
    it("accepts the four profiles", () => {
      for (const p of ["solo", "team", "org", "hosted"] as const) {
        expect(resolveTrustProfile({ MARATHON_TRUST_PROFILE: p })).toBe(p);
      }
    });
    it("throws on an unknown profile (fail loud)", () => {
      expect(() => resolveTrustProfile({ MARATHON_TRUST_PROFILE: "dev" })).toThrow(/MARATHON_TRUST_PROFILE/);
    });
  });

  describe("resolvePosture — profile defaults", () => {
    it("solo: egress open, trusted_deployment on, no deviations", () => {
      const p = resolvePosture({});
      expect(p.profile).toBe("solo");
      expect(p.internalEgressMode).toBe("open");
      expect(p.chatTrustedDeploymentDefault).toBe(true);
      expect(p.chatTrustedDeploymentForbidden).toBe(false);
      expect(p.defaultBudgetUsd).toBe(PROFILE_DEFAULTS.solo.defaultBudgetUsd);
      expect(p.deviations).toEqual([]);
      expect(p.loosenings).toEqual([]);
    });
    it("team: egress on-behalf-of, trusted_deployment off", () => {
      const p = resolvePosture({ MARATHON_TRUST_PROFILE: "team" });
      expect(p.internalEgressMode).toBe("on-behalf-of");
      expect(p.chatTrustedDeploymentDefault).toBe(false);
      expect(p.chatTrustedDeploymentForbidden).toBe(false);
    });
    it("hosted: egress audience, trusted_deployment forbidden", () => {
      const p = resolvePosture({ MARATHON_TRUST_PROFILE: "hosted" });
      expect(p.internalEgressMode).toBe("audience");
      expect(p.chatTrustedDeploymentForbidden).toBe(true);
      expect(p.chatTrustedDeploymentDefault).toBe(false);
    });
  });

  describe("resolvePosture — egress override + loosening ack (§30.5)", () => {
    it("tightening is silent (no ack), recorded as a non-loosening deviation", () => {
      const p = resolvePosture({ MARATHON_TRUST_PROFILE: "solo", MARATHON_INTERNAL_EGRESS_MODE: "audience" });
      expect(p.internalEgressMode).toBe("audience");
      expect(p.deviations).toHaveLength(1);
      expect(p.deviations[0]!.loosening).toBe(false);
      expect(p.loosenings).toEqual([]);
    });
    it("loosening without the ack fails closed and loud", () => {
      expect(() =>
        resolvePosture({ MARATHON_TRUST_PROFILE: "team", MARATHON_INTERNAL_EGRESS_MODE: "open" }),
      ).toThrow(/MARATHON_ALLOW_LOOSER_EGRESS/);
    });
    it("loosening WITH the ack is applied and recorded as a loosening", () => {
      const p = resolvePosture({
        MARATHON_TRUST_PROFILE: "team",
        MARATHON_INTERNAL_EGRESS_MODE: "open",
        MARATHON_ALLOW_LOOSER_EGRESS: "1",
      });
      expect(p.internalEgressMode).toBe("open");
      expect(p.loosenings).toHaveLength(1);
      expect(p.loosenings[0]!.knob).toBe("internal egress mode");
    });
    it("rejects an invalid egress mode", () => {
      expect(() => resolvePosture({ MARATHON_INTERNAL_EGRESS_MODE: "wide-open" })).toThrow(
        /MARATHON_INTERNAL_EGRESS_MODE/,
      );
    });
  });

  describe("resolveEffectiveBudget (floor #7)", () => {
    it("uses the agent's own budget when set", () => {
      const p = resolvePosture({});
      expect(resolveEffectiveBudget({ limitUsd: 2 }, p)).toEqual({ limitUsd: 2 });
    });
    it("an omitted budget becomes the profile default, never unlimited", () => {
      const p = resolvePosture({ MARATHON_TRUST_PROFILE: "hosted" });
      expect(resolveEffectiveBudget(undefined, p)).toEqual({ limitUsd: PROFILE_DEFAULTS.hosted.defaultBudgetUsd });
    });
  });

  describe("resolveEffectiveTrustedDeployment (§30.4 tri-state)", () => {
    it("solo: unset → on (profile-implied)", () => {
      const p = resolvePosture({});
      expect(resolveEffectiveTrustedDeployment(undefined, p, {})).toEqual({ value: true, loosening: false });
    });
    it("solo: an explicit true matches the default — no ack needed", () => {
      const p = resolvePosture({});
      expect(resolveEffectiveTrustedDeployment(true, p, {})).toEqual({ value: true, loosening: false });
    });
    it("team: unset → off", () => {
      const p = resolvePosture({ MARATHON_TRUST_PROFILE: "team" });
      expect(resolveEffectiveTrustedDeployment(undefined, p, {})).toEqual({ value: false, loosening: false });
    });
    it("team: explicit true is a loosening — needs the ack, else throws", () => {
      const p = resolvePosture({ MARATHON_TRUST_PROFILE: "team" });
      expect(() => resolveEffectiveTrustedDeployment(true, p, {})).toThrow(/MARATHON_ALLOW_TRUSTED_DEPLOYMENT/);
      expect(resolveEffectiveTrustedDeployment(true, p, { MARATHON_ALLOW_TRUSTED_DEPLOYMENT: "1" })).toEqual({
        value: true,
        loosening: true,
      });
    });
    it("hosted: an explicit true is forbidden outright", () => {
      const p = resolvePosture({ MARATHON_TRUST_PROFILE: "hosted" });
      expect(() => resolveEffectiveTrustedDeployment(true, p, { MARATHON_ALLOW_TRUSTED_DEPLOYMENT: "1" })).toThrow(
        /forbidden/,
      );
      expect(resolveEffectiveTrustedDeployment(undefined, p, {})).toEqual({ value: false, loosening: false });
    });
  });

  describe("renderPostureBanner", () => {
    it("states the profile and effective knobs", () => {
      const lines = renderPostureBanner(resolvePosture({}));
      expect(lines[0]).toMatch(/trust profile: solo/);
      expect(lines.join("\n")).toMatch(/internal egress mode: open/);
      expect(lines.join("\n")).toMatch(/chat\.trusted_deployment default: on/);
    });
    it("flags a loosening in the banner", () => {
      const lines = renderPostureBanner(
        resolvePosture({
          MARATHON_TRUST_PROFILE: "team",
          MARATHON_INTERNAL_EGRESS_MODE: "open",
          MARATHON_ALLOW_LOOSER_EGRESS: "1",
        }),
      );
      expect(lines.join("\n")).toMatch(/LOOSENED/);
    });
  });

  describe("renderSandboxResidualNote (§30.3 solo residual)", () => {
    it("warns under an egress-open network (bridge)", () => {
      const lines = renderSandboxResidualNote("bridge");
      expect(lines.join("\n")).toMatch(/§30\.3 residual/);
      expect(lines.join("\n")).toMatch(/NOT egress-protected/);
    });
    it("is silent when egress is locked (none)", () => {
      expect(renderSandboxResidualNote("none")).toEqual([]);
    });
  });

  describe("looseningAuditEvent (§30.5 — persisted acknowledgment)", () => {
    it("builds a posture.loosened event from a loosening (survives log rotation)", () => {
      const p = resolvePosture({
        MARATHON_TRUST_PROFILE: "team",
        MARATHON_INTERNAL_EGRESS_MODE: "open",
        MARATHON_ALLOW_LOOSER_EGRESS: "1",
      });
      const ev = looseningAuditEvent("tenant-1", p.profile, p.loosenings[0]!);
      expect(ev.tenantId).toBe("tenant-1");
      expect(ev.eventType).toBe("posture.loosened");
      expect(ev.summary).toMatch(/loosened/);
      expect(ev.metadata).toMatchObject({
        knob: "internal egress mode",
        from: "on-behalf-of",
        to: "open",
        profile: "team",
      });
    });
  });
});
