// src/services/tts-gemini.ts
// Google Gemini TTS (gemini-2.5-flash-preview-tts) as alternative provider.
//
// Tradeoff vs Azure:
// - Gemini does NOT provide per-word timestamps natively.
// - We use forced-alignment approximation based on character ratios.
// - Subtitle sync will be less precise than Azure (~sentence-level vs word-level).
// - Use Azure for production; use Gemini when Azure quota is exhausted.
//
// Gemini returns raw audio bytes (PCM or MP3 depending on config).

import fs from 'fs/promises';
import axios from 'axios';
import type { TtsResult, WordTiming } from '../types/index.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('tts-gemini');

const GEMINI_TTS_API =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent';

// ─── Approximate word timings from text ──────────────────────────────────────
// Without real timestamps, we distribute duration proportionally across words.
// This gives subtitle sync accurate to ±0.5s — acceptable for fallback mode.

function approximateWordTimings(text: string, totalDurationMs: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // Weight each word by character length (longer words take more time)
  const charCounts = words.map((w) => w.length);
  const totalChars = charCounts.reduce((a, b) => a + b, 0);

  let currentMs = 0;
  return words.map((word, i) => {
    const proportion = (charCounts[i] ?? 1) / totalChars;
    const durationMs = Math.round(proportion * totalDurationMs);
    const timing: WordTiming = { word, startMs: currentMs, durationMs };
    currentMs += durationMs;
    return timing;
  });
}

// ─── Main synthesizer ────────────────────────────────────────────────────────

export async function synthesizeGemini(
  text: string,
  outputPath: string,
  _mode: 'reels' | 'video'
): Promise<TtsResult> {
  const config = getConfig();
  const { apiKey, voice } = config.gemini;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  logger.info(
    { voice, charCount: text.length },
    'Starting Gemini TTS synthesis'
  );

  let response: { data: unknown };
  try {
    response = await axios.post(
      `${GEMINI_TTS_API}?key=${apiKey}`,
      {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120_000,
      }
    );
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const detail = JSON.stringify(err.response?.data ?? {});
      if (status === 401 || status === 403) {
        throw new Error(
          `Gemini TTS API ${status} — kiểm tra GEMINI_API_KEY trong .env. Response: ${detail}`
        );
      }
      throw new Error(`Gemini TTS API error (HTTP ${status}): ${detail}`);
    }
    throw err;
  }

  // Extract base64 audio from response
  const data = response.data as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
    }>;
  };

  const inlineData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inlineData?.data) {
    throw new Error('Gemini TTS: no audio data in response');
  }

  const audioBuffer = Buffer.from(inlineData.data, 'base64');
  const mimeType = inlineData.mimeType ?? 'audio/L16';

  // Gemini may return raw L16 PCM (no header) or MP3 depending on model/config.
  // FFmpeg/ffprobe requires a proper container — wrap raw PCM in a WAV header.
  // MP3 already has headers; write it as-is but rename outputPath to .mp3.
  const isRawPcm = mimeType.includes('L16') || mimeType.includes('pcm');

  let finalAudioPath = outputPath;
  const sampleRate = 24_000;
  const channels = 1;
  const bytesPerSample = 2; // L16 = 16-bit

  if (isRawPcm) {
    // Build a minimal 44-byte WAV header and prepend it to the PCM data.
    // This allows ffprobe and FFmpeg to correctly read the file.
    const dataSize = audioBuffer.length;
    const header = Buffer.alloc(44);
    // RIFF chunk
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);     // chunk size
    header.write('WAVE', 8);
    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);               // sub-chunk size (PCM = 16)
    header.writeUInt16LE(1, 20);               // audio format: PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
    header.writeUInt16LE(channels * bytesPerSample, 32);              // block align
    header.writeUInt16LE(bytesPerSample * 8, 34);                     // bits per sample
    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    await fs.writeFile(finalAudioPath, Buffer.concat([header, audioBuffer]));
  } else {
    // MP3 or other container — write directly, adjust extension
    finalAudioPath = outputPath.replace(/\.\w+$/, '.mp3');
    await fs.writeFile(finalAudioPath, audioBuffer);
  }

  const durationMs = Math.round(
    (audioBuffer.length / (sampleRate * bytesPerSample * channels)) * 1000
  );

  const wordTimings = approximateWordTimings(text, durationMs);

  logger.info(
    { durationMs, wordCount: wordTimings.length, outputPath: finalAudioPath, mimeType },
    'Gemini TTS synthesis complete (approximate timings)'
  );

  return {
    audioPath: finalAudioPath,
    wordTimings,
    durationMs,
  };
}
