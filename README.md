# News Video Pipeline

Hệ thống tự động hoá tạo và đăng video tin tức lên Facebook, gồm hai chế độ:

- **Auto pipeline** — lấy bài từ DB → sinh script → TTS → dựng video → đăng Facebook (cron)
- **Manual mode** — Web UI để nhập topic, research, tuỳ chỉnh ảnh, preview script rồi đăng

---

## Kiến trúc

```
┌────────────────────────────────────────────────────┐
│ src/index.ts  (entry point + cron scheduler)       │
│  --mode=reels  → Reels auto pipeline (one-shot)    │
│  --mode=video  → Video auto pipeline (one-shot)    │
│  --mode=web    → Web UI only (no cron)             │
│  (default)     → Web UI + cron daemon              │
└──────────────┬─────────────────────┬───────────────┘
               │                     │
    ┌──────────▼──────────┐  ┌───────▼──────────────┐
    │   Auto Pipelines    │  │  Manual Mode (Web UI) │
    │  reels.pipeline.ts  │  │  http://localhost:3456│
    │  video.pipeline.ts  │  │  POST /api/jobs       │
    └──────────┬──────────┘  │  GET  /api/jobs/:id/  │
               │             │        events (SSE)   │
               └──────┬──────┘  GET  /api/jobs/:id/  │
                      │              download        │
          ┌───────────▼──────────────────────────┐
          │           Shared Services            │
          │  script-generator.ts  (Claude API)   │
          │  tts.ts               (Azure→Gemini) │
          │  ffmpeg.ts            (slideshow)     │
          │  facebook.ts          (upload+capts)  │
          │  news-repository.ts   (Prisma+locks)  │
          └──────────────────────────────────────┘
```

---

## Yêu cầu

| Dependency | Phiên bản |
|---|---|
| Node.js | ≥ 20 |
| FFmpeg | ≥ 5 (với `ffprobe`) |
| PostgreSQL | ≥ 14 (DB hiện có) |

---

## Cài đặt

```bash
npm install
cp .env.example .env        # điền đầy đủ
npx prisma generate         # generate Prisma client
npm run typecheck           # phải pass 0 errors
mkdir -p assets/images      # thêm 5-10 ảnh nền vào đây
```

---

## Biến môi trường bắt buộc

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/newsdb"
AZURE_SPEECH_KEY="..."          # Azure Cognitive Services
AZURE_SPEECH_REGION="southeastasia"
AZURE_TTS_VOICE="vi-VN-NamMinhNeural"
ANTHROPIC_API_KEY="..."         # Claude script generation
FACEBOOK_PAGE_ID="..."
FACEBOOK_ACCESS_TOKEN="..."     # Long-lived Page Access Token
                                # Scopes: pages_manage_posts, publish_video
```

Xem `.env.example` cho đầy đủ các biến tuỳ chọn.

---

## Chạy

```bash
npm run dev:web      # Web UI only — http://localhost:3456
npm run dev          # Web UI + cron daemon
npm run reels        # chạy Reels pipeline một lần
npm run video        # chạy Video pipeline một lần
npm run build && npm start  # production
docker-compose up -d        # Docker
```

---

## Manual Mode (Web UI)

Truy cập `http://localhost:3456`

1. Nhập **chủ đề** (VD: "Phân tích tác động lãi suất Fed Q4 2025 lên vàng")
2. Chọn **định dạng**: Video (~5 phút, 1920×1080) hoặc Reels (~75s, 1080×1920)
3. Chọn **nguồn research**:
   - 🌐 **Web search** — Serper API → scrape top 5 trang (cần `SERPER_API_KEY`)
   - 🔗 **Scrape URL** — paste URL cụ thể để scrape
   - 🧠 **Claude only** — dùng kiến thức nội tại
4. Upload **ảnh nền** (kéo thả file hoặc nhập URL ảnh)
5. Bật **upload Facebook** nếu muốn đăng ngay
6. Nhấn **Bắt đầu** → theo dõi real-time qua SSE → download hoặc xem trên Facebook

---

## Subtitle

Không burn subtitle vào video pixel. Thay vào đó upload `.srt` qua Facebook Caption API sau khi video live:

```
POST /{video-id}/captions  →  locale_code: vi_VN, captions_file: subtitles.srt
```

Lợi ích: người xem tắt/bật được, FB hỗ trợ auto-translate, không re-encode khi sửa.

---

## Cấu trúc source

```
src/
├── index.ts / web-entry.ts         entry points
├── types/index.ts                  shared types
├── utils/                          config, logger, filesystem, subtitle
├── services/                       script, tts, ffmpeg, facebook, news-repo
├── pipelines/                      reels.pipeline, video.pipeline
└── manual/                         Web UI: job-store, researcher,
    ├── routes/jobs.ts              script-from-research, pipeline-executor
    └── public/index.html           SPA (dark theme, SSE realtime)
prisma/schema.prisma                News model
```

---

## Troubleshooting

| Triệu chứng | Kiểm tra |
|---|---|
| Azure TTS 401 | Region phải là `southeastasia` không phải `Southeast Asia` |
| Facebook upload fail | Token phải là Page Access Token, scope `publish_video` |
| Video < 100KB | Xem log `component=ffmpeg` — thường do ảnh không đọc được |
| Prisma generate fail | Cần `DATABASE_URL` hợp lệ |
| Web search không hoạt động | Set `SERPER_API_KEY` — pipeline vẫn chạy được không có key |
