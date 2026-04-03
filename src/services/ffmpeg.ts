// src/services/ffmpeg.ts
// Builds MP4 video: image slideshow + TTS audio.
// NO burned-in subtitles — captions are uploaded as native Facebook SRT.
//
// Slideshow strategy:
//   - Total duration = audio duration.
//   - Images distributed evenly across duration (cycle if needed).
//   - Crossfade transition between images using xfade filter.
//   - Output: H.264/AAC MP4 with faststart for streaming.

import { exec } from 'child_process';
import { promisify } from 'util';
import type { PipelineMode } from '../types/index.js';
import { getLogger } from '../utils/logger.js';

const execAsync = promisify(exec);
const logger = getLogger('ffmpeg');

const MIN_IMAGE_DURATION_SEC = 4;  // Each image shown at least 4s
const XFADE_DURATION_SEC = 0.5;    // Crossfade between slides

// ─── Audio duration probe ─────────────────────────────────────────────────────

export async function getAudioDurationMs(audioPath: string): Promise<number> {
    const { stdout } = await execAsync(
        `ffprobe -v quiet -print_format json -show_streams "${audioPath}"`
    );

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
    const brandSize = isReels ? 136 : 120;   // "GVNews24" — to, nổi bật
    const textSize  = isReels ? 108 : 72;    // subtitle text bên dưới
    const lineH     = textSize + 14;         // khoảng cách dòng
    const maxChars  = isReels ? 18 : 32;

    const lines     = wrapText(text, maxChars);
    const brand     = 'GVNews24';
    const enable    = `enable='between(t,0,5)':expansion=none:fix_bounds=true`;

    // Vị trí: đặt ở top 20%
    const brandY = `h*0.20`;
    const textBaseY = `h*0.20+${brandSize + 20}`;

    const brandFilter =
        `drawtext=text='${escapeDrawtext(brand)}':` +
        `fontsize=${brandSize}:font='Noto Sans Bold':fontcolor=#FFD700:` +
        `box=1:boxcolor=black@0.92:boxborderw=24:` +
        `x=(w-text_w)/2:y=${brandY}:${enable}`;

    const textFilters = lines.map((line, i) => {
        const escaped = escapeDrawtext(line);
        const y       = `${textBaseY}+${i * lineH}`;
        return (
            `drawtext=text='${escaped}':` +
            `fontsize=${textSize}:font='Noto Sans Bold':fontcolor=white:` +
            `box=1:boxcolor=black@0.92:boxborderw=20:` +
            `x=(w-text_w)/2:y=${y}:${enable}`
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

    const inputs = segments
        .map((s) => `-loop 1 -framerate ${fps} -t ${s.durationSec} -i "${s.imagePath}"`)
        .join(' ');

    let filterComplex = buildFilterComplex(segments, width, height);

    // Thêm drawtext overlay nếu có thumbnailText
    // buildThumbnailFilter trả về "shadow_filter,main_filter" (2 layers)
    // Cần chain: [vpre] → shadow → [vs] → main → [vout]
    if (thumbnailText?.trim()) {
        const filters = buildThumbnailFilter(thumbnailText.trim(), width, height, mode);
        // Chain: [vout] → [t0] → [t1] → ... → [vout]
        let chain = filterComplex.replace(/\[vout\]$/, '[tbase]');
        let prev = '[tbase]';
        filters.forEach((f, i) => {
            const next = i === filters.length - 1 ? '[vout]' : `[t${i}]`;
            chain += `;${prev}${f}${next}`;
            prev = next;
        });
        filterComplex = chain;
    }

    const audioIdx = segments.length;

    const cmd = [
        'ffmpeg -y',
        inputs,
        `-i "${audioPath}"`,
        `-filter_complex "${filterComplex}"`,
        `-map "[vout]"`,
        `-map ${audioIdx}:a`,
        `-c:v libx264 -preset medium -crf ${crf} -r ${fps}`,
        `-c:a aac -b:a ${audioBitrate}`,
        `-pix_fmt yuv420p`,
        `-movflags +faststart`,
        `-shortest`,
        `"${outputPath}"`,
    ].join(' ');

    logger.debug({ cmdPreview: cmd.slice(0, 400) }, 'FFmpeg command');

    const t0 = Date.now();
    try {
        const { stderr } = await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
        const lastLine = stderr.split('\n').filter(Boolean).pop() ?? '';
        logger.info({ outputPath, elapsedSec, lastLine }, 'Slideshow built');
    } catch (err) {
        const e = err as { stderr?: string; message?: string };
        logger.error({ stderr: e.stderr?.slice(-3000) }, 'FFmpeg failed');
        throw new Error(`FFmpeg failed: ${e.message ?? String(err)}`);
    }

    return outputPath;
}