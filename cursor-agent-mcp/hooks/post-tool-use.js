#!/usr/bin/env node
// PostToolUse hook for cursor-agent session tools.
// Reads session state from disk and injects pending questions as additionalContext
// so Claude Code is reminded to reply when a cursor-agent session is waiting.
//
// Install in Claude Code settings (.claude/settings.json):
// {
//   "hooks": {
//     "PostToolUse": [{
//       "command": "node /absolute/path/to/cursor-agent-mcp/hooks/post-tool-use.js",
//       "timeout": 5000
//     }]
//   }
// }

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let input;
try {
  input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
} catch {
  process.exit(0);
}

const sessionDir = process.env.CURSOR_SESSION_DIR
  || join(tmpdir(), 'cursor-agent-mcp-sessions');

// Scan all session files for any that are waiting for an answer
let waitingSessions = [];
try {
  for (const file of readdirSync(sessionDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const session = JSON.parse(readFileSync(join(sessionDir, file), 'utf8'));
      if (session.status === 'waiting_for_answer' && session.pending_question) {
        waitingSessions.push(session);
      }
    } catch {}
  }
} catch {
  // Session dir doesn't exist or can't be read — nothing to do
  process.exit(0);
}

if (waitingSessions.length === 0) {
  process.exit(0);
}

// Build additionalContext for all waiting sessions
const lines = ['[Cursor-Agent Sessions Awaiting Your Reply]', ''];
for (const session of waitingSessions) {
  lines.push(`Session: ${session.session_id} (round ${session.round}/${session.max_rounds})`);
  if (session.model) lines.push(`Model: ${session.model}`);
  lines.push(`Question: ${session.pending_question}`);
  lines.push('');
  lines.push(`To reply: call cursor_agent_session_reply with session_id "${session.session_id}" and your answer.`);
  lines.push('---');
}

const response = {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: lines.join('\n'),
  },
};

process.stdout.write(JSON.stringify(response));
process.exit(0);
