import { getHermesDbPath, interpretHermesMessage } from './hermes.js';
import { SessionTracker, DEFAULT_THRESHOLDS } from '../state-machine.js';
import type { World } from '../world.js';
import type { Fact } from '../transcript/facts.js';

/**
 * Hermes Poller: periodically queries the Hermes Agent SQLite database (state.db)
 * and generates facts for SessionTracker.
 *
 * Hermes stores sessions in SQLite, not JSONL files, so SourceWatcher cannot be
 * used. This poller mirrors the OpenCodePoller pattern: dynamic import of
 * better-sqlite3, readonly DB open, timer-based polling, SessionTracker lifecycle.
 */

const POLL_INTERVAL_MS = 5_000; // Poll every 5 seconds
/** How many days back to fetch existing sessions on startup. */
const HISTORICAL_WINDOW_DAYS = 31;
const HISTORICAL_WINDOW_MS = HISTORICAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** Seconds without activity after which a session stops generating new facts. */
const STALE_SESSION_MS = 5 * 60_000;
/** Data validity boundary: remove sessions older than this from memory. */
const SESSION_RETENTION_MS = HISTORICAL_WINDOW_MS;

/** Backoff for non-existent database (e.g. Hermes not yet installed/run). */
const DB_RETRY_INITIAL_MS = 5_000;
const DB_RETRY_MAX_MS = 5 * 60_000;

function isDbMissingError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'SQLITE_CANTOPEN' || code === 'ENOENT';
}

function isSchemaMismatchError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such column/i.test(message) || /no such table/i.test(message);
}

interface SessionState {
  tracker: SessionTracker;
  lastMessageId: number;
  lastMessageTimestamp: number;
  projectDir: string;
  title: string;
  model?: string;
  workingDir?: string;
  sessionEnded: boolean;
  /** Track cumulative tokens from session table to avoid double-counting. */
  lastInputTokens: number;
  lastOutputTokens: number;
}

export class HermesPoller {
  private sessions = new Map<string, SessionState>();
  private timer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private retryDelayMs = DB_RETRY_INITIAL_MS;
  private waitingLogged = false;
  private db: any; // better-sqlite3 Database
  private isRunning = false;
  /** Historical sessions already handled (do not repeat). */
  private processedStale = new Set<string>();
  /** Main (parent) session IDs. Subagents are linked via parent_session_id. */
  private mainSessions = new Set<string>();

  constructor(private readonly world: World) {}

  async start(): Promise<void> {
    if (this.isRunning || this.retryTimer) return;

    // Resolve DB path
    const dbPath = getHermesDbPath();
    if (!dbPath) {
      console.log('[Hermes] No Hermes database found — source disabled. Set AOA_HERMES_DB_PATH to configure.');
      return;
    }

    let Database: unknown;
    try {
      const mod = await import('better-sqlite3');
      Database = mod.default;
      if (!Database || typeof Database !== 'function') {
        throw new Error('better-sqlite3 did not export a Database constructor');
      }
    } catch (err) {
      console.warn('[Hermes] better-sqlite3 unavailable — Hermes source disabled:', err instanceof Error ? err.message : String(err));
      console.log('[Hermes] Install it to enable Hermes sessions: npm install better-sqlite3');
      return;
    }
    await this.open(Database, dbPath);
  }

  private async open(Database: unknown, dbPath: string): Promise<void> {
    this.retryTimer = undefined;
    try {
      this.db = new (Database as any)(dbPath, { readonly: true });
    } catch (err) {
      if (isDbMissingError(err)) {
        if (!this.waitingLogged) {
          console.log(`[Hermes] Database not found at ${dbPath} — will keep checking in the background`);
          this.waitingLogged = true;
        }
        this.retryTimer = setTimeout(() => void this.open(Database, dbPath), this.retryDelayMs);
        this.retryTimer.unref?.();
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, DB_RETRY_MAX_MS);
        return;
      }
      console.warn('[Hermes] Could not open database:', err instanceof Error ? err.message : String(err));
      return;
    }

