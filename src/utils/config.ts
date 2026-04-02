// src/utils/config.ts
import { z } from 'zod';
import type { AppConfig } from '../types/index.js';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  AZURE_SPEECH_KEY:   z.string().min(1, 'AZURE_SPEECH_KEY is required'),
  AZURE_SPEECH_REGION: z.string().default('southeastasia'),
  AZURE_TTS_VOICE:    z.string().default('vi-VN-NamMinhNeural'),

  GEMINI_API_KEY:      z.string().min(1, 'GEMINI_API_KEY is required'),
  GEMINI_TTS_VOICE:    z.string().default('Charon'),
  GEMINI_SCRIPT_MODEL: z.string().default('gemini-2.5-flash'),

  TTS_PROVIDER: z.enum(['azure', 'gemini']).default('azure'),

  FACEBOOK_PAGE_ID:      z.string().min(1, 'FACEBOOK_PAGE_ID is required'),
  FACEBOOK_ACCESS_TOKEN: z.string().min(1, 'FACEBOOK_ACCESS_TOKEN is required'),
  FACEBOOK_API_VERSION:  z.string().default('v21.0'),

  ASSETS_DIR:          z.string().default('./assets'),
  TMP_DIR:             z.string().default('./tmp'),
  MAX_NEWS_PER_RUN:    z.coerce.number().int().positive().default(5),
  STALE_LOCK_MINUTES:  z.coerce.number().int().positive().default(30),
  LOG_LEVEL:           z.string().default('info'),

  REELS_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(90),
  REELS_VIDEO_WIDTH:          z.coerce.number().int().positive().default(1080),
  REELS_VIDEO_HEIGHT:         z.coerce.number().int().positive().default(1920),

  VIDEO_MAX_DURATION_SECONDS: z.coerce.number().int().positive().default(180),
  VIDEO_WIDTH:                z.coerce.number().int().positive().default(1920),
  VIDEO_HEIGHT:               z.coerce.number().int().positive().default(1080),

  WEB_PORT:       z.coerce.number().int().positive().default(3456),
  WEB_UPLOAD_DIR: z.string().default('./outputs/uploads'),
  WEB_OUTPUT_DIR: z.string().default('./outputs/manual'),
});

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.errors.map((e) => `  [${e.path.join('.')}] ${e.message}`).join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }
  const env = parsed.data;
  return {
    db:  { url: env.DATABASE_URL },
    azure: { speechKey: env.AZURE_SPEECH_KEY, speechRegion: env.AZURE_SPEECH_REGION, voice: env.AZURE_TTS_VOICE },
    gemini: { apiKey: env.GEMINI_API_KEY, voice: env.GEMINI_TTS_VOICE, scriptModel: env.GEMINI_SCRIPT_MODEL },
    ttsProvider: env.TTS_PROVIDER,
    facebook: { pageId: env.FACEBOOK_PAGE_ID, accessToken: env.FACEBOOK_ACCESS_TOKEN, apiVersion: env.FACEBOOK_API_VERSION },
    pipeline: { assetsDir: env.ASSETS_DIR, tmpDir: env.TMP_DIR, maxNewsPerRun: env.MAX_NEWS_PER_RUN, staleLockMinutes: env.STALE_LOCK_MINUTES },
    reels: { maxDurationSeconds: env.REELS_MAX_DURATION_SECONDS, width: env.REELS_VIDEO_WIDTH, height: env.REELS_VIDEO_HEIGHT },
    video: { maxDurationSeconds: env.VIDEO_MAX_DURATION_SECONDS, width: env.VIDEO_WIDTH, height: env.VIDEO_HEIGHT },
    logLevel: env.LOG_LEVEL,
    web: { port: env.WEB_PORT, uploadDir: env.WEB_UPLOAD_DIR, outputDir: env.WEB_OUTPUT_DIR },
  };
}

let _config: AppConfig | null = null;
export function getConfig(): AppConfig {
  if (!_config) _config = loadConfig();
  return _config;
}