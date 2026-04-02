// src/types/index.ts
// Central type definitions for the video pipeline

export type PipelineMode = 'reels' | 'video';
export type TtsProvider = 'azure' | 'gemini';

// ─── News article from DB ────────────────────────────────────────────────────
export interface NewsArticle {
  id: number;
  headlineVi: string | null;
  headlineEn: string;
  shortVi: string | null;
  shortEn: string | null;
  contentVi: string | null;
  contentEn: string;
  pageCited: string;
  category: string;
  publishedAt: Date | null;
}

// ─── Generated script structure ─────────────────────────────────────────────
export interface GeneratedScript {
  title: string;
  fullText: string;           // Complete TTS text
  segments: ScriptSegment[];  // For subtitle timing alignment
  estimatedDurationSec: number;
}

export interface ScriptSegment {
  index: number;
  text: string;
  // Populated after TTS synthesis with Azure word-boundary events
  startMs?: number;
  endMs?: number;
}

// ─── TTS output ─────────────────────────────────────────────────────────────
export interface TtsResult {
  audioPath: string;           // Path to .wav or .mp3 file
  wordTimings: WordTiming[];   // Per-word timestamps from Azure
  durationMs: number;
}

export interface WordTiming {
  word: string;
  startMs: number;
  durationMs: number;
}

// ─── SRT subtitle ────────────────────────────────────────────────────────────
export interface SrtCue {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

// ─── Pipeline result ─────────────────────────────────────────────────────────
export interface PipelineResult {
  success: boolean;
  newsIds: number[];
  facebookPostId?: string;
  videoPath?: string;
  error?: string;
  durationMs: number;
}

// ─── Config (validated from env) ────────────────────────────────────────────
export interface AppConfig {
  db: { url: string };
  azure: {
    speechKey: string;
    speechRegion: string;
    voice: string;
  };
  gemini: {
    apiKey: string;
    voice: string;
    scriptModel: string;
  };
  ttsProvider: TtsProvider;
  anthropic: {
    apiKey: string;
    model: string;
  };
  facebook: {
    pageId: string;
    accessToken: string;
    apiVersion: string;
  };
  pipeline: {
    assetsDir: string;
    tmpDir: string;
    maxNewsPerRun: number;
    staleLockMinutes: number;
  };
  reels: {
    maxDurationSeconds: number;
    width: number;
    height: number;
  };
  video: {
    maxDurationSeconds: number;
    width: number;
    height: number;
  };
  logLevel: string;
  web: {
    port: number;
    uploadDir: string;
    outputDir: string;
  };
  serper: {
    apiKey: string;
  };
}
