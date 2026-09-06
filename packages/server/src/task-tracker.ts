import type { ChildProcess } from 'node:child_process';

export interface TrackedTask {
  pid: number;
  sessionId: string;
  message: string;
  startedAt: Date;
  process: ChildProcess;
}

export interface TaskSummary {
  pid: number;
  sessionId: string;
  message: string;
  startedAt: string;
  elapsedMs: number;
}

/**
 * In-memory registry of live Hermes CLI processes.
 * Per ADR-005: no persistence needed — tasks are ephemeral (max 60s).
 */
export class TaskTracker {
  private tasks = new Map<number, TrackedTask>();

  register(pid: number, meta: Omit<TrackedTask, 'pid'>): void {
    this.tasks.set(pid, { pid, ...meta });
  }

  get(pid: number): TrackedTask | undefined {
    return this.tasks.get(pid);
  }

  remove(pid: number): void {
    this.tasks.delete(pid);
  }

  list(): TaskSummary[] {
    const now = Date.now();
    return [...this.tasks.values()].map((t) => ({
      pid: t.pid,
      sessionId: t.sessionId,
      message: t.message.length > 100 ? t.message.slice(0, 97) + '...' : t.message,
      startedAt: t.startedAt.toISOString(),
      elapsedMs: now - t.startedAt.getTime(),
    }));
  }

  /** Kill a running task. Returns false if task not found or already exited. */
  kill(pid: number): boolean {
    const task = this.tasks.get(pid);
    if (!task) return false;
    if (task.process.exitCode !== null) {
      this.tasks.delete(pid);
      return false;
    }
    task.process.kill('SIGTERM');
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (task.process.exitCode === null) {
        try { task.process.kill('SIGKILL'); } catch { /* already dead */ }
      }
      this.tasks.delete(pid);
    }, 5000);
    return true;
  }
}