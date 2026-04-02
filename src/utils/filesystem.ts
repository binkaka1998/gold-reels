// src/utils/filesystem.ts
// Handles temp file lifecycle, image pool loading, and cleanup.
// All generated files live in TMP_DIR/{runId}/ and are cleaned up after upload.

import fs from 'fs/promises';
import path from 'path';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';

const logger = getLogger('filesystem');

const SUPPORTED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * Creates a dedicated temp directory for a pipeline run.
 * Returns the absolute path.
 */
export async function createRunDir(runId: string): Promise<string> {
  const config = getConfig();
  const runDir = path.resolve(config.pipeline.tmpDir, runId);
  await fs.mkdir(runDir, { recursive: true });
  logger.debug({ runDir }, 'Created run directory');
  return runDir;
}

/**
 * Removes a run directory and all generated artifacts.
 * Should always be called in a finally block to prevent disk exhaustion.
 */
export async function cleanupRunDir(runDir: string): Promise<void> {
  try {
    await fs.rm(runDir, { recursive: true, force: true });
    logger.debug({ runDir }, 'Cleaned up run directory');
  } catch (err) {
    // Non-fatal: log but don't rethrow — cleanup failures shouldn't mask real errors
    logger.warn({ runDir, err }, 'Failed to clean up run directory');
  }
}

/**
 * Loads images từ một folder cụ thể. Throw nếu không có ảnh.
 */
export async function loadImagePoolFromDir(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new Error(`Thư mục không tồn tại: ${dir}`);
  }

  const images = entries
      .filter((f) => SUPPORTED_IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(dir, f));

  if (images.length < 1) {
    throw new Error(`Không có ảnh trong: ${dir}`);
  }

  // Fisher-Yates shuffle
  for (let i = images.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [images[i], images[j]] = [images[j]!, images[i]!];
  }

  logger.info({ count: images.length, dir }, 'Images loaded');
  return images;
}

/**
 * Fallback pool: gom ảnh từ tất cả subfolders (up/, down/, video/).
 * Dùng khi không có folder trend/video cụ thể.
 */
async function loadImageFallback(baseDir: string): Promise<string[]> {
  const all: string[] = [];
  try {
    const entries = await fs.readdir(baseDir);
    for (const entry of entries) {
      const subPath = path.join(baseDir, entry);
      try {
        const stat = await fs.stat(subPath);
        if (!stat.isDirectory()) continue;
        const subs = await fs.readdir(subPath);
        subs
            .filter((f) => SUPPORTED_IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
            .forEach((f) => all.push(path.join(subPath, f)));
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  if (all.length === 0) {
    throw new Error(
        `Không tìm thấy ảnh trong: ${baseDir}\n` +
        `Cấu trúc mong đợi:\n` +
        `  ${baseDir}/up/     ← Reels uptrend\n` +
        `  ${baseDir}/down/   ← Reels downtrend\n` +
        `  ${baseDir}/video/  ← Video dài`
    );
  }

  // Shuffle
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }

  logger.warn({ count: all.length, baseDir }, 'Using fallback image pool from all subdirs');
  return all;
}

/**
 * Load ảnh theo trend cho Reels:
 *   uptrend   → ASSETS_DIR/up/
 *   downtrend → ASSETS_DIR/down/
 */
export async function loadImagesByTrend(
    trend: 'uptrend' | 'downtrend'
): Promise<string[]> {
  const config   = getConfig();
  const baseDir  = path.resolve(config.pipeline.assetsDir);
  const trendDir = path.join(baseDir, trend === 'uptrend' ? 'up' : 'down');

  try {
    return await loadImagePoolFromDir(trendDir);
  } catch {
    logger.warn({ trendDir }, `Không có ảnh cho ${trend} — fallback`);
    return loadImageFallback(baseDir);
  }
}

/**
 * Load ảnh cho Video dài — ASSETS_DIR/video/
 */
export async function loadImagesForVideo(): Promise<string[]> {
  const config   = getConfig();
  const baseDir  = path.resolve(config.pipeline.assetsDir);
  const videoDir = path.join(baseDir, 'video');

  try {
    return await loadImagePoolFromDir(videoDir);
  } catch {
    logger.warn({ videoDir }, 'Không có ảnh video — fallback');
    return loadImageFallback(baseDir);
  }
}

/**
 * Generic pool — dùng bởi các context không cần trend.
 * Ưu tiên ASSETS_DIR/up/ nếu có, rồi fallback toàn bộ subdirs.
 */
export async function loadImagePool(): Promise<string[]> {
  const config  = getConfig();
  const baseDir = path.resolve(config.pipeline.assetsDir);

  // Thử up/ trước (phổ biến nhất)
  try {
    return await loadImagePoolFromDir(path.join(baseDir, 'up'));
  } catch { /* fallback */ }

  return loadImageFallback(baseDir);
}

/**
 * Writes a file and returns its path.
 */
export async function writeFile(filePath: string, content: string | Buffer): Promise<string> {
  await fs.writeFile(filePath, content);
  return filePath;
}

/**
 * Returns file size in bytes. Returns 0 if file doesn't exist.
 */
export async function getFileSizeBytes(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * Ensures a directory exists (creates recursively if needed).
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(path.resolve(dirPath), { recursive: true });
}