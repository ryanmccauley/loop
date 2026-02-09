# opencode-loop

Autonomous loop orchestrator for [OpenCode](https://github.com/opencode-ai). Wraps the OpenCode AI coding agent in an iterative execution loop, re-prompting it until it signals that its work is complete, is blocked, or a maximum iteration limit is reached. Turns a single-turn AI coding assistant into a persistent, autonomous coding agent that can tackle multi-step tasks without human intervention.

## How It Works

1. You provide a prompt describing the work to be done.
2. The orchestrator sends the prompt to an OpenCode agent.
3. The agent works on the task using all available tools (editing files, running commands, searching code, etc.).
4. At the end of each turn, the agent calls a `loop_control` tool to signal its status:
   - **`complete`** -- All tasks are finished. The loop ends.
   - **`progress`** -- Progress was made but there's more to do. The loop continues.
   - **`blocked`** -- The agent cannot proceed. The loop ends.
5. If the agent forgets to call `loop_control`, the orchestrator re-prompts with escalating urgency.
6. Cost, tokens, and duration are tracked per iteration.

## Prerequisites

- [Bun](https://bun.sh/) runtime
- An AI provider configured in OpenCode (e.g. Anthropic API key)

## Installation

```bash
git clone https://github.com/ryanmccauley/loop.git
cd loop
bun install
```

## Usage

```bash
# Basic usage with an inline prompt
bun run src/index.ts "Implement user authentication with JWT tokens"

# Read the prompt from a file, targeting a specific project directory
bun run src/index.ts --file tasks/sprint-1.md --cwd ~/projects/myapp

# Attach to an already-running OpenCode server
bun run src/index.ts --attach http://localhost:4096 "Fix all failing tests"

# Use a specific model and disable the TUI
bun run src/index.ts --model anthropic/claude-sonnet-4-20250514 --no-tui "Refactor the database layer"
```

## CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--file <path>` | -- | Read prompt from a file instead of positional args |
| `--cwd <dir>` | Current directory | Target project directory |
| `--max-iterations <n>` | `50` | Maximum loop iterations |
| `--model <provider/id>` | -- | Model to use (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `--agent <name>` | `loop` | Agent name |
| `--port <n>` | `0` (auto) | Port for the OpenCode server |
| `--attach <url>` | -- | Connect to an existing OpenCode server |
| `--max-retries <n>` | `3` | Max retries on error per iteration |
| `--no-tui` | `false` | Disable TUI dashboard, use plain log output |
| `--help` | -- | Show help message |

## Display Modes

By default, the orchestrator renders a rich TUI dashboard showing live iteration progress, tool activity, and a history of completed iterations. Press `p` to pause/resume the loop and `q` to quit. Use `--no-tui` for plain text log output, which is useful for piping to a file or running in environments without full terminal support.
