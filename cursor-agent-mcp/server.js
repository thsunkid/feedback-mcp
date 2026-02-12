// MCP wrapper server for cursor-agent CLI
// Exposes multiple tools (chat/edit/analyze/search/plan/raw + legacy run) for better discoverability.
// Start via MCP config (stdio). Requires Node 18+.

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Tool input schema
const RUN_SCHEMA = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  output_format: z.enum(['text', 'json', 'markdown']).default('text'),
  extra_args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  // Optional override for the executable path if not on PATH
  executable: z.string().optional(),
  // Optional model and force for parity with other tools/env overrides
  model: z.string().optional(),
  force: z.boolean().optional(),
});

// Resolve the executable path for cursor-agent
function resolveExecutable(explicit) {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.CURSOR_AGENT_PATH && process.env.CURSOR_AGENT_PATH.trim()) {
    return process.env.CURSOR_AGENT_PATH.trim();
  }
  // default assumes "cursor-agent" is on PATH
  return 'cursor-agent';
}

/**
* Internal executor that spawns cursor-agent with provided argv and common options.
* Adds --print and --output-format, handles env/model/force, timeouts and idle kill.
*/
async function invokeCursorAgent({ argv, output_format = 'text', cwd, executable, model, force, print = true }) {
 const cmd = resolveExecutable(executable);

 // Compute model/force from args/env
 const userArgs = [...(argv ?? [])];
 const hasModelFlag = userArgs.some((a) => a === '-m' || a === '--model' || /^(?:-m=|--model=)/.test(String(a)));
 const envModel = process.env.CURSOR_AGENT_MODEL && process.env.CURSOR_AGENT_MODEL.trim();
 const effectiveModel = model?.trim?.() || envModel;

 const hasForceFlag = userArgs.some((a) => a === '-f' || a === '--force');
 const envForce = (() => {
   const v = (process.env.CURSOR_AGENT_FORCE || '').toLowerCase();
   return v === '1' || v === 'true' || v === 'yes' || v === 'on';
 })();
 const effectiveForce = typeof force === 'boolean' ? force : envForce;

 const finalArgv = [
   ...(print ? ['--print', '--output-format', output_format] : []),
   ...userArgs,
   ...(hasForceFlag || !effectiveForce ? [] : ['-f']),
   ...(hasModelFlag || !effectiveModel ? [] : ['-m', effectiveModel]),
 ];

 return new Promise((resolve) => {
   let settled = false;
   let out = '';
   let err = '';
   let idleTimer = null;
   let killedByIdle = false;

   const cleanup = () => {
     if (mainTimer) clearTimeout(mainTimer);
     if (idleTimer) clearTimeout(idleTimer);
   };

   if (process.env.DEBUG_CURSOR_MCP === '1') {
     try {
       console.error('[cursor-mcp] spawn:', cmd, ...finalArgv);
     } catch {}
   }

   const child = spawn(cmd, finalArgv, {
     shell: false, // safer across platforms; rely on PATH/PATHEXT
     cwd: cwd || process.cwd(),
     env: process.env,
   });
   try { child.stdin?.end(); } catch {}

   const idleMs = Number.parseInt(process.env.CURSOR_AGENT_IDLE_EXIT_MS || '0', 10);
   const scheduleIdleKill = () => {
     if (!Number.isFinite(idleMs) || idleMs <= 0) return;
     if (idleTimer) clearTimeout(idleTimer);
     idleTimer = setTimeout(() => {
       killedByIdle = true;
       try { child.kill('SIGKILL'); } catch {}
     }, idleMs);
   };

   child.stdout.on('data', (d) => {
     out += d.toString();
     scheduleIdleKill();
   });

   child.stderr.on('data', (d) => {
     err += d.toString();
   });

   child.on('error', (e) => {
     if (settled) return;
     settled = true;
     cleanup();
     if (process.env.DEBUG_CURSOR_MCP === '1') {
       try { console.error('[cursor-mcp] error:', e); } catch {}
     }
     const msg =
       `Failed to start "${cmd}": ${e?.message || e}\n` +
       `Args: ${JSON.stringify(finalArgv)}\n` +
       (process.env.CURSOR_AGENT_PATH ? `CURSOR_AGENT_PATH=${process.env.CURSOR_AGENT_PATH}\n` : '');
     resolve({ content: [{ type: 'text', text: msg }], isError: true });
   });

   const defaultTimeout = 30000;
   const timeoutMs = Number.parseInt(process.env.CURSOR_AGENT_TIMEOUT_MS || String(defaultTimeout), 10);
   const mainTimer = setTimeout(() => {
     try { child.kill('SIGKILL'); } catch {}
     if (settled) return;
     settled = true;
     cleanup();
     resolve({
       content: [{ type: 'text', text: `cursor-agent timed out after ${Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeout}ms` }],
       isError: true,
     });
   }, Number.isFinite(timeoutMs) ? timeoutMs : defaultTimeout);

   child.on('close', (code) => {
     if (settled) return;
     settled = true;
     cleanup();
     if (process.env.DEBUG_CURSOR_MCP === '1') {
       try { console.error('[cursor-mcp] exit:', code, 'stdout bytes=', out.length, 'stderr bytes=', err.length); } catch {}
     }
     if (code === 0 || (killedByIdle && out)) {
       resolve({ content: [{ type: 'text', text: out || '(no output)' }] });
     } else {
       resolve({
         content: [{ type: 'text', text: `cursor-agent exited with code ${code}\n${err || out || '(no output)'}` }],
         isError: true,
       });
     }
   });
 });
}

