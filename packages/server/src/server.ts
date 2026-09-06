import Fastify from 'fastify';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { WS_PATH, type GameEvent, validateQuestionAnswer } from '@agent-citadel/shared';
import { World } from './world.js';
import { registerMappingRoutes } from './mapping-routes.js';
import { registerModelRoutes } from './model-routes.js';
import { OpenCodePoller } from './sources/opencode-poller.js';
import { HermesPoller } from './sources/hermes-poller.js';
import { DockerPoller } from './sources/docker-poller.js';
import { CliDockerClient } from './sources/docker-client.js';
import { ArsenalPoller } from './arsenal/arsenal-poller.js';
import type { SourceWatcher } from './watcher.js';
import { PendingRegistry } from './pending-registry.js';
import { registerPermissionPolicyRoutes } from './permission-policy-routes.js';
import { LiveSessionRegistry } from './sdk/sessions.js';
import { registerSessionRoutes } from './session-routes.js';
import { registerFsRoutes } from './fs-routes.js';
import { loadOrCreateToken } from './security/token.js';
import { registerSecurityGuard, verifyWsClient } from './security/guard.js';
import { TaskTracker } from './task-tracker.js';

export interface StartServerOptions {
  /** HTTP port. Pass 0 so the system picks a free one (useful in tests). */
  port: number;
  host?: string;
  /** Demo mode: synthetic data instead of watching ~/.claude/projects. */
  demo: boolean;
  /** Katalog ze zbudowanym klientem (dist/web). Gdy podany — serwer serwuje SPA. */
  webRoot?: string;
  /** Override permission-policy file path (tests). Defaults to ~/.age-of-agents. */
  policyPath?: string;
  /** Override session-token file path (tests). Defaults to ~/.age-of-agents/session-token. */
  tokenPath?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close: () => Promise<void>;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!LOOPBACK.has(host) && process.env.AOA_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to bind to non-loopback host "${host}": the server has no transport ` +
      `encryption and is meant for local use. Set AOA_ALLOW_REMOTE=1 to override.`,
    );
  }
  const app = Fastify({ logger: { level: 'info' } });
  if (!LOOPBACK.has(host)) app.log.warn(`Binding to non-loopback host ${host} (AOA_ALLOW_REMOTE=1)`);
  const token = await loadOrCreateToken(opts.tokenPath);
  let resolvedPort = opts.port;
  registerSecurityGuard(app, { getPort: () => resolvedPort, token });
  const world = new World();
    const taskTracker = new TaskTracker();
    const pendingRegistry = new PendingRegistry(world);
  world.onEvent((event) => {
    if (event.type === 'hero-removed') pendingRegistry.cancelForSession(event.sessionId);
  });
  let watchers: SourceWatcher[] = [];
  let opencodePoller: OpenCodePoller | undefined;
  let hermesPoller: HermesPoller | undefined;
  let dockerPoller: DockerPoller | undefined;
  let arsenalPoller: ArsenalPoller | undefined;
  let liveSessions: LiveSessionRegistry | undefined;

  app.get('/health', async () => ({ ok: true, demo: opts.demo }));

  if (opts.demo) {
    // No-op routes so installed hooks do not emit 404s in demo mode.
    app.post('/hooks', async () => ({ ok: true }));
    app.get('/hooks/status', async () => ({ installed: false, demo: true }));
    app.get('/building-stats', async () => ({ updatedAt: new Date().toISOString(), buildings: {} }));
    // Tool->building map: demo does not persist (PUT only validates, GET = default).
    registerMappingRoutes(app, { persist: false });
    registerModelRoutes(app, { persist: false });
    app.post('/hooks/decide', async () => ({}));
    registerPermissionPolicyRoutes(app, { persist: false });
    const { FakeSdkRunner } = await import('./sdk/fake-runner.js');
    liveSessions = new LiveSessionRegistry(new FakeSdkRunner(), (sessionId) => world.emitCustom({ type: 'sdk-session-started', sessionId }));
    registerSessionRoutes(app, { sessions: liveSessions });
    registerFsRoutes(app);

    // Hermes assign-task (demo: simulate success)
    app.post('/api/assign-task', async (request, reply) => {
      const body = (request.body ?? {}) as { agent_role?: string; task_description?: string };
      const task = body.task_description?.trim();
      if (!task) return reply.code(400).send({ error: 'task_description is required' });
      return { ok: true, pid: 0, message: `[demo] Task dispatched: ${task.slice(0, 80)}` };
    });
  } else {
    const { SourceWatcher } = await import('./watcher.js');
    const { activeSources } = await import('./sources/index.js');
    const { translateHook, hooksStatus, installHooks, uninstallHooks, DECIDE_TIMEOUT_SEC } = await import('./hooks.js');
    const { getBuildingStats, invalidateBuildingStatsCache } = await import('./building-stats.js');
    const sources = activeSources(process.env.AOA_SOURCES);
    watchers = sources.map((source) => new SourceWatcher(world, source));
    // HTTP hooks are the Claude channel; route them to the Claude watcher.
    const claudeWatcher = watchers.find((w) => w.id === 'claude');

    // OpenCode uses SQLite instead of JSONL: start poller.
    const opencodeEnabled = sources.some((source) => source.id === 'opencode');
    opencodePoller = opencodeEnabled ? new OpenCodePoller(world) : undefined;
    // Hermes uses SQLite instead of JSONL: start poller.
    const hermesEnabled = sources.some((source) => source.id === 'hermes');
    hermesPoller = hermesEnabled ? new HermesPoller(world) : undefined;
    // Containerized Claude sessions are controlled by the Claude source filter.
    const dockerEnabled = sources.some((source) => source.id === 'claude');
    dockerPoller = dockerEnabled ? new DockerPoller(world, new CliDockerClient()) : undefined;

    app.get('/building-stats', async () => getBuildingStats());
    // Tool->building map: local server = source of truth (file on user's disk);
    // saving invalidates stats cache so numbers keep up with the new map.
    registerMappingRoutes(app, { persist: true, onSaved: invalidateBuildingStatsCache });
    registerModelRoutes(app, { persist: true });
    const { decideHook } = await import('./hook-decide.js');
    const { loadPermissionPolicy, addPolicyRule } = await import('./permission-policy.js');
    registerPermissionPolicyRoutes(app, { persist: true, policyPath: opts.policyPath });
    const { RealSdkRunner } = await import('./sdk/real-runner.js');
    liveSessions = new LiveSessionRegistry(new RealSdkRunner(pendingRegistry, (DECIDE_TIMEOUT_SEC - 10) * 1000), (sessionId) => world.emitCustom({ type: 'sdk-session-started', sessionId }));
    registerSessionRoutes(app, { sessions: liveSessions });
    registerFsRoutes(app);

    // ---- Hermes endpoints: chat, assign-task, stop, list ----

        /** POST /api/hermes/chat — wysyła wiadomość do Hermesa i zwraca odpowiedź */
            app.post('/api/hermes/chat', async (request, reply) => {
          const body = (request.body ?? {}) as { message?: string; session_id?: string };
          const message = body.message?.trim();
          if (!message) return reply.code(400).send({ ok: false, error: 'message is required' });

          const resumeArgs = body.session_id ? ['--resume', body.session_id] : [];
          const TIMEOUT_MS = 60_000;

          const child = spawn('hermes', ['chat', '-Q', '-q', message, ...resumeArgs], {
            cwd: 'D:\\Hermes',
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
          });

          if (child.pid) {
            taskTracker.register(child.pid, {
              sessionId: body.session_id ?? 'pending',
              message,
              startedAt: new Date(),
              process: child,
            });
          }

          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

          try {
            const result = await new Promise<{ ok: boolean; session_id: string; response: string; error?: string; pid?: number }>((resolve) => {
              const timer = setTimeout(() => {
                child.kill('SIGTERM');
                resolve({ ok: false, session_id: body.session_id ?? '', response: stdout.slice(0, 500), error: 'timeout', pid: child.pid ?? undefined });
              }, TIMEOUT_MS);

              child.on('close', (code) => {
                clearTimeout(timer);
                if (child.pid) taskTracker.remove(child.pid);

                // Parse session_id from first line: "session_id: 20260726_..."
                const sessionIdMatch = stdout.match(/^session_id:\s*(\S+)/m);
                const sessionId = sessionIdMatch?.[1] ?? body.session_id ?? '';

                // Remove session_id line and trailing newlines from response
                let response = stdout.replace(/^session_id:\s*\S+\s*/m, '').trim();
                if (!response && stderr) response = stderr.trim();

                if (code !== 0 && !response) {
                  resolve({ ok: false, session_id: sessionId, response: stderr.trim() || `exit code ${code}`, error: `hermes exited with code ${code}`, pid: child.pid ?? undefined });
                } else {
                  resolve({ ok: code === 0, session_id: sessionId, response, pid: child.pid ?? undefined });
                }
              });

              child.on('error', (err) => {
                clearTimeout(timer);
                if (child.pid) taskTracker.remove(child.pid);
                resolve({ ok: false, session_id: body.session_id ?? '', response: '', error: err.message, pid: child.pid ?? undefined });
              });
            });

            if (result.ok) {
              app.log.info({ session_id: result.session_id }, 'Hermes chat response received');
              return { ok: true, session_id: result.session_id, response: result.response, pid: result.pid };
            } else {
              return reply.code(result.error === 'timeout' ? 408 : 500).send(result);
            }
          } catch (err) {
            return reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : 'unknown error' });
          }
        });

        /** POST /api/assign-task — kompatybilność wsteczna: fire-and-forget (bez odpowiedzi) */
        app.post('/api/assign-task', async (request, reply) => {
          const body = (request.body ?? {}) as { agent_role?: string; task_description?: string };
          const role = body.agent_role?.trim();
          const task = body.task_description?.trim();
          if (!task) return reply.code(400).send({ error: 'task_description is required' });

          const prompt = role ? `You are ${role}. ${task}` : task;

          const child = spawn('hermes', ['chat', '-Q', '-q', prompt], {
            detached: true,
            stdio: 'ignore',
            shell: true,
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
          });
          child.unref();

          if (child.pid) {
            taskTracker.register(child.pid, {
              sessionId: 'pending',
              message: prompt,
              startedAt: new Date(),
              process: child,
            });
            child.on('close', () => { if (child.pid) taskTracker.remove(child.pid); });
            child.on('error', () => { if (child.pid) taskTracker.remove(child.pid); });
          }

          app.log.info({ role, task: task.slice(0, 100) }, 'Hermes task dispatched');
          return { ok: true, pid: child.pid, message: `Task dispatched: ${task.slice(0, 80)}` };
        });

        /** POST /api/task/:pid/stop — zatrzymuje działający task */
        app.post<{ Params: { pid: string } }>('/api/task/:pid/stop', async (request, reply) => {
          const pid = parseInt(request.params.pid, 10);
          if (isNaN(pid)) return reply.code(400).send({ ok: false, error: 'invalid pid' });
          const wasRunning = taskTracker.kill(pid);
          if (!wasRunning) return reply.code(404).send({ ok: false, error: 'task not found or already completed' });
          app.log.info({ pid }, 'Task stopped by user');
          return { ok: true, pid, was_running: true };
        });

        /** GET /api/tasks — lista aktywnych tasków */
        app.get('/api/tasks', async () => {
          return { tasks: taskTracker.list() };
        });

        /* ---- existing endpoints continue below ---- */

    app.post('/hooks/decide', async (request) => {
      const body = (request.body ?? {}) as never;
      // Animate the tool like the regular /hooks channel does.
      const translated = translateHook(body);
      if (translated && claudeWatcher) {
        claudeWatcher.applyExternalFacts(translated.sessionId, translated.projectDir, translated.facts, translated.cwd);
      }
      const policy = await loadPermissionPolicy(opts.policyPath);
      return decideHook(body, {
        policy,
        registry: pendingRegistry,
        timeoutMs: (DECIDE_TIMEOUT_SEC - 10) * 1000,
        onAlwaysRule: async (rule) => { await addPolicyRule(rule, opts.policyPath); },
      });
    });
    app.post('/hooks', async (request, reply) => {
      const translated = translateHook((request.body ?? {}) as never);
      if (translated) {
        if (!claudeWatcher) return reply.code(409).send({ ok: false, error: 'claude source disabled' });
        claudeWatcher.applyExternalFacts(translated.sessionId, translated.projectDir, translated.facts, translated.cwd);
      }
      return { ok: true };
    });
    app.get('/hooks/status', async () => hooksStatus());
    app.post('/hooks/install', async () => {
      await installHooks();
      return { ok: true, installed: true };
    });
    app.post('/hooks/uninstall', async () => {
      await uninstallHooks();
      return { ok: true, installed: false };
    });

    app.addHook('onReady', async () => {
      for (const w of watchers) w.start();
      await opencodePoller?.start();
      await hermesPoller?.start();
      // Fire-and-forget: Docker unavailability must not delay server readiness.
      void dockerPoller?.start();
      // `arsenal-updated` event to client (Arsenal panel).
      arsenalPoller = new ArsenalPoller(world);
      arsenalPoller.start();
      app.log.info(`Source watchers active: ${watchers.map((w) => w.id).join(', ')}`);
    });
  }

  // Issued only to allowlisted origins (the guard rejects foreign Origins first).
  app.get('/session-token', async () => ({ token }));

  // Serwowanie zbudowanego klienta — tylko w dystrybucji; w dev robi to Vite.
  if (opts.webRoot) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: opts.webRoot, wildcard: false });
    // SPA fallback: unknown GET route -> index.html (API routes are registered,
    // so they will not land here).
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET') return reply.sendFile('index.html');
      reply.code(404).send({ error: 'not found' });
    });
  }

  try {
    await app.listen({ port: opts.port, host });
  } catch (err) {
    // tsx watch restarts may race with the previous instance still releasing
    // the port — EADDRINUSE is harmless when the old server is still running.
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      app.log.warn(`Port ${opts.port} already in use — server likely already running (tsx watch restart race)`);
      return;
    }
    throw err;
  }

  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : opts.port;
  resolvedPort = actualPort;

  const wss = new WebSocketServer({
    server: app.server,
    path: WS_PATH,
    verifyClient: (info: { origin: string; req: { url?: string } }) =>
          verifyWsClient({ origin: info.origin, reqUrl: info.req.url }, resolvedPort, token),
  });

  const send = (socket: WebSocket, event: GameEvent): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    // Client may disappear during broadcast; its failure must not interrupt
    // delivery to the others.
    try {
      socket.send(JSON.stringify(event));
    } catch (err) {
      app.log.warn({ err }, 'WS send failed — skipping this client');
    }
  };

  wss.on('connection', (socket) => {
    send(socket, { type: 'snapshot', ...world.snapshot() });
    for (const q of pendingRegistry.open()) send(socket, { type: 'pending-question', question: q });
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { type?: string; payload?: unknown };
        if (msg.type === 'answer') {
          const res = validateQuestionAnswer(msg.payload);
          if (res.ok) pendingRegistry.resolve(res.answer);
        }
      } catch {
        /* ignore malformed client messages */
      }
    });
  });
  const offEvent = world.onEvent((event) => {
    for (const socket of wss.clients) send(socket, event);
  });

  if (opts.demo) {
    const { startDemo } = await import('./demo/scenario.js');
    startDemo(world);
  }

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;
  return {
    url,
    port: actualPort,
    token,
    close: async () => {
      offEvent();
      await liveSessions?.stopAll();
      await opencodePoller?.stop();
      await hermesPoller?.stop();
      dockerPoller?.stop();
      await Promise.all(watchers.map((w) => w.stop()));
      arsenalPoller?.stop();
      await new Promise<void>((resolve, reject) =>
        wss.close((err) => (err ? reject(err) : resolve())),
      );
      await app.close();
    },
  };
}