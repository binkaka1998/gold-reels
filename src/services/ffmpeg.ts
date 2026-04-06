// src/services/ffmpeg.ts
// Builds MP4 video: image slideshow + TTS audio.
// NO burned-in subtitles — captions are uploaded as native Facebook SRT.
//
// Slideshow strategy:
//   - Total duration = audio duration.
//   - Images distributed evenly across duration (cycle if needed).
//   - Crossfade transition between images using xfade filter.
//   - Output: H.264/AAC MP4 with faststart for streaming.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import type { PipelineMode } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('ffmpeg');

const MIN_IMAGE_DURATION_SEC = 4;
const XFADE_DURATION_SEC = 0.5;

// ─── Audio duration probe ─────────────────────────────────────────────────────

export async function getAudioDurationMs(audioPath: string): Promise<number> {
    const stdout = await new Promise<string>((resolve, reject) => {
        const proc = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json', '-show_streams', audioPath,
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
        proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`ffprobe exit ${code}`)));
        proc.on('error', reject);
    });

    const probe = JSON.parse(stdout) as {
        streams: Array<{ duration?: string; codec_type?: string }>;
    };

    const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
    if (!audioStream?.duration) {
        throw new Error(`Cannot detect audio duration for: ${audioPath}`);
    }

    return Math.ceil(parseFloat(audioStream.duration) * 1000);
}

// ─── Image segment distribution ───────────────────────────────────────────────

interface ImageSegment {
    imagePath: string;
    durationSec: number;
}

function buildImageSegments(
    imagePaths: string[],
    totalDurationMs: number
): ImageSegment[] {
    const totalSec = totalDurationMs / 1000;
    const segments: ImageSegment[] = [];
    const poolSize = imagePaths.length;

    // How many segments do we need to cover totalSec with MIN_IMAGE_DURATION_SEC?
    const count = Math.max(1, Math.ceil(totalSec / MIN_IMAGE_DURATION_SEC));
    const sliceSec = parseFloat((totalSec / count).toFixed(3));

    for (let i = 0; i < count; i++) {
        // Last segment absorbs any rounding remainder
        const duration = i === count - 1
            ? parseFloat((totalSec - sliceSec * (count - 1)).toFixed(3))
            : sliceSec;

        segments.push({
            imagePath: imagePaths[i % poolSize]!,
            durationSec: Math.max(duration, 0.1),
        });
    }

    return segments;
}

// ─── xfade filter chain ───────────────────────────────────────────────────────

