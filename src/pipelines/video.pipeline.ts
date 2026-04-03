// src/pipelines/video.pipeline.ts
// Auto pipeline: lấy bài DOMESTIC mới nhất theo author → script → TTS → video → Facebook Video

import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { PipelineResult, NewsArticle } from '../types/index.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';
import { createRunDir, cleanupRunDir, loadImagesForVideo } from '../utils/filesystem.js';
import { generateScript } from '../services/script-generator.js';
import { synthesizeSpeech } from '../services/tts.js';
import { buildSlideshow } from '../services/ffmpeg.js';
import { publishToFacebook } from '../services/facebook.js';
import { fetchLatestByAuthor } from '../services/news-repository.js';

const logger = getLogger('video-pipeline');

export async function runVideoPipeline(): Promise<PipelineResult> {
    const config    = getConfig();
    const runId     = uuidv4();
    const startTime = Date.now();

    logger.info({ runId, author: config.pipeline.dbAuthor }, 'Video pipeline start');

    const articles = await fetchLatestByAuthor(config.pipeline.dbAuthor, 1);

    if (articles.length === 0) {
        logger.info({ runId }, 'No articles — skipping');
        return { success: true, newsIds: [], durationMs: Date.now() - startTime };
    }

    const articleIds = articles.map((a) => a.id);
    let runDir: string | null = null;

    try {
        runDir = await createRunDir(runId);

        const stripHtml = (html: string) =>
            html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        const articlesForScript: NewsArticle[] = articles.map((a) => ({
            ...a,
            contentVi: a.contentVi ? stripHtml(a.contentVi) : null,
            contentEn: stripHtml(a.contentEn),
        }));

        const script = await generateScript(articlesForScript, 'video');
        logger.info({ estSec: script.estimatedDurationSec }, 'Script generated');

        const ttsResult = await synthesizeSpeech(script.fullText, runDir, 'video', 'audio.wav');
        logger.info({ durationMs: ttsResult.durationMs }, 'TTS done');

        const imagePaths = await loadImagesForVideo();
        logger.info({ imageCount: imagePaths.length }, 'Images loaded');

        const videoPath = path.join(runDir, 'video.mp4');
        await buildSlideshow({
            mode: 'video', width: config.video.width, height: config.video.height,
            fps: 30, imagePaths, audioPath: ttsResult.audioPath, outputPath: videoPath, thumbnailText: script.thumbnail,
        });

        const article     = articles[0]!;
        const headline    = article.headlineVi ?? article.headlineEn;
        const description = `📰 ${headline}\n\n#vàng #taichinh #phanTich`;

        const fbResult = await publishToFacebook({
            videoPath, title: headline.slice(0, 255), description, mode: 'video',
        });

        logger.info({ postId: fbResult.postId }, 'Video published');

        return { success: true, newsIds: articleIds, facebookPostId: fbResult.postId, videoPath, durationMs: Date.now() - startTime };
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error({ runId, error }, 'Video pipeline failed');
        return { success: false, newsIds: articleIds, error, durationMs: Date.now() - startTime };
    } finally {
        if (runDir) await cleanupRunDir(runDir);
    }
}