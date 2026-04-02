// src/services/tts-azure.ts
// Azure Cognitive Services TTS with per-word boundary events.
//
// Word boundary events give us exact timestamps (start_ms, duration_ms) per word.
// These feed directly into subtitle.ts to generate perfectly synced SRT cues.
//
// Audio output: WAV PCM 24kHz mono (best quality for FFmpeg input).
// SSML: controls prosody (rate/pitch) per mode to match content pacing.
//
// Azure rate limits:
//   F0 (free): 0.5M chars/month, 20 req/min
//   S0 (standard): pay-per-char, 200 req/min
//   Each Reels script ≈ 150–250 chars; Video ≈ 600–1000 chars.

import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import type { TtsResult, WordTiming } from '../types/index.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('tts-azure');

// ─── SSML builder ─────────────────────────────────────────────────────────────
//
// NamMinh (vi-VN-NamMinhNeural):
//   - Giọng nam miền Nam, neutral style
//   - rate: dùng số tuyệt đối (medium=100%) thay vì % delta để ổn định hơn
//   - pitch: Hz thay vì % — chính xác hơn, ít bị AI-sounding
//   - "mất chữ" trước đây do insertBreaks chạy SAU escape → <break> bị escape thành text
//     Fix: tách text thành segments, escape từng segment, join với break tags
//
// Reels: rate 115%, pitch -8Hz — MC bản tin buổi sáng, nhanh rõ
// Video: rate 105%, pitch -10Hz — chuyên gia phân tích, trầm chắc

function escapeXml(text: string): string {
  return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
}

function buildSsml(text: string, voice: string, mode: 'reels' | 'video'): string {
  const prosody = mode === 'reels'
      ? { rate: '115%',  pitch: '-8Hz',  volume: '+8%' }
      : { rate: '105%',  pitch: '-10Hz', volume: '+6%' };

  // Split text thành segments tại dấu câu TRƯỚC KHI escape
  // Sau đó escape từng segment rồi join với <break> tags
  // → tránh <break> bị escape thành &lt;break&gt;
  const segments = text
      .split(/([,;。]|\.\s|\!\s|\?\s)/)
      .reduce<string[]>((acc, part) => {
        if (!part.trim()) return acc;
        // Nếu là dấu câu → gắn vào segment trước
        if (/^[,;。]$/.test(part) || /^[.!?]\s$/.test(part)) {
          if (acc.length > 0) acc[acc.length - 1] += part.trim();
        } else {
          acc.push(part);
        }
        return acc;
      }, []);

  const ssmlParts = segments.map((seg, i) => {
    const escaped = escapeXml(seg.trim());
    if (!escaped) return '';

    // Xác định loại break dựa vào ký tự kết thúc của segment
    const lastChar = seg.trimEnd().slice(-1);
    const breakAfter = (i < segments.length - 1)
        ? (lastChar === ',' ? '<break time="150ms"/>'
            : lastChar === ';' ? '<break time="200ms"/>'
                : /[.!?。]/.test(lastChar) ? '<break time="280ms"/>'
                    : '')
        : '';

    return escaped + breakAfter;
  });

  const body = ssmlParts.filter(Boolean).join(' ');

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="vi-VN">
  <voice name="${voice}">
    <mstts:express-as style="newscast">
      <prosody rate="${prosody.rate}" pitch="${prosody.pitch}" volume="${prosody.volume}">
        ${body}
      </prosody>
    </mstts:express-as>
  </voice>
</speak>`;
}

// ─── Synthesizer ──────────────────────────────────────────────────────────────

export async function synthesizeAzure(
    text: string,
    outputPath: string,
    mode: 'reels' | 'video'
): Promise<TtsResult> {
  const config = getConfig();
  const { speechKey, speechRegion, voice } = config.azure;

  logger.info({ voice, region: speechRegion, charCount: text.length, mode }, 'Azure TTS start');

  return new Promise<TtsResult>((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);

    // WAV 24kHz mono PCM — best quality, no lossy encoding artifacts
    speechConfig.speechSynthesisOutputFormat =
        sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;

    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(outputPath);
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    const wordTimings: WordTiming[] = [];

    // WordBoundary events: fired per word (and per punctuation, which we filter out)
    // Azure timestamps are in 100-nanosecond "ticks" — divide by 10,000 for ms.
    synthesizer.wordBoundary = (
        _s: sdk.SpeechSynthesizer,
        e: sdk.SpeechSynthesisWordBoundaryEventArgs
    ) => {
      if (e.boundaryType === sdk.SpeechSynthesisBoundaryType.Word) {
        wordTimings.push({
          word: e.text,
          startMs: Math.round(e.audioOffset / 10_000),
          durationMs: Math.round(e.duration / 10_000),
        });
      }
    };

    const ssml = buildSsml(text, voice, mode);

    synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          synthesizer.close();

          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            const durationMs = Math.round(result.audioDuration / 10_000);
            logger.info({ durationMs, wordCount: wordTimings.length, outputPath }, 'Azure TTS complete');
            resolve({ audioPath: outputPath, wordTimings, durationMs });
          } else {
            const details = sdk.CancellationDetails.fromResult(result);
            reject(new Error(`Azure TTS cancelled: ${details.reason} — ${details.errorDetails ?? 'no detail'}`));
          }
        },
        (err) => {
          synthesizer.close();
          reject(new Error(`Azure TTS error: ${err}`));
        }
    );
  });
}