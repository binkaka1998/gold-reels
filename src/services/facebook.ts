// src/services/facebook.ts
// Facebook Graph API — 2 flow riêng biệt:
//
// REELS (3 bước bắt buộc theo docs):
//   1. POST /{page_id}/video_reels  upload_phase=start  → upload_url
//   2. POST {upload_url}            binary upload       → (no response body)
//   3. POST /{page_id}/video_reels  upload_phase=finish → video_id, post_id
//
// VIDEO (resumable chunks):
//   1. POST /{page_id}/videos  upload_phase=start    → session_id
//   2. POST /{page_id}/videos  upload_phase=transfer → chunks
//   3. POST /{page_id}/videos  upload_phase=finish   → video_id

import { createReadStream } from 'fs';
import FormData from 'form-data';
import axios, { type AxiosInstance } from 'axios';
import type { PipelineMode } from '../types/index.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';
import { getFileSizeBytes } from '../utils/filesystem.js';

const logger = getLogger('facebook');

const UPLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const CHUNK_SIZE        = 200 * 1024 * 1024; // 200 MB
const MAX_RETRIES       = 3;
const RETRY_BASE_MS     = 5_000;

export interface FacebookPublishOptions {
  videoPath:   string;
  title:       string;
  description: string;
  mode:        PipelineMode;
}

