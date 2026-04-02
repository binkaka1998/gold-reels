// src/manual/script-from-research.ts
// Sinh script + trend từ content DB bằng Google GenAI SDK.
//
// Gemini trả về JSON: { trend: "uptrend"|"downtrend", script: "..." }
// trend dùng để chọn folder ảnh nền:
//   uptrend   → assets/images/up/
//   downtrend → assets/images/down/

import { GoogleGenAI } from '@google/genai';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('script-generator-manual');

export type TrendDirection = 'uptrend' | 'downtrend';

export interface GeneratedManualScript {
  fullText: string;
  estimatedDurationSec: number;
  trend: TrendDirection;
}

const CLOSING = 'Hãy theo dõi page Giá Vàng 24 News để có các tin tức cập nhật về giá vàng mới nhất nhé. Cảm ơn các bạn!';

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildReelsPrompt(content: string): string {
  return `Bạn là MC bản tin tài chính của kênh Giá Vàng 24 News. Nhiệm vụ: đọc bản tin vắn về giá vàng hôm nay dựa trên nội dung bên dưới.

NỘI DUNG GỐC:
${content}

PHONG CÁCH:
- Giọng MC bản tin — ngắn gọn, súc tích, có trọng lượng.
- Không dùng ngôn ngữ hoa mỹ, không cường điệu, không clickbait.
- Số liệu cụ thể (giá, % tăng/giảm) là trọng tâm — đưa vào tự nhiên trong câu.
- Câu ngắn, rõ ý. Mỗi câu một thông tin chính.
- Không dùng "Xin chào", "Hẹn gặp lại", hay lời chào mào.

CẤU TRÚC script (75 giây — khoảng 160 từ):
1. Mở đầu (1 câu): Nêu ngay số liệu nổi bật nhất — giá SJC hoặc giá thế giới hôm nay.
2. Diễn biến (2–3 câu): Mức thay đổi, xu hướng, nguyên nhân chính.
3. Bối cảnh (1–2 câu): Yếu tố vĩ mô tác động nếu có (Fed, USD, địa chính trị).
4. Nhận định (1 câu): Ngắn gọn, khách quan — không khuyến nghị mua/bán cụ thể.
5. Kết (bắt buộc, nguyên văn): "${CLOSING}"

LƯU Ý:
- Viết để đọc thành tiếng — câu chuyển tiếp tự nhiên, không cứng nhắc.
- Số tiền: ghi đầy đủ bằng chữ lần đầu, ví dụ "một trăm bảy mươi tám triệu đồng một lượng".
- Tổng 150–170 từ. Không dài hơn.

TRẢ VỀ JSON theo đúng format sau, không có text nào ngoài JSON:
{
  "trend": "uptrend" hoặc "downtrend" (dựa trên xu hướng giá vàng trong bài),
  "script": "toàn bộ văn bản script thuần túy ở đây"
}`;
}

