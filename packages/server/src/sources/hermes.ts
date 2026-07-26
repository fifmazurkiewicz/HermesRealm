import { join } from 'node:path';
import type { Fact } from '../transcript/facts.js';
import { rootIfExists } from './config.js';
import type { AgentSource, ClassifiedFile } from './types.js';

/**
 * Hermes Agent source: reads sessions from Hermes Agent's state.db (SQLite).
 *
 * Hermes stores sessions in SQLite at D:\Hermes\state.db with tables:
 *   sessions: id TEXT PK, source TEXT, model TEXT, started_at REAL, ended_at REAL, ...
 *   messages: id INT PK, session_id TEXT FK, role TEXT, content TEXT, tool_calls TEXT (JSON), ...
 *   async_delegations: delegation_id TEXT PK, state TEXT, parent_session_id TEXT, ...
 *
 * This source uses DB polling (hermes-poller.ts), not file watching.
 */

/** Clip text for display (same convention as other sources). */
function clip(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/* ─────────────────────────────────────────────────────────────────
 * Hermes tool → canonical game name mapping.
 *
 * Maps Hermes tools to Age of Agents workshops (buildings):
 *   read_file / write_file / patch / search_files → forge (code)
 *   web_search / web_extract → tower (research / mage_tower)
 *   terminal / execute_code → mine (terminal)
 *   memory / skill_view / session_search → library (memory)
 *   delegate_task → barracks (subagents)
 *   browser_* tools → tower (web research)
 *   computer_use → citadel (desktop control)
 * ───────────────────────────────────────────────────────────────── */
export function hermesToolToCanonical(name: string): string {
  switch (name) {
    // Code tools → forge
    case 'read_file':
      return 'Read';
    case 'write_file':
      return 'Write';
    case 'patch':
      return 'Edit';
    case 'search_files':
      return 'Grep';

    // Web/Research tools → tower
    case 'web_search':
      return 'WebSearch';
    case 'web_extract':
    case 'web_fetch':
      return 'WebFetch';
    case 'browser_navigate':
    case 'browser_snapshot':
    case 'browser_click':
    case 'browser_type':
    case 'browser_press':
    case 'browser_scroll':
    case 'browser_back':
    case 'browser_get_images':
    case 'browser_console':
      return 'WebSearch';

    // Terminal tools → mine
    case 'terminal':
    case 'execute_code':
      return 'Bash';

    // Memory/knowledge tools → library
    case 'skill_view':
    case 'skill_manage':
    case 'skills_list':
    case 'session_search':
      return 'Read';
    case 'todo':
      return 'TodoWrite';

    // Subagent delegation → barracks
    case 'delegate_task':
      return 'Task';

    // Desktop control → citadel (fallback for GUI tools)
    case 'computer_use':
      return 'Bash';

    // Media
    case 'text_to_speech':
      return 'WebFetch';

    // Process management → mine
    case 'process':
      return 'Bash';

    // Note-taking / observation
    case 'obsidian':
    case 'x_search':
      return 'WebSearch';

    default:
      // MCP tools: 'server__tool' or 'server.tool'.
      if (name.includes('__')) return `mcp__${name}`;
      if (name.includes('.')) return `mcp__${name.replace(/\./g, '__')}`;
      return name;
  }
}

/** Extract detail from tool arguments for the bubble above the unit. */
function hermesToolDetail(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;

  if (name === 'read_file') {
    return str(args.path);
  }
  if (name === 'write_file') {
    return str(args.path);
  }
  if (name === 'patch') {
    return str(args.path) ?? str(args.old_string)?.slice(0, 40);
  }
  if (name === 'search_files') {
    return str(args.pattern) ?? str(args.query);
  }
  if (name === 'web_search') {
    return str(args.query);
  }
  if (name === 'web_extract') {
    const urls = args.urls as string[] | undefined;
    return urls?.[0] ? clip(urls[0], 60) : undefined;
  }
  if (name === 'terminal' || name === 'execute_code') {
    const cmd = str(args.command);
    return cmd ? clip(cmd.replace(/^bash\s+-lc\s+/, ''), 60) : undefined;
  }
  if (name === 'session_search') {
    return str(args.query);
  }
  if (name === 'skill_view' || name === 'skill_manage') {
    return str(args.name);
  }
  if (name === 'delegate_task') {
    return str(args.task) ?? str(args.goal);
  }
  if (name === 'text_to_speech') {
    return clip(str(args.text) ?? '', 60) || undefined;
  }
  if (name === 'browser_navigate') {
    return str(args.url);
  }
  if (name === 'computer_use') {
    return str(args.action);
  }

  return str(args.path) ?? str(args.pattern) ?? str(args.query) ?? str(args.command);
}

/** Whether tool call result indicates an error. */
function hermesOutputIsError(content: string | undefined): boolean {
  if (!content) return false;
  // Check for error patterns in tool output
  if (content.startsWith('Error') || content.startsWith('error')) return true;
  if (content.includes('exit_code') && content.includes('"exit_code": 1')) return true;
  return false;
}

/**
 * Hermes source definition.
 * DB polling is handled by HermesPoller; this source exists for registration,
 * type consistency, and provides parseLine for potential JSONL export.
 */
export const hermesSource: AgentSource = {
  id: 'hermes',
  roots: () => [], // No file watching — DB polling via HermesPoller
  depth: 0,
  classify(_path: string, _root: string): ClassifiedFile {
    return { kind: 'other' };
  },
  parseLine(_line: string): Fact[] {
    // Hermes uses DB polling, not JSONL line parsing.
    // This stub exists to satisfy the AgentSource interface.
    return [];
  },
};

/**
 * Parse a single Hermes message row from the DB into Facts.
 * Called by HermesPoller during polling.
 */
export function interpretHermesMessage(
  msg: {
    id: number;
    session_id: string;
    role: string;
    content: string | null;
    tool_calls: string | null;
    tool_name: string | null;
    token_count: number | null;
    timestamp: number;
    reasoning: string | null;
  },
): Fact[] {
  const facts: Fact[] = [];
  const ts = new Date(msg.timestamp * 1000).toISOString();

  // User message → prompt
  if (msg.role === 'user' && msg.content) {
    facts.push({ kind: 'prompt', text: clip(msg.content), ts });
    return facts;
  }

  // Tool role → tool-result
  if (msg.role === 'tool') {
    const isError = hermesOutputIsError(msg.content ?? undefined);
    facts.push({ kind: 'tool-result', isError, ts });
    return facts;
  }

  // Assistant role
  if (msg.role === 'assistant') {
    // Reasoning/thinking content
    if (msg.reasoning) {
      facts.push({ kind: 'thinking', ts });
    }

    // Text content
    if (msg.content && msg.content.trim()) {
      facts.push({ kind: 'assistant-text', text: clip(msg.content), ts });
    }

    // Tool calls
    if (msg.tool_calls) {
      try {
        const calls = JSON.parse(msg.tool_calls);
        if (Array.isArray(calls)) {
          for (const call of calls) {
            const fn = call?.function;
            const toolName = str(fn?.name);
            if (!toolName) continue;

            let args: Record<string, unknown> | undefined;
            if (typeof fn?.arguments === 'string') {
              try { args = JSON.parse(fn.arguments); } catch { /* ignore */ }
            } else if (fn?.arguments && typeof fn.arguments === 'object') {
              args = fn.arguments as Record<string, unknown>;
            }

            facts.push({
              kind: 'tool-start',
              tool: hermesToolToCanonical(toolName),
              detail: hermesToolDetail(toolName, args),
              messageId: str(call?.id) ?? str(call?.call_id) ?? `hermes-${msg.id}`,
              ts,
            });
          }
        }
      } catch {
        /* ignore malformed tool_calls JSON */
      }
    }

    // No tool calls and no text content with reasoning → turn-end (returning)
    if (!msg.tool_calls && !msg.content?.trim() && !msg.reasoning) {
      facts.push({ kind: 'turn-end', ts });
    }
  }

  return facts;
}

/**
 * Map Hermes agent state based on message patterns.
 * user message → thinking
 * assistant + tool_calls → working
 * assistant, no tool_calls → returning
 * session ended → sleeping/resting
 */
export function hermesAgentState(
  sessionEnded: boolean,
  lastMessageRole: string | undefined,
  lastMessageHasToolCalls: boolean,
): 'thinking' | 'working' | 'returning' | 'sleeping' {
  if (sessionEnded) return 'sleeping';
  if (lastMessageRole === 'user') return 'thinking';
  if (lastMessageRole === 'assistant' && lastMessageHasToolCalls) return 'working';
  if (lastMessageRole === 'assistant' && !lastMessageHasToolCalls) return 'returning';
  return 'thinking';
}

/**
 * Resolve the Hermes DB path.
 * Priority: AOA_HERMES_DB_PATH env var → D:\Hermes\state.db if exists → no path.
 */
export function getHermesDbPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envPath = env.AOA_HERMES_DB_PATH?.trim();
  if (envPath) return envPath;

  // Default Windows location
  const defaultPath = join('D:', 'Hermes', 'state.db');
  try {
    const roots = rootIfExists(defaultPath);
    if (roots.length > 0) return defaultPath;
  } catch {
    /* ignore */
  }

  return undefined;
}