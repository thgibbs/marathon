/**
 * Trust profiles (design §30) — one security model from solo dev to company.
 *
 * A **trust profile** is a named preset (`solo | team | org | hosted`) declared
 * once per deployment that sets the *default* value of every posture knob the
 * system already has. Profiles change DEFAULTS, never MECHANISMS (§30.2): this
 * table only expresses knobs that exist as real mechanisms today. The FLOOR
 * (§30.3, `demos/floor`) is invariant across every profile and is not encoded
 * here — it is never a default to be relaxed.
 *
 * `solo` is the out-of-the-box default and IS the kernel's existing posture,
 * named (§30.4) — so an unset `MARATHON_TRUST_PROFILE` changes nothing.
 */

export type TrustProfile = "solo" | "team" | "org" | "hosted";

export const TRUST_PROFILES: readonly TrustProfile[] = ["solo", "team", "org", "hosted"];

/**
 * Internal egress mode (§7.8): how far internal (tenant-visible) egress is
 * scoped. Ordered loosest → strictest — the index is the strictness rank, used
 * to decide whether an override is a loosening (needs an ack) or a tightening.
 *
 * NOTE (P1 scope): the gateway *reads* this knob and records it on the egress
 * audit trail; `open` is today's behavior. The additional enforcement of
 * `on-behalf-of` / `audience` binds at its tier (`team`/`org`) because it needs
 * acting-user + audience inputs that identity linking (§7.20) supplies — it is
 * not silently enforced here.
 */
export type InternalEgressMode = "open" | "on-behalf-of" | "audience";
const EGRESS_ORDER: readonly InternalEgressMode[] = ["open", "on-behalf-of", "audience"];

/** The profile's default values for the posture knobs that are mechanisms today (§30.4). */
export interface ProfileDefaults {
  internalEgressMode: InternalEgressMode;
  /**
   * `chat.trusted_deployment` default (chat-repo.md; §30.4 "profile-implied").
   * `"forbidden"` → the knob may not be enabled at all at this tier (`hosted`).
   */
  chatTrustedDeployment: boolean | "forbidden";
  /**
   * Per-task default spend cap in USD, applied when an agent omits `budget:`
   * (floor #7): an omitted budget means the profile default, never "unlimited".
   * A tunable constant — the exact figure is not load-bearing.
   */
  defaultBudgetUsd: number;
}

/**
 * The §30.4 knob table, restricted to knobs that are real mechanisms today.
 * Deliberately omitted (no mechanism to bind yet, so the profile cannot express
 * them — §30.2): sandbox network default (flipping `bridge → locked` waits on
 * the model-proxy spike, §30.9), console auth (P2 builds it), role enforcement
 * (P3), retention (P3).
 */
export const PROFILE_DEFAULTS: Record<TrustProfile, ProfileDefaults> = {
  solo: { internalEgressMode: "open", chatTrustedDeployment: true, defaultBudgetUsd: 10 },
  team: { internalEgressMode: "on-behalf-of", chatTrustedDeployment: false, defaultBudgetUsd: 10 },
  org: { internalEgressMode: "on-behalf-of", chatTrustedDeployment: false, defaultBudgetUsd: 10 },
  hosted: { internalEgressMode: "audience", chatTrustedDeployment: "forbidden", defaultBudgetUsd: 5 },
};

/** One posture knob whose effective value differs from the profile default (for the banner). */
export interface PostureDeviation {
  knob: string;
  profileDefault: string;
  effective: string;
  /** True when the effective value is LOOSER than the profile default (needs an ack). */
  loosening: boolean;
}

/** The effective posture for this deployment: profile defaults + acknowledged overrides. */
export interface ResolvedPosture {
  profile: TrustProfile;
  internalEgressMode: InternalEgressMode;
  /** Effective default for agents that don't set `chat.trusted_deployment`. */
  chatTrustedDeploymentDefault: boolean;
  /** `hosted`: the knob is forbidden entirely (an explicit `true` is refused at wiring). */
  chatTrustedDeploymentForbidden: boolean;
  defaultBudgetUsd: number;
  /** Every knob deviating from the profile default. */
  deviations: PostureDeviation[];
  /** The subset of deviations that are loosenings — logged loudly + audited (§30.5). */
  loosenings: PostureDeviation[];
}

