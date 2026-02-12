# PostToolUse Hook for Cursor-Agent Sessions

This hook integrates with Claude Code's hook system to proactively remind Claude Code when a cursor-agent session is waiting for an answer.

## What it does

After every tool call, the hook:
1. Scans session state files on disk
2. If any session has `status: "waiting_for_answer"`, injects `additionalContext` into Claude Code's conversation
3. The context includes the pending question and instructions to call `cursor_agent_session_reply`

This mimics how Claude Code's native agent teams use the InboxPoller to inject teammate messages between agentic loop iterations.

## Installation

Add to your Claude Code settings (`.claude/settings.json` or project-level):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "command": "node /absolute/path/to/cursor-agent-mcp/hooks/post-tool-use.js",
        "timeout": 5000
      }
    ]
  }
}
```

Replace `/absolute/path/to` with the actual path to this repository.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `CURSOR_SESSION_DIR` | `$TMPDIR/cursor-agent-mcp-sessions` | Where session state files are stored |

The hook reads the same session directory that the MCP server writes to.

## How it works with the session tools

```
Claude Code calls cursor_agent_session_start("Review auth module", model: "gpt-5")
  → cursor-agent asks: "Which auth module?"
  → Tool returns: status=waiting_for_answer, question="Which auth module?"

Claude Code does other work (reads files, makes edits, etc.)
  → [PostToolUse hook fires after each tool call]
  → Hook detects waiting session
  → Injects: "Session abc-123 needs your answer: Which auth module?"
  → Claude Code sees the reminder and calls cursor_agent_session_reply

Claude Code calls cursor_agent_session_reply("abc-123", "The one in src/auth/")
  → cursor-agent continues and delivers final result
```

## Notes

- The hook is optional — the session tools work without it. The hook just ensures Claude Code doesn't "forget" about a pending question while doing other work.
- The hook scans all session files, so it works even if multiple sessions are active.
- Hook timeout is set to 5 seconds — the file scan is fast (sub-100ms typically).
