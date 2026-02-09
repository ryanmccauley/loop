import { tool } from "@opencode-ai/plugin/tool"

export default tool({
  description:
    "MANDATORY: Signal your current status to the loop orchestrator. " +
    "You MUST call this tool as the LAST action of EVERY turn — it is the ONLY way to properly end your turn. " +
    "If you do not call this tool, the orchestrator will re-prompt you, wasting time and resources. " +
    "Use 'complete' when ALL tasks are finished, 'blocked' when you cannot proceed, " +
    "or 'progress' ONLY when there is clearly more work remaining. " +
    "Do NOT use 'progress' if all work is done — use 'complete' instead.",
  args: {
    status: tool.schema.enum(["complete", "blocked", "progress"]).describe(
      "'complete' = all tasks finished successfully, " +
      "'blocked' = cannot proceed due to an issue, " +
      "'progress' = reporting a checkpoint, will continue working"
    ),
    message: tool.schema.string().describe(
      "A brief summary of what was accomplished, what is blocked, or current progress"
    ),
  },
  async execute(args, context) {
    const fs = await import("fs")
    const path = await import("path")

    const statusFile = path.join(context.directory, ".opencode", "loop-status.json")
    const payload = {
      status: args.status,
      message: args.message,
      timestamp: new Date().toISOString(),
      sessionID: context.sessionID,
      messageID: context.messageID,
    }

    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.writeFileSync(statusFile, JSON.stringify(payload, null, 2))

    if (args.status === "complete") {
      return `Loop status set to COMPLETE. The orchestrator will end the loop. Summary: ${args.message}`
    }
    if (args.status === "blocked") {
      return `Loop status set to BLOCKED. The orchestrator will stop. Reason: ${args.message}`
    }
    return `Progress recorded. The orchestrator will continue the loop. Progress: ${args.message}`
  },
})
