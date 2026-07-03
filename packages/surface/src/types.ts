import type { SurfaceType } from "@marathon/core";

/** A surface event normalized to a surface-agnostic shape (design.md §7.16). */
export interface NormalizedInvocation {
  surfaceType: SurfaceType;
  /** Opaque per-surface location (Slack: { channel, thread_ts, event_id }). */
  sourceRef: Record<string, unknown>;
  userExternalId: string;
  teamExternalId?: string;
  /** Explicitly named agent, or null to use the default. */
  agentName: string | null;
  text: string;
  /** Surface event id, used for dedupe. */
  eventId?: string;
}

export interface StructuredResult {
  summary: string;
  evidence?: string[];
  recommendation?: string;
  actionsTaken?: string[];
  openQuestions?: string[];
  /** Silent cost footer (design.md §13.3). */
  costUsd?: number | null;
  /** The other places this result was delivered to (K2 fan-out cross-links). */
  crossLinks?: string[];
}

export interface AgentDescriptor {
  name: string;
  description?: string;
  keywords?: string[];
}

/** One prior message in the conversation a task lives in (context loading, §7.18). */
export interface SurfaceMessage {
  /** External author handle (Slack user id, GitHub login); absent for system posts. */
  author?: string;
  text: string;
  /** Surface timestamp/ordering token, when available. */
  ts?: string;
}

/**
 * What each surface implements (design §7.16). Of the design's six duties —
 * identity resolution, context loading, progress, delivery, feedback, status —
 * progress/delivery are the required core, context loading is the optional
 * `loadContext` below (Track 12), identity resolution lives in
 * `Database.findOrCreateUserByIdentity` + the §7.20 verification fields, and
 * feedback/status stay surface-specific until Track 16 unifies status.
 */
export interface SurfaceAdapter {
  acknowledge(ref: Record<string, unknown>): Promise<void>;
  postProgress(ref: Record<string, unknown>, message: string): Promise<void>;
  deliverResult(ref: Record<string, unknown>, result: StructuredResult): Promise<void>;
  /**
   * Load recent conversation context for prompt assembly (Track 12, §7.18):
   * the thread/comment history around `ref`, oldest first. Everything returned
   * is untrusted and must be fenced by the prompt builder.
   */
  loadContext?(ref: Record<string, unknown>, opts?: { limit?: number }): Promise<SurfaceMessage[]>;
}
