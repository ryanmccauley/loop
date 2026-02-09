import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

export const LoopPlugin: Plugin = async ({ directory }) => {
  return {
    "experimental.session.compacting": async (_input, output) => {
      // Inject progress.md contents into compaction context if it exists
      const progressPath = join(directory, "progress.md")
      if (existsSync(progressPath)) {
        try {
          const content = readFileSync(progressPath, "utf-8")
          output.context.push(
            "## Progress Notes (from progress.md)\n\n" +
            "The following progress notes were saved from previous work. " +
            "Use these to understand what has already been done and what remains:\n\n" +
            content
          )
        } catch {
          // Ignore read errors
        }
      }

      // Also inject loop-status.json if it exists
      const statusPath = join(directory, ".opencode", "loop-status.json")
      if (existsSync(statusPath)) {
        try {
          const content = readFileSync(statusPath, "utf-8")
          const status = JSON.parse(content)
          output.context.push(
            "## Loop Status\n\n" +
            `Last reported status: **${status.status}**\n` +
            `Message: ${status.message}\n` +
            `Timestamp: ${status.timestamp}`
          )
        } catch {
          // Ignore parse errors
        }
      }
    },
  }
}
