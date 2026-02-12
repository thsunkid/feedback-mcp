# Testing Guide: Cursor-Agent MCP Session Tools

## Prerequisites

1. **Pull the branch:**
   ```bash
   git fetch origin claude/claude-cli-agent-orchestration-Uxqrw
   git checkout claude/claude-cli-agent-orchestration-Uxqrw
   ```

2. **Install dependencies:**
   ```bash
   cd cursor-agent-mcp
   npm ci
   ```

3. **Ensure cursor-agent CLI is available:**
   ```bash
   cursor-agent --version
   # If not on PATH, set: export CURSOR_AGENT_PATH=/path/to/cursor-agent
   ```

4. **Recommended env for testing:**
   ```bash
   export CURSOR_AGENT_TIMEOUT_MS=60000       # 60s per round (sessions need more time)
   export CURSOR_AGENT_FORCE=true              # Allow file writes without confirmation
   export DEBUG_CURSOR_MCP=1                   # See spawn/exit logs on stderr
   export CURSOR_AGENT_ECHO_PROMPT=1           # See the full prompt in output
   ```

---

## Test Level 1: Syntax & Startup

### Test 1.1: Server starts without errors
```bash
# Should hang waiting for MCP stdin — that means it started OK
# Press Ctrl+C to exit
node server.js
```
Expected: No error output, process waits for input.

### Test 1.2: Node syntax check
```bash
node --check server.js && echo "OK"
node --check hooks/post-tool-use.js && echo "OK"
```
Expected: Both print "OK".

### Test 1.3: Tool discovery via test client
```bash
node test_client.mjs "hello"
```
Expected: Output includes all 11 tools:
```
Tools: cursor_agent_chat, cursor_agent_edit_file, cursor_agent_analyze_files,
cursor_agent_search_repo, cursor_agent_plan_task, cursor_agent_raw,
cursor_agent_run, cursor_agent_session_start, cursor_agent_session_reply,
cursor_agent_session_status, cursor_agent_session_end
```

---

## Test Level 2: Original Tools (Backward Compat)

### Test 2.1: One-shot chat still works
```bash
TEST_TOOL=cursor_agent_chat node test_client.mjs "What is 2+2?"
```
Expected: Returns a response containing "4". No session state created.

### Test 2.2: Raw tool still works
```bash
TEST_TOOL=cursor_agent_raw TEST_ARGV='["--version"]' node test_client.mjs
```
Expected: Returns cursor-agent version string.

### Test 2.3: Search tool still works
```bash
TEST_TOOL=cursor_agent_search_repo TEST_QUERY="import" node test_client.mjs
```
Expected: Returns search results from the repo.

---

## Test Level 3: Session Tools (Unit-Level)

These tests verify the session tools work at the MCP protocol level. They require writing a small test script since `test_client.mjs` doesn't yet have session test cases.

### Test 3.1: Session start (happy path)

Create `test_session.mjs`:

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['./server.js'],
    cwd: new URL('.', import.meta.url).pathname,
    env: {
      ...process.env,
      CURSOR_AGENT_TIMEOUT_MS: '60000',
      DEBUG_CURSOR_MCP: '1',
    },
  });

  const client = new Client({ name: 'session-test', version: '0.0.1' });
  await client.connect(transport);

  // List tools to verify session tools exist
  const tools = await client.listTools({});
  const names = tools.tools.map(t => t.name);
  console.log('Session tools present:',
    names.filter(n => n.includes('session')).join(', '));

  // Start a session
  console.log('\n--- Starting session ---');
  const startResult = await client.callTool({
    name: 'cursor_agent_session_start',
    arguments: {
      prompt: 'I want you to review a codebase. Before you start, ask me which directory to focus on.',
      output_format: 'text',
      max_rounds: 5,
    },
  });

  const startText = startResult.content
    .filter(c => c.type === 'text').map(c => c.text).join('\n');
  console.log('Start result:\n', startText.slice(0, 1000));

  // Extract session_id
  const idMatch = startText.match(/session_id:\s*([a-f0-9-]+)/);
  if (!idMatch) {
    console.error('No session_id found in output!');
    await client.close();
    return;
  }
  const sessionId = idMatch[1];
  console.log('\nSession ID:', sessionId);

  // Check if it's waiting for answer
  if (startText.includes('waiting_for_answer')) {
    console.log('\n--- Session is waiting, sending reply ---');
    const replyResult = await client.callTool({
      name: 'cursor_agent_session_reply',
      arguments: {
        session_id: sessionId,
        reply: 'Focus on the src/ directory. Look for security issues.',
      },
    });

    const replyText = replyResult.content
      .filter(c => c.type === 'text').map(c => c.text).join('\n');
    console.log('Reply result:\n', replyText.slice(0, 1000));
  } else {
    console.log('Session completed in first round (no question asked).');
  }

  // Check status
  console.log('\n--- Checking session status ---');
  const statusResult = await client.callTool({
    name: 'cursor_agent_session_status',
    arguments: { session_id: sessionId },
  });
  const statusText = statusResult.content
    .filter(c => c.type === 'text').map(c => c.text).join('\n');
  console.log('Status:\n', statusText.slice(0, 500));

  // End session
  console.log('\n--- Ending session ---');
  const endResult = await client.callTool({
    name: 'cursor_agent_session_end',
    arguments: { session_id: sessionId },
  });
  console.log('End result:',
    endResult.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));

  await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
