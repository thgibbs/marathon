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
}

export interface AgentDescriptor {
  name: string;
  description?: string;
  keywords?: string[];
}

/** What each surface implements to deliver back (subset for M4). */
export interface SurfaceAdapter {
  acknowledge(ref: Record<string, unknown>): Promise<void>;
  postProgress(ref: Record<string, unknown>, message: string): Promise<void>;
  deliverResult(ref: Record<string, unknown>, result: StructuredResult): Promise<void>;
}
