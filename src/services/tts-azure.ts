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
// NamMinh (vi-VN-NamMinhNeural)
//
// Azure Neural voice rate quirks:
//   - rate="100%" = medium speed (không phải "bình thường" — Azure có thể interpret khác)
//   - Dùng giá trị relative dạng "-X%" (delta từ default) thay vì absolute %
//   - Hoặc dùng keyword: "x-slow" | "slow" | "medium" | "fast" | "x-fast"
//   - "medium" = tốc độ tự nhiên nhất, không bị override
//   - Không dùng mstts:express-as style — style override prosody rate
//
// Reels: rate="slow"  — rõ ràng, không vội
// Video: rate="slow"  — trầm, có trọng lượng

function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildSsml(text: string, voice: string, mode: 'reels' | 'video'): string {
    // "slow" = khoảng 80% default — nghe tự nhiên nhất cho bản tin tài chính
    // Dùng keyword thay vì % để Azure Neural voice xử lý đúng
    const prosody = mode === 'reels'
        ? { rate: 'fast',     pitch: '-10Hz', volume: '+10%' }
        : { rate: 'fast',   pitch: '-12Hz', volume: '+8%'  };

    const parts: string[] = [];

    for (const para of text.split(/\n\n+/)) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        const sentences = trimmed
            .split(/(?<=[.!?,;])\s+/)
            .map((s) => s.trim())
            .filter(Boolean);

        for (let i = 0; i < sentences.length; i++) {
            const s        = sentences[i]!;
            const escaped  = escapeXml(s);
            const lastChar = s.slice(-1);

            let breakTag = '';
            if (i < sentences.length - 1) {
                if (lastChar === ',')             breakTag = '<break time="120ms"/>';
                else if (lastChar === ';')        breakTag = '<break time="180ms"/>';
                else if (/[.!?]/.test(lastChar)) breakTag = '<break time="250ms"/>';
            }

            parts.push(escaped + breakTag);
        }

        if (text.includes('\n\n')) {
            parts.push('<break time="350ms"/>');
        }
    }

    const body = parts.join(' ');

    // Không dùng mstts:express-as — để Azure dùng giọng neutral
    // cho phép prosody rate/pitch hoạt động đúng
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="vi-VN">
  <voice name="${voice}">
    <prosody rate="${prosody.rate}" pitch="${prosody.pitch}" volume="${prosody.volume}">
      ${body}
    </prosody>
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