```

Run:
```bash
node test_session.mjs
```

Expected:
1. Session tools listed
2. Session starts, cursor-agent either asks a question or delivers a result
3. If question: reply sends answer, next round runs
4. Status shows session state
5. End terminates cleanly

### Test 3.2: Session with specific model
```bash
# Set model for the session
CURSOR_AGENT_MODEL=gpt-4o node test_session.mjs
```
Expected: Same flow, but cursor-agent uses gpt-4o.

### Test 3.3: Session not found (error case)
Add to your test script or run inline:
```javascript
const result = await client.callTool({
  name: 'cursor_agent_session_reply',
  arguments: { session_id: 'nonexistent-id', reply: 'hello' },
});
// Expected: isError: true, message contains "not found"
```

### Test 3.4: Reply to non-waiting session (error case)
```javascript
// After a session completes:
const result = await client.callTool({
  name: 'cursor_agent_session_reply',
  arguments: { session_id: completedSessionId, reply: 'hello' },
});
// Expected: isError: true, message contains "not waiting for an answer"
```

---

## Test Level 4: Integration with Claude Code

These tests use a real Claude Code CLI session talking to the MCP server.

### Test 4.1: Add MCP server to Claude Code

Add to your `.claude/settings.json` (or use `claude mcp add`):

```json
{
  "mcpServers": {
    "cursor-agent": {
      "command": "node",
      "args": ["/absolute/path/to/cursor-agent-mcp/server.js"],
      "env": {
        "CURSOR_AGENT_TIMEOUT_MS": "60000",
        "CURSOR_AGENT_FORCE": "true",
        "CURSOR_AGENT_MODEL": "gpt-5",
        "DEBUG_CURSOR_MCP": "1"
      }
    }
  }
}
```

Or via CLI:
```bash
claude mcp add cursor-agent -- node /absolute/path/to/cursor-agent-mcp/server.js
```

### Test 4.2: Simple delegation (no questions)

Prompt Claude Code:
```
Use cursor_agent_session_start to ask cursor-agent: "What is the capital of France?"
```

Expected:
- Claude Code calls `cursor_agent_session_start`
- cursor-agent responds with `[CURSOR_RESULT]` containing the answer
- Session completes in 1 round

### Test 4.3: Multi-round conversation

Prompt Claude Code:
```
Use cursor_agent_session_start to delegate this task to cursor-agent:
"I need you to refactor a module, but first ask me which one."
When cursor-agent asks you a question, answer: "Refactor the auth module in src/auth/."
```

Expected:
- Round 1: cursor-agent asks which module → status: `waiting_for_answer`
- Claude Code sees `[ACTION_REQUIRED]` and calls `session_reply`
- Round 2: cursor-agent delivers result → status: `completed`

### Test 4.4: Model selection

Prompt Claude Code:
```
Start a session with cursor-agent using model "gpt-4o" and ask it to explain
how async/await works in JavaScript in 3 sentences.
```

Expected: Session starts with `model: "gpt-4o"` shown in the status output.

### Test 4.5: Multi-round with 3+ rounds

Prompt Claude Code:
```
Start a session with cursor-agent for this task:
"Help me design a database schema. Ask me questions one at a time about
my requirements before proposing the schema."
Answer each question cursor-agent asks until it delivers a final schema.
```

Expected:
- Multiple rounds of Q&A
- Each round shows incrementing round counter
- Final round has status: `completed` with the schema

---

## Test Level 5: PostToolUse Hook

### Test 5.1: Install the hook

Add to `.claude/settings.json`:
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

### Test 5.2: Hook fires on waiting session

1. Start a session that will ask a question
2. Before replying, do some other work (e.g., read a file)
3. Observe that the hook injects a reminder about the waiting session

Expected: After any tool call, Claude Code sees:
```
[Cursor-Agent Sessions Awaiting Your Reply]

