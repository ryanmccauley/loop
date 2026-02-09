import type { OpencodeClient, Event, Part } from "@opencode-ai/sdk"

export type LoopStatus = "complete" | "blocked" | "progress" | "unknown"

export interface LoopControlResult {
  status: LoopStatus
  message: string
}

/**
 * Extract loop_control tool call result from message parts.
 * Looks for the last ToolPart with a tool name ending in "loop_control" that has completed.
 * Uses endsWith to handle both native tool names and MCP-prefixed names
 * (e.g. "loop_control", "loop_loop_control").
 */
export function extractLoopControl(parts: Part[], debug = false): LoopControlResult | null {
  if (debug) {
    console.error(`[DEBUG extractLoopControl] parts.length=${parts.length}`)
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (p.type === "tool") {
        console.error(`[DEBUG extractLoopControl]   part[${i}] type=tool tool=${p.tool} state.status=${p.state?.status}`)
      } else {
        console.error(`[DEBUG extractLoopControl]   part[${i}] type=${p.type}`)
      }
    }
  }

  // Iterate in reverse to find the most recent loop_control call
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type === "tool" && part.tool.endsWith("loop_control")) {
      if (debug) {
        console.error(`[DEBUG extractLoopControl] Found loop_control at part[${i}], state=${JSON.stringify(part.state)}`)
      }
      if (part.state.status === "completed") {
        const input = part.state.input as { status?: string; message?: string }
        return {
          status: (input.status as LoopStatus) ?? "unknown",
          message: input.message ?? "",
        }
      }
      if (part.state.status === "error") {
        return {
          status: "unknown",
          message: `loop_control tool errored: ${part.state.error}`,
        }
      }
    }
  }
  if (debug) {
    console.error(`[DEBUG extractLoopControl] No loop_control found, returning null`)
  }
  return null
}

/**
 * Fetch the latest assistant message parts for a session.
 */
export async function getLatestAssistantParts(
  client: OpencodeClient,
  sessionID: string,
  debug = false
): Promise<{ parts: Part[]; cost: number; tokens: { input: number; output: number } } | null> {
  const result = await client.session.messages({
    path: { id: sessionID },
  })
  if (result.error || !result.data) {
    if (debug) {
      console.error(`[DEBUG getLatestAssistantParts] error=${JSON.stringify(result.error)}, data=${result.data}`)
    }
    return null
  }

  // Find the last assistant message
  const messages = result.data
  if (debug) {
    console.error(`[DEBUG getLatestAssistantParts] total messages=${messages.length}`)
    // Log last few messages with roles
    const start = Math.max(0, messages.length - 5)
    for (let i = start; i < messages.length; i++) {
      const msg = messages[i]
      console.error(`[DEBUG getLatestAssistantParts]   msg[${i}] role=${msg.info.role} id=${msg.info.id} parts=${msg.parts.length}`)
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role === "assistant") {
      if (debug) {
        console.error(`[DEBUG getLatestAssistantParts] Using assistant msg[${i}] id=${msg.info.id} with ${msg.parts.length} parts`)
      }
      return {
        parts: msg.parts,
        cost: msg.info.cost,
        tokens: {
          input: msg.info.tokens.input,
          output: msg.info.tokens.output,
        },
      }
    }
  }
  if (debug) {
    console.error(`[DEBUG getLatestAssistantParts] No assistant message found!`)
  }
  return null
}

export interface EventLoopCallbacks {
  onIdle: (sessionID: string) => void
  onError: (sessionID: string, error: any) => void
  onToolUpdate: (tool: string, status: string, title?: string) => void
  onTextDelta: (text: string) => void
  onStatus: (sessionID: string, status: string) => void
  onLoopControl: (result: LoopControlResult) => void
}

/**
 * Subscribe to SSE event stream and dispatch to callbacks.
 * Returns an abort function to stop listening.
 */
export async function subscribeToEvents(
  client: OpencodeClient,
  targetSessionID: string,
  callbacks: EventLoopCallbacks
): Promise<{ abort: () => void }> {
  const abortController = new AbortController()

  // Start consuming events in the background
  const eventLoop = (async () => {
    try {
      const subscription = await client.event.subscribe()
      const stream = subscription.stream

      for await (const event of stream) {
        if (abortController.signal.aborted) break

        const evt = event as Event

        // Filter for events related to our session
        switch (evt.type) {
          case "session.idle": {
            if (evt.properties.sessionID === targetSessionID) {
              callbacks.onIdle(evt.properties.sessionID)
            }
            break
          }
          case "session.error": {
            if (evt.properties.sessionID === targetSessionID) {
              callbacks.onError(evt.properties.sessionID, evt.properties.error)
            }
            break
          }
          case "session.status": {
            if (evt.properties.sessionID === targetSessionID) {
              const status = evt.properties.status
              callbacks.onStatus(
                evt.properties.sessionID,
                status.type === "retry"
                  ? `retry (attempt ${status.attempt}: ${status.message})`
                  : status.type
              )
            }
            break
          }
          case "message.part.updated": {
            const part = evt.properties.part as Part
            if (part.sessionID !== targetSessionID) break

            if (part.type === "tool") {
              const title =
                part.state.status === "completed" || part.state.status === "running"
                  ? part.state.title
                  : undefined
              callbacks.onToolUpdate(part.tool, part.state.status, title ?? undefined)

              // Detect loop_control completion directly from SSE stream
              if (part.tool.endsWith("loop_control") && part.state.status === "completed") {
                const input = part.state.input as { status?: string; message?: string }
                callbacks.onLoopControl({
                  status: (input.status as LoopStatus) ?? "unknown",
                  message: input.message ?? "",
                })
              } else if (part.tool.endsWith("loop_control") && part.state.status === "error") {
                callbacks.onLoopControl({
                  status: "unknown",
                  message: `loop_control tool errored: ${(part.state as any).error}`,
                })
              }
            }
            break
          }
        }
      }
    } catch (err: any) {
      if (!abortController.signal.aborted) {
        callbacks.onError("", `Event stream error: ${err.message}`)
      }
    }
  })()

  return {
    abort: () => {
      abortController.abort()
    },
  }
}
