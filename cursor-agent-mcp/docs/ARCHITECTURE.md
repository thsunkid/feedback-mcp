# Architecture: Bidirectional Claude Code ↔ Cursor CLI Sessions

## Problem

Claude Code (master) needs to delegate tasks to Cursor CLI (subagent) using Cursor's model catalog (GPT-5, Gemini, etc.) while allowing the subagent to **ask questions back** mid-task and receive answers before continuing.

The constraint: `cursor-agent --print` is one-shot — it takes a prompt, runs, outputs, exits. There is no persistent session, no stdin after launch, no MCP client support.

## Solution: Multi-Round One-Shot Invocations

Bidirectional communication is achieved by running **multiple one-shot `cursor-agent --print` calls**, where the MCP server:

1. Manages conversation history across rounds (server-side session state)
2. Injects a **prompt protocol** that teaches cursor-agent to signal questions vs. results
3. Rebuilds the full context (protocol + history + latest message) on each round
4. Parses cursor-agent's output for protocol markers
5. Returns structured status to Claude Code so it knows whether to reply or collect the result

## How It Compares to Claude Code Agent Teams

Claude Code's native agent teams use an **InboxPoller** at the runtime level:

```
Teammate writes to ~/.claude/teams/{team}/inboxes/lead.json
  → Lead's Node.js runtime polls inbox between agentic loop turns
  → Messages injected as <teammate-message> XML in user-role turns
  → Model never calls a "check inbox" tool — delivery is automatic
```

Our approach replicates this pattern at the MCP tool level:

```
cursor-agent outputs [CURSOR_QUESTION]...[/CURSOR_QUESTION]
  → MCP server parses markers, saves session state to disk
  → Tool result contains the question + session_id
  → Claude Code's model sees [ACTION_REQUIRED] and calls session_reply
  → (Optional) PostToolUse hook reinforces by injecting additionalContext
```

The key difference: agent teams have runtime-level message injection (zero model effort). Our approach requires Claude Code to explicitly call `session_reply` — but the structured tool result format makes this natural for the model.

## Data Flow

```
Claude Code (Master)         MCP Server (server.js)        cursor-agent CLI
    |                              |                              |
    |-- session_start(task) ------>|                              |
    |                              |  1. Create session object    |
    |                              |  2. buildSessionPrompt()     |
    |                              |     (protocol + task)        |
    |                              |  3. invokeCursorAgent()      |
    |                              |------ --print prompt ------->|
    |                              |                              |-- runs with gpt-5
    |                              |                              |-- detects ambiguity
    |                              |                              |-- wraps in markers:
    |                              |                              |   [CURSOR_QUESTION]
    |                              |                              |   Which module?
    |                              |                              |   [/CURSOR_QUESTION]
    |                              |<----- stdout ----------------|
    |                              |  4. parseSessionOutput()     |
    |                              |     → type: "question"       |
    |                              |  5. session.status =         |
    |                              |     "waiting_for_answer"     |
    |                              |  6. writeSessionFile()       |
    |<-- tool result: -------------|                              |
    |    status: waiting           |                              |
    |    question: "Which module?" |                              |
    |    ACTION_REQUIRED           |                              |
    |                              |                              |
    |  (Claude reads question,     |                              |
    |   formulates answer)         |                              |
    |                              |                              |
    |-- session_reply(id, ans) --->|                              |
    |                              |  7. Append answer to history |
    |                              |  8. buildSessionPrompt()     |
    |                              |     (protocol + history      |
    |                              |      + answer)               |
    |                              |  9. invokeCursorAgent()      |
    |                              |------ --print prompt ------->|
    |                              |                              |-- runs with full context
    |                              |                              |-- wraps in markers:
    |                              |                              |   [CURSOR_RESULT]
    |                              |                              |   Here's my review...
    |                              |                              |   [/CURSOR_RESULT]
    |                              |<----- stdout ----------------|
    |                              |  10. parseSessionOutput()    |
    |                              |      → type: "result"        |
    |                              |  11. session.status =        |
    |                              |      "completed"             |
    |<-- tool result: -------------|                              |
    |    status: completed         |                              |
    |    result: "Here's my..."    |                              |
```

## Key Components

### Protocol Preamble (server.js:247-270)

Injected at the start of every round's prompt. Teaches cursor-agent to use:
- `[CURSOR_QUESTION]...[/CURSOR_QUESTION]` — when it needs info to proceed
- `[CURSOR_RESULT]...[/CURSOR_RESULT]` — when it has a final answer

Rules enforce exactly one marker pair per response and require all content inside markers.

### Session State (in-memory Map + disk JSON)

