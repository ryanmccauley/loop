import {
  createCliRenderer,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  type KeyEvent,
  t,
  bold,
  dim,
  fg,
  bg,
  type StyledText,
} from "@opentui/core"
import {
  type LoopUI,
  type IterationSummary,
  formatDuration,
  formatTokens,
  formatCost,
  statusIcon,
} from "./ui.js"

// ─── Color palette ────────────────────────────────────────────────────

const COLORS = {
  bg: "#1a1a2e",
  headerBg: "#16213e",
  panelBg: "#0f3460",
  border: "#444466",
  focusBorder: "#7c83ff",
  text: "#e0e0e0",
  textDim: "#888899",
  green: "#4ade80",
  yellow: "#facc15",
  red: "#f87171",
  cyan: "#22d3ee",
  blue: "#60a5fa",
  magenta: "#c084fc",
} as const

// ─── Activity entry ───────────────────────────────────────────────────

interface ActivityEntry {
  tool: string
  status: string
  title?: string
}

// ─── TuiUI class ──────────────────────────────────────────────────────

export class TuiUI implements LoopUI {
  private renderer: CliRenderer
  private root!: BoxRenderable
  private headerTitle!: TextRenderable
  private headerStats!: TextRenderable
  private activityScroll!: ScrollBoxRenderable
  private historyScroll!: ScrollBoxRenderable
  private footerText!: TextRenderable

  // State
  private prompt = ""
  private iteration = 0
  private maxIter = 0
  private status = "idle"
  private startTime = Date.now()
  private totalCost = 0
  private totalTokensIn = 0
  private totalTokensOut = 0
  private timerInterval: ReturnType<typeof setInterval> | null = null
  private _paused = false
  private pauseResolve: (() => void) | null = null

  // Activity buffer (capped)
  private activities: ActivityEntry[] = []
  private readonly maxActivities = 200

  // Focus tracking
  private focusedPanel: "activity" | "history" = "activity"

  private constructor(renderer: CliRenderer) {
    this.renderer = renderer
  }