Session: abc-123 (round 1/10)
Question: Which auth module?
```

### Test 5.3: Hook is silent when no sessions waiting

Do normal Claude Code work without any active sessions.

Expected: No additional context injected. Hook exits cleanly.

---

## Test Level 6: Edge Cases

### Test 6.1: Cursor-agent ignores protocol markers

Use a prompt that's so simple the model might not use markers:
```
Start a session: "Say hello"
```

Expected: `parseSessionOutput` fallback kicks in — treats entire output as result. Session completes normally.

### Test 6.2: Max rounds exceeded

```javascript
// Start session with max_rounds: 2
const result = await client.callTool({
  name: 'cursor_agent_session_start',
  arguments: {
    prompt: 'Ask me a series of 5 questions about my project before starting.',
    max_rounds: 2,
  },
});
// Reply once, then the next round should hit the limit
```

Expected: After 2 rounds, status is `error` with message "Max rounds (2) exceeded."

### Test 6.3: cursor-agent timeout

```bash
CURSOR_AGENT_TIMEOUT_MS=1000 node test_session.mjs
```

Expected: Session status is `error` with timeout message.

### Test 6.4: Session cleanup

```bash
# Set very short TTL
CURSOR_SESSION_TTL_MS=5000 node test_session.mjs
# Wait 6 seconds
sleep 6
# Check session dir — files should be cleaned on next session_start
```

### Test 6.5: Server restart mid-session

1. Start a session, get a `waiting_for_answer` response
2. Kill and restart the MCP server
3. Call `session_reply` with the session_id

Expected: Session is reloaded from disk via `resolveSession()`, conversation continues.

---

## Test Level 7: Session File Inspection

After any test, inspect the session state file:

```bash
# Find session files
ls /tmp/cursor-agent-mcp-sessions/

# Read a session
cat /tmp/cursor-agent-mcp-sessions/<session-id>.json | python3 -m json.tool
```

Verify:
- `session_id` matches what was returned
- `status` is correct (`waiting_for_answer`, `completed`, or `error`)
- `history` contains the full conversation
- `raw_outputs` contains the actual cursor-agent stdout per round
- `round` increments correctly
- `pending_question` is set when status is `waiting_for_answer`
- `result` is set when status is `completed`

---

## Quick Test Matrix

| # | Test | What to verify | Requires cursor-agent? |
|---|------|----------------|----------------------|
| 1.1 | Server starts | No crash on startup | No |
| 1.2 | Syntax check | `node --check` passes | No |
| 1.3 | Tool discovery | All 11 tools listed | No (but needs npm ci) |
| 2.1 | Chat backward compat | One-shot still works | Yes |
| 3.1 | Session happy path | Start → question → reply → result | Yes |
| 3.3 | Session not found | Error returned cleanly | No |
| 3.4 | Wrong state reply | Error returned cleanly | No |
| 4.2 | Claude Code simple | End-to-end with real Claude | Yes |
| 4.3 | Claude Code multi-round | Full bidirectional flow | Yes |
| 5.2 | Hook injection | additionalContext appears | Yes (needs active session) |
| 6.1 | No markers fallback | Graceful degradation | Yes |
| 6.2 | Max rounds | Error on overflow | Yes |
| 6.5 | Server restart | Disk recovery works | Yes |

---

## Debugging Tips

- **Enable debug mode:**
  ```bash
  export DEBUG_CURSOR_MCP=1
  ```
  This prints spawn args, exit codes, and session events to stderr.

- **Echo prompts:**
  ```bash
  export CURSOR_AGENT_ECHO_PROMPT=1
  ```
  Shows the full prompt sent to cursor-agent in the tool output.

- **Inspect session state:**
  ```bash
  cat /tmp/cursor-agent-mcp-sessions/*.json | python3 -m json.tool
  ```

- **Watch session dir for changes:**
  ```bash
  watch -n 1 'ls -la /tmp/cursor-agent-mcp-sessions/'
  ```

- **If cursor-agent hangs:**
  Increase timeout: `CURSOR_AGENT_TIMEOUT_MS=120000`
