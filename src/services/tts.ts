// src/services/tts.ts
// Provider-agnostic TTS facade.
// Routes to Azure or Gemini based on config, with automatic fallback.

import path from 'path';
import type { TtsResult, PipelineMode } from '../types/index.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';
import { synthesizeAzure } from './tts-azure.js';
import { synthesizeGemini } from './tts-gemini.js';

const logger = getLogger('tts');

export async function synthesizeSpeech(
  text: string,
  runDir: string,
  mode: PipelineMode,
  filename = 'audio.wav'
): Promise<TtsResult> {
  const config = getConfig();
  const outputPath = path.join(runDir, filename);
  const provider = config.ttsProvider;

  logger.info({ provider, mode, outputPath }, 'Starting TTS synthesis');

  if (provider === 'azure') {
    try {
      return await synthesizeAzure(text, outputPath, mode);
    } catch (err) {
      logger.warn(
        { err, fallback: 'gemini' },
        'Azure TTS failed, attempting Gemini fallback'
      );
      return await synthesizeGemini(text, outputPath, mode);
    }
  }

  if (provider === 'gemini') {
    try {
      return await synthesizeGemini(text, outputPath, mode);
    } catch (err) {
      logger.warn(
        { err, fallback: 'azure' },
        'Gemini TTS failed, attempting Azure fallback'
      );
      return await synthesizeAzure(text, outputPath, mode);
    }
  }

  throw new Error(`Unknown TTS provider: ${provider as string}`);
}
