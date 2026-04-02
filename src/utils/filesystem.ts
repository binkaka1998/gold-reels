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
 * Loads all supported image paths from the assets directory.
 * Shuffles them so different runs use different image orderings.
 * Throws if the pool is empty (misconfiguration).
 */
export async function loadImagePool(): Promise<string[]> {
  const config = getConfig();
  return loadImagePoolFromDir(path.resolve(config.pipeline.assetsDir));
}

/**
 * Loads images from a specific directory (for trend-based selection).
 * Minimum 1 image required.
 */
export async function loadImagePoolFromDir(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new Error(
        `Thư mục ảnh không tồn tại hoặc không đọc được: ${dir}`
    );
  }

  const images = entries
      .filter((f) => SUPPORTED_IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(dir, f));

  if (images.length < 1) {
    throw new Error(`Không có ảnh nào trong: ${dir}. Thêm ít nhất 1 ảnh.`);
  }

  // Fisher-Yates shuffle
  const shuffled = [...images];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  logger.info({ count: shuffled.length, dir }, 'Image pool loaded');
  return shuffled;
}

/**
 * Load ảnh theo trend cho Reels:
 *   uptrend   → assets/images/up/
 *   downtrend → assets/images/down/
 * Fallback về assets/images/ nếu thư mục trend trống/không tồn tại.
 */
export async function loadImagesByTrend(
    trend: 'uptrend' | 'downtrend'
): Promise<string[]> {
  const config  = getConfig();
  const baseDir = path.resolve(config.pipeline.assetsDir);
  const subDir  = trend === 'uptrend' ? 'up' : 'down';
  const trendDir = path.join(baseDir, subDir);

  try {
    const images = await loadImagePoolFromDir(trendDir);
    return images;
  } catch {
    logger.warn({ trendDir }, `Không có ảnh cho ${trend} — fallback về assets root`);
    return loadImagePool();
  }
}

/**
 * Load ảnh cho Video — assets/images/video/
 * Fallback về assets/images/ nếu thư mục video trống/không tồn tại.
 */
export async function loadImagesForVideo(): Promise<string[]> {
  const config   = getConfig();
  const baseDir  = path.resolve(config.pipeline.assetsDir);
  const videoDir = path.join(baseDir, 'video');

  try {
    const images = await loadImagePoolFromDir(videoDir);
    return images;
  } catch {
    logger.warn({ videoDir }, 'Không có ảnh video — fallback về assets root');
    return loadImagePool();
  }
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