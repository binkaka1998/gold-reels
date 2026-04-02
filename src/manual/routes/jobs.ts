// src/manual/routes/jobs.ts

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { jobStore } from '../job-store.js';
import { executeManualJob } from '../pipeline-executor.js';
import type { ManualJobRequest, VideoMode } from '../types.js';
import { getConfig } from '../../utils/config.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('routes-jobs');
export const jobsRouter = Router();

// ── Multer ────────────────────────────────────────────────────────────────────

function buildMulter() {
  const config = getConfig();
  const uploadDir = path.resolve(config.web.uploadDir);
  fs.mkdir(uploadDir, { recursive: true }).catch(() => undefined);

  return multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, file, cb) => {
        const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
        const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
        cb(null, `${Date.now()}_${base}${ext}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024, files: 10 },
    fileFilter: (_req, file, cb) => {
      if (/\.(jpe?g|png|webp)$/i.test(file.originalname)) cb(null, true);
      else cb(new Error('Chỉ chấp nhận JPEG/PNG/WebP'));
    },
  });
}

const upload = buildMulter();

function toArray(v: unknown): string[] {
  if (Array.isArray(v)) return (v as string[]).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

// ── POST /api/jobs ────────────────────────────────────────────────────────────

jobsRouter.post(
  '/',
  upload.array('images', 10),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = req.body as Record<string, unknown>;

      const author         = typeof body['author'] === 'string' ? body['author'].trim() : '';
      const mode           = (body['mode'] as string) ?? 'reels';
      const postToFacebook = body['postToFacebook'] === 'true';
      const facebookDesc   = typeof body['facebookDescription'] === 'string' ? body['facebookDescription'].trim() : undefined;

      if (!author) { res.status(400).json({ error: 'author là bắt buộc' }); return; }
      if (!['reels', 'video'].includes(mode)) { res.status(400).json({ error: 'mode phải là "reels" hoặc "video"' }); return; }

      const uploadedFiles    = (req.files as Express.Multer.File[]) ?? [];
      const customImagePaths = uploadedFiles.map((f) => f.path);
      const customImageUrls  = toArray(body['imageUrls']);

      const request: ManualJobRequest = {
        author,
        mode: mode as VideoMode,
        customImagePaths,
        customImageUrls,
        postToFacebook,
        facebookDescription: facebookDesc,
      };

      const job = jobStore.create(request);
      logger.info({ jobId: job.id, author, mode }, 'Job created');
      void executeManualJob(job);

      res.status(202).json({ jobId: job.id });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

// ── GET /api/jobs ─────────────────────────────────────────────────────────────

jobsRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    jobs: jobStore.list().map((j) => ({
      id:          j.id,
      author:      j.request.author,
      mode:        j.request.mode,
      status:      j.status,
      progress:    j.progress,
      currentStep: j.currentStep,
      createdAt:   j.createdAt,
      hasVideo:    !!j.videoPath,
      facebookPostId: j.facebookPostId,
      error:       j.error,
    })),
  });
});

// ── GET /api/jobs/:id ─────────────────────────────────────────────────────────

jobsRouter.get('/:id', (req: Request, res: Response): void => {
  const job = jobStore.get(req.params['id']!);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  res.json({
    id:             job.id,
    status:         job.status,
    progress:       job.progress,
    currentStep:    job.currentStep,
    author:         job.request.author,
    mode:           job.request.mode,
    contentPreview: job.contentPreview,
    script:         job.script,
    videoFilename:  job.videoPath ? path.basename(job.videoPath) : null,
    facebookPostId: job.facebookPostId,
    error:          job.error,
    logs:           job.logs.slice(-100),
    createdAt:      job.createdAt,
    updatedAt:      job.updatedAt,
  });
});

// ── GET /api/jobs/:id/events (SSE) ────────────────────────────────────────────

jobsRouter.get('/:id/events', (req: Request, res: Response): void => {
  const jobId = req.params['id']!;
  const job   = jobStore.get(jobId);
  if (!job) { res.status(404).end(); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({
    jobId, status: job.status, progress: job.progress, step: job.currentStep,
    result: { script: job.script, facebookPostId: job.facebookPostId, error: job.error },
    logs: job.logs.slice(-20),
  });

  if (job.status === 'done' || job.status === 'failed') { res.end(); return; }

  const unsubscribe = jobStore.subscribe(jobId, (event) => {
    send(event);
    if (event.status === 'done' || event.status === 'failed') res.end();
  });

  const heartbeat = setInterval(() => res.write(': ♥\n\n'), 20_000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

// ── GET /api/jobs/:id/download ────────────────────────────────────────────────

jobsRouter.get('/:id/download', async (req: Request, res: Response): Promise<void> => {
  const job = jobStore.get(req.params['id']!);
  if (!job)           { res.status(404).json({ error: 'Job not found' }); return; }
  if (!job.videoPath) { res.status(404).json({ error: 'Video chưa sẵn sàng' }); return; }
  if (!existsSync(job.videoPath)) { res.status(410).json({ error: 'File đã bị xoá' }); return; }

  const stat = await fs.stat(job.videoPath);
  const filename = `${job.request.author}_${job.request.mode}_${job.id.slice(0, 8)}.mp4`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  createReadStream(job.videoPath).pipe(res);
});

// ── DELETE /api/jobs/:id ──────────────────────────────────────────────────────

jobsRouter.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const job = jobStore.get(req.params['id']!);
  if (!job) { res.status(404).json({ error: 'Job not found' }); return; }
  if (job.videoPath && existsSync(job.videoPath)) {
    await fs.rm(job.videoPath, { force: true });
  }
  res.json({ deleted: true });
});
