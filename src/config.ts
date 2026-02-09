import { readFileSync } from "fs"
import { resolve } from "path"

export interface Config {
  /** The prompt text to send to the agent */
  prompt: string
  /** Working directory of the target project */
  cwd: string
  /** Maximum number of loop iterations */
  maxIterations: number
  /** Model to use, e.g. "anthropic/claude-sonnet-4-20250514" */
  model?: { providerID: string; modelID: string }
  /** Agent to use (default: "loop") */
  agent: string
  /** Port for opencode serve (0 = auto) */
  port: number
  /** Connect to an existing opencode server instead of starting one */
  attach?: string
  /** Max retries on error per iteration */
  maxRetries: number
}

function printUsage(): never {
  console.log(`
opencode-loop — Autonomous loop orchestrator for OpenCode

Usage:
  bun run src/index.ts [options] <prompt>
  bun run src/index.ts [options] --file <path>

Options:
  --file <path>           Read prompt from a file instead of positional args
  --cwd <dir>             Target project directory (default: current directory)
  --max-iterations <n>    Maximum loop iterations (default: 50)
  --model <provider/id>   Model to use (e.g. "anthropic/claude-sonnet-4-20250514")
  --agent <name>          Agent to use (default: "loop")
  --port <n>              Port for opencode serve (default: 0 = auto)
  --attach <url>          Connect to existing opencode server (e.g. "http://localhost:4096")
  --max-retries <n>       Max retries on error per iteration (default: 3)
  --help                  Show this help message

Examples:
  bun run src/index.ts "Implement user authentication with JWT tokens"
  bun run src/index.ts --file tasks/sprint-1.md --cwd ~/projects/myapp
  bun run src/index.ts --attach http://localhost:4096 "Fix all failing tests"
`)
  process.exit(0)
}

export function parseConfig(argv: string[]): Config {
  // Skip bun and script path
  const args = argv.slice(2)

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage()
  }

  let file: string | undefined
  let cwd = process.cwd()
  let maxIterations = 50
  let model: { providerID: string; modelID: string } | undefined
  let agent = "loop"
  let port = 0
  let attach: string | undefined
  let maxRetries = 3
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case "--file":
        file = args[++i]
        if (!file) {
          console.error("Error: --file requires a path argument")
          process.exit(1)
        }
        break
      case "--cwd":
        cwd = args[++i]
        if (!cwd) {
          console.error("Error: --cwd requires a directory argument")
          process.exit(1)
        }
        cwd = resolve(cwd)
        break
      case "--max-iterations":
        maxIterations = parseInt(args[++i], 10)
        if (isNaN(maxIterations) || maxIterations < 1) {
          console.error("Error: --max-iterations must be a positive integer")
          process.exit(1)
        }
        break
      case "--model": {
        const modelStr = args[++i]
        if (!modelStr || !modelStr.includes("/")) {
          console.error("Error: --model must be in format 'provider/modelId'")
          process.exit(1)
        }
        const [providerID, ...rest] = modelStr.split("/")
        model = { providerID, modelID: rest.join("/") }
        break
      }
      case "--agent":
        agent = args[++i]
        if (!agent) {
          console.error("Error: --agent requires a name argument")
          process.exit(1)
        }
        break
      case "--port":
        port = parseInt(args[++i], 10)
        if (isNaN(port)) {
          console.error("Error: --port must be a number")
          process.exit(1)
        }
        break
      case "--attach":
        attach = args[++i]
        if (!attach) {
          console.error("Error: --attach requires a URL argument")
          process.exit(1)
        }
        break
      case "--max-retries":
        maxRetries = parseInt(args[++i], 10)
        if (isNaN(maxRetries) || maxRetries < 0) {
          console.error("Error: --max-retries must be a non-negative integer")
          process.exit(1)
        }
        break
      default:
        if (arg.startsWith("-")) {
          console.error(`Error: Unknown option '${arg}'`)
          process.exit(1)
        }
        positional.push(arg)
    }
  }

  // Determine prompt
  let prompt: string
  if (file) {
    const filePath = resolve(file)
    try {
      prompt = readFileSync(filePath, "utf-8").trim()
    } catch (err: any) {
      console.error(`Error: Could not read file '${filePath}': ${err.message}`)
      process.exit(1)
    }
    if (!prompt) {
      console.error(`Error: File '${filePath}' is empty`)
      process.exit(1)
    }
  } else if (positional.length > 0) {
    prompt = positional.join(" ")
  } else {
    console.error("Error: No prompt provided. Use positional args or --file <path>")
    process.exit(1)
  }

  return {
    prompt,
    cwd,
    maxIterations,
    model,
    agent,
    port,
    attach,
    maxRetries,
  }
}
