import { createOpencode, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { resolve, dirname } from "path"
import { parseConfig, type Config } from "./config.js"
import {
  subscribeToEvents,
  getLatestAssistantParts,
  extractLoopControl,
  type LoopControlResult,
} from "./events.js"
import type { LoopUI, IterationSummary } from "./ui.js"
import { LogUI } from "./log-ui.js"
import { TuiUI } from "./tui.js"

// ─── Agent & MCP configuration ────────────────────────────────────────

const LOOP_AGENT_PROMPT = `You are an autonomous coding agent running inside an iterative loop. The orchestrator will keep re-prompting you until you signal that your work is complete.

**CRITICAL: You MUST call the \`loop_control\` tool at the end of every single turn. Your turn is NOT considered finished until you call \`loop_control\`. If you do not call it, the orchestrator will assume you forgot and will re-prompt you, wasting time and resources. Text output alone does NOT end the loop.**

## How the Loop Works

1. You receive an initial prompt describing the work to be done.
2. You work on the task using all available tools — editing files, running commands, searching code, etc.
3. When you reach a natural stopping point, you MUST call the \`loop_control\` tool to signal your status:
   - \`complete\` — All tasks are finished and verified. The loop will end.
   - \`blocked\` — You cannot proceed due to an issue you can't resolve. The loop will end.
   - \`progress\` — You've made progress but there's more to do. The loop will continue and you'll be re-prompted.
4. If the orchestrator re-prompts you, continue where you left off. You have full context from previous iterations.

## When to Use Each Status

- **\`complete\`**: Use this when you have finished ALL the work requested. If there is nothing left to do, you MUST use \`complete\` — do not use \`progress\` when no work remains. Examples: you finished implementing a feature, you fixed the bug and tests pass, you answered the user's question fully.
- **\`progress\`**: Use this ONLY when there is clearly more work remaining that you intend to do in the next iteration. Examples: you finished step 1 of 3, you need to run tests after making changes but hit a tool limit.
- **\`blocked\`**: Use this only when you truly cannot proceed — e.g., missing credentials, ambiguous requirements that need human input, or a dependency that's broken in a way you can't fix.

## Rules

- **Always call \`loop_control\`** as the LAST action of each turn. This is mandatory, not optional. The \`loop_control\` tool call must be the final tool you invoke before your turn ends.
- **Be thorough.** Don't signal \`complete\` until you have verified your work (e.g., ran tests, checked for errors, confirmed the build passes).
- **Don't use \`progress\` when you're actually done.** If all tasks are complete, signal \`complete\`. Using \`progress\` when there's nothing left to do wastes an entire loop iteration.
- **Don't repeat work.** If you've already done something in a previous iteration, don't do it again unless there's a reason to.
- **Be concise** in your \`loop_control\` messages. The orchestrator logs them for the user.

## REMINDER: You MUST call \`loop_control\` before your turn ends. This is the ONLY way to properly signal the orchestrator. Do not end your turn without calling it.`

/** Path to the bundled MCP server script */
function getMcpServerPath(): string {
  return resolve(dirname(import.meta.dir), "src", "mcp-server.ts")
}

/** Build the config object for createOpencode with agent + MCP server defined inline */
function buildOpencodeConfig(config: Config): Record<string, any> {
  const agentConfig: Record<string, any> = {
    description: "Autonomous loop agent for iterative task completion",
    prompt: LOOP_AGENT_PROMPT,
    permission: {
      "*": "allow",
    },
    tools: { "*": true },
  }

  if (config.model) {
    agentConfig.model = `${config.model.providerID}/${config.model.modelID}`
  }

  return {
    agent: {
      [config.agent]: agentConfig,
    },
    mcp: {
      loop: {
        type: "local",
        command: ["bun", getMcpServerPath()],
        enabled: true,
        timeout: 10000,
      },
    },
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────

async function run() {
  const config = parseConfig(process.argv)

  // Create UI
  const ui: LoopUI = config.noTui ? new LogUI() : await TuiUI.create()

  const modelLabel = config.model
    ? `${config.model.providerID}/${config.model.modelID}`
    : undefined

  let client: OpencodeClient
  let serverClose: (() => void) | undefined
  let serverUrl: string | undefined

  try {
    // Connect or start server
    if (config.attach) {
      ui.onInfo(`Attaching to existing server at ${config.attach}`)
      client = createOpencodeClient({ baseUrl: config.attach })
      serverUrl = config.attach
    } else {
      ui.onInfo("Starting opencode server...")
      // Change to target directory so opencode serves the correct project
      process.chdir(config.cwd)
      const opencodeConfig = buildOpencodeConfig(config)
      const result = await createOpencode({
        port: config.port || undefined,
        config: opencodeConfig as any,
      })
      client = result.client
      serverClose = result.server.close
      serverUrl = result.server.url
      ui.onSuccess(`Server started at ${result.server.url}`)
    }

    // Now that we have serverUrl, call onStart
    ui.onStart(config.prompt, config.cwd, config.maxIterations, modelLabel, serverUrl)

    // Create session
    ui.onInfo("Creating session...")
    const sessionResult = await client.session.create()
    if (sessionResult.error || !sessionResult.data) {
      ui.onError(`Failed to create session: ${JSON.stringify(sessionResult.error)}`)
      process.exit(1)
    }
    const sessionID = sessionResult.data.id
    ui.onSuccess(`Session created: ${sessionID}`)

    // Run the loop
    await loopMain(client, sessionID, config, ui)
  } finally {
    if (serverClose) {
      ui.onInfo("Shutting down server...")
      serverClose()
    }
    await ui.waitForExit()
    ui.destroy()
  }
}

async function loopMain(client: OpencodeClient, sessionID: string, config: Config, ui: LoopUI) {
  const summaries: IterationSummary[] = []
  let totalCost = 0
  let currentIteration = 0
  let consecutiveMisses = 0 // Track consecutive turns without loop_control call

  // Set up signal handlers
  let aborted = false
  const onSignal = async () => {
    if (aborted) process.exit(1) // Force exit on second signal
    aborted = true
    ui.onWarn("Received interrupt signal, aborting current session...")
    try {
      await client.session.abort({ path: { id: sessionID } })
    } catch {
      // ignore
    }
    ui.onLoopComplete(summaries, totalCost)
    ui.destroy()
    process.exit(130)
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  // Subscribe to event stream
  const eventState = {
    idleResolve: null as ((value: void) => void) | null,
    errorResolve: null as ((value: any) => void) | null,
    latestLoopControl: null as import("./events.js").LoopControlResult | null,
  }

  const eventSub = await subscribeToEvents(client, sessionID, {
    onIdle: () => {
      if (eventState.idleResolve) {
        eventState.idleResolve()
        eventState.idleResolve = null
      }
    },
    onError: (_sid, error) => {
      // If this is a real session error, dispatch to the error resolver
      if (_sid && eventState.errorResolve) {
        eventState.errorResolve(error)
        eventState.errorResolve = null
      } else {
        // Event stream infrastructure error
        ui.onError(String(error))
      }
    },
    onToolUpdate: (tool, status, title) => {
      ui.onToolUpdate(tool, status, title)
    },
    onTextDelta: () => {
      // For future streaming; no-op for now
    },
    onStatus: (_sid, status) => {
      ui.onStatusChange(status)
    },
    onLoopControl: (result) => {
      eventState.latestLoopControl = result
    },
  })

  try {
    // Send initial prompt
    currentIteration = 1
    ui.onIterationStart(currentIteration, config.maxIterations)
    ui.onInfo("Sending initial prompt...")

    await sendPrompt(client, sessionID, config, config.prompt)

    // Main loop
    while (currentIteration <= config.maxIterations && !aborted) {
      const iterStart = Date.now()

      // Reset SSE-captured loop_control for this iteration
      eventState.latestLoopControl = null

      // Wait for session to go idle or error
      const result = await waitForIdleOrError(eventState, config.maxRetries, ui, async (retryNum) => {
        ui.onWarn(`Retrying prompt (attempt ${retryNum + 1}/${config.maxRetries})...`)
        const delay = [0, 5000, 15000][retryNum] ?? 15000
        if (delay > 0) await sleep(delay)
        await sendPrompt(client, sessionID, config, "Continue working on the task. Pick up where you left off.")
      })

      if (result === "error") {
        ui.onError("Max retries exceeded. Stopping loop.")
        break
      }

      // Session is idle — check what happened
      // Prefer SSE-captured loop_control (real-time, no race condition)
      // Fall back to REST API fetch if SSE missed it
      const assistantData = await getLatestAssistantParts(client, sessionID, true)
      const iterDuration = Date.now() - iterStart

      let loopResult: LoopControlResult | null = eventState.latestLoopControl
      if (!loopResult && assistantData) {
        loopResult = extractLoopControl(assistantData.parts, true)
      }

      const summary: IterationSummary = {
        iteration: currentIteration,
        status: loopResult,
        cost: assistantData?.cost ?? 0,
        tokens: assistantData?.tokens ?? { input: 0, output: 0 },
        duration: iterDuration,
      }
      summaries.push(summary)
      totalCost += summary.cost

      // Notify UI
      ui.onIterationComplete(summary)

      // Determine if we should stop
      if (loopResult) {
        consecutiveMisses = 0
        if (loopResult.status === "complete" || loopResult.status === "blocked") {
          break
        }
      } else {
        consecutiveMisses++
        ui.onWarn(`Agent did not call loop_control (miss #${consecutiveMisses}). Re-prompting to continue...`)
      }

      // Check if we've hit max iterations
      currentIteration++
      if (currentIteration > config.maxIterations) {
        ui.onWarn(`Reached max iterations (${config.maxIterations}). Stopping loop.`)
        break
      }

      // If paused (TUI feature), wait for unpause
      if (ui.isPaused()) {
        ui.onInfo("Loop paused. Press 'p' to resume...")
        if (ui instanceof TuiUI) {
          await ui.waitForUnpause()
        }
      }

      ui.onIterationStart(currentIteration, config.maxIterations)

      // Re-prompt with escalating urgency based on consecutive misses
      let continueMsg: string
      if (loopResult) {
        // Agent called loop_control with "progress" — nudge toward completion
        continueMsg =
          "Continue working on the task. You previously reported progress. Pick up where you left off. " +
          "When you are done with all remaining work, you MUST call `loop_control` with status 'complete'. " +
          "Do NOT use 'progress' if there is nothing left to do."
      } else if (consecutiveMisses === 1) {
        continueMsg =
          "You did not call the `loop_control` tool on your last turn. " +
          "You MUST call `loop_control` at the end of every turn — it is the only way to signal the orchestrator. " +
          "If all work is done, call `loop_control` with status 'complete'. " +
          "If there's more to do, call it with 'progress'. " +
          "If you're stuck, call it with 'blocked'. " +
          "Continue working, and make sure to call `loop_control` before your turn ends."
      } else if (consecutiveMisses === 2) {
        continueMsg =
          "IMPORTANT: You have failed to call `loop_control` for 2 consecutive turns. " +
          "This is wasting loop iterations. You MUST call the `loop_control` tool RIGHT NOW. " +
          "If your work is complete, call `loop_control` with status 'complete' and a brief summary. " +
          "If you still have work to do, call `loop_control` with status 'progress'. " +
          "Do not perform any other actions — just call `loop_control` immediately."
      } else {
        continueMsg =
          "CRITICAL: You have NOT called `loop_control` for " + consecutiveMisses + " consecutive turns. " +
          "STOP all other work. Your ONLY task right now is to call the `loop_control` tool. " +
          "Call `loop_control` with status 'complete' if work is done, 'progress' if not, or 'blocked' if stuck. " +
          "Do NOT do anything else. Just call `loop_control`."
      }

      ui.onInfo("Re-prompting agent...")
      await sendPrompt(client, sessionID, config, continueMsg)
    }
  } finally {
    eventSub.abort()
  }

  ui.onLoopComplete(summaries, totalCost)
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
  ui: LoopUI,
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
    ui.onError(`Session error: ${JSON.stringify(result.error)}`)
    retries++
    if (retries >= maxRetries) return "error"

    await onRetry(retries - 1)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Entry point ──────────────────────────────────────────────────────

run().catch((err) => {
  console.error(`Fatal error: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
