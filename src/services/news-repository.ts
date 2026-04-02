// src/services/news-repository.ts
// Data access layer for news articles with idempotent processing locks.
//
// Locking strategy (same as your existing social post pipeline):
//   1. SELECT articles WHERE socialEnabled=true AND postedFacebook=false
//      AND socialProcessing=false AND socialError IS NULL
//   2. Atomic UPDATE SET socialProcessing=true, socialProcessingAt=NOW()
//      WHERE socialProcessing=false (prevents race with concurrent cron runs)
//   3. After success: SET postedFacebook=true, facebookPostId=...
//   4. After failure: SET socialError=..., socialRetryCount++
//   5. Stale lock cleanup: reset socialProcessing=false
//      WHERE socialProcessingAt < NOW() - STALE_LOCK_MINUTES

import { PrismaClient } from '@prisma/client';
import type { NewsArticle } from '../types/index.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('news-repository');

// ─── Prisma singleton ─────────────────────────────────────────────────────────
// Don't create multiple instances in prod — Prisma manages its own connection pool.

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });

    _prisma.$on('warn' as never, (e: { message: string }) => {
      logger.warn({ msg: e.message }, 'Prisma warning');
    });

    _prisma.$on('error' as never, (e: { message: string }) => {
      logger.error({ msg: e.message }, 'Prisma error');
    });
  }
  return _prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

// ─── Stale lock cleanup ───────────────────────────────────────────────────────

export async function cleanStaleLocks(): Promise<number> {
  const config = getConfig();
  const cutoff = new Date(Date.now() - config.pipeline.staleLockMinutes * 60 * 1000);
  const prisma = getPrisma();

  const { count } = await prisma.news.updateMany({
    where: {
      socialProcessing: true,
      socialProcessingAt: { lt: cutoff },
    },
    data: {
      socialProcessing: false,
      socialError: 'Stale lock reset',
    },
  });

  if (count > 0) {
    logger.warn({ count, cutoffMinutes: config.pipeline.staleLockMinutes }, 'Reset stale locks');
  }

  return count;
}

// ─── Acquire processing lock ──────────────────────────────────────────────────

/**
 * Atomically selects and locks N articles for video processing.
 * Returns only articles that were successfully locked by THIS process.
 * Handles concurrent cron runs safely — only one process gets each article.
 */
export async function acquireArticlesForVideoProcessing(
  limit: number,
  mode: 'reels' | 'video'
): Promise<NewsArticle[]> {
  const prisma = getPrisma();

  // Step 1: Find candidates (read — no lock yet)
  const candidates = await prisma.news.findMany({
    where: {
      socialEnabled: true,
      active: true,
      postedFacebook: false,
      socialProcessing: false,
      // Only retry if under threshold
      socialRetryCount: { lt: 3 },
      socialError: null,
    },
    orderBy: [
      { featured: 'desc' },
      { publishedAt: 'desc' },
    ],
    take: limit * 2, // Fetch extra — some may lose the atomic lock race
    select: {
      id: true,
      headlineVi: true,
      headlineEn: true,
      shortVi: true,
      shortEn: true,
      contentVi: true,
      contentEn: true,
      pageCited: true,
      category: true,
      publishedAt: true,
    },
  });

  if (candidates.length === 0) {
    logger.info({ mode }, 'No articles available for video processing');
    return [];
  }

  // Step 2: Atomic lock — only update WHERE socialProcessing = false
  // This WHERE clause is the critical race-condition guard.
  const lockedIds: number[] = [];

  for (const candidate of candidates) {
    if (lockedIds.length >= limit) break;

    const result = await prisma.news.updateMany({
      where: {
        id: candidate.id,
        socialProcessing: false, // ATOMIC CHECK: must still be false
        postedFacebook: false,   // Re-check: not posted by a concurrent run
      },
      data: {
        socialProcessing: true,
        socialProcessingAt: new Date(),
      },
    });

    if (result.count === 1) {
      lockedIds.push(candidate.id);
    } else {
      logger.debug({ articleId: candidate.id }, 'Article lock lost to concurrent process');
    }
  }

  if (lockedIds.length === 0) {
    logger.info({ mode }, 'No articles locked — all taken by concurrent processes');
    return [];
  }

  // Step 3: Fetch full data for locked articles
  const locked = await prisma.news.findMany({
    where: { id: { in: lockedIds } },
    select: {
      id: true,
      headlineVi: true,
      headlineEn: true,
      shortVi: true,
      shortEn: true,
      contentVi: true,
      contentEn: true,
      pageCited: true,
      category: true,
      publishedAt: true,
    },
  });

  logger.info({ lockedCount: locked.length, mode }, 'Articles locked for video processing');
  return locked as NewsArticle[];
}

// ─── Mark success ─────────────────────────────────────────────────────────────

export async function markVideoPostSuccess(
  articleIds: number[],
  facebookPostId: string
): Promise<void> {
  const prisma = getPrisma();

  await prisma.news.updateMany({
    where: { id: { in: articleIds } },
    data: {
      postedFacebook: true,
      facebookPostId,
      socialProcessing: false,
      socialPostedAt: new Date(),
      socialError: null,
    },
  });

  logger.info({ articleIds, facebookPostId }, 'Marked articles as video-posted');
}

// ─── Mark failure ─────────────────────────────────────────────────────────────

export async function markVideoPostFailure(
  articleIds: number[],
  error: string
): Promise<void> {
  const prisma = getPrisma();

  // Truncate error to prevent DB overflow
  const truncatedError = error.slice(0, 2000);

  await prisma.news.updateMany({
    where: { id: { in: articleIds } },
    data: {
      socialProcessing: false,
      socialError: truncatedError,
      // Prisma doesn't support atomic increment in updateMany, so we do it per-record
    },
  });

  // Increment retry counter individually
  for (const id of articleIds) {
    await prisma.news.update({
      where: { id },
      data: { socialRetryCount: { increment: 1 } },
    });
  }

  logger.error({ articleIds, error: truncatedError }, 'Marked articles as video-post failed');
}

// ─── Release lock without marking failure ────────────────────────────────────
// Used when the pipeline is aborted cleanly (e.g. SIGTERM during shutdown)

export async function releaseVideoProcessingLock(articleIds: number[]): Promise<void> {
  const prisma = getPrisma();

  await prisma.news.updateMany({
    where: { id: { in: articleIds } },
    data: {
      socialProcessing: false,
      socialProcessingAt: null,
    },
  });

  logger.info({ articleIds }, 'Released processing locks');
}

// ─── Fetch latest articles by author (for manual DB source) ──────────────────

export interface DbSourceArticle {
  id: number;
  headlineVi: string | null;
  headlineEn: string;
  contentEn: string;
  contentVi: string | null;
  publishedAt: Date | null;
}

export async function fetchLatestByAuthor(
  author: string,
  limit = 1
): Promise<DbSourceArticle[]> {
  const prisma = getPrisma();

  const rows = await prisma.news.findMany({
    where: {
      author,
      active: true,
    },
    orderBy: { publishedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      headlineVi: true,
      headlineEn: true,
      contentEn: true,
      contentVi: true,
      publishedAt: true,
    },
  });

  if (rows.length === 0) {
    throw new Error(
      `Không tìm thấy bài nào của author "${author}" trong DB (active=true). ` +
      `Kiểm tra lại field author hoặc thêm bài có active=true.`
    );
  }

  logger.info({ author, found: rows.length }, 'Fetched articles from DB by author');
  return rows as DbSourceArticle[];
}
