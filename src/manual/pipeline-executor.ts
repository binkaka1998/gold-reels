// src/manual/pipeline-executor.ts
// Pipeline: DB → Gemini script → TTS → FFmpeg → Facebook

import path from 'path';
import fs from 'fs/promises';
import type { ManualJob } from './types.js';
import { jobStore } from './job-store.js';
import { generateScriptFromContent } from './script-from-research.js';
import type { TrendDirection } from './script-from-research.js';
import { synthesizeSpeech } from '../services/tts.js';
import { buildSlideshow } from '../services/ffmpeg.js';
import { publishToFacebook } from '../services/facebook.js';
import { loadImagesByTrend, loadImagesForVideo, createRunDir, cleanupRunDir } from '../utils/filesystem.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';
import { fetchLatestByAuthor } from '../services/news-repository.js';

const logger = getLogger('pipeline-executor');

async function resolveImages(
    localPaths: string[],
    remoteUrls: string[],
    runDir: string,
    mode: 'reels' | 'video',
    trend: TrendDirection,
    log: (msg: string) => void,
): Promise<string[]> {
  const resolved: string[] = [];

  for (const p of localPaths) {
    try { await fs.access(p); resolved.push(p); log(`  ✓ ${path.basename(p)}`); }
    catch { log(`  ✗ File không tồn tại: ${path.basename(p)}`); }
  }

  for (let i = 0; i < remoteUrls.length; i++) {
    const url = remoteUrls[i]!;
    const ext  = url.split('?')[0]?.match(/\.(jpe?g|png|webp)$/i)?.[0] ?? '.jpg';
    const dest = path.join(runDir, `url_img_${i}${ext}`);
    try {
      const axios = (await import('axios')).default;
      const { data } = await axios.get<Buffer>(url, { responseType: 'arraybuffer', timeout: 20_000 });
      await fs.writeFile(dest, Buffer.from(data));
      resolved.push(dest);
      log(`  ✓ Downloaded: ${url.slice(0, 60)}`);
    } catch {
      log(`  ✗ Download thất bại: ${url.slice(0, 60)}`);
    }
  }

  if (resolved.length === 0) {
    log(`Dùng ảnh từ assets (mode=${mode}, trend=${trend})`);
    return mode === 'video' ? loadImagesForVideo() : loadImagesByTrend(trend);
  }

  return resolved;
}

export async function executeManualJob(job: ManualJob): Promise<void> {
  const { id, request } = job;
  const config = getConfig();
  const runDir = await createRunDir(`manual_${id}`);

  const log  = (msg: string) => jobStore.log(id, 'info', msg);
  const warn = (msg: string) => jobStore.log(id, 'warn', msg);
  const err  = (msg: string) => jobStore.log(id, 'error', msg);
  const step = (status: ManualJob['status'], pct: number, label: string) =>
      jobStore.step(id, status, pct, label);

  try {
    // ── Step 1: Lấy content từ DB ────────────────────────────────────────────
    step('fetching', 8, 'Đang lấy bài từ DB...');
    log(`Author: "${request.author}" | Mode: ${request.mode}`);

    const articles = await fetchLatestByAuthor(request.author, 1);
    const article  = articles[0]!;

    log(`Bài: ${article.headlineVi ?? article.headlineEn}`);
    log(`Ngày: ${article.publishedAt?.toLocaleDateString('vi-VN') ?? 'N/A'}`);

    const stripHtml = (html: string) =>
        html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const content = stripHtml(article.contentVi ?? article.contentEn).slice(0, 12_000);
    log(`Content: ${content.length} ký tự`);

    jobStore.update(id, { contentPreview: content.slice(0, 400) + '...' });

    // ── Step 2: Sinh script ──────────────────────────────────────────────────
    step('scripting', 22, `Sinh script ${request.mode === 'reels' ? 'Reels (~75s)' : 'Video (~3p)'}...`);

    const { fullText, estimatedDurationSec, trend } = await generateScriptFromContent(
        content, request.mode,
    );

    jobStore.update(id, { script: fullText });
    log(`Script: ${fullText.split(/\s+/).length} từ (~${estimatedDurationSec}s) | trend: ${trend}`);

    if (estimatedDurationSec > (request.mode === 'reels'
        ? config.reels.maxDurationSeconds
        : config.video.maxDurationSeconds) + 20) {
      warn('Script có thể dài hơn giới hạn — FFmpeg sẽ trim');
    }

    // ── Step 3: TTS ──────────────────────────────────────────────────────────
    step('tts', 40, 'Chuyển text → giọng nói...');
    log(`TTS: ${config.ttsProvider}`);

    const ttsResult = await synthesizeSpeech(fullText, runDir, request.mode, 'audio.wav');
    log(`Audio: ${(ttsResult.durationMs / 1000).toFixed(1)}s`);

    // ── Step 4: Ảnh ──────────────────────────────────────────────────────────
    step('encoding', 55, 'Chuẩn bị ảnh nền...');
    const imagePaths = await resolveImages(
        request.customImagePaths, request.customImageUrls,
        runDir, request.mode, trend, log,
    );
    log(`Sử dụng ${imagePaths.length} ảnh (trend: ${trend})`);

    // ── Step 5: FFmpeg ───────────────────────────────────────────────────────
    const isReels = request.mode === 'reels';
    const width   = isReels ? config.reels.width  : config.video.width;
    const height  = isReels ? config.reels.height : config.video.height;

    step('encoding', 65, `Dựng video ${width}×${height}...`);

    const rawVideoPath = path.join(runDir, `output_${request.mode}.mp4`);
    await buildSlideshow({
      mode: request.mode, width, height, fps: 30,
      imagePaths, audioPath: ttsResult.audioPath, outputPath: rawVideoPath,
    });

    // ── Step 6: Lưu video ────────────────────────────────────────────────────
    step('encoding', 78, 'Lưu video...');
    const outputDir = path.resolve(config.web.outputDir);
    await fs.mkdir(outputDir, { recursive: true });
    const finalVideoPath = path.join(outputDir, `${id}.mp4`);
    await fs.copyFile(rawVideoPath, finalVideoPath);

    const stat = await fs.stat(finalVideoPath);
    log(`Video: ${(stat.size / 1_048_576).toFixed(1)} MB`);
    jobStore.update(id, { videoPath: finalVideoPath });

    // ── Step 7: Facebook ─────────────────────────────────────────────────────
    if (request.postToFacebook) {
      step('uploading', 82, 'Upload lên Facebook...');
      const headline    = article.headlineVi ?? article.headlineEn;
      const description = request.facebookDescription?.trim()
          || `${headline}\n\n#vàng #taichinh #giavang`;

      const fbResult = await publishToFacebook({
        videoPath: finalVideoPath,
        title:     headline.slice(0, 255),
        description,
        mode:      request.mode,
      });

      log(`✅ Published: ${fbResult.permalink}`);
      jobStore.update(id, { facebookPostId: fbResult.postId });
    } else {
      log('Bỏ qua upload Facebook');
    }

    step('done', 100, '🎉 Hoàn thành!');

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ jobId: id, err: msg }, 'Pipeline failed');
    err(`❌ ${msg}`);
    jobStore.update(id, { status: 'failed', error: msg, currentStep: 'Thất bại' });
  } finally {
    await cleanupRunDir(runDir);
    for (const p of request.customImagePaths) {
      await fs.rm(p, { force: true }).catch(() => undefined);
    }
  }
}