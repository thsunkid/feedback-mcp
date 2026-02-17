#!/usr/bin/env node
/**
 * 5-turn conversation in a SINGLE cursor-agent process.
 *
 * Uses interactive mode (no --print) with --output-format stream-json
 * to detect response boundaries via {"type":"result",...} events.
 *
 * One process. Five rounds. Real bidirectional communication.
 */

import { spawn } from 'node:child_process';

// ── Config ───────────────────────────────────────────────────────────────────

const MODEL = process.env.CURSOR_AGENT_MODEL || 'composer-1';
const EXECUTABLE = process.env.CURSOR_AGENT_PATH || 'cursor-agent';

const TURNS = [
  // Turn 1: Assign task
  'I need a JavaScript utility function. Before writing it, ask me what it should do. Just ask the question, nothing else.',

  // Turn 2: Answer the question
  'Write a function called `deepMerge` that deep-merges two objects. Show me the code.',

  // Turn 3: Request a change
  'Good, but add support for merging arrays by concatenation instead of overwriting. Show updated code.',

  // Turn 4: Ask for tests
  'Now write 3 unit test cases for deepMerge covering: nested objects, array merging, and null handling.',

  // Turn 5: Final feedback
  'Perfect. Now add JSDoc comments to the deepMerge function with @param and @returns tags. Show the final version.',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const log = (tag, msg) => {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
};

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('INIT', `Spawning single cursor-agent process (model: ${MODEL})...`);

  const child = spawn(EXECUTABLE, [
    '--yolo',
    '--model', MODEL,
    '--output-format', 'stream-json',
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  // Stream stdout line-by-line
  let lineBuf = '';
  const lineListeners = [];

  function onLine(line) {
    for (const listener of lineListeners) {
      listener(line);
    }
  }

  child.stdout.on('data', (chunk) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.trim()) onLine(line.trim());
    }
  });

  // Wait for a turn to complete: returns the full assistant response text
  function waitForResult() {
    return new Promise((resolve, reject) => {
      let assistantText = '';
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for result (120s)'));
      }, 120_000);

      const handler = (line) => {
        try {
          const evt = JSON.parse(line);

          if (evt.type === 'assistant' && evt.message?.content) {
            for (const part of evt.message.content) {
              if (part.type === 'text') assistantText += part.text;
            }
          }

          if (evt.type === 'result') {
            clearTimeout(timeout);
            // Remove this handler
            const idx = lineListeners.indexOf(handler);
            if (idx >= 0) lineListeners.splice(idx, 1);
            resolve({
              text: assistantText || evt.result || '(no text)',
              duration_ms: evt.duration_ms,
              is_error: evt.is_error,
            });
          }
        } catch {
          // Not JSON, ignore
        }
      };

      lineListeners.push(handler);
    });
  }

  // Wait for the init event
  await new Promise((resolve) => {
    const handler = (line) => {
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'system' && evt.subtype === 'init') {
          const idx = lineListeners.indexOf(handler);
          if (idx >= 0) lineListeners.splice(idx, 1);
          log('INIT', `Session: ${evt.session_id} | Model: ${evt.model}`);
          resolve();
        }
      } catch {}
    };
    lineListeners.push(handler);
  });

  log('INIT', `Running ${TURNS.length} turns in single process...\n`);

  // ── Run all turns ──────────────────────────────────────────────────────────

  const results = [];

  for (let i = 0; i < TURNS.length; i++) {
    const turnNum = i + 1;
    const prompt = TURNS[i];

    log(`TURN${turnNum}→`, prompt.slice(0, 90) + (prompt.length > 90 ? '...' : ''));

    // Write the message to stdin (newline submits it)
    child.stdin.write(prompt + '\n');

    // Wait for the full response
    const response = await waitForResult();
    results.push(response);

    const preview = response.text.trim().replace(/\n/g, '\\n').slice(0, 120);
    log(`TURN${turnNum}←`, `(${response.duration_ms}ms) ${preview}...`);
    console.log('');
  }

  // Close stdin to end the process
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('═'.repeat(60));
  console.log('5-TURN SINGLE-PROCESS TEST RESULTS');
  console.log('═'.repeat(60));

  for (let i = 0; i < results.length; i++) {
    console.log(`\n── Turn ${i + 1} (${results[i].duration_ms}ms) ──`);
    // Show first 300 chars of each response
    console.log(results[i].text.trim().slice(0, 300));
    if (results[i].text.trim().length > 300) console.log('  ...(truncated)');
  }

  console.log('\n' + '═'.repeat(60));
  const totalMs = results.reduce((s, r) => s + (r.duration_ms || 0), 0);
  const errors = results.filter(r => r.is_error).length;
  log('DONE', `✓ ${TURNS.length} turns completed in 1 process | Total API time: ${(totalMs/1000).toFixed(1)}s | Errors: ${errors}`);

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('5-turn test failed:', e);
  process.exit(1);
});
