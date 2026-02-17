# Cursor Agent MCP — Bidirectional Claude Code ↔ Cursor CLI Orchestration

MCP-based system for spawning a `cursor-agent` as a background subagent and communicating with it bidirectionally. One cursor-agent process, many turns, fully non-blocking.

## Architecture

```
┌──────────────────────┐       MCP tools          ┌───────────────────────┐
│   Claude Code        │◄─────────────────────────►│  Orchestrator MCP     │
│   (master agent)     │  cursor_agent_spawn/      │  orchestrator-mcp/    │
│                      │  check/reply/status/      │  server.js            │
│                      │  result/kill              │                       │
└──────────────────────┘                           └───────┬───────────────┘
                                                           │ file IPC
                                                           │ /tmp/cursor-bridge-session/
                                                           │ question_N.json ↔ answer_N.json
┌──────────────────────┐       MCP tool            ┌───────┴───────────────┐
│   cursor-agent       │──────────────────────────►│  Bridge MCP           │
│   (subagent, 1 proc) │  report_to_orchestrator   │  bridge-mcp/          │
│   --print --yolo     │  (blocks until answered)  │  server.js            │
└──────────────────────┘                           └───────────────────────┘
```

### Flow

1. Claude Code calls `cursor_agent_spawn(task, model)` → orchestrator MCP spawns `cursor-agent --print --yolo` in background
2. cursor-agent works on the task. When it needs to communicate, it calls `report_to_orchestrator` (bridge MCP tool)
3. Bridge MCP writes `question_N.json` to the session dir, then **blocks** polling for `answer_N.json`
4. Claude Code calls `cursor_agent_check()` → sees the question
5. Claude Code calls `cursor_agent_reply(answer)` → writes `answer_N.json`
6. Bridge MCP reads the answer, unblocks, returns it to cursor-agent
7. cursor-agent continues working, repeats from step 2
8. When done, Claude Code calls `cursor_agent_result()` for final output

## Components

### 1. Orchestrator MCP (`orchestrator-mcp/server.js`)

**Claude Code connects to this.** Provides 6 tools:

| Tool | Description |
|------|-------------|
| `cursor_agent_spawn` | Spawn background cursor-agent with task + model. Auto-prepends bridge protocol. |
| `cursor_agent_check` | Check for pending message from cursor-agent |
| `cursor_agent_reply` | Send reply to cursor-agent's question |
| `cursor_agent_status` | Get agent status: working / waiting_for_reply / completed |
| `cursor_agent_result` | Get agent's final stdout output |
| `cursor_agent_kill` | Force-terminate the agent |

Config for Claude Code (`.mcp.json` at project root):
```json
{
  "mcpServers": {
    "cursor-agent-orchestrator": {
      "command": "node",
      "args": ["/path/to/cursor-agent-mcp/orchestrator-mcp/server.js"],
      "env": { "BRIDGE_SESSION_DIR": "/tmp/cursor-bridge-session" }
    }
  }
}
```

### 2. Bridge MCP (`bridge-mcp/server.js`)

**cursor-agent connects to this.** Single tool: `report_to_orchestrator(message)`.

When called, writes a question file to the session dir, then blocks polling for an answer file. Returns the answer to cursor-agent when it appears.

