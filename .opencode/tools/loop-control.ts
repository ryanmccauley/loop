import { tool } from "@opencode-ai/plugin/tool"

export default tool({
  description:
    "Signal your current status to the loop orchestrator. " +
    "Call this tool when you have completed all work, when you are blocked and cannot proceed, " +
    "or to report progress at natural checkpoints. " +
    "You MUST call this with status 'complete' when you have finished all tasks.",
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