// Back-compat: single-shot run by prompt as positional argument.
// Accepts either a flat args object or an object with an "arguments" field (some hosts).
async function runCursorAgent(input) {
  const source = (input && typeof input === 'object' && input.arguments && typeof input.prompt === 'undefined')
    ? input.arguments
    : input;

  const {
    prompt,
    output_format = 'text',
    extra_args,
    cwd,
    executable,
    model,
    force,
  } = source || {};

  const argv = [...(extra_args ?? []), String(prompt)];
  const usedPrompt = argv.length ? String(argv[argv.length - 1]) : '';
 
  // Optional prompt echo and debug diagnostics
  if (process.env.DEBUG_CURSOR_MCP === '1') {
    try {
      const preview = usedPrompt.slice(0, 400).replace(/\n/g, '\\n');
      console.error('[cursor-mcp] prompt:', preview);
      if (extra_args?.length) console.error('[cursor-mcp] extra_args:', JSON.stringify(extra_args));
      if (model) console.error('[cursor-mcp] model:', model);
      if (typeof force === 'boolean') console.error('[cursor-mcp] force:', String(force));
    } catch {}
  }
 
  const result = await invokeCursorAgent({ argv, output_format, cwd, executable, model, force });
 
  // Echo prompt either when env is set or when caller provided echo_prompt: true (if host forwards unknown args it's fine)
  const echoEnabled = process.env.CURSOR_AGENT_ECHO_PROMPT === '1' || source?.echo_prompt === true;
  if (echoEnabled) {
    const text = `Prompt used:\n${usedPrompt}`;
    const content = Array.isArray(result?.content) ? result.content : [];
    return { ...result, content: [{ type: 'text', text }, ...content] };
  }
 
  return result;
}

/**
* Create MCP server and register a suite of cursor-agent tools.
* We expose multiple verbs for better discoverability in hosts (chat/edit/analyze/search/plan),
* plus the legacy cursor_agent_run for back-compat and a raw escape hatch.
*/
const server = new McpServer(
 {
   name: 'cursor-agent',
   version: '1.2.0',
   description: 'MCP wrapper for cursor-agent CLI (multi-tool: chat/edit/analyze/search/plan/raw + interactive sessions)',
 },
 {
   instructions:
     [
       'Tools:',
       '- cursor_agent_chat: chat with a prompt; optional model/force/format.',
       '- cursor_agent_edit_file: prompt-based file edit wrapper; you provide file and instruction.',
       '- cursor_agent_analyze_files: prompt-based analysis of one or more paths.',
       '- cursor_agent_search_repo: prompt-based code search with include/exclude globs.',
       '- cursor_agent_plan_task: prompt-based planning given a goal and optional constraints.',
       '- cursor_agent_raw: pass raw argv directly to cursor-agent; set print=false to avoid implicit --print.',
       '- cursor_agent_run: legacy single-shot chat (prompt as positional).',
       '- cursor_agent_session_start: start a multi-round interactive session; cursor-agent can ask questions back.',
       '- cursor_agent_session_reply: answer a pending question from cursor-agent within a session.',
       '- cursor_agent_session_status: check the status of an active session.',
       '- cursor_agent_session_end: terminate a session and clean up.',
     ].join(' '),
 },
);

