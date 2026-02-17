#!/usr/bin/env node
/**
 * Single-execution 3-turn bidirectional test with composer-1.
 *
 * Turn 1: Assign task → agent responds (question or draft)
 * Turn 2: Answer/requirements → agent delivers result
 * Turn 3: Give feedback → agent delivers revised result
 *
 * The session system supports re-opening completed sessions,
 * so turn 3 always works even if the agent completed on turn 2.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const log = (tag, msg) => console.log(`[${new Date().toISOString().slice(11,23)}] [${tag}] ${msg}`);
const txt = (r) => (r?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
const st = (t) => t.match(/status:\s*(\S+)/)?.[1] || '?';
const rnd = (t) => t.match(/round:\s*(\d+)/)?.[1] || '?';
const id = (t) => t.match(/session_id:\s*(\S+)/)?.[1];
const question = (t) => t.match(/\[QUESTION_FROM_CURSOR_AGENT\]\n([\s\S]*?)\n\n\[/)?.[1]?.trim();
const result = (t) => t.match(/\[RESULT_FROM_CURSOR_AGENT\]\n([\s\S]*)/)?.[1]?.trim();

async function main() {
  const transport = new StdioClientTransport({
    command: 'node', args: ['./server.js'],
    cwd: new URL('.', import.meta.url).pathname,
    env: {
      ...process.env,
      CURSOR_AGENT_TIMEOUT_MS: '120000',
      CURSOR_AGENT_FORCE: '1',
      CURSOR_AGENT_MODEL: 'composer-1',
    },
  });

  const client = new Client({ name: '3turn-test', version: '1.0.0' });
  await client.connect(transport);
  log('INIT', 'MCP connected → composer-1 via --yolo\n');

  // ═══ TURN 1: Give task, agent should ask what it should do ════════════════
  log('TURN1→', 'Assigning task: "write a bash script, ask me what it should do first"');
  const r1 = txt(await client.callTool({
    name: 'cursor_agent_session_start',
    arguments: {
      prompt: [
        'I need a bash script. Before writing anything, ask me ONE question about what',
        'it should do. Use [CURSOR_QUESTION]...[/CURSOR_QUESTION] markers.',
        'Do NOT write code yet.',
      ].join(' '),
      max_rounds: 6,
    },
  }));

  const sessionId = id(r1);
  log('TURN1←', `Status: ${st(r1)} | ${question(r1) ? 'Question: ' + question(r1) : 'Response received'}`);
  console.log('');

  // ═══ TURN 2: Give requirements → agent writes draft ═══════════════════════
  log('TURN2→', 'Answering: "list 5 largest files in a directory, human-readable sizes"');
  const r2 = txt(await client.callTool({
    name: 'cursor_agent_session_reply',
    arguments: {
      session_id: sessionId,
      reply: [
        'Write a bash script that takes a directory path and prints the 5 largest files',
        'with human-readable sizes. Sort largest first. Include a header showing the dir.',
      ].join(' '),
    },
  }));

  log('TURN2←', `Status: ${st(r2)} | Round: ${rnd(r2)}`);
  const draft = result(r2) || question(r2) || '(no parsed content)';
  console.log(`         Preview: ${draft.slice(0, 150).replace(/\n/g, '\\n')}...`);
  console.log('');

  // ═══ TURN 3: Give feedback → agent revises ════════════════════════════════
  log('TURN3→', 'Feedback: "add color output and error handling for missing dirs"');
  const r3 = txt(await client.callTool({
    name: 'cursor_agent_session_reply',
    arguments: {
      session_id: sessionId,
      reply: [
        'Two changes needed:',
        '1) Add color output (green for header, yellow for file sizes)',
        '2) Add error handling if the directory does not exist',
        'Return the final script using [CURSOR_RESULT]...[/CURSOR_RESULT] markers.',
      ].join(' '),
    },
  }));

  const finalCode = result(r3);
  log('TURN3←', `Status: ${st(r3)} | Round: ${rnd(r3)}`);

  // ═══ Cleanup ══════════════════════════════════════════════════════════════
  await client.callTool({ name: 'cursor_agent_session_end', arguments: { session_id: sessionId } });

  // ═══ Summary ══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('FINAL RESULT:');
  console.log('═'.repeat(60));
  console.log(finalCode || r3);
  console.log('═'.repeat(60));
  console.log(`\n3-turn test: ${st(r3) === 'completed' ? '✓ PASS' : '⚠ ' + st(r3)} | Rounds: ${rnd(r3)}`);

  await client.close();
  process.exit(st(r3) === 'completed' ? 0 : 1);
}

main().catch(e => { console.error('Test failed:', e); process.exit(1); });
