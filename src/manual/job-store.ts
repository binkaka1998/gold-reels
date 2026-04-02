// src/manual/job-store.ts
// In-memory job registry with Server-Sent Events broadcasting.
//
// Design decisions:
// - In-memory only (no DB): manual jobs are ephemeral, video file is the artifact.
// - SSE over WebSocket: simpler, no handshake, perfect for unidirectional progress.
// - Max 50 jobs retained (oldest pruned) to prevent memory growth in daemon mode.
// - Each job has its own EventEmitter; clients subscribe by job ID.

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { ManualJob, ManualJobRequest, JobStatus, JobLogEntry, JobUpdateEvent } from './types.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('job-store');
const MAX_JOBS = 50;

class JobStore {
  private jobs = new Map<string, ManualJob>();
  private emitters = new Map<string, EventEmitter>();

  create(request: ManualJobRequest): ManualJob {
    const id = uuidv4();
    const now = new Date();

    const job: ManualJob = {
      id,
      request,
      status: 'pending',
      progress: 0,
      currentStep: 'Đang chờ xử lý...',
      logs: [],
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, job);
    this.emitters.set(id, new EventEmitter());

    // Prune oldest jobs if over limit
    if (this.jobs.size > MAX_JOBS) {
      const oldest = [...this.jobs.keys()][0];
      if (oldest) {
        this.jobs.delete(oldest);
        this.emitters.get(oldest)?.removeAllListeners();
        this.emitters.delete(oldest);
      }
    }

    logger.info({ jobId: id, author: request.author, mode: request.mode }, 'Job created');
    return job;
  }

  get(id: string): ManualJob | undefined {
    return this.jobs.get(id);
  }

  list(): ManualJob[] {
    return [...this.jobs.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  // ── Update helpers ─────────────────────────────────────────────────────────

  update(
    id: string,
    patch: Partial<Pick<ManualJob, 'status' | 'progress' | 'currentStep' | 'contentPreview' | 'script' | 'videoPath' | 'facebookPostId' | 'error'>>
  ): void {
    const job = this.jobs.get(id);
    if (!job) return;

    Object.assign(job, patch, { updatedAt: new Date() });

    const event: JobUpdateEvent = {
      jobId: id,
      status: job.status,
      progress: job.progress,
      step: job.currentStep,
      result: {
        script: job.script,
        facebookPostId: job.facebookPostId,
        error: job.error,
      },
    };

    this.emit(id, event);
  }

  log(id: string, level: JobLogEntry['level'], msg: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    const entry: JobLogEntry = { ts: Date.now(), level, msg };
    job.logs.push(entry);
    job.updatedAt = new Date();

    // Keep last 200 log entries per job
    if (job.logs.length > 200) job.logs.shift();

    const event: JobUpdateEvent = {
      jobId: id,
      status: job.status,
      progress: job.progress,
      step: job.currentStep,
      log: entry,
    };

    this.emit(id, event);
    logger[level]({ jobId: id }, msg);
  }

  // Convenience: update status + progress + step in one call
  step(
    id: string,
    status: JobStatus,
    progress: number,
    stepMsg: string,
    logMsg?: string
  ): void {
    this.update(id, { status, progress, currentStep: stepMsg });
    if (logMsg) this.log(id, 'info', logMsg);
  }

  // ── SSE plumbing ───────────────────────────────────────────────────────────

  subscribe(id: string, listener: (event: JobUpdateEvent) => void): () => void {
    const emitter = this.emitters.get(id);
    if (!emitter) return () => undefined;
    emitter.on('update', listener);
    return () => emitter.off('update', listener);
  }

  private emit(id: string, event: JobUpdateEvent): void {
    this.emitters.get(id)?.emit('update', event);
  }
}

// Singleton
export const jobStore = new JobStore();