// Common shape used by multiple schemas
const COMMON = {
 output_format: z.enum(['text', 'json', 'markdown']).default('text'),
 extra_args: z.array(z.string()).optional(),
 cwd: z.string().optional(),
 executable: z.string().optional(),
 model: z.string().optional(),
 force: z.boolean().optional(),
 // When true, the server will prepend the effective prompt to the tool output (useful for Claude debugging)
 echo_prompt: z.boolean().optional(),
};

// ---------------------------------------------------------------------------
// Session management for multi-round bidirectional communication
// ---------------------------------------------------------------------------

const sessions = new Map();

const SESSION_PROTOCOL_PREAMBLE = [
  '=== INTERACTIVE SESSION PROTOCOL ===',
  'You are in a multi-turn interactive session managed by an orchestration layer.',
  'Follow these rules for EVERY response:',
  '',
  'RULE 1 - QUESTION: If you need information, clarification, or a decision from',
  'the user before you can proceed, wrap your question in these exact markers:',
  '[CURSOR_QUESTION]',
  'Your question here. Be specific about what you need.',
  '[/CURSOR_QUESTION]',
  '',
  'RULE 2 - FINAL RESULT: When you have completed the task and have a final answer',
  'or result, wrap it in these exact markers:',
  '[CURSOR_RESULT]',
  'Your complete final result here.',
  '[/CURSOR_RESULT]',
  '',
  'RULE 3: Use EXACTLY ONE marker pair per response. Never both. If uncertain',
  'whether you can proceed, ask a question rather than guessing.',
  '',
  'RULE 4: Put ALL meaningful content inside the markers. Text outside markers',
  'is treated as debug output and may not be shown to the user.',
  '=== END PROTOCOL ===',
].join('\n');

const MAX_HISTORY_ENTRY_CHARS = 8000;

function getSessionDir() {
  const custom = process.env.CURSOR_SESSION_DIR;
  const dir = custom || join(tmpdir(), 'cursor-agent-mcp-sessions');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function writeSessionFile(session) {
  try {
    const dir = getSessionDir();
    const filePath = join(dir, `${session.session_id}.json`);
    writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
  } catch (e) {
    if (process.env.DEBUG_CURSOR_MCP === '1') {
      try { console.error('[cursor-mcp] writeSessionFile error:', e); } catch {}
    }
  }
}

function readSessionFile(sessionId) {
  try {
    const dir = getSessionDir();
    const filePath = join(dir, `${sessionId}.json`);
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = readSessionFile(sessionId);
    if (session) sessions.set(sessionId, session);
  }
  return session || null;
}

function cleanupExpiredSessions() {
  const ttl = parseInt(process.env.CURSOR_SESSION_TTL_MS || '1800000', 10);
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.updated_at > ttl) sessions.delete(id);
  }
  try {
    const dir = getSessionDir();
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(dir, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > ttl) unlinkSync(filePath);
      } catch {}
    }
  } catch {}
}

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + `\n... (truncated at ${max} chars)`;
}

function buildSessionPrompt(session) {
  let prompt = SESSION_PROTOCOL_PREAMBLE + '\n\n';
  if (session.history.length > 1) {
    prompt += '=== CONVERSATION HISTORY ===\n';
    for (const entry of session.history.slice(0, -1)) {
      const label = entry.role === 'user' ? 'User' : 'Assistant';
      prompt += `[${label}]: ${truncate(entry.content, MAX_HISTORY_ENTRY_CHARS)}\n\n`;
    }
    prompt += '=== END HISTORY ===\n\n';
  }
  const latest = session.history[session.history.length - 1];
  prompt += `Current request:\n${latest.content}`;
  return prompt;
}

function parseSessionOutput(rawOutput) {
  const questionMatch = rawOutput.match(
    /\[CURSOR_QUESTION\]([\s\S]*?)\[\/CURSOR_QUESTION\]/
  );
  if (questionMatch) {
    return { type: 'question', content: questionMatch[1].trim() };
  }
  const resultMatch = rawOutput.match(
    /\[CURSOR_RESULT\]([\s\S]*?)\[\/CURSOR_RESULT\]/
  );
  if (resultMatch) {
    return { type: 'result', content: resultMatch[1].trim() };
  }
  // Graceful degradation: no markers found, treat entire output as result
  return { type: 'result', content: rawOutput.trim() };
}