Config for cursor-agent (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "orchestrator-bridge": {
      "command": "node",
      "args": ["/path/to/cursor-agent-mcp/bridge-mcp/server.js"],
      "env": {
        "BRIDGE_SESSION_DIR": "/tmp/cursor-bridge-session",
        "BRIDGE_POLL_MS": "500",
        "BRIDGE_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

Must be enabled: `cursor-agent mcp enable orchestrator-bridge`

### 3. Orchestrator CLI (`orchestrator.js`)

Standalone CLI wrapper for the same file IPC, useful for testing or Bash-based workflows:

```bash
node orchestrator.js spawn "task" --model composer-1
node orchestrator.js check      # pending question?
node orchestrator.js reply "answer"
node orchestrator.js status     # working/waiting/completed
node orchestrator.js result     # final output
node orchestrator.js kill       # terminate
```

### 4. Legacy One-Shot Tools (`server.js`)

The original single-shot MCP tools (`cursor_agent_chat`, `cursor_agent_edit_file`, etc.) for fire-and-forget delegation. Still work but don't support bidirectional communication.

## Setup

### Prerequisites

- Node.js 18+
- `cursor-agent` CLI installed and authenticated (`cursor-agent status`)

### Install

```bash
cd cursor-agent-mcp
npm install
```

### Configure bridge MCP for cursor-agent

Add to `~/.cursor/mcp.json` (see config above), then:

```bash
cursor-agent mcp enable orchestrator-bridge
cursor-agent mcp list-tools orchestrator-bridge
# Should show: report_to_orchestrator (message)
```

### Configure orchestrator MCP for Claude Code

Add `.mcp.json` to the project root (see config above). Restart Claude Code to load.

## Key Design Decisions

- **One process per task.** cursor-agent runs as a single `--print --yolo` process. Its agentic loop calls `report_to_orchestrator` multiple times internally.
- **File-based IPC.** Simple, debuggable, no sockets. Question/answer JSON files in a shared directory.
- **Blocking bridge.** The bridge MCP blocks until the orchestrator answers. cursor-agent waits naturally — no polling from its side.
- **Non-blocking orchestrator.** Claude Code spawns the agent in background (`detached: true`) and checks on it whenever convenient.
- **Protocol preamble auto-injected.** `cursor_agent_spawn` automatically prepends the bridge communication rules to the task prompt. The user just provides the task.
- **`--model` not `-m`.** cursor-agent's `-m` short flag is broken. Always use `--model`.
- **`--yolo` / `-f` for trust.** Required to skip workspace trust prompts in non-interactive mode.

## Testing

Quick smoke test of the bridge:

```bash
# Terminal 1: Spawn agent
node orchestrator.js spawn "Ask me what to build via report_to_orchestrator" --model composer-1

# Terminal 2: Watch for questions and answer
node orchestrator.js check
node orchestrator.js reply "Build a hello world function"
node orchestrator.js check
node orchestrator.js reply "Looks good, stop"
node orchestrator.js result
```

Full automated test (5 turns, 1 process):

```bash
node test_5turn_bridge.mjs
```

## File Structure

```
cursor-agent-mcp/
├── server.js                  # Legacy one-shot MCP tools (chat/edit/analyze/search/plan)
├── orchestrator.js            # CLI wrapper for file IPC (spawn/check/reply/status/result/kill)
├── package.json
├── bridge-mcp/
│   └── server.js              # Bridge MCP: report_to_orchestrator (cursor-agent side)
├── orchestrator-mcp/
│   └── server.js              # Orchestrator MCP: cursor_agent_* tools (Claude Code side)
├── hooks/
│   ├── post-tool-use.js       # PostToolUse hook for auto-discovering pending questions
│   └── README.md
├── docs/
│   ├── ARCHITECTURE.md        # Detailed architecture documentation
│   └── TESTING.md             # Comprehensive testing guide
├── test_5turn_bridge.mjs      # 5-turn single-process e2e test
├── test_3turn.mjs             # 3-turn session test
├── test_session_e2e.mjs       # Session tools e2e test
├── test_session_feedback.mjs  # 3-round feedback test
└── test_client.mjs            # Legacy smoke test client
```

## Future Improvements

- **Auto-answer mode.** Claude Code automatically decides answers without manual `reply` calls — full autonomous delegation.
- **Multiple concurrent agents.** Session-scoped IPC dirs to support parallel subagents.
- **Structured output.** Parse cursor-agent's stream-json output for richer status reporting.
- **Webhook/push notification.** Replace file polling with an HTTP callback or Unix socket for instant delivery.
- **Timeout + retry.** Auto-retry if bridge MCP times out, with exponential backoff.
