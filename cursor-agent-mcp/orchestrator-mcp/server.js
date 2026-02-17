/**
 * Orchestrator MCP Server — Claude Code's native interface to cursor-agent.
 *
 * Tools:
 *   cursor_agent_spawn   — spawn a background cursor-agent process
 *   cursor_agent_check   — check for pending question from cursor-agent
 *   cursor_agent_reply   — reply to a pending question
 *   cursor_agent_status  — get agent status (working/waiting/completed)
 *   cursor_agent_result  — get final agent output
 *   cursor_agent_kill    — terminate the agent
 *
 * Env:
 *   BRIDGE_SESSION_DIR — shared IPC dir (default: /tmp/cursor-bridge-session)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import {
  existsSync, readFileSync, writeFileSync, readdirSync,
  mkdirSync, unlinkSync, createWriteStream,
} from 'node:fs';
import { join } from 'node:path';

const SESSION_DIR = process.env.BRIDGE_SESSION_DIR || '/tmp/cursor-bridge-session';
const STATE_FILE = join(SESSION_DIR, '.orchestrator-state.json');
mkdirSync(SESSION_DIR, { recursive: true });

// ── State helpers ────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { pid: null, answeredCount: 0, startedAt: null }; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findPendingQuestion() {
  const files = readdirSync(SESSION_DIR)
    .filter(f => f.startsWith('question_') && f.endsWith('.json'))
    .sort();
  for (const file of files) {
    const turnNum = parseInt(file.match(/question_(\d+)\.json/)?.[1], 10);
    if (!turnNum) continue;
    if (existsSync(join(SESSION_DIR, `answer_${turnNum}.json`))) continue;
    try {
      const data = JSON.parse(readFileSync(join(SESSION_DIR, file), 'utf8'));
      return { turn: turnNum, message: data.message };
    } catch { continue; }
  }
  return null;
}

function countAnswered() {
  return readdirSync(SESSION_DIR).filter(f => f.startsWith('answer_') && f.endsWith('.json')).length;
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const BRIDGE_PREAMBLE = [
  'You have access to "report_to_orchestrator" from "orchestrator-bridge" MCP.',
  'RULES:',
  '1. Use report_to_orchestrator for ALL communication with me.',
  '2. NEVER finish or exit on your own. After completing each unit of work, ALWAYS call report_to_orchestrator to report what you did and ask what to do next.',
  '3. If you need clarification or have questions, ask via report_to_orchestrator.',
  '4. Your workflow: receive instruction → do work → report_to_orchestrator → wait for reply → repeat.',
  '5. Only stop when I explicitly say "stop", "done", or "you can stop now".',
  '',
].join('\n');

const server = new McpServer(
  { name: 'cursor-agent-orchestrator', version: '1.0.0' },
  {
    instructions: [
      'Tools for spawning and communicating with a background cursor-agent subagent.',
      'Workflow: spawn → (check → reply) loop → result.',
      'The agent communicates back via bridge MCP. One process per task.',
    ].join(' '),
  }
);

// ── spawn ────────────────────────────────────────────────────────────────────

server.tool(
  'cursor_agent_spawn',
  'Spawn a background cursor-agent process. Returns immediately. The agent will call report_to_orchestrator to communicate — use cursor_agent_check to see its messages.',
  {
    task: z.string().min(1, 'task description is required'),
    model: z.string().default('composer-1'),
    cwd: z.string().optional(),
    output_file: z.string().optional().describe('File path for agent to write detailed results to'),
  },
  async ({ task, model, cwd, output_file }) => {
    // Clean old session files
    for (const f of readdirSync(SESSION_DIR)) {
      if (f.startsWith('question_') || f.startsWith('answer_')) {
        try { unlinkSync(join(SESSION_DIR, f)); } catch {}
      }
    }

    let prompt = BRIDGE_PREAMBLE + '\nTASK: ' + task;
    if (output_file) {
      prompt += `\n\nWrite detailed results to: ${output_file}`;
    }

    const child = spawn('cursor-agent', [
      '--print', '--yolo', '--model', model, '--output-format', 'text', prompt,
    ], {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdin.end();
    child.unref();

    const outStream = createWriteStream(join(SESSION_DIR, '.agent-stdout.txt'));
    const errStream = createWriteStream(join(SESSION_DIR, '.agent-stderr.txt'));
    child.stdout.pipe(outStream);
    child.stderr.pipe(errStream);

    const state = { pid: child.pid, answeredCount: 0, startedAt: Date.now() };
    saveState(state);

    return {
      content: [{ type: 'text', text: `Agent spawned (PID ${child.pid}, model: ${model}). Use cursor_agent_check to see its messages.` }],
    };
  }
);

// ── check ────────────────────────────────────────────────────────────────────

server.tool(
  'cursor_agent_check',
  'Check if cursor-agent has a pending question/message. Returns the message or "no pending question".',
  {},
  async () => {
    const q = findPendingQuestion();
    if (q) {
      return {
        content: [{ type: 'text', text: `[Turn ${q.turn}] Agent says: ${q.message}` }],
      };
    }
    const state = loadState();
    const running = state.pid ? isRunning(state.pid) : false;
    return {
      content: [{ type: 'text', text: running ? 'No pending question. Agent is still working.' : 'No pending question. Agent has finished.' }],
    };
  }
);

// ── reply ────────────────────────────────────────────────────────────────────

server.tool(
  'cursor_agent_reply',
  'Reply to cursor-agent\'s pending question. The agent will receive this and continue working.',
  {
    message: z.string().min(1, 'reply message is required'),
  },
  async ({ message }) => {
    const q = findPendingQuestion();
    if (!q) {
      return { content: [{ type: 'text', text: 'No pending question to reply to.' }], isError: true };
    }
    const answerFile = join(SESSION_DIR, `answer_${q.turn}.json`);
    const replyWithReminder = message + '\n\n[When done, call report_to_orchestrator.]';
    writeFileSync(answerFile, JSON.stringify({ reply: replyWithReminder, timestamp: Date.now() }), 'utf8');

    const state = loadState();
    state.answeredCount = countAnswered();
    saveState(state);

    return {
      content: [{ type: 'text', text: `Reply sent (turn ${q.turn}, total: ${state.answeredCount}).` }],
    };
  }
);

// ── status ───────────────────────────────────────────────────────────────────

server.tool(
  'cursor_agent_status',
  'Get current agent status: working, waiting_for_reply, or completed.',
  {},
  async () => {
    const state = loadState();
    const running = state.pid ? isRunning(state.pid) : false;
    const q = findPendingQuestion();
    const answered = countAnswered();
    const elapsed = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;

    let status;
    if (running && q) status = 'waiting_for_reply';
    else if (running) status = 'working';
    else status = 'completed';

    return {
      content: [{
        type: 'text',
        text: `Status: ${status} | Answered: ${answered} | Elapsed: ${elapsed}s` +
              (q ? `\nPending: ${q.message}` : ''),
      }],
    };
  }
);

// ── result ───────────────────────────────────────────────────────────────────

server.tool(
  'cursor_agent_result',
  'Get the agent\'s final stdout output after it completes.',
  {},
  async () => {
    const outFile = join(SESSION_DIR, '.agent-stdout.txt');
    if (!existsSync(outFile)) {
      return { content: [{ type: 'text', text: 'No output yet — agent may not have been spawned.' }] };
    }
    const content = readFileSync(outFile, 'utf8').trim();
    return { content: [{ type: 'text', text: content || '(empty output)' }] };
  }
);

// ── kill ─────────────────────────────────────────────────────────────────────

server.tool(
  'cursor_agent_kill',
  'Force-terminate the running cursor-agent process.',
  {},
  async () => {
    const state = loadState();
    if (!state.pid) {
      return { content: [{ type: 'text', text: 'No agent to kill.' }] };
    }
    try {
      process.kill(state.pid, 'SIGTERM');
      return { content: [{ type: 'text', text: `Killed agent (PID ${state.pid}).` }] };
    } catch {
      return { content: [{ type: 'text', text: `Agent (PID ${state.pid}) already stopped.` }] };
    }
  }
);

// ── Connect ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  console.error('Orchestrator MCP failed to start:', e);
  process.exit(1);
});