function formatSessionResult(session) {
  let text = '';
  text += `[SESSION_STATUS]\n`;
  text += `session_id: ${session.session_id}\n`;
  text += `status: ${session.status}\n`;
  text += `round: ${session.round} / ${session.max_rounds}\n`;
  if (session.model) text += `model: ${session.model}\n`;
  text += '\n';

  if (session.status === 'waiting_for_answer') {
    text += `[QUESTION_FROM_CURSOR_AGENT]\n${session.pending_question}\n\n`;
    text += `[ACTION_REQUIRED]\n`;
    text += `Call cursor_agent_session_reply with:\n`;
    text += `  session_id: "${session.session_id}"\n`;
    text += `  reply: "<your answer>"\n`;
  } else if (session.status === 'completed') {
    text += `[RESULT_FROM_CURSOR_AGENT]\n${session.result}\n`;
  } else if (session.status === 'error') {
    text += `[ERROR]\n${session.error}\n`;
    if (session.raw_outputs.length) {
      const lastOutput = session.raw_outputs[session.raw_outputs.length - 1];
      text += `\n[LAST_OUTPUT]\n${truncate(lastOutput, 2000)}\n`;
    }
  }

  return { content: [{ type: 'text', text }] };
}

async function invokeSessionRound(session) {
  session.round += 1;
  session.status = 'active';
  session.updated_at = Date.now();

  if (session.round > session.max_rounds) {
    session.status = 'error';
    session.error = `Max rounds (${session.max_rounds}) exceeded.`;
    writeSessionFile(session);
    return formatSessionResult(session);
  }

  const sessionPrompt = buildSessionPrompt(session);
  const extraArgs = session.extra_args ?? [];

  const result = await invokeCursorAgent({
    argv: [...extraArgs, sessionPrompt],
    output_format: session.output_format || 'text',
    cwd: session.cwd,
    executable: session.executable,
    model: session.model,
    force: session.force,
    print: true,
  });

  if (result.isError) {
    session.status = 'error';
    session.error = result.content[0]?.text || 'Unknown invocation error';
    writeSessionFile(session);
    sessions.set(session.session_id, session);
    return formatSessionResult(session);
  }

  const rawOutput = result.content[0]?.text || '';
  session.raw_outputs.push(rawOutput);

  const parsed = parseSessionOutput(rawOutput);

  if (parsed.type === 'question') {
    session.status = 'waiting_for_answer';
    session.pending_question = parsed.content;
    session.history.push({ role: 'assistant', content: parsed.content });
  } else {
    session.status = 'completed';
    session.result = parsed.content;
    session.pending_question = null;
    session.history.push({ role: 'assistant', content: parsed.content });
  }

  session.updated_at = Date.now();
  writeSessionFile(session);
  sessions.set(session.session_id, session);

  return formatSessionResult(session);
}

// Session schemas
const SESSION_START_SCHEMA = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  model: z.string().optional(),
  cwd: z.string().optional(),
  executable: z.string().optional(),
  force: z.boolean().optional(),
  output_format: z.enum(['text', 'json', 'markdown']).default('text'),
  extra_args: z.array(z.string()).optional(),
  max_rounds: z.number().int().min(1).max(20).default(10),
});

const SESSION_REPLY_SCHEMA = z.object({
  session_id: z.string().min(1, 'session_id is required'),
  reply: z.string().min(1, 'reply is required'),
});

const SESSION_STATUS_SCHEMA = z.object({
  session_id: z.string().min(1, 'session_id is required'),
});

const SESSION_END_SCHEMA = z.object({
  session_id: z.string().min(1, 'session_id is required'),
  reason: z.string().optional(),
});

// Schemas
const CHAT_SCHEMA = z.object({
 prompt: z.string().min(1, 'prompt is required'),
 ...COMMON,
});

const EDIT_FILE_SCHEMA = z.object({
 file: z.string().min(1, 'file is required'),
 instruction: z.string().min(1, 'instruction is required'),
 apply: z.boolean().optional(),
 dry_run: z.boolean().optional(),
 // optional free-form prompt to pass if the CLI supports one
 prompt: z.string().optional(),
 ...COMMON,
});

const ANALYZE_FILES_SCHEMA = z.object({
  paths: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  prompt: z.string().optional(),
  ...COMMON,
});

const SEARCH_REPO_SCHEMA = z.object({
  query: z.string().min(1, 'query is required'),
  include: z.union([z.string(), z.array(z.string())]).optional(),
  exclude: z.union([z.string(), z.array(z.string())]).optional(),
  ...COMMON,
});