function buildVideoPrompt(content: string): string {
  return `Bạn là chuyên gia phân tích thị trường vàng của kênh Giá Vàng 24 News. Nhiệm vụ: viết script phân tích ngắn gọn 3 phút dựa trên nội dung bên dưới.

NỘI DUNG GỐC:
${content}

PHONG CÁCH:
- Giọng chuyên gia phân tích — có chiều sâu, logic rõ ràng, dẫn chứng cụ thể.
- Không sensational, không đưa ra lời khuyên đầu tư trực tiếp.
- Số liệu chính xác từ bài gốc, trình bày trong ngữ cảnh để dễ hiểu.
- Câu văn mượt mà khi đọc thành tiếng — có nhịp điệu, không cứng nhắc.

CẤU TRÚC script (3 phút — khoảng 420 từ):
1. Mở đầu (30 giây): Bối cảnh phiên và số liệu nổi bật nhất.
2. Diễn biến thị trường (60 giây): Giá SJC, vàng nhẫn, giá thế giới — mức tăng/giảm cụ thể.
3. Phân tích nguyên nhân (60 giây): Các yếu tố tác động chính — vĩ mô, USD, Fed, địa chính trị.
4. Lưu ý cho nhà đầu tư (30 giây): Điểm cần thận trọng, trình bày khách quan.
5. Kết (bắt buộc, nguyên văn): "${CLOSING}"

LƯU Ý:
- Viết liền mạch, tự nhiên khi đọc to — không dùng headers, gạch đầu dòng, markdown.
- Câu chuyển tiếp giữa các phần phải mượt, không cảm giác "chuyển đề mục".
- Số liệu: trình bày bằng chữ lần đầu xuất hiện.
- Tổng 400–440 từ. Không dài hơn.

TRẢ VỀ JSON theo đúng format sau, không có text nào ngoài JSON:
{
  "trend": "uptrend" hoặc "downtrend" (dựa trên xu hướng giá vàng trong bài),
  "script": "toàn bộ văn bản script thuần túy ở đây"
}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function generateScriptFromContent(
    content: string,
    mode: 'reels' | 'video',
): Promise<GeneratedManualScript> {
  const config = getConfig();
  const prompt = mode === 'reels' ? buildReelsPrompt(content) : buildVideoPrompt(content);

  logger.info({ mode, contentLen: content.length, model: config.gemini.scriptModel }, 'Generating script + trend');

  const genAI = new GoogleGenAI({ apiKey: config.gemini.apiKey });

  let parsed: { trend: string; script: string };

  try {
    const result = await genAI.models.generateContent({
      model: config.gemini.scriptModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 65_535,
        temperature: 0.7,
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const raw = (result.text ?? '').trim();

    const candidate = result.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const tokenCount = result.usageMetadata?.candidatesTokenCount;

    logger.info({ finishReason, outputTokens: tokenCount, rawLen: raw.length }, 'Gemini response');

    if (finishReason === 'SAFETY') {
      throw new Error('Gemini safety filter chặn output. Thử đổi cách diễn đạt topic.');
    }
    if (finishReason === 'MAX_TOKENS') {
      logger.warn({ outputTokens: tokenCount }, 'MAX_TOKENS — script có thể bị cắt');
    }

    // Parse JSON — strip markdown fences, extract JSON object từ bất kỳ vị trí nào
    // Gemini đôi khi thêm text trước/sau JSON khi dùng googleSearch tool
    const jsonMatch = raw.match(/\{[\s\S]*"trend"[\s\S]*"script"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Không tìm thấy JSON trong response. Raw (200 chars): ${raw.slice(0, 200)}`);
    }
    parsed = JSON.parse(jsonMatch[0]) as { trend: string; script: string };

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('API_KEY_INVALID') || msg.includes('401') || msg.includes('403')) {
      throw new Error(`Gemini API key không hợp lệ — kiểm tra GEMINI_API_KEY. Chi tiết: ${msg}`);
    }
    if (msg.includes('JSON') || msg.includes('parse')) {
      throw new Error(`Gemini không trả về JSON hợp lệ. Chi tiết: ${msg}`);
    }
    throw err;
  }

  // Validate trend
  const trend: TrendDirection =
      parsed.trend === 'downtrend' ? 'downtrend' : 'uptrend';

  // Validate script
  let fullText = (parsed.script ?? '').trim();
  if (!fullText || fullText.length < 80) {
    throw new Error(`Script quá ngắn (${fullText.length} chars). Response: ${JSON.stringify(parsed)}`);
  }

  // Đảm bảo câu kết luôn có mặt
  if (!fullText.includes('Giá Vàng 24 News')) {
    fullText = fullText + '\n\n' + CLOSING;
  }

  const wordCount = fullText.split(/\s+/).length;
  const estimatedDurationSec = Math.ceil((wordCount / 140) * 60);

  logger.info({ trend, wordCount, estimatedDurationSec }, 'Script generated');

  return { fullText, estimatedDurationSec, trend };
}