function buildFilterComplex(
    segments: ImageSegment[],
    width: number,
    height: number
): string {
    const scale =
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`;

    if (segments.length === 1) {
        return `[0:v]${scale}[vout]`;
    }

    const parts: string[] = [];

    // Scale each input
    for (let i = 0; i < segments.length; i++) {
        parts.push(`[${i}:v]${scale}[s${i}]`);
    }

    // Chain xfade between consecutive scaled inputs
    // offset = cumulative presentation time of all segments before this xfade
    let offset = 0;
    let prev = '[s0]';

    for (let i = 1; i < segments.length; i++) {
        offset += segments[i - 1]!.durationSec - XFADE_DURATION_SEC;
        const outLabel = i === segments.length - 1 ? '[vout]' : `[x${i}]`;
        parts.push(
            `${prev}[s${i}]xfade=transition=fade:duration=${XFADE_DURATION_SEC}:` +
            `offset=${offset.toFixed(3)}${outLabel}`
        );
        prev = `[x${i}]`;
    }

    return parts.join(';');
}

// ─── Thumbnail text overlay ───────────────────────────────────────────────────
// Vẽ 1 câu text nổi bật lên 5s đầu video để làm thumbnail khi Facebook preview.
// Dùng drawtext filter với font hệ thống (NotoSans hỗ trợ tiếng Việt trên Ubuntu).
// Text tự wrap dựa vào max_chars, căn giữa dọc/ngang.

function escapeDrawtext(text: string): string {
    // ffmpeg drawtext cần escape: ' : \ %
    return text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/%/g, '\\%');
}

// ─── Word wrap cho thumbnail text ────────────────────────────────────────────
// ffmpeg drawtext không tự wrap — cần tách tay thành dòng trước khi escape.
// Wrap theo từ, giữ nguyên ký tự, không cắt giữa chữ.

function wrapText(text: string, maxCharsPerLine: number): string[] {
    const words = text.trim().split(/\s+/);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxCharsPerLine) {
            current = candidate;
        } else {
            if (current) lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines;
}

function buildThumbnailFilter(
    text: string,
    _width: number,
    _height: number,
    mode: PipelineMode,
): string[] {
    const isReels   = mode === 'reels';
    const brandSize = isReels ? 136 : 120;
    const textSize  = isReels ? 108 : 72;
    const lineH     = textSize + 14;
    const maxChars  = isReels ? 18 : 32;

    const lines = wrapText(text, maxChars);
    const brand = 'GVNews24';

    // Resolve font tại runtime — thử Noto trước, fallback DejaVu, skip nếu không có
    const FONT_CANDIDATES = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',           // Ubuntu default — luôn có
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',   // fonts-liberation
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',            // fonts-noto (CJK, hỗ trợ tiếng Việt)
        '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',               // fonts-noto-core nếu có
    ];
    const boldFont = FONT_CANDIDATES.find(existsSync);
    if (!boldFont) {
        logger.warn('No bold font found — skipping thumbnail overlay');
        return [];
    }

    const enable = `enable=lte(t\\,5)`;

    const brandFilter =
        `drawtext=text='${escapeDrawtext(brand)}':` +
        `fontsize=${brandSize}:fontfile=${boldFont}:fontcolor=#FFD700:` +
        `box=1:boxcolor=black@0.92:boxborderw=24:` +
        `x=(w-text_w)/2:y=h*0.20:` +
        `fix_bounds=1:${enable}:expansion=none`;

    const textFilters = lines.map((line, i) => {
        const escaped = escapeDrawtext(line);
        const yOffset = brandSize + 20 + i * lineH;
        return (
            `drawtext=text='${escaped}':` +
            `fontsize=${textSize}:fontfile=${boldFont}:fontcolor=white:` +
            `box=1:boxcolor=black@0.92:boxborderw=20:` +
            `x=(w-text_w)/2:y=h*0.20+${yOffset}:` +
            `fix_bounds=1:${enable}:expansion=none`
        );
    });

    return [brandFilter, ...textFilters];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SlideshowConfig {
    mode:           PipelineMode;
    width:          number;
    height:         number;
    fps:            number;
    imagePaths:     string[];
    audioPath:      string;
    outputPath:     string;
    thumbnailText?: string;   // Câu subtitle hiện 5s đầu làm thumbnail
}

export async function buildSlideshow(cfg: SlideshowConfig): Promise<string> {
    const { mode, width, height, fps, imagePaths, audioPath, outputPath, thumbnailText } = cfg;

    if (imagePaths.length === 0) throw new Error('buildSlideshow: no images provided');

    const totalDurationMs = await getAudioDurationMs(audioPath);
    const segments = buildImageSegments(imagePaths, totalDurationMs);

    logger.info({
        mode, width, height, fps,
        imageCount: imagePaths.length,
        segmentCount: segments.length,
        totalDurationSec: (totalDurationMs / 1000).toFixed(1),
        hasThumbnail: !!thumbnailText,
    }, 'Building FFmpeg slideshow');

    const crf = mode === 'reels' ? 26 : 22;
    const audioBitrate = mode === 'reels' ? '128k' : '192k';

    let filterComplex = buildFilterComplex(segments, width, height);

    // Thêm drawtext overlay nếu có thumbnailText
    // buildThumbnailFilter trả về "shadow_filter,main_filter" (2 layers)
    // Cần chain: [vpre] → shadow → [vs] → main → [vout]
    if (thumbnailText?.trim()) {
        const filters = buildThumbnailFilter(thumbnailText.trim(), width, height, mode);
        if (filters.length > 0) {
            const lastVout = filterComplex.lastIndexOf('[vout]');
            if (lastVout === -1) throw new Error('buildFilterComplex: [vout] label not found');
            let chain = filterComplex.slice(0, lastVout) + '[tbase]' + filterComplex.slice(lastVout + 6);
            let prev = 'tbase';
            filters.forEach((f, i) => {
                const outLabel = i === filters.length - 1 ? 'vout' : `t${i}`;
                chain += `;[${prev}]${f}[${outLabel}]`;
                prev = outLabel;
            });
            filterComplex = chain;
        }
    }

    const audioIdx = segments.length;

    // Build args array per segment — không split string để tránh vỡ path có space
    const imageArgs: string[] = [];
    for (const s of segments) {
        imageArgs.push('-loop', '1', '-framerate', String(fps), '-t', String(s.durationSec), '-i', s.imagePath);
    }

    // Dùng args array thay vì string — tránh hoàn toàn shell quoting issues
    // filter_complex truyền thẳng vào spawn, không qua shell
    const args = [
        '-y',
        ...imageArgs,
        '-i', audioPath,
        '-filter_complex', filterComplex,
        '-map', '[vout]',
        '-map', `${audioIdx}:a`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-r', String(fps),
        '-c:a', 'aac', '-b:a', audioBitrate,
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-shortest',
        outputPath,
    ];

    logger.debug({ argsLen: args.length, filterLen: filterComplex.length }, 'FFmpeg args');
    logger.info({ filterComplex }, 'FFmpeg filter_complex');

    const t0 = Date.now();
    await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderrBuf = '';
        proc.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString(); });
        proc.on('close', (code) => {
            if (code === 0) {
                const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
                const lastLine = stderrBuf.split('\n').filter(Boolean).pop() ?? '';
                logger.info({ outputPath, elapsedSec, lastLine }, 'Slideshow built');
                resolve();
            } else {
                logger.error({ stderr: stderrBuf.slice(-3000) }, 'FFmpeg failed');
                reject(new Error(`FFmpeg failed (code ${code}): ${stderrBuf.slice(-500)}`));
            }
        });
        proc.on('error', (err) => reject(new Error(`FFmpeg spawn error: ${err.message}`)));
    });

    return outputPath;
}