  static async create(): Promise<TuiUI> {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      useAlternateScreen: true,
      useMouse: false,
    })

    const tui = new TuiUI(renderer)
    tui.buildLayout()
    tui.setupKeyboard()
    tui.startTimer()

    renderer.auto()

    return tui
  }

  // ─── Layout construction ──────────────────────────────────────────

  private buildLayout() {
    const r = this.renderer

    // Root container
    this.root = new BoxRenderable(r, {
      id: "root",
      width: "100%" as any,
      height: "100%" as any,
      flexDirection: "column",
      backgroundColor: COLORS.bg,
    })
    r.root.add(this.root)

    // ── Header panel ──
    const header = new BoxRenderable(r, {
      id: "header",
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.border,
      title: "opencode-loop",
      titleAlignment: "left",
      flexShrink: 0,
      padding: 0,
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
    })
    this.root.add(header)

    this.headerTitle = new TextRenderable(r, {
      id: "header-title",
      content: t`${dim("Waiting to start...")}`,
      height: 1,
      truncate: true,
    })
    header.add(this.headerTitle)

    this.headerStats = new TextRenderable(r, {
      id: "header-stats",
      content: t`${dim("─")}`,
      height: 1,
      truncate: true,
    })
    header.add(this.headerStats)

    // ── Activity panel ──
    this.activityScroll = new ScrollBoxRenderable(r, {
      id: "activity",
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.focusBorder,
      title: "Activity",
      titleAlignment: "left",
      flexGrow: 1,
      flexShrink: 1,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      contentOptions: {
        flexDirection: "column",
      },
    })
    this.root.add(this.activityScroll)

    // ── History panel ──
    this.historyScroll = new ScrollBoxRenderable(r, {
      id: "history",
      border: true,
      borderStyle: "rounded",
      borderColor: COLORS.border,
      title: "History",
      titleAlignment: "left",
      height: 8,
      flexShrink: 0,
      stickyScroll: true,
      stickyStart: "bottom",
      contentOptions: {
        flexDirection: "column",
      },
    })
    this.root.add(this.historyScroll)

    // ── Footer ──
    this.footerText = new TextRenderable(r, {
      id: "footer",
      content: this.buildFooter(),
      height: 1,
      truncate: true,
      flexShrink: 0,
    })
    this.root.add(this.footerText)
  }

  // ─── Keyboard handling ────────────────────────────────────────────

  private setupKeyboard() {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.name === "q" && !key.ctrl && !key.meta) {
        // Graceful quit — the orchestrator catches SIGINT
        process.kill(process.pid, "SIGINT")
        return
      }

      if (key.name === "p" && !key.ctrl && !key.meta) {
        this._paused = !this._paused
        this.footerText.content = this.buildFooter()
        if (!this._paused && this.pauseResolve) {
          this.pauseResolve()
          this.pauseResolve = null
        }
        return
      }

      if (key.name === "tab") {
        // Switch focus
        this.focusedPanel = this.focusedPanel === "activity" ? "history" : "activity"
        this.activityScroll.borderColor = this.focusedPanel === "activity" ? COLORS.focusBorder : COLORS.border
        this.historyScroll.borderColor = this.focusedPanel === "history" ? COLORS.focusBorder : COLORS.border
        return
      }

      if (key.name === "up" || key.name === "down") {
        const target = this.focusedPanel === "activity" ? this.activityScroll : this.historyScroll
        target.scrollBy(key.name === "up" ? -1 : 1)
        return
      }

      // Ctrl+C
      if (key.ctrl && key.name === "c") {
        process.kill(process.pid, "SIGINT")
        return
      }
    })
  }

  // ─── Timer ────────────────────────────────────────────────────────

  private startTimer() {
    this.timerInterval = setInterval(() => {
      this.updateHeader()
    }, 1000)
  }

  // ─── Header updates ───────────────────────────────────────────────

  private updateHeader() {
    const elapsed = formatDuration(Date.now() - this.startTime)
    const iterLabel = this.maxIter > 0 ? `Iter ${this.iteration}/${this.maxIter}` : "..."
    const statusDot = this.status === "busy"
      ? fg(COLORS.yellow)("●")
      : this.status === "idle"
        ? fg(COLORS.green)("●")
        : fg(COLORS.red)("●")
    const pauseLabel = this._paused ? fg(COLORS.yellow)(" PAUSED") : ""

    this.headerTitle.content = t`  ${bold(fg(COLORS.cyan)(iterLabel))}  ${statusDot} ${this.status}${pauseLabel}  ${dim(elapsed)}`

    const promptTrunc = this.prompt.length > 60 ? this.prompt.slice(0, 57) + "..." : this.prompt
    this.headerStats.content = t`  ${dim("Prompt:")} ${promptTrunc}  ${dim("Cost:")} ${fg(COLORS.green)(formatCost(this.totalCost))}  ${dim("Tokens:")} ${formatTokens(this.totalTokensIn)} in / ${formatTokens(this.totalTokensOut)} out`
  }

  // ─── Footer builder ───────────────────────────────────────────────

  private buildFooter(): StyledText {
    const pauseLabel = this._paused ? "unpause" : "pause"
    return t` ${dim("q")} quit  ${dim("p")} ${pauseLabel}  ${dim("↑↓")} scroll  ${dim("tab")} switch panel`
  }

  // ─── LoopUI implementation ────────────────────────────────────────

  onStart(prompt: string, cwd: string, maxIterations: number, model?: string, serverUrl?: string): void {
    this.prompt = prompt
    this.maxIter = maxIterations
    this.startTime = Date.now()
    this.updateHeader()

    // Add initial info to activity
    this.addActivity("info", "started", `Target: ${cwd}`)
    if (model) this.addActivity("info", "config", `Model: ${model}`)
    if (serverUrl) this.addActivity("info", "config", `Server: ${serverUrl}`)
  }

  onIterationStart(iteration: number, max: number): void {
    this.iteration = iteration
    this.maxIter = max
    this.status = "busy"
    this.updateHeader()
  }

  onStatusChange(status: string): void {
    this.status = status
    this.updateHeader()
  }

  onToolUpdate(tool: string, status: string, title?: string): void {
    this.addActivity(tool, status, title)
  }

  onIterationComplete(summary: IterationSummary): void {
    this.status = "idle"
    this.totalCost += summary.cost
    this.totalTokensIn += summary.tokens.input
    this.totalTokensOut += summary.tokens.output
    this.updateHeader()

    // Add to history panel
    this.addHistoryRow(summary)
  }

  onLoopComplete(summaries: IterationSummary[], totalCost: number): void {
    this.totalCost = totalCost
    this.status = "done"
    this.updateHeader()

    const lastStatus = summaries[summaries.length - 1]?.status
    if (lastStatus?.status === "complete") {
      this.addActivity("loop", "complete", lastStatus.message)
    } else if (lastStatus?.status === "blocked") {
      this.addActivity("loop", "blocked", lastStatus.message)
    } else {
      this.addActivity("loop", "incomplete", "Max iterations or interrupted")
    }

    // Print plain-text summary to stdout after TUI exits (see destroy)
    this._finalSummary = { summaries, totalCost }
  }

  private _finalSummary: { summaries: IterationSummary[]; totalCost: number } | null = null

  onInfo(message: string): void {
    this.addActivity("info", "info", message)
  }

  onSuccess(message: string): void {
    this.addActivity("info", "success", message)
  }

  onWarn(message: string): void {
    this.addActivity("warn", "warning", message)
  }

  onError(message: string): void {
    this.addActivity("error", "error", message)
  }

  isPaused(): boolean {
    return this._paused
  }

  /** Returns a promise that resolves when unpaused. Resolves immediately if not paused. */
  waitForUnpause(): Promise<void> {
    if (!this._paused) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.pauseResolve = resolve
    })
  }

  destroy(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval)
      this.timerInterval = null
    }

    if (!this.renderer.isDestroyed) {
      this.renderer.destroy()
    }

    // Print summary to stdout (now that alternate screen is gone)
    if (this._finalSummary) {
      this.printPlainSummary(this._finalSummary.summaries, this._finalSummary.totalCost)
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  private addActivity(tool: string, status: string, title?: string) {
    this.activities.push({ tool, status, title })
    if (this.activities.length > this.maxActivities) {
      this.activities.shift()
    }

    // Build styled line
    const icon = this.activityIcon(status)
    const toolLabel = fg(COLORS.blue)(tool)
    const titleText = title ? dim(` ${title}`) : ""
    const line = new TextRenderable(this.renderer, {
      content: t`  ${icon} ${toolLabel}${titleText}`,
      height: 1,
      truncate: true,
      flexShrink: 0,
    })
    this.activityScroll.add(line)

    // Trim old entries from the ScrollBox if over cap
    const children = this.activityScroll.getChildren()
    if (children.length > this.maxActivities) {
      const toRemove = children[0]
      if (toRemove?.id) {
        this.activityScroll.remove(toRemove.id)
      }
    }
  }

  private activityIcon(status: string): ReturnType<typeof fg> extends (...args: any) => infer R ? R : any {
    switch (status) {
      case "completed":
      case "complete":
      case "success":
        return fg(COLORS.green)("✓") as any
      case "running":
        return fg(COLORS.yellow)("●") as any
      case "error":
      case "blocked":
        return fg(COLORS.red)("✗") as any
      case "pending":
        return fg(COLORS.textDim)("○") as any
      case "warning":
        return fg(COLORS.yellow)("!") as any
      case "info":
      case "config":
      case "started":
        return fg(COLORS.cyan)("·") as any
      default:
        return fg(COLORS.textDim)("•") as any
    }
  }

  private addHistoryRow(summary: IterationSummary) {
    const { iteration, status, duration, cost } = summary
    const num = String(iteration).padStart(2, " ")
    const icon = status ? statusIcon(status.status) : "?"
    const iconColor = status?.status === "complete" ? COLORS.green
      : status?.status === "blocked" ? COLORS.red
      : status?.status === "progress" ? COLORS.cyan
      : COLORS.yellow

    const msg = status?.message
      ? (status.message.length > 40 ? status.message.slice(0, 37) + "..." : status.message)
      : "no loop_control call"
    const dur = formatDuration(duration)
    const c = formatCost(cost)

    const row = new TextRenderable(this.renderer, {
      content: t`  ${dim(num)}  ${fg(iconColor)(icon)}  ${msg}  ${dim(dur)}  ${dim(c)}`,
      height: 1,
      truncate: true,
      flexShrink: 0,
    })
    this.historyScroll.add(row)
  }

  private printPlainSummary(summaries: IterationSummary[], totalCost: number) {
    console.log("\n── Loop Summary ──────────────────────────────────────")

    if (summaries.length === 0) {
      console.log("No iterations completed.")
      return
    }

    for (const s of summaries) {
      const status = s.status
        ? `${s.status.status.toUpperCase()}: ${s.status.message}`
        : "no loop_control call"
      console.log(`  Iteration ${s.iteration}: ${status} (${formatDuration(s.duration)}, ${formatCost(s.cost)})`)
    }

    const totalDuration = summaries.reduce((a, s) => a + s.duration, 0)
    const totalTokensIn = summaries.reduce((a, s) => a + s.tokens.input, 0)
    const totalTokensOut = summaries.reduce((a, s) => a + s.tokens.output, 0)

    console.log("─────────────────────────────────────────────────────")
    console.log(`Total iterations: ${summaries.length}`)
    console.log(`Total time: ${formatDuration(totalDuration)}`)
    console.log(`Total cost: ${formatCost(totalCost)}`)
    console.log(`Total tokens: ${totalTokensIn.toLocaleString()} in / ${totalTokensOut.toLocaleString()} out`)

    const lastStatus = summaries[summaries.length - 1]?.status
    if (lastStatus?.status === "complete") {
      console.log("Result: COMPLETE")
    } else if (lastStatus?.status === "blocked") {
      console.log("Result: BLOCKED")
    } else {
      console.log("Result: INCOMPLETE (max iterations or interrupted)")
    }
    console.log("")
  }
}