export interface FacebookPublishResult {
  postId:    string;
  videoId:   string;
  permalink: string;
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

function buildClient(): AxiosInstance {
  const { facebook } = getConfig();
  return axios.create({
    baseURL: `https://graph.facebook.com/${facebook.apiVersion}`,
    timeout: UPLOAD_TIMEOUT_MS,
    headers: { 'User-Agent': 'NewsVideoPipeline/1.0' },
  });
}

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * attempt;
        logger.warn({ label, attempt, delay, err: lastErr.message }, 'Retrying');
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`${label} failed after ${MAX_RETRIES} attempts: ${lastErr?.message}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// REELS FLOW
// Docs: https://developers.facebook.com/docs/video-api/reels-publishing-api
// ══════════════════════════════════════════════════════════════════════════════

export async function reelsInitSession(
    client: AxiosInstance,
    pageId: string,
    token: string,
    fileSize: number,
): Promise<{ uploadUrl: string; videoId: string }> {
  const { data } = await withRetry(
      () => client.post(`/${pageId}/video_reels`, null, {
        params: { upload_phase: 'start', file_size: fileSize, access_token: token },
      }),
      'Reels init session'
  );

  if (!data.upload_url || !data.video_id) {
    throw new Error(`Reels init failed: ${JSON.stringify(data)}`);
  }

  logger.info({ videoId: data.video_id }, 'Reels session started');
  return { uploadUrl: data.upload_url as string, videoId: data.video_id as string };
}

export async function reelsUploadVideo(
    uploadUrl: string,
    videoPath: string,
    fileSize: number,
    token: string,
): Promise<void> {
  const fileStream = createReadStream(videoPath);

  await withRetry(
      () => axios.post(uploadUrl, fileStream, {
        headers: {
          'Content-Type':    'application/octet-stream',
          'Offset':          '0',
          'X-Entity-Length': fileSize.toString(),
          'Content-Length':  fileSize.toString(),
          'Authorization':   `Bearer ${token}`,
        },
        maxBodyLength:    Infinity,
        maxContentLength: Infinity,
        timeout:          UPLOAD_TIMEOUT_MS,
      }),
      'Reels binary upload'
  );

  logger.info({ fileSizeMB: (fileSize / 1_048_576).toFixed(1) }, 'Reels video uploaded');
}

export async function reelsPublish(
    client: AxiosInstance,
    pageId: string,
    token: string,
    videoId: string,
    title: string,
    description: string,
): Promise<{ postId: string; videoId: string }> {
  const { data } = await withRetry(
      () => client.post(`/${pageId}/video_reels`, null, {
        params: {
          upload_phase: 'finish',
          video_id:     videoId,
          video_state:  'PUBLISHED',
          published:    true,
          title:        title.slice(0, 255),
          description:  description.slice(0, 2200),
          access_token: token,
        },
      }),
      'Reels publish'
  );

  logger.info({ data }, 'Reels publish response');

  const rawPostId = (data.post_id ?? data.id ?? videoId) as string;
  return { postId: String(rawPostId), videoId };
}

// ══════════════════════════════════════════════════════════════════════════════
// VIDEO FLOW (resumable chunks)
// ══════════════════════════════════════════════════════════════════════════════

async function videoInitSession(
    client: AxiosInstance,
    pageId: string,
    token: string,
    fileSize: number,
): Promise<{ sessionId: string }> {
  const { data } = await withRetry(
      () => client.post(`/${pageId}/videos`, null, {
        params: { upload_phase: 'start', file_size: fileSize, access_token: token },
      }),
      'Video init session'
  );

  if (!data.upload_session_id) {
    throw new Error(`Video session init failed: ${JSON.stringify(data)}`);
  }

  return { sessionId: data.upload_session_id as string };
}

async function videoUploadChunks(
    client: AxiosInstance,
    pageId: string,
    token: string,
    sessionId: string,
    videoPath: string,
    fileSize: number,
): Promise<void> {
  let offset = 0;

  while (offset < fileSize) {
    const end = Math.min(offset + CHUNK_SIZE, fileSize);

    const form = new FormData();
    form.append('upload_phase',      'transfer');
    form.append('upload_session_id', sessionId);
    form.append('start_offset',      String(offset));
    form.append('access_token',      token);
    form.append('video_file_chunk',
        createReadStream(videoPath, { start: offset, end: end - 1 }), {
          filename:    'video.mp4',
          contentType: 'video/mp4',
          knownLength: end - offset,
        }
    );

    const { data } = await withRetry(
        () => client.post(`/${pageId}/videos`, form, { headers: form.getHeaders() }),
        `Video chunk @ offset ${offset}`
    );

    const nextOffset = Number(data.start_offset ?? end);
    if (nextOffset <= offset) throw new Error(`Upload stalled at offset ${offset}`);

    logger.debug({ pct: Math.round((nextOffset / fileSize) * 100) }, 'Chunk done');
    offset = nextOffset;
  }
}

async function videoPublish(
    client: AxiosInstance,
    pageId: string,
    token: string,
    sessionId: string,
    title: string,
    description: string,
): Promise<{ postId: string; videoId: string }> {
  const { data } = await withRetry(
      () => client.post(`/${pageId}/videos`, null, {
        params: {
          upload_phase:      'finish',
          upload_session_id: sessionId,
          title:             title.slice(0, 255),
          description:       description.slice(0, 2200),
          access_token:      token,
        },
      }),
      'Video publish'
  );

  const rawVideoId = (data.id ?? data.video_id) as string | undefined;
  if (!rawVideoId) {
    throw new Error(`Video publish returned no ID: ${JSON.stringify(data)}`);
  }

  return { postId: String(rawVideoId), videoId: String(rawVideoId) };
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════════

export async function publishToFacebook(
    options: FacebookPublishOptions
): Promise<FacebookPublishResult> {
  const config = getConfig();
  const { pageId, accessToken: token } = config.facebook;
  const { videoPath, title, description, mode } = options;

  const fileSize = await getFileSizeBytes(videoPath);
  if (fileSize < 1024) {
    throw new Error(`Video missing or empty: ${videoPath} (${fileSize} B)`);
  }

  logger.info({ mode, fileSizeMB: (fileSize / 1_048_576).toFixed(1) }, 'Starting Facebook publish');

  const client = buildClient();
  let postId: string;
  let videoId: string;

  if (mode === 'reels') {
    logger.info('Reels flow: start → upload → publish');
    const session = await reelsInitSession(client, pageId, token, fileSize);
    await reelsUploadVideo(session.uploadUrl, videoPath, fileSize, token);
    ({ postId, videoId } = await reelsPublish(client, pageId, token, session.videoId, title, description));
  } else {
    logger.info('Video flow: start → chunks → publish');
    const session = await videoInitSession(client, pageId, token, fileSize);
    logger.info({ sessionId: session.sessionId }, 'Video session initialized');
    await videoUploadChunks(client, pageId, token, session.sessionId, videoPath, fileSize);
    logger.info('Video chunks fully uploaded');
    ({ postId, videoId } = await videoPublish(client, pageId, token, session.sessionId, title, description));
  }

  logger.info({ postId, videoId, mode }, 'Published successfully');

  const permalink = `https://www.facebook.com/${pageId}/videos/${videoId}`;
  return { postId, videoId, permalink };
}