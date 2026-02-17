/**
 * Bridge MCP Server — file-based blocking IPC for orchestrator communication.
 *
 * Exposes a single tool `report_to_orchestrator` that cursor-agent calls
 * when it needs to communicate with the orchestrating agent (e.g. Claude Code).
 *
 * Flow:
 *   1. cursor-agent calls report_to_orchestrator(message)
 *   2. This server writes the message to a question file
 *   3. It polls for an answer file (blocks until one appears)
 *   4. Returns the answer to cursor-agent
 *
 * The orchestrator watches for question files and writes answer files.
 *
 * Env:
 *   BRIDGE_SESSION_DIR — directory for IPC files (required, set by orchestrator)
 *   BRIDGE_POLL_MS     — poll interval in ms (default: 500)
 *   BRIDGE_TIMEOUT_MS  — max wait time in ms (default: 300000 = 5 min)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SESSION_DIR = process.env.BRIDGE_SESSION_DIR;
if (!SESSION_DIR) {
  console.error('BRIDGE_SESSION_DIR env is required');
  process.exit(1);
}

const POLL_MS = parseInt(process.env.BRIDGE_POLL_MS || '500', 10);
const TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS || '300000', 10);

let turnCounter = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const server = new McpServer(
  { name: 'orchestrator-bridge', version: '1.0.0' },
  {
    instructions: [
      'This MCP provides a single tool: report_to_orchestrator.',
      'Use it to send messages to the orchestrating agent and receive replies.',
      'Call it whenever you need to:',
      '- Ask a clarifying question',
      '- Report progress or intermediate results',
      '- Request feedback on your work',
      '- Deliver your final result',
      'The orchestrator will reply through this same channel.',
      'Always wait for the orchestrator reply before continuing.',
    ].join(' '),
  }
);

server.tool(
  'report_to_orchestrator',
  'Send a message to the orchestrating agent and wait for their reply. Use this for questions, progress updates, intermediate results, or final deliverables.',
  { message: z.string().min(1, 'message is required') },
  async ({ message }) => {
    turnCounter++;
    const turn = turnCounter;

    const questionFile = join(SESSION_DIR, `question_${turn}.json`);
    const answerFile = join(SESSION_DIR, `answer_${turn}.json`);

    // Write question
    writeFileSync(questionFile, JSON.stringify({ turn, message, timestamp: Date.now() }), 'utf8');

    // Poll for answer
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (existsSync(answerFile)) {
        try {
          const data = JSON.parse(readFileSync(answerFile, 'utf8'));
          // Clean up
          try { unlinkSync(questionFile); } catch {}
          try { unlinkSync(answerFile); } catch {}
          return { content: [{ type: 'text', text: data.reply || '(empty reply)' }] };
        } catch {
          // File not fully written yet, retry
        }
      }
      await sleep(POLL_MS);
    }

    return {
      content: [{ type: 'text', text: `Orchestrator did not reply within ${TIMEOUT_MS}ms.` }],
      isError: true,
    };
  }
);

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  console.error('Bridge MCP failed to start:', e);
  process.exit(1);
});
