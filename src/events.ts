import type { OpencodeClient, Event, Part } from "@opencode-ai/sdk"

export type LoopStatus = "complete" | "blocked" | "progress" | "unknown"

export interface LoopControlResult {
  status: LoopStatus
  message: string
}

/**
 * Extract loop_control tool call result from message parts.
 * Looks for the last ToolPart with tool === "loop_control" that has completed.
 */
export function extractLoopControl(parts: Part[]): LoopControlResult | null {
  // Iterate in reverse to find the most recent loop_control call
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type === "tool" && part.tool === "loop_control") {
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
  return null
}

/**
 * Fetch the latest assistant message parts for a session.
 */
export async function getLatestAssistantParts(
  client: OpencodeClient,
  sessionID: string
): Promise<{ parts: Part[]; cost: number; tokens: { input: number; output: number } } | null> {
  const result = await client.session.messages({
    path: { id: sessionID },
  })
  if (result.error || !result.data) return null

  // Find the last assistant message
  const messages = result.data
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role === "assistant") {
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
  return null
}

export interface EventLoopCallbacks {
  onIdle: (sessionID: string) => void
  onError: (sessionID: string, error: any) => void
  onToolUpdate: (tool: string, status: string, title?: string) => void
  onTextDelta: (text: string) => void
  onStatus: (sessionID: string, status: string) => void
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
