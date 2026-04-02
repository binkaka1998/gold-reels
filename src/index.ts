// src/index.ts
// Application entry point.
// Modes (--mode=X):
//   reels  → one-shot: run Reels auto-pipeline and exit
//   video  → one-shot: run Video auto-pipeline and exit
//   web    → Web UI server only (no cron)
//   (none) → daemon: Web UI + cron scheduler

import 'dotenv/config';
import cron from 'node-cron';
import { getConfig } from './utils/config.js';
import { getLogger } from './utils/logger.js';
import { disconnectPrisma, releaseVideoProcessingLock } from './services/news-repository.js';
import { ensureDir } from './utils/filesystem.js';
import { runReelsPipeline } from './pipelines/reels.pipeline.js';
import { runVideoPipeline } from './pipelines/video.pipeline.js';
import { startServer } from './manual/server.js';

const logger = getLogger('main');

// ── Init ───────────────────────────────────────────────────────────────────────
async function initialize(): Promise<void> {
  const config = getConfig(); // throws fast on bad env
  await ensureDir(config.pipeline.tmpDir);
  await ensureDir(config.pipeline.assetsDir);
  await ensureDir(config.web.uploadDir);
  await ensureDir(config.web.outputDir);
  logger.info(
    { ttsProvider: config.ttsProvider, webPort: config.web.port },
    'Pipeline initialized'
  );
}

// ── Auto-pipeline runners ──────────────────────────────────────────────────────
async function runReels(): Promise<void> {
  logger.info('▶ Reels pipeline start');
  const result = await runReelsPipeline().catch((err: Error) => {
    logger.error({ err: err.message }, 'Reels pipeline crashed');
    return null;
  });
  if (result) {
    logger.info({ success: result.success, newsIds: result.newsIds.length }, '◀ Reels done');
  }
}

async function runVideo(): Promise<void> {
  logger.info('▶ Video pipeline start');
  const result = await runVideoPipeline().catch((err: Error) => {
    logger.error({ err: err.message }, 'Video pipeline crashed');
    return null;
  });
  if (result) {
    logger.info({ success: result.success, newsIds: result.newsIds.length }, '◀ Video done');
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');
  await releaseVideoProcessingLock([]).catch(() => undefined);
  await disconnectPrisma();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message }, 'Uncaught exception');
  void shutdown('uncaughtException');
});

// ── Main ───────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await initialize();

  const modeArg = process.argv.slice(2)
    .find((a) => a.startsWith('--mode='))
    ?.split('=')[1];

  // One-shot modes
  if (modeArg === 'reels') { await runReels(); await disconnectPrisma(); return; }
  if (modeArg === 'video') { await runVideo(); await disconnectPrisma(); return; }

  // Web UI (both --mode=web and daemon)
  const config = getConfig();
  startServer(config.web.port);

  if (modeArg === 'web') {
    logger.info({ port: config.web.port }, 'Web-only mode — cron disabled');
    return;
  }

  // Daemon: cron scheduler
  // Reels: every 2h during 07:00–21:00 ICT
  cron.schedule('0 */2 7-21 * * *', () => void runReels(), { timezone: 'Asia/Ho_Chi_Minh' });
  // Long-form video: daily 19:30 ICT
  cron.schedule('30 19 * * *', () => void runVideo(), { timezone: 'Asia/Ho_Chi_Minh' });

  logger.info(
    { reels: 'every 2h 07–21 ICT', video: 'daily 19:30 ICT', webPort: config.web.port },
    'Daemon started'
  );
}

main().catch((err: Error) => {
  logger.fatal({ err: err.message }, 'Fatal startup error');
  process.exit(1);
});
