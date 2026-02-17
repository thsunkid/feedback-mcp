#!/usr/bin/env node
/**
 * End-to-end test for bidirectional session tools via MCP.
 *
 * Spins up the cursor-agent-mcp server as a child process, connects as an
 * MCP client, and runs a multi-round session conversation with cursor-agent.
 *
 * Usage:
 *   node test_session_e2e.mjs
 *
 * Env overrides:
 *   CURSOR_AGENT_MODEL    – model to use (default: composer-1)
 *   CURSOR_AGENT_TIMEOUT_MS – per-round timeout (default: 120000)
 *   CURSOR_AGENT_FORCE    – set to 1 to pass --yolo/-f (default: 1)
 *   DEBUG_CURSOR_MCP      – set to 1 for server debug logs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function extractText(result) {
  if (!result?.content) return '';
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function parseStatus(text) {
  const status = text.match(/status:\s*(\S+)/)?.[1] || 'unknown';
  const round = text.match(/round:\s*(\d+)/)?.[1] || '?';
  const sessionId = text.match(/session_id:\s*(\S+)/)?.[1] || null;
  return { status, round, sessionId };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const serverDir = new URL('.', import.meta.url).pathname;

  log('INIT', 'Starting cursor-agent-mcp server...');

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['./server.js'],
    cwd: serverDir,
    env: {
      ...process.env,
      CURSOR_AGENT_TIMEOUT_MS: process.env.CURSOR_AGENT_TIMEOUT_MS ?? '120000',
      CURSOR_AGENT_FORCE: process.env.CURSOR_AGENT_FORCE ?? '1',
      CURSOR_AGENT_MODEL: process.env.CURSOR_AGENT_MODEL ?? 'composer-1',
      DEBUG_CURSOR_MCP: process.env.DEBUG_CURSOR_MCP ?? '0',
    },
  });

  const client = new Client({
    name: 'session-e2e-test',
    version: '1.0.0',
  });

  await client.connect(transport);
  log('INIT', 'Connected to MCP server.');

  // List tools to verify session tools exist
  const { tools } = await client.listTools({});
  const toolNames = tools.map((t) => t.name);
  const sessionTools = toolNames.filter((n) => n.includes('session'));
  log('INIT', `Found ${tools.length} tools. Session tools: ${sessionTools.join(', ')}`);

  if (!sessionTools.includes('cursor_agent_session_start')) {
    throw new Error('cursor_agent_session_start tool not found!');
  }

  // ── Round 1: Start session with a task that should trigger a question ──────

  const task = [
    'I need you to write a short JavaScript function.',
    'Before writing it, you MUST ask me exactly ONE question:',
    'what should the function do? Use the [CURSOR_QUESTION] markers.',
    'Do NOT write any code yet until I answer your question.',
  ].join(' ');

  log('SESSION', `Starting session with task...`);
  log('SESSION', `Task: "${task.slice(0, 100)}..."`);

  const startResult = await client.callTool({
    name: 'cursor_agent_session_start',
    arguments: {
      prompt: task,
      output_format: 'text',
      max_rounds: 5,
    },
  });

  const startText = extractText(startResult);
  const s1 = parseStatus(startText);
  log('ROUND1', `Status: ${s1.status} | Round: ${s1.round}`);
  console.log('─'.repeat(60));
  console.log(startText);
  console.log('─'.repeat(60));

  if (!s1.sessionId) {
    throw new Error('No session_id returned from session_start');
  }

  // ── Handle: if it asked a question, reply. If it completed, that's ok too ──

  let sessionId = s1.sessionId;
  let currentStatus = s1.status;
  let roundNum = 1;

  if (currentStatus === 'waiting_for_answer') {
    // ── Round 2: Reply with what the function should do ────────────────────

    roundNum++;
    const reply1 = 'The function should take an array of numbers and return the sum of all even numbers. Name it sumEvens.';
    log(`ROUND${roundNum}`, `Replying: "${reply1.slice(0, 80)}..."`);

    const replyResult = await client.callTool({
      name: 'cursor_agent_session_reply',
      arguments: {
        session_id: sessionId,
        reply: reply1,
      },
    });

    const replyText = extractText(replyResult);
    const s2 = parseStatus(replyText);
    log(`ROUND${roundNum}`, `Status: ${s2.status} | Round: ${s2.round}`);
    console.log('─'.repeat(60));
    console.log(replyText);
    console.log('─'.repeat(60));
    currentStatus = s2.status;

    // ── Round 3: If it asks another question, give feedback ──────────────

    if (currentStatus === 'waiting_for_answer') {
      roundNum++;
      const reply2 = 'Looks good! Please finalize the code and return it as the final result using [CURSOR_RESULT] markers.';
      log(`ROUND${roundNum}`, `Replying with feedback: "${reply2.slice(0, 80)}..."`);

      const feedbackResult = await client.callTool({
        name: 'cursor_agent_session_reply',
        arguments: {
          session_id: sessionId,
          reply: reply2,
        },
      });

      const fbText = extractText(feedbackResult);
      const s3 = parseStatus(fbText);
      log(`ROUND${roundNum}`, `Status: ${s3.status} | Round: ${s3.round}`);
      console.log('─'.repeat(60));
      console.log(fbText);
      console.log('─'.repeat(60));
      currentStatus = s3.status;
    }
  }

  // ── Check final session status ─────────────────────────────────────────────

  log('CHECK', 'Querying final session status...');
  const statusResult = await client.callTool({
    name: 'cursor_agent_session_status',
    arguments: { session_id: sessionId },
  });
  const statusText = extractText(statusResult);
  const sFinal = parseStatus(statusText);
  log('FINAL', `Status: ${sFinal.status} | Total rounds: ${sFinal.round}`);
  console.log('═'.repeat(60));
  console.log(statusText);
  console.log('═'.repeat(60));

  // ── End session ────────────────────────────────────────────────────────────

  log('CLEANUP', 'Ending session...');
  const endResult = await client.callTool({
    name: 'cursor_agent_session_end',
    arguments: { session_id: sessionId },
  });
  log('CLEANUP', extractText(endResult));

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  log('SUMMARY', `Test complete!`);
  log('SUMMARY', `Final status: ${sFinal.status}`);
  log('SUMMARY', `Total rounds: ${sFinal.round}`);
  log('SUMMARY', `Session ID: ${sessionId}`);

  if (sFinal.status === 'completed') {
    log('SUMMARY', '✓ Session completed successfully — bidirectional communication worked!');
  } else if (sFinal.status === 'waiting_for_answer') {
    log('SUMMARY', '⚠ Session still waiting (model may not have used CURSOR_RESULT markers)');
  } else {
    log('SUMMARY', `⚠ Unexpected final status: ${sFinal.status}`);
  }

  await client.close();
  process.exit(sFinal.status === 'completed' ? 0 : 1);
}

main().catch((e) => {
  console.error('E2E session test failed:', e);
  process.exit(1);
});
