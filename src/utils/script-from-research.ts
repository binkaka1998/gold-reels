// src/manual/script-from-research.ts
// Sinh script từ research context (khác với news pipeline dùng DB articles).
//
// Claude nhận: topic + research context → trả về script TTS-ready.
// Hai mode prompt:
//   reels  → 150–200 từ, hook mạnh, kết luận súc tích
//   video  → 700–900 từ, phân tích sâu có cấu trúc rõ ràng

import axios from 'axios';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('script-from-research');

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildReelsPrompt(topic: string, context: string): string {
  const contextSection = context.trim()
    ? `\nDỮ LIỆU NGHIÊN CỨU:\n${context}\n`
    : '\n(Không có dữ liệu nghiên cứu — dùng kiến thức có sẵn)\n';

  return `Bạn là biên tập viên video tài chính chuyên nghiệp. Viết script cho Facebook Reels ngắn (~75 giây).
${contextSection}
CHỦ ĐỀ: ${topic}

YÊU CẦU:
- Mở đầu bằng câu hook hấp dẫn dưới 15 từ (đặt câu hỏi hoặc nêu số liệu gây tò mò).
- Phần thân: trình bày 2–3 điểm chính từ nghiên cứu một cách cô đọng.
- Kết: một câu nhận định hoặc dự báo ngắn + nhắc follow.
- Tổng: 150–200 từ tiếng Việt.
- Viết liền mạch, tự nhiên khi đọc to — không dùng gạch đầu dòng, số thứ tự, hay ký hiệu.
- Số tiền, tỷ lệ: viết đầy đủ bằng chữ lần đầu.

Chỉ trả về văn bản script thuần túy.`;
}

function buildVideoPrompt(topic: string, context: string): string {
  const contextSection = context.trim()
    ? `\nDỮ LIỆU NGHIÊN CỨU:\n${context}\n`
    : '\n(Không có dữ liệu nghiên cứu — dùng kiến thức có sẵn)\n';

  return `Bạn là chuyên gia phân tích tài chính và biên tập viên video. Viết script phân tích chuyên sâu (~5 phút).
${contextSection}
CHỦ ĐỀ: ${topic}

CẤU TRÚC BẮT BUỘC:
1. MỞ ĐẦU (30–45 giây): Hook + đặt vấn đề + preview nội dung.
2. BỐI CẢNH (45–60 giây): Tại sao chủ đề này quan trọng ở thời điểm hiện tại.
3. PHÂN TÍCH CHÍNH (2.5–3 phút): 
   - Đi sâu các khía cạnh từ nghiên cứu.
   - Liên hệ tác động đến thị trường Việt Nam nếu liên quan.
   - Đưa ra góc nhìn phân tích, không chỉ mô tả sự kiện.
4. RỦI RO & CƠ HỘI (30–45 giây): Điều nhà đầu tư/doanh nghiệp cần lưu ý.
5. KẾT LUẬN (30 giây): Tổng kết + xu hướng cần theo dõi + call-to-action.

YÊU CẦU:
- 700–900 từ tiếng Việt.
- Viết liền mạch, tự nhiên khi đọc to.
- Dùng câu chuyển tiếp mượt mà giữa các phần.
- Không dùng gạch đầu dòng, headers, hay markdown.
- Số liệu: nêu nguồn ngắn gọn trong câu khi có thể.

Chỉ trả về văn bản script thuần túy.`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export interface GeneratedManualScript {
  fullText: string;
  estimatedDurationSec: number;
}

export async function generateScriptFromResearch(
  topic: string,
  researchContext: string,
  mode: 'reels' | 'video'
): Promise<GeneratedManualScript> {
  const config = getConfig();

  const prompt = mode === 'reels'
    ? buildReelsPrompt(topic, researchContext)
    : buildVideoPrompt(topic, researchContext);

  logger.info({ topic, mode, contextLen: researchContext.length }, 'Generating script from research');

  let data: unknown;
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.scriptModel}:generateContent?key=${config.gemini.apiKey}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: mode === 'reels' ? 600 : 2500,
          temperature: 0.7,
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 90_000,
      }
    );
    data = response.data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const body = JSON.stringify(err.response?.data ?? {});
      if (status === 401 || status === 403) {
        throw new Error(
          `Gemini API ${status} Unauthorized — kiểm tra GEMINI_API_KEY trong .env. ` +
          `Lấy key tại: aistudio.google.com/app/apikey. Response: ${body}`
        );
      }
      throw new Error(`Gemini script generation error HTTP ${status}: ${body}`);
    }
    throw err;
  }

  const responseData = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text?.trim()) {
    throw new Error(`Gemini returned empty script: ${JSON.stringify(data)}`);
  }

  const fullText = text.trim();

  if (fullText.length < 80) {
    throw new Error(`Script too short (${fullText.length} chars) — check topic/context`);
  }

  // Vietnamese: ~140 words/min
  const wordCount = fullText.split(/\s+/).length;
  const estimatedDurationSec = Math.ceil((wordCount / 140) * 60);

  logger.info({ wordCount, estimatedDurationSec }, 'Script generated');

  return { fullText, estimatedDurationSec };
}