    this.isRunning = true;
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);

    // First poll immediately
    await this.poll();

    if (this.isRunning) console.log(`[Hermes] Poller started (${dbPath})`);
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.db) {
      this.db.close();
      this.db = undefined as any;
    }
  }

  private async poll(): Promise<void> {
    if (!this.db || !this.isRunning) return;

    try {
      // Fetch main (cli) sessions + subagent sessions from recent window
      const cutoffTime = (Date.now() - HISTORICAL_WINDOW_MS) / 1000; // SQLite REAL timestamp is seconds

      const sessions = this.db.prepare(`
        SELECT
          s.id,
          s.source,
          s.parent_session_id,
          s.model,
          s.display_name,
          s.title,
          s.started_at,
          s.ended_at,
          s.message_count,
          s.tool_call_count,
          s.input_tokens,
          s.output_tokens,
          s.cwd,
          s.git_branch,
          s.cache_read_tokens,
          s.cache_write_tokens,
          s.reasoning_tokens
        FROM sessions s
        WHERE s.started_at > ?
          AND s.source IN ('cli', 'subagent')
        ORDER BY s.started_at DESC
      `).all(cutoffTime);

      // Track main sessions for subagent association
      this.mainSessions.clear();
      for (const session of sessions) {
        if (session.source === 'cli') {
          this.mainSessions.add(session.id);
        }
      }

      for (const session of sessions) {
        const isMainSession = session.source === 'cli';
        const sessionEnded = session.ended_at !== null && session.ended_at > 0;
        const ageMs = Date.now() - (sessionEnded
          ? session.ended_at * 1000
          : session.started_at * 1000);

        // Skip subagent sessions without an active parent
        if (!isMainSession && session.parent_session_id && !this.mainSessions.has(session.parent_session_id)) {
          continue;
        }

        if (sessionEnded && ageMs > STALE_SESSION_MS) {
          // Old ended session: only count tokens once
          await this.processStaleSession(session);
        } else {
          await this.processSession(session);
        }
      }

      this.sweep();
    } catch (err) {
      if (isSchemaMismatchError(err)) {
        console.warn('[Hermes] Poll error, stopping poller:', err instanceof Error ? err.message : String(err));
        await this.stop();
        return;
      }
      console.error('[Hermes] Poll error:', err);
    }
  }

  private async processSession(sessionRow: Record<string, unknown>): Promise<void> {
    const sessionId = String(sessionRow.id);
    const source = String(sessionRow.source ?? 'cli');
    const parentSessionId = str(sessionRow.parent_session_id);
    const isMainSession = source === 'cli';
    const sessionEnded = sessionRow.ended_at !== null && sessionRow.ended_at !== 0;

    // Subagent sessions → emit as peons, not heroes
    if (!isMainSession) {
      await this.processSubagentSession(sessionRow);
      return;
    }

    const cwd = str(sessionRow.cwd) ?? 'D:\\Hermes';
    const projectDir = cwd;
    const model = str(sessionRow.model) ?? undefined;
    const title = str(sessionRow.title) ?? str(sessionRow.display_name) ?? 'Hermes Session';
    const startedAt = new Date(Number(sessionRow.started_at) * 1000).toISOString();
    const tokensInput = Number(sessionRow.input_tokens ?? 0);
    const tokensOutput = Number(sessionRow.output_tokens ?? 0);

    let state = this.sessions.get(sessionId);

    if (!state) {
      // New session: create tracker
      state = {
        tracker: new SessionTracker(this.world, sessionId, projectDir, DEFAULT_THRESHOLDS, 'hermes'),
        lastMessageId: 0,
        lastMessageTimestamp: 0,
        projectDir,
        title,
        model,
        workingDir: cwd,
        sessionEnded,
        lastInputTokens: 0,
        lastOutputTokens: 0,
      };
      this.sessions.set(sessionId, state);

      // Emit meta facts
      state.tracker.apply({
        kind: 'meta',
        model,
        cwd,
        ts: startedAt,
      });

      // Emit title
      state.tracker.apply({
        kind: 'title',
        title,
        ts: startedAt,
      });

      // Emit accumulated token usage
      if (tokensInput > 0 || tokensOutput > 0) {
        state.tracker.apply({
          kind: 'usage-total',
          input: tokensInput,
          output: tokensOutput,
        });
        state.lastInputTokens = tokensInput;
        state.lastOutputTokens = tokensOutput;
      }
    } else {
      // Update tokens if they've grown
      if (tokensInput > state.lastInputTokens || tokensOutput > state.lastOutputTokens) {
        state.tracker.apply({
          kind: 'usage-total',
          input: tokensInput,
          output: tokensOutput,
        });
        state.lastInputTokens = tokensInput;
        state.lastOutputTokens = tokensOutput;
      }
      state.sessionEnded = sessionEnded;
      if (model && !state.model) state.model = model;
    }

    // Fetch new messages since last poll
    const messages = this.db.prepare(`
      SELECT
        id,
        session_id,
        role,
        content,
        tool_calls,
        tool_name,
        token_count,
        timestamp,
        reasoning
      FROM messages
      WHERE session_id = ?
        AND id > ?
      ORDER BY id ASC
    `).all(sessionId, state.lastMessageId);

    for (const msg of messages) {
      const facts = interpretHermesMessage(msg);
      for (const fact of facts) {
        state.tracker.apply(fact);
      }
      state.lastMessageId = Math.max(state.lastMessageId, Number(msg.id));
      state.lastMessageTimestamp = Math.max(state.lastMessageTimestamp, Number(msg.timestamp));
    }

    // Handle session ended state
    if (sessionEnded && state.sessionEnded) {
      // If the session just ended and we haven't sent turn-end yet
      const hero = this.world.getHero(sessionId);
      if (hero && hero.state !== 'sleeping') {
        state.tracker.apply({
          kind: 'turn-end',
          ts: new Date(Number(sessionRow.ended_at) * 1000).toISOString(),
        });
      }
    }
  }

  private async processSubagentSession(sessionRow: Record<string, unknown>): Promise<void> {
    const sessionId = String(sessionRow.id);
    const parentSessionId = str(sessionRow.parent_session_id);
    if (!parentSessionId) return;

    const sessionEnded = sessionRow.ended_at !== null && sessionRow.ended_at !== 0;

    // Track as peon for the parent session
    let state = this.sessions.get(sessionId);

    if (!state) {
      const cwd = str(sessionRow.cwd) ?? 'D:\\Hermes';
      const description = str(sessionRow.title) ?? str(sessionRow.display_name) ?? `Subagent ${sessionId.slice(-6)}`;

      state = {
        tracker: new SessionTracker(this.world, sessionId, cwd, DEFAULT_THRESHOLDS, 'hermes'),
        lastMessageId: 0,
        lastMessageTimestamp: 0,
        projectDir: cwd,
        title: description,
        model: str(sessionRow.model) ?? undefined,
        workingDir: cwd,
        sessionEnded,
        lastInputTokens: 0,
        lastOutputTokens: 0,
      };
      this.sessions.set(sessionId, state);

      // Emit subagent-meta so the parent tracker can link it
      state.tracker.apply({
        kind: 'subagent-meta',
        agentId: sessionId,
        parentSessionId,
        description,
      });
    }

    // Fetch messages for subagent
    const messages = this.db.prepare(`
      SELECT id, session_id, role, content, tool_calls, tool_name, token_count, timestamp, reasoning
      FROM messages
      WHERE session_id = ? AND id > ?
      ORDER BY id ASC
    `).all(sessionId, state.lastMessageId);

    for (const msg of messages) {
      const facts = interpretHermesMessage(msg);
      for (const fact of facts) {
        state.tracker.apply(fact);
      }
      state.lastMessageId = Math.max(state.lastMessageId, Number(msg.id));
      state.lastMessageTimestamp = Math.max(state.lastMessageTimestamp, Number(msg.timestamp));
    }

    if (sessionEnded && state.sessionEnded) {
      state.tracker.apply({
        kind: 'turn-end',
        ts: new Date(Number(sessionRow.ended_at) * 1000).toISOString(),
      });
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [sessionId, state] of this.sessions) {
      // Tick the tracker for lifecycle transitions (idle → sleeping → remove)
      if (state.tracker.tick(now) === 'remove') {
        this.sessions.delete(sessionId);
        continue;
      }
      // Remove sessions older than retention window
      if (now - state.lastMessageTimestamp * 1000 > SESSION_RETENTION_MS) {
        state.tracker.apply({ kind: 'turn-end', ts: new Date().toISOString() });
        this.sessions.delete(sessionId);
      }
    }
  }

  /** Process historical (stale) session: only count tokens, no hero spawn. */
  private async processStaleSession(sessionRow: Record<string, unknown>): Promise<void> {
    const sessionId = String(sessionRow.id);
    if (this.processedStale.has(sessionId)) return;
    this.processedStale.add(sessionId);
    // Tokens are collected by building-stats from the session table, no action needed here.
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}