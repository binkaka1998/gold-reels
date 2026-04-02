// src/services/script-generator.ts
// Uses Claude (Anthropic) to generate TTS-ready scripts from news articles.
//
// Reels mode:  Short ~60-90s brief — punchy, direct, no filler.
// Video mode:  Deep analysis ~4-6 min — context, implications, expert framing.
//
// Both outputs are structured as segments to allow subtitle alignment.

import axios from 'axios';
import type { NewsArticle, GeneratedScript, PipelineMode } from '../types/index.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('script-generator');

// ─── Prompt templates ────────────────────────────────────────────────────────

function buildReelsPrompt(articles: NewsArticle[]): string {
  const headlines = articles
    .map((a, i) => `${i + 1}. [${a.pageCited}] ${a.headlineVi ?? a.headlineEn}`)
    .join('\n');

  const contents = articles
    .map(
      (a, i) =>
        `--- Bài ${i + 1}: ${a.headlineVi ?? a.headlineEn} ---\n${a.shortVi ?? a.shortEn ?? a.contentVi ?? a.contentEn}`
    )
    .join('\n\n');

  return `Bạn là biên tập viên tin tức tài chính chuyên nghiệp. Viết bản tin vắn cho Facebook Reels, PHẢI đọc được trong 60-80 giây.

DANH SÁCH TIN:
${headlines}

NỘI DUNG CHI TIẾT:
${contents}

YÊU CẦU BẮT BUỘC:
1. Bắt đầu bằng một câu giới thiệu hấp dẫn (hook) dưới 15 từ.
2. Tổng hợp ${articles.length} tin thành bản tin liền mạch, tự nhiên khi đọc to.
3. Mỗi tin một đoạn riêng, không dùng số thứ tự hay gạch đầu dòng.
4. Kết thúc bằng câu nhắc theo dõi ngắn gọn.
5. Tổng độ dài: 150-200 từ.
6. Ngôn ngữ: Tiếng Việt, giọng báo chí chuyên nghiệp nhưng dễ nghe.
7. KHÔNG dùng ký tự đặc biệt, ký hiệu toán học, viết tắt khó đọc.
8. Số tiền: viết bằng chữ (ví dụ: "một triệu đô la" thay vì "$1M").

Chỉ trả về văn bản script thuần túy, không có tiêu đề, không có chú thích, không có markdown.`;
}

function buildVideoPrompt(articles: NewsArticle[]): string {
  const headlines = articles
    .map((a, i) => `${i + 1}. [${a.pageCited}] ${a.headlineVi ?? a.headlineEn}`)
    .join('\n');

  const contents = articles
    .map(
      (a, i) =>
        `--- Bài ${i + 1} ---\nTiêu đề: ${a.headlineVi ?? a.headlineEn}\nNguồn: ${a.pageCited}\nNội dung: ${a.contentVi ?? a.contentEn}`
    )
    .join('\n\n');

  return `Bạn là chuyên gia phân tích tài chính và biên tập viên kỳ cựu. Viết script phân tích chuyên sâu dạng video dài, đọc được trong 4-6 phút.

DANH SÁCH TIN:
${headlines}

NỘI DUNG CHI TIẾT:
${contents}

CẤU TRÚC BẮT BUỘC (theo thứ tự):
1. PHẦN MỞ ĐẦU (30-45 giây): Hook mạnh, nêu vấn đề trọng tâm của ngày hôm nay.
2. PHẦN PHÂN TÍCH CHÍNH (3-4 phút): 
   - Đi sâu vào từng tin, giải thích bối cảnh và nguyên nhân.
   - Liên kết các tin với nhau nếu có mối quan hệ.
   - Phân tích tác động đến thị trường Việt Nam và quốc tế.
   - Đưa ra góc nhìn chuyên gia, không chỉ truyền đạt thông tin.
3. PHẦN KẾT (30-45 giây): Tổng kết, xu hướng cần theo dõi, call-to-action.

YÊU CẦU:
- Tổng độ dài: 600-800 từ.
- Ngôn ngữ Tiếng Việt, chuyên nghiệp, có chiều sâu phân tích.
- Viết liên tục, tự nhiên khi đọc to — đây là script TTS.
- KHÔNG dùng ký tự đặc biệt, bullet points, số thứ tự, hay markdown.
- Số liệu: viết đầy đủ bằng chữ khi đọc lần đầu.
- Kết thúc mỗi phần chính bằng câu chuyển tiếp mượt mà.

Chỉ trả về văn bản script thuần túy.`;
}

// ─── Segment splitter ────────────────────────────────────────────────────────
// Splits script into segments at sentence boundaries for subtitle alignment.
// Azure TTS provides per-word timing, but segment-level structure helps
// with post-processing and analytics.

function splitIntoSegments(text: string): string[] {
  // Split on sentence boundaries, preserving trailing punctuation
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function estimateDurationSeconds(text: string): number {
  // Vietnamese spoken: approximately 130-150 words/min
  const wordCount = text.split(/\s+/).length;
  return Math.ceil((wordCount / 140) * 60);
}

// ─── Main service ─────────────────────────────────────────────────────────────

export async function generateScript(
  articles: NewsArticle[],
  mode: PipelineMode
): Promise<GeneratedScript> {
  const config = getConfig();

  if (articles.length === 0) {
    throw new Error('Cannot generate script: no articles provided');
  }

  const prompt = mode === 'reels'
    ? buildReelsPrompt(articles)
    : buildVideoPrompt(articles);

  logger.info({ mode, articleCount: articles.length, model: config.gemini.scriptModel }, 'Generating script via Gemini');

  let fullText: string;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.scriptModel}:generateContent?key=${config.gemini.apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: mode === 'reels' ? 1024 : 4096,
          temperature: 0.7,
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60_000,
      }
    );

    const responseData = response.data as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };

    if (responseData?.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked prompt: ${responseData.promptFeedback.blockReason}`);
    }

    const candidate = responseData?.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const text = candidate?.content?.parts?.[0]?.text;

    logger.debug({ finishReason, textLen: text?.length }, 'Gemini script response');

    if (!text) {
      throw new Error(
        `Gemini returned no text. finishReason: ${finishReason}. ` +
        `Full: ${JSON.stringify(responseData)}`
      );
    }

    if (finishReason === 'SAFETY') {
      throw new Error(`Gemini safety filter blocked script output`);
    }

    fullText = text.trim();
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const detail = JSON.stringify(err.response?.data ?? {});
      if (status === 401 || status === 403) {
        throw new Error(
          `Gemini API ${status} Unauthorized — kiểm tra GEMINI_API_KEY trong .env. ` +
          `Lấy key tại: aistudio.google.com/app/apikey. Response: ${detail}`
        );
      }
      throw new Error(`Gemini script generation error (HTTP ${status}): ${detail}`);
    }
    throw err;
  }

  if (!fullText || fullText.length < 50) {
    throw new Error(`Script too short or empty (length: ${fullText?.length ?? 0})`);
  }

  const sentenceTexts = splitIntoSegments(fullText);
  const segments = sentenceTexts.map((text, index) => ({ index, text }));

  const estimatedDurationSec = estimateDurationSeconds(fullText);
  const title = articles[0]?.headlineVi ?? articles[0]?.headlineEn ?? 'Bản tin';

  logger.info(
    { mode, segments: segments.length, estimatedDurationSec, charCount: fullText.length },
    'Script generated successfully'
  );

  return { title, fullText, segments, estimatedDurationSec };
}
