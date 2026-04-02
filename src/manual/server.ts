// src/manual/server.ts
// Express server for manual video creation UI.
// Serves the SPA from public/ and mounts API routes.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { jobsRouter } from './routes/jobs.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';

const logger   = getLogger('server');
const __dir    = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dir, 'public');

export function startServer(port?: number): void {
  const config      = getConfig();
  const listenPort  = port ?? config.web.port;

  const app = express();

  // Body parsers (multipart handled by multer in routes)
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Static UI files
  app.use(express.static(publicDir));

  // API
  app.use('/api/jobs', jobsRouter);

  // Health (useful for Docker healthcheck + load balancer probes)
  app.get('/health', (_req, res) =>
    res.json({ ok: true, ts: Date.now(), uptime: process.uptime() })
  );

  // SPA fallback — all non-API routes serve index.html
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.listen(listenPort, () => {
    logger.info({ port: listenPort, url: `http://localhost:${listenPort}` }, 'Manual UI server started');
    logger.info({ uploadDir: config.web.uploadDir, outputDir: config.web.outputDir }, 'Storage dirs');
  });
}