const PLAN_TASK_SCHEMA = z.object({
 goal: z.string().min(1, 'goal is required'),
 constraints: z.array(z.string()).optional(),
 ...COMMON,
});

const RAW_SCHEMA = z.object({
  // raw argv to pass after common flags; e.g., ["--help"] or ["subcmd","--flag"]
  argv: z.array(z.string()).min(1, 'argv must contain at least one element'),
  print: z.boolean().optional(),
  ...COMMON,
});

// Tools
server.tool(
  'cursor_agent_chat',
  'Chat with cursor-agent using a prompt and optional model/force/output_format.',
  CHAT_SCHEMA.shape,
  async (args) => {
    try {
      // Normalize prompt in case the host nests under "arguments"
      const prompt =
        (args && typeof args === 'object' && 'prompt' in args ? args.prompt : undefined) ??
        (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments.prompt : undefined);

      const flat = {
        ...(args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments : args),
        prompt,
      };

      return await runCursorAgent(flat);
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_edit_file',
  'Edit a file with an instruction. Prompt-based wrapper; no CLI subcommand required.',
  EDIT_FILE_SCHEMA.shape,
  async (args) => {
    try {
      const { file, instruction, apply, dry_run, prompt, output_format, cwd, executable, model, force, extra_args } = args;
      const composedPrompt =
        `Edit the repository file:\n` +
        `- File: ${String(file)}\n` +
        `- Instruction: ${String(instruction)}\n` +
        (apply ? `- Apply changes if safe.\n` : `- Propose a patch/diff without applying.\n`) +
        (dry_run ? `- Treat as dry-run; do not write to disk.\n` : ``) +
        (prompt ? `- Additional context: ${String(prompt)}\n` : ``);
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_analyze_files',
  'Analyze one or more paths; optional prompt. Prompt-based wrapper.',
  ANALYZE_FILES_SCHEMA.shape,
  async (args) => {
    try {
      const { paths, prompt, output_format, cwd, executable, model, force, extra_args } = args;
      const list = Array.isArray(paths) ? paths : [paths];
      const composedPrompt =
        `Analyze the following paths in the repository:\n` +
        list.map((p) => `- ${String(p)}`).join('\n') + '\n' +
        (prompt ? `Additional prompt: ${String(prompt)}\n` : '');
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_search_repo',
  'Search repository code with include/exclude patterns. Prompt-based wrapper.',
  SEARCH_REPO_SCHEMA.shape,
  async (args) => {
    try {
      const { query, include, exclude, output_format, cwd, executable, model, force, extra_args } = args;
      const inc = include == null ? [] : (Array.isArray(include) ? include : [include]);
      const exc = exclude == null ? [] : (Array.isArray(exclude) ? exclude : [exclude]);
      const composedPrompt =
        `Search the repository for occurrences relevant to:\n` +
        `- Query: ${String(query)}\n` +
        (inc.length ? `- Include globs:\n${inc.map((p)=>`  - ${String(p)}`).join('\n')}\n` : '') +
        (exc.length ? `- Exclude globs:\n${exc.map((p)=>`  - ${String(p)}`).join('\n')}\n` : '') +
        `Return concise findings with file paths and line references.`;
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_plan_task',
  'Generate a plan for a goal with optional constraints. Prompt-based wrapper.',
  PLAN_TASK_SCHEMA.shape,
  async (args) => {
    try {
      const { goal, constraints, output_format, cwd, executable, model, force, extra_args } = args;
      const cons = constraints ?? [];
      const composedPrompt =
        `Create a step-by-step plan to accomplish the following goal:\n` +
        `- Goal: ${String(goal)}\n` +
        (cons.length ? `- Constraints:\n${cons.map((c)=>`  - ${String(c)}`).join('\n')}\n` : '') +
        `Provide a numbered list of actions.`;
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

// Raw escape hatch for power-users and forward compatibility
server.tool(
 'cursor_agent_raw',
 'Advanced: provide raw argv array to pass after common flags (e.g., ["search","--query","foo"]).',
 RAW_SCHEMA.shape,
 async (args) => {
   try {
     const { argv, output_format, cwd, executable, model, force } = args;
     // For raw calls we disable implicit --print to allow commands like "--help"
     return await invokeCursorAgent({ argv, output_format, cwd, executable, model, force, print: false });
   } catch (e) {
     return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
   }
 },
);

// Legacy single-shot prompt tool retained for compatibility
server.tool(
 'cursor_agent_run',
 'Run cursor-agent with a prompt and desired output format (legacy single-shot).',
 RUN_SCHEMA.shape,
 async (args) => {
   try {
     return await runCursorAgent(args);
   } catch (e) {
     return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
   }
 },
);

// ---------------------------------------------------------------------------
// Session tools: multi-round bidirectional communication with cursor-agent
// ---------------------------------------------------------------------------

server.tool(
  'cursor_agent_session_start',
  'Start an interactive multi-round session with cursor-agent. Returns a question (needs session_reply) or a final result. Use for complex tasks where cursor-agent may need clarification.',
  SESSION_START_SCHEMA.shape,
  async (args) => {
    try {
      cleanupExpiredSessions();
      const sessionId = randomUUID();
      const now = Date.now();
      const defaultMaxRounds = parseInt(process.env.CURSOR_SESSION_MAX_ROUNDS || '10', 10);
      const session = {
        session_id: sessionId,
        status: 'active',
        model: args.model || undefined,
        cwd: args.cwd || undefined,
        executable: args.executable || undefined,
        force: args.force ?? undefined,
        output_format: args.output_format || 'text',
        extra_args: args.extra_args || [],
        max_rounds: args.max_rounds ?? defaultMaxRounds,
        history: [{ role: 'user', content: args.prompt }],
        round: 0,
        pending_question: null,
        result: null,
        raw_outputs: [],
        error: null,
        created_at: now,
        updated_at: now,
      };
      sessions.set(sessionId, session);

      if (process.env.DEBUG_CURSOR_MCP === '1') {
        try { console.error('[cursor-mcp] session_start:', sessionId, 'prompt:', args.prompt.slice(0, 200)); } catch {}
      }

      return await invokeSessionRound(session);
    } catch (e) {
      return { content: [{ type: 'text', text: `Session start failed: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_session_reply',
  'Send an answer to cursor-agent\'s pending question within an active session. Continues the conversation.',
  SESSION_REPLY_SCHEMA.shape,
  async (args) => {
    try {
      const session = resolveSession(args.session_id);
      if (!session) {
        return {
          content: [{ type: 'text', text: `Session "${args.session_id}" not found. It may have expired (TTL: ${process.env.CURSOR_SESSION_TTL_MS || '1800000'}ms). Start a new session with cursor_agent_session_start.` }],
          isError: true,
        };
      }
      if (session.status !== 'waiting_for_answer') {
        return {
          content: [{ type: 'text', text: `Session "${args.session_id}" is not waiting for an answer. Current status: ${session.status}` }],
          isError: true,
        };
      }

      session.history.push({ role: 'user', content: args.reply });
      session.pending_question = null;

      if (process.env.DEBUG_CURSOR_MCP === '1') {
        try { console.error('[cursor-mcp] session_reply:', args.session_id, 'reply:', args.reply.slice(0, 200)); } catch {}
      }

      return await invokeSessionRound(session);
    } catch (e) {
      return { content: [{ type: 'text', text: `Session reply failed: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_session_status',
  'Check the current status of an active session. Read-only.',
  SESSION_STATUS_SCHEMA.shape,
  async (args) => {
    try {
      const session = resolveSession(args.session_id);
      if (!session) {
        return { content: [{ type: 'text', text: `Session "${args.session_id}" not found.` }], isError: true };
      }
      return formatSessionResult(session);
    } catch (e) {
      return { content: [{ type: 'text', text: `Session status check failed: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_session_end',
  'Explicitly terminate a session and clean up state.',
  SESSION_END_SCHEMA.shape,
  async (args) => {
    try {
      const session = resolveSession(args.session_id);
      if (!session) {
        return { content: [{ type: 'text', text: `Session "${args.session_id}" not found.` }], isError: true };
      }
      session.status = args.reason ? 'error' : 'completed';
      if (args.reason) session.error = args.reason;
      session.updated_at = Date.now();
      writeSessionFile(session);
      sessions.delete(args.session_id);

      const text = `Session "${args.session_id}" terminated. Status: ${session.status}` +
        (args.reason ? `. Reason: ${args.reason}` : '') +
        `. Completed ${session.round} round(s).`;
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Session end failed: ${e?.message || e}` }], isError: true };
    }
  },
);

// Connect using stdio transport
const transport = new StdioServerTransport();

server.connect(transport).catch((e) => {
 console.error('MCP server failed to start:', e);
 process.exit(1);
});