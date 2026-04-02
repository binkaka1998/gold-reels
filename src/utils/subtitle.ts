// src/utils/subtitle.ts
// Converts per-word TTS timestamps → SRT subtitle file.
//
// This SRT is uploaded to Facebook as native captions (NOT burned into video).
// FB native captions are a separate text track — users can toggle on/off,
// and page admins can edit via Creator Studio.
//
// SRT grouping strategy:
//   - Max 8 words per cue (FB caption line length recommendation).
//   - Max 4s per cue (readability standard).
//   - Min 400ms per cue (avoids invisible flash cues).
//   - Cues are sequential with no overlap.
//   - Azure provides per-word ms precision; Gemini uses approximations.

import path from 'path';
import fs from 'fs/promises';
import type { WordTiming, SrtCue } from '../types/index.js';

const MAX_WORDS_PER_CUE = 8;
const MAX_CUE_DURATION_MS = 4_000;
const MIN_CUE_DURATION_MS = 400;

// ─── Cue builder ─────────────────────────────────────────────────────────────

export function buildCues(wordTimings: WordTiming[]): SrtCue[] {
  if (wordTimings.length === 0) return [];

  const cues: SrtCue[] = [];
  let groupStart = 0;
  let cueIndex = 1;

  while (groupStart < wordTimings.length) {
    let groupEnd = groupStart;
    const firstWord = wordTimings[groupStart]!;

    // Expand group until word limit or duration limit is hit
    while (groupEnd + 1 < wordTimings.length) {
      const next = groupEnd + 1;
      const wordCount = next - groupStart + 1;
      const potentialEnd = wordTimings[next]!;
      const potentialDuration =
        potentialEnd.startMs + potentialEnd.durationMs - firstWord.startMs;

      if (wordCount > MAX_WORDS_PER_CUE || potentialDuration > MAX_CUE_DURATION_MS) break;
      groupEnd = next;
    }

    const cueWords = wordTimings.slice(groupStart, groupEnd + 1);
    const lastWord = cueWords[cueWords.length - 1]!;

    const startMs = firstWord.startMs;
    const endMs = Math.max(
      startMs + MIN_CUE_DURATION_MS,
      lastWord.startMs + lastWord.durationMs
    );

    cues.push({
      index: cueIndex++,
      startMs,
      endMs,
      text: cueWords.map((w) => w.word).join(' '),
    });

    groupStart = groupEnd + 1;
  }

  return cues;
}

// ─── SRT formatting ───────────────────────────────────────────────────────────

function msToSrtTimestamp(ms: number): string {
  const h   = Math.floor(ms / 3_600_000);
  const m   = Math.floor((ms % 3_600_000) / 60_000);
  const s   = Math.floor((ms % 60_000) / 1_000);
  const mil = ms % 1_000;
  return (
    `${String(h).padStart(2, '0')}:` +
    `${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')},` +
    `${String(mil).padStart(3, '0')}`
  );
}

function serializeSrt(cues: SrtCue[]): string {
  return cues
    .map(
      (c) =>
        `${c.index}\n` +
        `${msToSrtTimestamp(c.startMs)} --> ${msToSrtTimestamp(c.endMs)}\n` +
        `${c.text}`
    )
    .join('\n\n')
    .concat('\n'); // SRT files should end with a newline
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates a .srt file from TTS word timings.
 * Returns the absolute path to the written file.
 *
 * This file is uploaded to Facebook as a native caption track.
 * It is NOT embedded in the video file itself.
 */
export async function generateSrtFile(
  wordTimings: WordTiming[],
  runDir: string,
  filename = 'captions.srt'
): Promise<string> {
  const cues = buildCues(wordTimings);

  if (cues.length === 0) {
    // Fallback: create a single cue with all text if timing data is missing
    // This prevents caption upload from failing entirely
    const allWords = wordTimings.map((w) => w.word).join(' ');
    const fallbackCue: SrtCue = { index: 1, startMs: 0, endMs: 5_000, text: allWords };
    const srtPath = path.join(runDir, filename);
    await fs.writeFile(srtPath, serializeSrt([fallbackCue]), 'utf-8');
    return srtPath;
  }

  const srtContent = serializeSrt(cues);
  const srtPath = path.join(runDir, filename);
  await fs.writeFile(srtPath, srtContent, 'utf-8');
  return srtPath;
}
