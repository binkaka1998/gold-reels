// src/pipelines/reels.pipeline.ts
// Auto pipeline: DB → Gemini script+trend → TTS → slideshow → Facebook Reels

import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { PipelineResult } from '../types/index.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';
import { createRunDir, cleanupRunDir, loadImagesByTrend } from '../utils/filesystem.js';
import { generateScript } from '../services/script-generator.js';
import { synthesizeSpeech } from '../services/tts.js';
import { buildSlideshow } from '../services/ffmpeg.js';
import { publishToFacebook } from '../services/facebook.js';
import {
  acquireArticlesForVideoProcessing,
  markVideoPostSuccess,
  markVideoPostFailure,
  cleanStaleLocks,
} from '../services/news-repository.js';

const logger = getLogger('reels-pipeline');

export async function runReelsPipeline(): Promise<PipelineResult> {
  const config    = getConfig();
  const runId     = uuidv4();
  const startTime = Date.now();

  logger.info({ runId }, 'Reels pipeline start');
  await cleanStaleLocks();

  const articles = await acquireArticlesForVideoProcessing(config.pipeline.maxNewsPerRun, 'reels');

  if (articles.length === 0) {
    logger.info({ runId }, 'No articles — skipping');
    return { success: true, newsIds: [], durationMs: Date.now() - startTime };
  }

  const articleIds = articles.map((a) => a.id);
  let runDir: string | null = null;

  try {
    runDir = await createRunDir(runId);

    // Script + trend từ Gemini
    const script = await generateScript(articles, 'reels');
    logger.info({ estSec: script.estimatedDurationSec, trend: script.trend }, 'Script generated');

    // TTS
    const ttsResult = await synthesizeSpeech(script.fullText, runDir, 'reels', 'audio.wav');
    logger.info({ durationMs: ttsResult.durationMs }, 'TTS done');

    // Ảnh theo trend: assets/up/ hoặc assets/down/
    const imagePaths = await loadImagesByTrend(script.trend);
    logger.info({ trend: script.trend, imageCount: imagePaths.length }, 'Images loaded');

    // Video
    const videoPath = path.join(runDir, 'reels.mp4');
    await buildSlideshow({
      mode: 'reels', width: config.reels.width, height: config.reels.height,
      fps: 30, imagePaths, audioPath: ttsResult.audioPath, outputPath: videoPath,
    });

    // Facebook
    const sources     = [...new Set(articles.map((a) => a.pageCited))];
    const description = `📰 ${script.title}\n\nNguồn: ${sources.join(' • ')}\n\n#vàng #taichinh #giavang`;

    const fbResult = await publishToFacebook({
      videoPath, title: script.title, description, mode: 'reels',
    });

    await markVideoPostSuccess(articleIds, fbResult.postId);
    logger.info({ postId: fbResult.postId, trend: script.trend }, 'Reels published');

    return { success: true, newsIds: articleIds, facebookPostId: fbResult.postId, videoPath, durationMs: Date.now() - startTime };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ runId, error }, 'Reels pipeline failed');
    await markVideoPostFailure(articleIds, error).catch(() => undefined);
    return { success: false, newsIds: articleIds, error, durationMs: Date.now() - startTime };
  } finally {
    if (runDir) await cleanupRunDir(runDir);
  }
}