```json
{
  "session_id": "f47ac10b-...",
  "status": "waiting_for_answer",
  "model": "gpt-5",
  "cwd": "/path/to/project",
  "force": true,
  "output_format": "text",
  "max_rounds": 10,
  "round": 2,
  "history": [
    { "role": "user", "content": "Review auth module" },
    { "role": "assistant", "content": "Which auth module?" },
    { "role": "user", "content": "The one in src/auth/" }
  ],
  "pending_question": "Which auth module?",
  "result": null,
  "raw_outputs": ["[full stdout from round 1]", "[full stdout from round 2]"],
  "created_at": 1706000000000,
  "updated_at": 1706000060000
}
```

Dual storage:
- **In-memory** `Map<string, Session>` for fast access during the MCP server's lifetime
- **On-disk** JSON at `$CURSOR_SESSION_DIR/<session_id>.json` so PostToolUse hooks (separate processes) can read session status

### Prompt Construction (buildSessionPrompt)

Each round builds a composite prompt:

```
=== INTERACTIVE SESSION PROTOCOL ===
[... rules about markers ...]
=== END PROTOCOL ===

=== CONVERSATION HISTORY ===
[User]: Review the auth module for security issues
[Assistant]: Which auth module? I see two candidates...
=== END HISTORY ===

Current request:
The one in src/auth/legacy.ts. Focus on JWT validation.
```

History entries are truncated at 8000 chars to prevent context overflow.

### Output Parsing (parseSessionOutput)

Regex extraction with graceful degradation:
1. Check for `[CURSOR_QUESTION]...[/CURSOR_QUESTION]` → return `{type: "question"}`
2. Check for `[CURSOR_RESULT]...[/CURSOR_RESULT]` → return `{type: "result"}`
3. No markers found → treat entire output as result (graceful fallback)

This means if cursor-agent ignores the protocol (e.g., a model that doesn't follow instructions well), the session still completes instead of hanging.

### invokeSessionRound (server.js:396-449)

The core orchestrator. Calls the **original** `invokeCursorAgent()` as a black box — no modifications to the existing executor. Steps:

1. Increment round counter
2. Guard against max_rounds exceeded
3. Build composite prompt with protocol + history
4. Call `invokeCursorAgent()` with `print: true`
5. Parse output for markers
6. Update session status (`waiting_for_answer` or `completed`)
7. Write to disk and in-memory Map
8. Return formatted result

### Tool Result Format

Claude Code sees structured text that makes the next action obvious:

**When waiting for answer:**
```
[SESSION_STATUS]
session_id: f47ac10b-...
status: waiting_for_answer
round: 2 / 10
model: gpt-5

[QUESTION_FROM_CURSOR_AGENT]
Which auth module should I refactor?

[ACTION_REQUIRED]
Call cursor_agent_session_reply with:
  session_id: "f47ac10b-..."
  reply: "<your answer>"
```

**When completed:**
```
[SESSION_STATUS]
session_id: f47ac10b-...
status: completed
round: 3 / 10

[RESULT_FROM_CURSOR_AGENT]
Here is the complete security review...
```

## PostToolUse Hook (Phase 2)

`hooks/post-tool-use.js` runs after every Claude Code tool call. It:
1. Scans all session JSON files in the session directory
2. If any session has `status: "waiting_for_answer"`, returns `additionalContext`
3. This gets injected into Claude Code's conversation, reminding it to reply

This mimics the InboxPoller pattern — ensuring Claude Code doesn't "forget" about a pending question while doing other work.

## Backward Compatibility

All existing functionality is preserved:
- `invokeCursorAgent()` — untouched (session tools call it as-is)
- `runCursorAgent()` — untouched
- All 7 original tools — untouched
- New session tools are additive only

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `CURSOR_SESSION_DIR` | `$TMPDIR/cursor-agent-mcp-sessions` | Session state file directory |
| `CURSOR_SESSION_TTL_MS` | `1800000` (30 min) | Auto-cleanup threshold for idle sessions |
| `CURSOR_SESSION_MAX_ROUNDS` | `10` | Default max rounds if not specified per session |
| `CURSOR_AGENT_TIMEOUT_MS` | `30000` | Per-round timeout (recommend 60000+ for sessions) |
| `DEBUG_CURSOR_MCP` | `0` | Enable stderr debug logging |

## Limitations & Future Work

1. **Each round is a fresh process** — cursor-agent doesn't retain memory between rounds. Context is rebuilt from history each time, consuming tokens.
2. **Prompt protocol depends on model compliance** — smaller/weaker models may not produce markers reliably. The graceful fallback mitigates this.
3. **History grows linearly** — each round adds to the prompt. `max_rounds` (default 10) and `MAX_HISTORY_ENTRY_CHARS` (8000) provide guardrails.
4. **No async/background mode** — session tools are synchronous. Claude Code blocks during each `invokeCursorAgent()` call.
5. **Single-machine only** — session state is on the local filesystem. Not suitable for distributed setups.
