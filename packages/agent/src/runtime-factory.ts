import { type AgentSpec, type SecretStore, validateHarnessConfig } from "@marathon/config";
import type { ModelRegistry } from "@marathon/model-gateway";
import { ClaudeCodeAgentRuntime, type ClaudeCodeAgentOptions } from "./claude-code";
import { PiAgentRuntime, type GovernedToolsConfig, type PiAgentOptions } from "./pi";
import type { AgentRuntime } from "./types";

/**
 * The shared harness factory (K7, design §7.5): pick the `AgentRuntime` from the
 * agent spec's `harness` field, so the harness is selectable per deployment with
 * the worker step runners untouched — the seam holds. Used at the BUILD wiring
 * site (github-app), the only surface where `claude-code` is supported today: it
 * runs its whole loop inside a per-task code container, so it needs a workspace
 * binding, the container factory, and the model proxy. The chat/general-agent
 * surface has no such workspace and stays on Pi. `claude-code`'s harness/model
 * pairing is cross-validated fail-closed (§13.1) before a runtime is built.
 */
export interface MakeAgentRuntimeDeps {
  secrets: SecretStore;
  registry?: ModelRegistry;
  sessionDir?: string;
  governed?: GovernedToolsConfig;
  clarification?: boolean;
  /**
   * Container factory derived from the task workspace (`workspaceSandboxFromSpec`).
   * Pattern 2 for Pi (routes bash/read/write/edit into it); Pattern 1 for Claude
   * Code (runs the whole CLI inside it). Its `createContainer` accepts an optional
   * third arg with extra mounts, which the Claude runtime uses for the broker socket.
   */
  sandbox?: PiAgentOptions["sandbox"];
  builtinTools?: string[];
  /** Claude Code: the model proxy endpoint + upstream (§4.1). */
  proxy?: ClaudeCodeAgentOptions["proxy"];
  /** Claude Code: checkpoint cadence (§2.1). */
  maxTurnsPerInvocation?: number;
  /** Claude Code: locked-down egress posture disallows `WebFetch` (§3.3). */
  lockedDownEgress?: boolean;
  /** Claude Code: CLI/shim overrides. */
  cli?: ClaudeCodeAgentOptions["cli"];
  /** Claude Code: host dir for per-task broker sockets. */
  socketDir?: string;
  /** Claude Code: per-turn remaining task budget for the mid-invocation kill (§4.3). */
  getRemainingBudgetUsd?: ClaudeCodeAgentOptions["getRemainingBudgetUsd"];
}

export function makeAgentRuntime(spec: AgentSpec, deps: MakeAgentRuntimeDeps): AgentRuntime {
  if (spec.harness === "claude-code") {
    // Fail closed before building: Anthropic model policy (§13.1) + a proxy (§4.1).
    validateHarnessConfig(spec, { proxyConfigured: deps.proxy !== undefined });
    if (!deps.sandbox) {
      throw new Error(`agent '${spec.name}': harness 'claude-code' requires a sandbox container factory`);
    }
    return new ClaudeCodeAgentRuntime({
      secrets: deps.secrets,
      registry: deps.registry,
      sessionDir: deps.sessionDir,
      // The workspace factory's createContainer takes the optional mounts arg.
      sandbox: deps.sandbox as ClaudeCodeAgentOptions["sandbox"],
      governed: deps.governed,
      proxy: deps.proxy,
      maxTurnsPerInvocation: deps.maxTurnsPerInvocation,
      clarification: deps.clarification,
      lockedDownEgress: deps.lockedDownEgress,
      cli: deps.cli,
      socketDir: deps.socketDir,
      getRemainingBudgetUsd: deps.getRemainingBudgetUsd,
    });
  }
  return new PiAgentRuntime({
    secrets: deps.secrets,
    registry: deps.registry,
    sessionDir: deps.sessionDir,
    governed: deps.governed,
    clarification: deps.clarification,
    sandbox: deps.sandbox,
    builtinTools: deps.builtinTools,
  });
}
