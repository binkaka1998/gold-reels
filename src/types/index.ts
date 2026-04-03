// src/types/index.ts
export type PipelineMode = 'reels' | 'video';
export type TtsProvider = 'azure' | 'gemini';

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

export interface GeneratedScript {
    title: string;
    fullText: string;
    segments: ScriptSegment[];
    estimatedDurationSec: number;
    trend: 'uptrend' | 'downtrend';
    thumbnail: string;
}

export interface ScriptSegment {
    index: number;
    text: string;
    startMs?: number;
    endMs?: number;
}

export interface TtsResult {
    audioPath: string;
    wordTimings: WordTiming[];
    durationMs: number;
}

export interface WordTiming {
    word: string;
    startMs: number;
    durationMs: number;
}

export interface SrtCue {
    index: number;
    startMs: number;
    endMs: number;
    text: string;
}

export interface PipelineResult {
    success: boolean;
    newsIds: number[];
    facebookPostId?: string;
    videoPath?: string;
    error?: string;
    durationMs: number;
}

export interface AppConfig {
    db: { url: string };
    azure: { speechKey: string; speechRegion: string; voice: string };
    gemini: { apiKey: string; voice: string; scriptModel: string };
    ttsProvider: TtsProvider;
    facebook: { pageId: string; accessToken: string; apiVersion: string };
    pipeline: { assetsDir: string; tmpDir: string; dbAuthor: string; maxNewsPerRun: number; staleLockMinutes: number };
    reels: { maxDurationSeconds: number; width: number; height: number };
    video: { maxDurationSeconds: number; width: number; height: number };
    logLevel: string;
    web: { port: number; uploadDir: string; outputDir: string };
}