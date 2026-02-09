import type { LoopControlResult } from "./events.js"

// ─── Shared types ─────────────────────────────────────────────────────

export interface IterationSummary {
  iteration: number
  status: LoopControlResult | null
  cost: number
  tokens: { input: number; output: number }
  duration: number
}

// ─── LoopUI interface ─────────────────────────────────────────────────

/**
 * Common interface for both TUI and plain-log output modes.
 * The orchestrator calls these methods — the implementation decides how to render.
 */
export interface LoopUI {
  /** Called once at startup with config info */
  onStart(prompt: string, cwd: string, maxIterations: number, model?: string, serverUrl?: string): void

  /** Called when a new iteration begins */
  onIterationStart(iteration: number, max: number): void

  /** Called when the session status changes (busy/idle/retry) */
  onStatusChange(status: string): void

  /** Called when a tool call is updated */
  onToolUpdate(tool: string, status: string, title?: string): void

  /** Called when an iteration completes */
  onIterationComplete(summary: IterationSummary): void

  /** Called when the entire loop finishes */
  onLoopComplete(summaries: IterationSummary[], totalCost: number): void

  /** Log an informational message */
  onInfo(message: string): void

  /** Log a success message */
  onSuccess(message: string): void

  /** Log a warning */
  onWarn(message: string): void

  /** Log an error */
  onError(message: string): void

  /** Whether the loop is paused (TUI only — always false for log mode) */
  isPaused(): boolean

  /** Wait for the user to acknowledge completion before exiting (TUI: "press any key", log: no-op) */
  waitForExit(): Promise<void>

  /** Clean up resources (renderer, timers, etc.) */
  destroy(): void
}

// ─── Formatting helpers ───────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}m ${s.toString().padStart(2, "0")}s`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

export function statusIcon(status: string): string {
  switch (status) {
    case "complete": return "\u2713"
    case "blocked": return "\u2717"
    case "progress": return "\u25CB"
    case "running": return "\u25CF"
    case "completed": return "\u2713"
    case "error": return "\u2717"
    case "pending": return "\u25CB"
    default: return "\u2022"
  }
}
