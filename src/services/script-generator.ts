// src/services/script-generator.ts
// Script generation cho auto pipelines (GitHub Actions).
// Dùng @google/genai SDK — trả về JSON { trend, script } giống manual flow.

import { GoogleGenAI } from '@google/genai';
import type { NewsArticle, PipelineMode } from '../types/index.js';
import { getConfig } from '../utils/config.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('script-generator');

const CLOSING = 'Hãy theo dõi page Giá Vàng 24 News để có các tin tức cập nhật về giá vàng mới nhất nhé. Cảm ơn các bạn!';

export type TrendDirection = 'uptrend' | 'downtrend';

export interface GeneratedScript {
    title:               string;
    fullText:            string;
    segments:            Array<{ index: number; text: string }>;
    estimatedDurationSec: number;
    trend:               TrendDirection;
    thumbnail:           string;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function buildReelsPrompt(articles: NewsArticle[]): string {
    const content = articles
        .map((a) => `${a.headlineVi ?? a.headlineEn}\n${a.contentVi ?? a.contentEn}`)
        .join('\n\n---\n\n');

    return `Bạn là MC bản tin tài chính của kênh Giá Vàng 24 News. Tóm tắt thành script Reels 75 giây.

NỘI DUNG:
${content}

CẤU TRÚC (150–170 từ):
1. Mở đầu: nêu ngay số liệu nổi bật nhất.
2. Diễn biến (2–3 câu): mức thay đổi, nguyên nhân chính.
3. Bối cảnh (1–2 câu): yếu tố vĩ mô nếu có.
4. Nhận định (1 câu): khách quan, không khuyến nghị mua/bán.
5. Kết (nguyên văn): "${CLOSING}"

PHONG CÁCH: MC bản tin — ngắn gọn, súc tích, không hoa mỹ, không clickbait. Số tiền viết bằng chữ lần đầu.

TRẢ VỀ JSON (không có text nào ngoài JSON):
{"trend":"uptrend hoặc downtrend","thumbnail":"1 câu ngắn dưới 10 từ làm thumbnail — nêu số liệu nổi bật nhất","script":"toàn bộ script"}`;
}

function buildVideoPrompt(articles: NewsArticle[]): string {
    const content = articles
        .map((a) => `${a.headlineVi ?? a.headlineEn}\n${a.contentVi ?? a.contentEn}`)
        .join('\n\n---\n\n');

    return `Bạn là chuyên gia phân tích thị trường vàng của kênh Giá Vàng 24 News. Viết script phân tích 3 phút.

NỘI DUNG:
${content}

CẤU TRÚC (400–440 từ):
1. Mở đầu (30 giây): bối cảnh và số liệu nổi bật.
2. Diễn biến (60 giây): giá SJC, vàng nhẫn, thế giới — mức tăng/giảm cụ thể.
3. Phân tích (60 giây): nguyên nhân — vĩ mô, USD, Fed, địa chính trị.
4. Lưu ý (30 giây): điểm cần thận trọng, khách quan.
5. Kết (nguyên văn): "${CLOSING}"

PHONG CÁCH: chuyên gia phân tích — chiều sâu, logic, không sensational. Viết liền mạch, không dùng gạch đầu dòng hay headers.

TRẢ VỀ JSON (không có text nào ngoài JSON):
{"trend":"uptrend hoặc downtrend","thumbnail":"1 câu ngắn dưới 10 từ làm thumbnail — nêu số liệu nổi bật nhất","script":"toàn bộ script"}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function generateScript(
    articles: NewsArticle[],
    mode: PipelineMode,
): Promise<GeneratedScript> {
    const config = getConfig();

    if (articles.length === 0) {
        throw new Error('Cannot generate script: no articles provided');
    }

    const prompt = mode === 'reels' ? buildReelsPrompt(articles) : buildVideoPrompt(articles);

    logger.info({ mode, articleCount: articles.length, model: config.gemini.scriptModel }, 'Generating script');

    const genAI  = new GoogleGenAI({ apiKey: config.gemini.apiKey });

    let parsed: { trend: string; script: string; thumbnail: string };

    try {
        const result = await genAI.models.generateContent({
            model:    config.gemini.scriptModel,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
                maxOutputTokens: 65_535,
                temperature:     0.7,
                tools:           [{ googleSearch: {} }],
                thinkingConfig:  { thinkingBudget: 0 },
            },
        });

        const raw         = (result.text ?? '').trim();
        const finishReason = result.candidates?.[0]?.finishReason;

        logger.info({ finishReason, rawLen: raw.length }, 'Gemini response');

        if (finishReason === 'SAFETY') throw new Error('Gemini safety filter blocked output');

        // Extract JSON — Gemini có thể thêm text thừa xung quanh khi dùng googleSearch
        const jsonMatch = raw.match(/\{[\s\S]*"trend"[\s\S]*"script"[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error(`Không tìm thấy JSON trong response. Raw: ${raw.slice(0, 200)}`);
        }
        parsed = JSON.parse(jsonMatch[0]) as { trend: string; script: string; thumbnail: string };

    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('API_KEY_INVALID') || msg.includes('401') || msg.includes('403')) {
            throw new Error(`Gemini API key không hợp lệ — kiểm tra GEMINI_API_KEY. Chi tiết: ${msg}`);
        }
        throw err;
    }

    const trend: TrendDirection = parsed.trend === 'downtrend' ? 'downtrend' : 'uptrend';
    const thumbnail = (parsed.thumbnail ?? '').trim();
    let fullText = (parsed.script ?? '').trim();

    if (!fullText || fullText.length < 50) {
        throw new Error(`Script too short (${fullText.length} chars)`);
    }

    if (!fullText.includes('Giá Vàng 24 News')) {
        fullText = fullText + '\n\n' + CLOSING;
    }

    const segments = fullText
        .split(/(?<=[.!?…])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((text, index) => ({ index, text }));

    const wordCount           = fullText.split(/\s+/).length;
    const estimatedDurationSec = Math.ceil((wordCount / 140) * 60);
    const title               = articles[0]?.headlineVi ?? articles[0]?.headlineEn ?? 'Bản tin';

    logger.info({ trend, thumbnail, wordCount, estimatedDurationSec }, 'Script generated');

    return { title, fullText, segments, estimatedDurationSec, trend, thumbnail };
}