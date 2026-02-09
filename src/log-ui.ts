import { log } from "./log.js"
import {
  type LoopUI,
  type IterationSummary,
  formatDuration,
  formatTokens,
  formatCost,
  statusIcon,
} from "./ui.js"

/**
 * Plain-log implementation of LoopUI.
 * Wraps the existing Logger class — used when --no-tui is set.
 */
export class LogUI implements LoopUI {
  onStart(prompt: string, cwd: string, maxIterations: number, model?: string, serverUrl?: string): void {
    log.banner("opencode-loop")
    log.info(`Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`)
    log.info(`Target: ${cwd}`)
    log.info(`Max iterations: ${maxIterations}`)
    if (model) log.info(`Model: ${model}`)
    if (serverUrl) log.info(`Attach a TUI with: opencode attach --url ${serverUrl}`)
    log.separator()
  }

  onIterationStart(iteration: number, max: number): void {
    log.setIteration(iteration, max)
    log.separator()
    log.info(`Starting iteration ${iteration}/${max}`)
  }

  onStatusChange(status: string): void {
    log.status(`Session status: ${status}`)
  }

  onToolUpdate(tool: string, status: string, title?: string): void {
    log.tool(tool, title ?? status)
  }

  onIterationComplete(summary: IterationSummary): void {
    const { status } = summary
    if (status) {
      const label = status.status.toUpperCase()
      if (status.status === "complete") {
        log.success(`Agent signaled COMPLETE: ${status.message}`)
      } else if (status.status === "blocked") {
        log.error(`Agent signaled BLOCKED: ${status.message}`)
      } else if (status.status === "progress") {
        log.info(`Agent signaled PROGRESS: ${status.message}`)
      } else {
        log.warn(`Agent signaled ${label}: ${status.message}`)
      }
    } else {
      log.warn("Agent did not call loop_control")
    }

    log.info(
      `  Duration: ${formatDuration(summary.duration)} | ` +
      `Cost: ${formatCost(summary.cost)} | ` +
      `Tokens: ${formatTokens(summary.tokens.input)} in / ${formatTokens(summary.tokens.output)} out`
    )
  }

  onLoopComplete(summaries: IterationSummary[], totalCost: number): void {
    log.separator()
    log.banner("Loop Summary")

    if (summaries.length === 0) {
      log.info("No iterations completed.")
      return
    }

    for (const s of summaries) {
      const status = s.status
        ? `${s.status.status.toUpperCase()}: ${s.status.message}`
        : "no loop_control call"
      log.info(`  Iteration ${s.iteration}: ${status} (${formatDuration(s.duration)}, ${formatCost(s.cost)})`)
    }

    const totalDuration = summaries.reduce((a, s) => a + s.duration, 0)
    const totalTokensIn = summaries.reduce((a, s) => a + s.tokens.input, 0)
    const totalTokensOut = summaries.reduce((a, s) => a + s.tokens.output, 0)

    log.separator()
    log.info(`Total iterations: ${summaries.length}`)
    log.info(`Total time: ${formatDuration(totalDuration)}`)
    log.info(`Total cost: ${formatCost(totalCost)}`)
    log.info(`Total tokens: ${totalTokensIn.toLocaleString()} in / ${totalTokensOut.toLocaleString()} out`)

    const lastStatus = summaries[summaries.length - 1]?.status
    if (lastStatus?.status === "complete") {
      log.success("Result: COMPLETE")
    } else if (lastStatus?.status === "blocked") {
      log.error("Result: BLOCKED")
    } else {
      log.warn("Result: INCOMPLETE (max iterations or interrupted)")
    }
  }

  onInfo(message: string): void {
    log.info(message)
  }

  onSuccess(message: string): void {
    log.success(message)
  }

  onWarn(message: string): void {
    log.warn(message)
  }

  onError(message: string): void {
    log.error(message)
  }

  isPaused(): boolean {
    return false
  }

  destroy(): void {
    // no-op for plain log mode
  }
}
