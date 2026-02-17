#!/usr/bin/env node
/**
 * 3-round feedback test: start → question → reply → feedback → final result.
 *
 * Tests that the session can handle multiple back-and-forth exchanges,
 * including giving feedback on an intermediate result.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function extractText(result) {
  return (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function parseStatus(text) {
  return {
    status: text.match(/status:\s*(\S+)/)?.[1] || 'unknown',
    round: text.match(/round:\s*(\d+)/)?.[1] || '?',
    sessionId: text.match(/session_id:\s*(\S+)/)?.[1] || null,
  };
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = extractText(result);
  const info = parseStatus(text);
  return { text, ...info };
}

async function main() {
  const serverDir = new URL('.', import.meta.url).pathname;

  log('INIT', 'Connecting to cursor-agent-mcp server...');
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['./server.js'],
    cwd: serverDir,
    env: {
      ...process.env,
      CURSOR_AGENT_TIMEOUT_MS: process.env.CURSOR_AGENT_TIMEOUT_MS ?? '120000',
      CURSOR_AGENT_FORCE: process.env.CURSOR_AGENT_FORCE ?? '1',
      CURSOR_AGENT_MODEL: process.env.CURSOR_AGENT_MODEL ?? 'composer-1',
    },
  });

  const client = new Client({ name: 'feedback-test', version: '1.0.0' });
  await client.connect(transport);
  log('INIT', 'Connected.');

  // ── Round 1: Start with a deliberately ambiguous task ──────────────────────
  const task = [
    'I want you to write a Python function, but first ask me TWO things:',
    '1) What the function should do',
    '2) What to name it',
    'Ask both questions in a single [CURSOR_QUESTION] block.',
    'Do NOT write any code until I answer both questions.',
  ].join(' ');

  log('R1', 'Starting session...');
  const r1 = await callTool(client, 'cursor_agent_session_start', {
    prompt: task,
    max_rounds: 6,
  });
  log('R1', `→ status=${r1.status} round=${r1.round}`);
  console.log(r1.text);
  console.log('');

  if (r1.status !== 'waiting_for_answer') {
    log('R1', '⚠ Expected a question, got: ' + r1.status);
    await client.close();
    process.exit(1);
  }

  // ── Round 2: Answer the questions ──────────────────────────────────────────
  const answer = [
    '1) The function should check if a string is a palindrome (reads the same forwards and backwards).',
    '2) Name it is_palindrome.',
    'Write the code now, but use [CURSOR_QUESTION] to ask if I want any edge case handling (like ignoring spaces/case).',
  ].join(' ');

  log('R2', 'Sending answers...');
  const r2 = await callTool(client, 'cursor_agent_session_reply', {
    session_id: r1.sessionId,
    reply: answer,
  });
  log('R2', `→ status=${r2.status} round=${r2.round}`);
  console.log(r2.text);
  console.log('');

  // ── Round 3: Give feedback if waiting, otherwise accept ────────────────────
  let r3;
  if (r2.status === 'waiting_for_answer') {
    const feedback = [
      'Yes, make it case-insensitive and ignore spaces.',
      'Also add a docstring explaining the function.',
      'Now give me the final code with [CURSOR_RESULT] markers.',
    ].join(' ');

    log('R3', 'Sending feedback...');
    r3 = await callTool(client, 'cursor_agent_session_reply', {
      session_id: r1.sessionId,
      reply: feedback,
    });
    log('R3', `→ status=${r3.status} round=${r3.round}`);
    console.log(r3.text);
    console.log('');
  } else {
    r3 = r2;
    log('R3', 'Skipped (model completed on round 2).');
  }

  // ── If still waiting after 3 rounds, do one more ──────────────────────────
  let rFinal = r3;
  if (r3.status === 'waiting_for_answer') {
    log('R4', 'Still waiting, sending final nudge...');
    rFinal = await callTool(client, 'cursor_agent_session_reply', {
      session_id: r1.sessionId,
      reply: 'Looks perfect. Please return the final code now using [CURSOR_RESULT] markers.',
    });
    log('R4', `→ status=${rFinal.status} round=${rFinal.round}`);
    console.log(rFinal.text);
    console.log('');
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const endResult = await callTool(client, 'cursor_agent_session_end', {
    session_id: r1.sessionId,
  });

  console.log('═'.repeat(60));
  log('DONE', `Final status: ${rFinal.status} | Total rounds: ${rFinal.round}`);
  if (rFinal.status === 'completed') {
    log('DONE', '✓ Multi-round feedback loop worked!');
  } else {
    log('DONE', '⚠ Did not reach completed status.');
  }

  await client.close();
  process.exit(rFinal.status === 'completed' ? 0 : 1);
}

main().catch((e) => {
  console.error('Feedback test failed:', e);
  process.exit(1);
});
