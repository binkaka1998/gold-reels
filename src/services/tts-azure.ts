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
// Mục tiêu: giọng MC bản tin tài chính — rõ ràng, có nhịp, không AI quá mức.
//
// NamMinh (vi-VN-NamMinhNeural) characteristics:
//   - Giọng nam miền Nam, tự nhiên
//   - Dễ bị nghe "đều đều AI" nếu rate quá nhanh hoặc pitch không đổi
//   - Cần rate vừa phải + pitch hơi thấp + break ở dấu câu để có cảm giác "đọc tin"
//
// Reels (~75s): rate +12%, pitch -4% — nhanh có kiểm soát như MC thời sự buổi sáng
// Video (~5p): rate +5%, pitch -5% — chậm hơn, trầm hơn cho phân tích chuyên sâu

function insertBreaks(text: string): string {
  // Thêm break ngắn sau dấu phẩy, chấm phẩy để tạo nhịp thở tự nhiên
  // Không thêm sau dấu chấm vì Azure tự xử lý pause ở cuối câu
  return text
      .replace(/,\s+/g, ', <break time="150ms"/> ')
      .replace(/;\s+/g, '; <break time="200ms"/> ')
      .replace(/\.\s+([A-ZÁÀẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬĐÉÈẺẼẸÊẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÚÙỦŨỤƯỨỪỬỮỰÝ])/g,
          '. <break time="300ms"/> $1');
}

function buildSsml(text: string, voice: string, mode: 'reels' | 'video'): string {
  const prosody =
      mode === 'reels'
          ? { rate: '+12%', pitch: '-4%', volume: '+8%' }   // Nhanh, rõ, hơi trầm — bản tin vắn
          : { rate: '+5%',  pitch: '-5%', volume: '+6%' };  // Vừa phải, trầm — phân tích sâu

  // Sanitize XML special characters
  const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

  // Thêm break sau khi sanitize (break tags cần ở dạng XML thuần)
  const withBreaks = insertBreaks(escaped);

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="vi-VN">
  <voice name="${voice}">
    <prosody rate="${prosody.rate}" pitch="${prosody.pitch}" volume="${prosody.volume}">
      ${withBreaks}
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