/** Read + validate the declared trust profile (default `solo`; §30.4). Throws on an unknown value. */
export function resolveTrustProfile(env: NodeJS.ProcessEnv = process.env): TrustProfile {
  const raw = env.MARATHON_TRUST_PROFILE?.trim();
  if (!raw) return "solo";
  if (!(TRUST_PROFILES as readonly string[]).includes(raw)) {
    throw new Error(`MARATHON_TRUST_PROFILE must be one of ${TRUST_PROFILES.join(" | ")} (got ${JSON.stringify(raw)})`);
  }
  return raw as TrustProfile;
}

/**
 * Resolve the effective deployment posture from the profile + any acknowledged
 * loosening overrides (§30.5). Tightening is silent; loosening a knob below its
 * profile default requires an acknowledgment-shaped env (the generalized
 * `CONSOLE_ALLOW_NONLOOPBACK` pattern) or boot fails closed and loud. The FLOOR
 * is never expressible here, so it is never overridable.
 */
export function resolvePosture(env: NodeJS.ProcessEnv = process.env): ResolvedPosture {
  const profile = resolveTrustProfile(env);
  const defaults = PROFILE_DEFAULTS[profile];
  const deviations: PostureDeviation[] = [];

  // Internal egress mode: profile default unless explicitly overridden. A looser
  // override (rank below the default) requires MARATHON_ALLOW_LOOSER_EGRESS=1.
  let internalEgressMode = defaults.internalEgressMode;
  const egressOverride = env.MARATHON_INTERNAL_EGRESS_MODE?.trim();
  if (egressOverride) {
    if (!(EGRESS_ORDER as readonly string[]).includes(egressOverride)) {
      throw new Error(
        `MARATHON_INTERNAL_EGRESS_MODE must be one of ${EGRESS_ORDER.join(" | ")} (got ${JSON.stringify(egressOverride)})`,
      );
    }
    const requested = egressOverride as InternalEgressMode;
    if (requested !== defaults.internalEgressMode) {
      const loosening = EGRESS_ORDER.indexOf(requested) < EGRESS_ORDER.indexOf(defaults.internalEgressMode);
      if (loosening && env.MARATHON_ALLOW_LOOSER_EGRESS !== "1") {
        throw new Error(
          `refusing to loosen internal egress mode from "${defaults.internalEgressMode}" (profile ${profile}) to ` +
            `"${requested}"; set MARATHON_ALLOW_LOOSER_EGRESS=1 to acknowledge (§30.5)`,
        );
      }
      internalEgressMode = requested;
      deviations.push({
        knob: "internal egress mode",
        profileDefault: defaults.internalEgressMode,
        effective: requested,
        loosening,
      });
    }
  }

  const chatTrustedDeploymentForbidden = defaults.chatTrustedDeployment === "forbidden";
  const chatTrustedDeploymentDefault =
    defaults.chatTrustedDeployment === "forbidden" ? false : defaults.chatTrustedDeployment;

  return {
    profile,
    internalEgressMode,
    chatTrustedDeploymentDefault,
    chatTrustedDeploymentForbidden,
    defaultBudgetUsd: defaults.defaultBudgetUsd,
    deviations,
    loosenings: deviations.filter((d) => d.loosening),
  };
}

/**
 * The startup posture banner (§30.5): each live app prints its effective posture
 * at boot — the profile, the effective knobs, and any deviation/loosening from
 * the profile default. Extends the §2b #13 fail-loud rule from "which webhook
 * mode am I in" to "which trust posture am I in", so a team deployment silently
 * running a solo default becomes impossible to miss. Returns the lines to log.
 */
export function renderPostureBanner(posture: ResolvedPosture): string[] {
  const lines: string[] = [];
  const suffix = posture.profile === "solo" ? " (out-of-the-box default; the kernel posture)" : "";
  lines.push(`trust profile: ${posture.profile}${suffix}`);
  lines.push(`  internal egress mode: ${posture.internalEgressMode}`);
  lines.push(
    `  chat.trusted_deployment default: ${
      posture.chatTrustedDeploymentForbidden ? "forbidden" : posture.chatTrustedDeploymentDefault ? "on" : "off"
    }`,
  );
  lines.push(`  default per-task budget: $${posture.defaultBudgetUsd.toFixed(2)}`);
  for (const d of posture.deviations) {
    const tag = d.loosening ? "LOOSENED (acknowledged)" : "tightened";
    lines.push(`  ${d.loosening ? "⚠ " : ""}${d.knob}: ${d.effective} — ${tag} from profile default "${d.profileDefault}"`);
  }
  return lines;
}
