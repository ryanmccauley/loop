#!/usr/bin/env bun
/**
 * Minimal stdio-based MCP server that exposes the `loop_control` tool.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (newline-delimited).
 * Only handles: initialize, notifications/initialized, tools/list, tools/call.
 */

import { createInterface } from "readline"

const TOOL_NAME = "loop_control"

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "MANDATORY: Signal your current status to the loop orchestrator. " +
    "You MUST call this tool as the LAST action of EVERY turn — it is the ONLY way to properly end your turn. " +
    "If you do not call this tool, the orchestrator will re-prompt you, wasting time and resources. " +
    "Use 'complete' when ALL tasks are finished, 'blocked' when you cannot proceed, " +
    "or 'progress' ONLY when there is clearly more work remaining. " +
    "Do NOT use 'progress' if all work is done — use 'complete' instead.",
  inputSchema: {
    type: "object" as const,
    properties: {
      status: {
        type: "string",
        enum: ["complete", "blocked", "progress"],
        description:
          "'complete' = all tasks finished successfully, " +
          "'blocked' = cannot proceed due to an issue, " +
          "'progress' = reporting a checkpoint, will continue working",
      },
      message: {
        type: "string",
        description:
          "A brief summary of what was accomplished, what is blocked, or current progress",
      },
    },
    required: ["status", "message"],
  },
}

function send(msg: object) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function handleRequest(id: string | number, method: string, params?: any) {
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "opencode-loop", version: "1.0.0" },
        },
      })
      break

    case "tools/list":
      send({
        jsonrpc: "2.0",
        id,
        result: { tools: [TOOL_DEFINITION] },
      })
      break

    case "tools/call": {
      const toolName = params?.name
      const args = params?.arguments ?? {}

      if (toolName !== TOOL_NAME) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        })
        return
      }

      const status = args.status ?? "unknown"
      const message = args.message ?? ""

      let text: string
      if (status === "complete") {
        text = `Loop status set to COMPLETE. The orchestrator will end the loop. Summary: ${message}`
      } else if (status === "blocked") {
        text = `Loop status set to BLOCKED. The orchestrator will stop. Reason: ${message}`
      } else {
        text = `Progress recorded. The orchestrator will continue the loop. Progress: ${message}`
      }

      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }] },
      })
      break
    }

    default:
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
  }
}

// Read JSON-RPC messages from stdin, one per line
const rl = createInterface({ input: process.stdin })

rl.on("line", (line) => {
  let msg: any
  try {
    msg = JSON.parse(line)
  } catch {
    return // ignore malformed input
  }

  // Notifications (no id) — just acknowledge silently
  if (msg.id === undefined || msg.id === null) {
    return
  }

  handleRequest(msg.id, msg.method, msg.params)
})
