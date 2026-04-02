// src/web-entry.ts
// Dedicated entry point: Web UI only, no cron. Used for dev or separate deployment.
//   npm run dev:web
//   node dist/web-entry.js
import 'dotenv/config';
import { getConfig } from './utils/config.js';
import { getLogger } from './utils/logger.js';
import { ensureDir } from './utils/filesystem.js';
import { startServer } from './manual/server.js';
import { disconnectPrisma } from './services/news-repository.js';

const logger = getLogger('web-entry');

async function main() {
  const config = getConfig();
  await ensureDir(config.pipeline.tmpDir);
  await ensureDir(config.web.uploadDir);
  await ensureDir(config.web.outputDir);
  startServer(config.web.port);
  logger.info({ port: config.web.port }, 'Web UI started');
}

process.on('SIGTERM', async () => { await disconnectPrisma(); process.exit(0); });
process.on('SIGINT',  async () => { await disconnectPrisma(); process.exit(0); });

main().catch((err: Error) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
