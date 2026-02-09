const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
} as const

function timestamp(): string {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, "0")
  const m = String(now.getMinutes()).padStart(2, "0")
  const s = String(now.getSeconds()).padStart(2, "0")
  return `${COLORS.dim}${h}:${m}:${s}${COLORS.reset}`
}

export class Logger {
  private iteration = 0
  private maxIterations = 0

  setIteration(current: number, max: number) {
    this.iteration = current
    this.maxIterations = max
  }

  private prefix(): string {
    if (this.iteration > 0) {
      return `${timestamp()} ${COLORS.bold}[${this.iteration}/${this.maxIterations}]${COLORS.reset}`
    }
    return timestamp()
  }

  info(msg: string) {
    console.log(`${this.prefix()} ${msg}`)
  }

  success(msg: string) {
    console.log(`${this.prefix()} ${COLORS.green}${msg}${COLORS.reset}`)
  }

  warn(msg: string) {
    console.log(`${this.prefix()} ${COLORS.yellow}${msg}${COLORS.reset}`)
  }

  error(msg: string) {
    console.error(`${this.prefix()} ${COLORS.red}${msg}${COLORS.reset}`)
  }

  status(msg: string) {
    console.log(`${this.prefix()} ${COLORS.bold}${msg}${COLORS.reset}`)
  }

  tool(name: string, status: string) {
    console.log(`${this.prefix()} ${COLORS.dim}[tool]${COLORS.reset} ${name} ${COLORS.dim}${status}${COLORS.reset}`)
  }

  text(msg: string) {
    console.log(`${this.prefix()} ${COLORS.dim}${msg}${COLORS.reset}`)
  }

  separator() {
    console.log(`${COLORS.dim}${"─".repeat(60)}${COLORS.reset}`)
  }

  banner(title: string) {
    this.separator()
    console.log(`${COLORS.bold}  ${title}${COLORS.reset}`)
    this.separator()
  }
}

export const log = new Logger()
