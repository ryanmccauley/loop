import { createOpencode, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { cpSync, existsSync, rmSync } from "fs"
import { join, resolve, dirname } from "path"
import { parseConfig, type Config } from "./config.js"
import { log } from "./log.js"
import {
  subscribeToEvents,
  getLatestAssistantParts,
  extractLoopControl,
  type LoopControlResult,
} from "./events.js"

// ─── .opencode file installation ──────────────────────────────────────

const OPENCODE_FILES = ["agents/loop.md", "plugins/loop.ts", "tools/loop-control.ts"]

/** The directory where this package's .opencode files live */
function getSourceOpencodeDir(): string {
  // Resolve relative to this file's location → project root / .opencode
  return resolve(dirname(import.meta.dir), ".opencode")
}

/**
 * Copy our .opencode agent/plugin/tool files into the target project.
 * Overwrites existing files with a warning.
 */
function installOpencodeFiles(targetCwd: string) {
  const sourceDir = getSourceOpencodeDir()
  const targetDir = join(targetCwd, ".opencode")

  for (const file of OPENCODE_FILES) {
    const src = join(sourceDir, file)
    const dest = join(targetDir, file)

    if (!existsSync(src)) {
      log.warn(`Source file not found: ${src}`)
      continue
    }

    if (existsSync(dest)) {
      log.info(`Overwriting ${file} in target .opencode/`)
    }

    cpSync(src, dest, { recursive: true })
  }

  log.success("Installed loop agent, plugin, and tool into target project")
}

/**
 * Clean up installed .opencode files from the target project.
 */
function cleanupOpencodeFiles(targetCwd: string) {
  const targetDir = join(targetCwd, ".opencode")

  for (const file of OPENCODE_FILES) {
    const dest = join(targetDir, file)
    if (existsSync(dest)) {
      rmSync(dest)
    }
  }

  // Clean up empty directories
  for (const dir of ["agents", "plugins", "tools"]) {
    const dirPath = join(targetDir, dir)
    try {
      const entries = Bun.file(dirPath)
      // rmSync only if directory is empty - use readdir check
    } catch {
      // ignore
    }
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────

interface IterationSummary {
  iteration: number
  status: LoopControlResult | null
  cost: number
  tokens: { input: number; output: number }
  duration: number
}

async function run() {
  const config = parseConfig(process.argv)

  log.banner("opencode-loop")
  log.info(`Prompt: ${config.prompt.slice(0, 100)}${config.prompt.length > 100 ? "..." : ""}`)
  log.info(`Target: ${config.cwd}`)
  log.info(`Max iterations: ${config.maxIterations}`)
  if (config.model) log.info(`Model: ${config.model.providerID}/${config.model.modelID}`)
  log.info(`Agent: ${config.agent}`)
  log.separator()

  // Install .opencode files into target project
  installOpencodeFiles(config.cwd)

  let client: OpencodeClient
  let serverClose: (() => void) | undefined

  try {
    // Connect or start server
    if (config.attach) {
      log.info(`Attaching to existing server at ${config.attach}`)
      client = createOpencodeClient({ baseUrl: config.attach })
    } else {
      log.info("Starting opencode server...")
      // Change to target directory so opencode serves the correct project
      process.chdir(config.cwd)
      const result = await createOpencode({
        port: config.port || undefined,
      })
      client = result.client
      serverClose = result.server.close
      log.success(`Server started at ${result.server.url}`)
      log.info(`Attach a TUI with: opencode attach --url ${result.server.url}`)
    }

    // Create session
    log.info("Creating session...")
    const sessionResult = await client.session.create()
    if (sessionResult.error || !sessionResult.data) {
      log.error(`Failed to create session: ${JSON.stringify(sessionResult.error)}`)
      process.exit(1)
    }
    const sessionID = sessionResult.data.id
    log.success(`Session created: ${sessionID}`)

    // Run the loop
    await loopMain(client, sessionID, config)
  } finally {
    cleanupOpencodeFiles(config.cwd)
    if (serverClose) {
      log.info("Shutting down server...")
      serverClose()
    }
  }
}

async function loopMain(client: OpencodeClient, sessionID: string, config: Config) {
  const summaries: IterationSummary[] = []
  let totalCost = 0
  let currentIteration = 0

  // Set up signal handlers
  let aborted = false
  const onSignal = async () => {
    if (aborted) process.exit(1) // Force exit on second signal
    aborted = true
    log.warn("Received interrupt signal, aborting current session...")
    try {
      await client.session.abort({ path: { id: sessionID } })
    } catch {
      // ignore
    }
    printSummary(summaries, totalCost)
    process.exit(130)
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  // Subscribe to event stream
  const eventState = {
    idleResolve: null as ((value: void) => void) | null,
    errorResolve: null as ((value: any) => void) | null,
  }

  const eventSub = await subscribeToEvents(client, sessionID, {
    onIdle: () => {
      if (eventState.idleResolve) {
        eventState.idleResolve()
        eventState.idleResolve = null
      }
    },
    onError: (_sid, error) => {
      if (eventState.errorResolve) {
        eventState.errorResolve(error)
        eventState.errorResolve = null
      }
    },
    onToolUpdate: (tool, status, title) => {
      log.tool(tool, title ?? status)
    },
    onTextDelta: () => {
      // For future TUI streaming; no-op for now
    },
    onStatus: (_sid, status) => {
      log.status(`Session status: ${status}`)
    },
  })

  try {
    // Send initial prompt
    currentIteration = 1
    log.setIteration(currentIteration, config.maxIterations)
    log.separator()
    log.info("Sending initial prompt...")

    await sendPrompt(client, sessionID, config, config.prompt)

    // Main loop
    while (currentIteration <= config.maxIterations && !aborted) {
      const iterStart = Date.now()

      // Wait for session to go idle or error
      const result = await waitForIdleOrError(eventState, config.maxRetries, async (retryNum) => {
        log.warn(`Retrying prompt (attempt ${retryNum + 1}/${config.maxRetries})...`)
        const delay = [0, 5000, 15000][retryNum] ?? 15000
        if (delay > 0) await sleep(delay)
        await sendPrompt(client, sessionID, config, "Continue working on the task. Pick up where you left off.")
      })

      if (result === "error") {
        log.error("Max retries exceeded. Stopping loop.")
        break
      }

      // Session is idle — check what happened
      const assistantData = await getLatestAssistantParts(client, sessionID)
      const iterDuration = Date.now() - iterStart
      const loopResult = assistantData ? extractLoopControl(assistantData.parts) : null

      const summary: IterationSummary = {
        iteration: currentIteration,
        status: loopResult,
        cost: assistantData?.cost ?? 0,
        tokens: assistantData?.tokens ?? { input: 0, output: 0 },
        duration: iterDuration,
      }
      summaries.push(summary)
      totalCost += summary.cost

      // Log iteration result
      if (loopResult) {
        const statusLabel = loopResult.status.toUpperCase()
        if (loopResult.status === "complete") {
          log.success(`Agent signaled COMPLETE: ${loopResult.message}`)
          break
        } else if (loopResult.status === "blocked") {
          log.error(`Agent signaled BLOCKED: ${loopResult.message}`)
          break
        } else if (loopResult.status === "progress") {
          log.info(`Agent signaled PROGRESS: ${loopResult.message}`)
        } else {
          log.warn(`Agent signaled ${statusLabel}: ${loopResult.message}`)
        }
      } else {
        log.warn("Agent did not call loop_control. Re-prompting to continue...")
      }

      // Check if we've hit max iterations
      currentIteration++
      if (currentIteration > config.maxIterations) {
        log.warn(`Reached max iterations (${config.maxIterations}). Stopping loop.`)
        break
      }

      log.setIteration(currentIteration, config.maxIterations)
      log.separator()

      // Re-prompt
      const continueMsg = loopResult
        ? "Continue working on the task. You previously reported progress. Pick up where you left off."
        : "Continue working on the task. Remember to call the loop_control tool when you reach a stopping point — use 'complete' when all work is done, 'progress' to report a checkpoint, or 'blocked' if you're stuck."

      log.info("Re-prompting agent...")
      await sendPrompt(client, sessionID, config, continueMsg)
    }
  } finally {
    eventSub.abort()
  }

  printSummary(summaries, totalCost)
}

async function sendPrompt(
  client: OpencodeClient,
  sessionID: string,
  config: Config,
  text: string
) {
  const body: any = {
    parts: [{ type: "text" as const, text }],
    agent: config.agent,
  }
  if (config.model) {
    body.model = config.model
  }

  const result = await client.session.promptAsync({
    path: { id: sessionID },
    body,
  })

  // promptAsync returns 204 on success. Check for errors.
  if (result.error) {
    throw new Error(`Failed to send prompt: ${JSON.stringify(result.error)}`)
  }
}

/**
 * Wait for session.idle or session.error events.
 * On error, calls the retry callback and waits again.
 * Returns "idle" on success, "error" if retries exhausted.
 */
async function waitForIdleOrError(
  state: {
    idleResolve: ((value: void) => void) | null
    errorResolve: ((value: any) => void) | null
  },
  maxRetries: number,
  onRetry: (retryNum: number) => Promise<void>
): Promise<"idle" | "error"> {
  let retries = 0

  while (true) {
    const result = await new Promise<"idle" | { error: any }>((resolve) => {
      state.idleResolve = () => resolve("idle")
      state.errorResolve = (err) => resolve({ error: err })
    })

    if (result === "idle") return "idle"

    // Error occurred
    log.error(`Session error: ${JSON.stringify(result.error)}`)
    retries++
    if (retries >= maxRetries) return "error"

    await onRetry(retries - 1)
  }
}

function printSummary(summaries: IterationSummary[], totalCost: number) {
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
    const duration = (s.duration / 1000).toFixed(1)
    const cost = s.cost.toFixed(4)
    log.info(`  Iteration ${s.iteration}: ${status} (${duration}s, $${cost})`)
  }

  const totalDuration = summaries.reduce((a, s) => a + s.duration, 0)
  const totalTokensIn = summaries.reduce((a, s) => a + s.tokens.input, 0)
  const totalTokensOut = summaries.reduce((a, s) => a + s.tokens.output, 0)

  log.separator()
  log.info(`Total iterations: ${summaries.length}`)
  log.info(`Total time: ${(totalDuration / 1000).toFixed(1)}s`)
  log.info(`Total cost: $${totalCost.toFixed(4)}`)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Entry point ──────────────────────────────────────────────────────

run().catch((err) => {
  log.error(`Fatal error: ${err.message}`)
  if (err.stack) log.error(err.stack)
  process.exit(1)
})
