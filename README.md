# Vidora AI — Multi-Studio Media Workspace

A five-page media workflow built with Node.js/Express, PostgreSQL sessions, FFmpeg/FFprobe, Chromaprint and optional Gemini vision analysis. The application is designed around three studios: Video, Photo and Audio.

## Included workflow

1. **Account** — sign in, create an account, request a time-limited password-reset email, or continue as a browse-only guest. Authentication uses a browser-session cookie (no persistent Max-Age) and best-effort logout when the page is left.
2. **Upload** — select one supported media file, review the media limits and confirm permission to process it.
3. **AI Tools** — choose from 9 Video Studio tools, 1 Photo Studio tool and 2 Audio Studio tools. Fingerprint tools reveal the second upload only after selection.
4. **Processing** — a dedicated animated holographic brain view, actual upload progress, FFmpeg job progress where available, elapsed time and a progress-derived remaining-time estimate.
5. **Results** — download the processed output or a technical JSON report. Fingerprint reports return to Upload; there is no sixth page.

Help is available from the header on every page. Feedback and suggestions are public immediately; bug reports remain private. Administrators can hide or delete public posts and manage report statuses. The administrator can review reports, update statuses, publish/hide approved feedback/suggestions and delete reports/comments. Bug reports cannot be made public.

## Tool capability and honest limitations

| Studio | Tool | Current implementation |
|---|---|---|
| Video | Video Enhance AI | Optional Gemini frame assessment recommends filter settings; FFmpeg performs the actual denoise/sharpen/colour render. This is AI-guided conventional enhancement, not a neural restoration model. |
| Video | AI Video Analysis | Gemini-assisted sampled-frame analysis when a valid API key/model is available; otherwise returns an explicit local technical fallback. |
| Video | AI Video Edit | Uses the AI edit/quality plan, then renders an MP4 with conservative visual enhancement and optional long-silence trimming. It does not yet apply semantic scene rearrangement, generative transitions or AI-selected clip assembly. |
| AI Visual Change | Uses Runway Aleph 2 video-to-video editing for prompt-driven anime/cinematic restyling, background/environment changes and object/appearance edits. Requires `RUNWAYML_API_SECRET` and purchased provider credits. The source audio track is restored after the visual model finishes. Provider limits are 2–30 seconds, up to 1080p, 30 FPS or lower and 200 MB per clip; unsupported clips are rejected rather than silently truncated or downscaled. |
| Video | Video Fingerprint Check | Perceptual frame hashes sampled at 1 frame/second, with approximate alignment and matching windows. Brief segments can be missed; this is not a copyright verdict. |
| Video | Video Full Details | FFprobe metadata report. |
| Video | AI Video Upscale | Lanczos interpolation to the selected output size. A neural AI upscaling model is not bundled. |
| Video | Audio Extractor | MP3/WAV extraction. |
| Video | Video Audio Enhance | FFmpeg noise reduction and loudness normalization while re-encoding the video/audio output. |
| Photo | Photo Enhance AI | Gemini can assess a downscaled preview and recommend conventional denoise/sharpen/tone settings; FFmpeg applies the filters and exports PNG. Without Gemini it uses conservative local settings. No neural image-restoration model or generated image content is included. |
| Audio | Audio Enhance AI | FFmpeg noise reduction and loudness normalization. It is conventional signal processing, not a neural speech model. |
| Audio | Audio Fingerprint Check | Chromaprint acoustic fingerprint alignment and approximate similarity. It compares only the two supplied files, not a global music database. |

The product labels are retained for the approved workflow, but the implementation distinctions above must remain visible to users. Do not market conventional filters/interpolation as neural AI.

## Media limits

- Generative AI Visual Change: provider limits of 2–30 seconds, up to 1080p, 30 FPS or lower and 200 MB per clip; requires Runway Dev API credits and `RUNWAYML_API_SECRET`. The regular upload limit remains 5 minutes / 250 MB for the other video tools.

- Video: one file, maximum 250 MB and 5 minutes.
- Audio: one file, maximum 50 MB and 30 minutes.
- Photo: one image, maximum 25 MB.
- Fingerprint comparison: the second file uses the same media type and per-file limits.

The backend checks filename extension, file signature and FFprobe-detected streams before starting a job. The original upload is never overwritten. Files are placed in private temporary directories and cleaned up after the configured retention period.

## Requirements

- Node.js 20.11 or newer (for streaming provider uploads with `fs.openAsBlob`).
- FFmpeg and FFprobe on `PATH` (or set `FFMPEG_PATH` and `FFPROBE_PATH`).
- `fpcalc` / Chromaprint for audio fingerprint comparisons. The Dockerfile installs `libchromaprint-tools`.
- PostgreSQL for account/session/community storage.
- Optional Gemini API key for vision-assisted analysis and enhancement recommendations.
- Optional Resend account/API key for password-reset email delivery.

## Local setup

1. Install Node.js 20+ and FFmpeg/FFprobe.
2. Copy `.env.example` to `.env` and fill in the database and authentication values.
3. Generate a random session secret (for example, `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) and set `SESSION_SECRET`. Generate an administrator password hash using `bcryptjs` (cost 12) and set `ADMIN_PASSWORD_HASH`.
4. In development, `TRUST_PROXY_HOPS` may be `0`. In production, set it to the **verified number of trusted ingress proxies**. Do not guess or use `true`.
5. For password reset, configure `APP_BASE_URL`, `RESEND_API_KEY` and a verified `RESEND_FROM` address. Without these, the app will show the generic reset response but no email will be delivered.
6. Install dependencies and run tests:

```bash
npm ci
npm test
npm run check
npm start
```

Open `http://localhost:3000`.

## Required environment variables

- `DATABASE_URL` — PostgreSQL connection string with certificate validation enabled.
- `SESSION_SECRET` — at least 48 random characters.
- `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` — administrator login.
- `TRUST_PROXY_HOPS` — explicitly set in production after verifying the hosting topology.

Optional variables: `RUNWAYML_API_SECRET` (for generative AI Visual Change; separate from Gemini and credit-billed), `GEMINI_API_KEY`, `GEMINI_FALLBACK_MODEL`, `GEMINI_REQUEST_TIMEOUT_MS`, `RESEND_API_KEY`, `RESEND_FROM`, `APP_BASE_URL`, `MAX_UPLOAD_MB`, `RETENTION_HOURS`, `FFMPEG_PATH`, `FFPROBE_PATH`, `FPCALC_PATH`, `DB_POOL_MAX`, `DATABASE_SSL`.

Never commit `.env`, API keys, database credentials, session secrets or password hashes. `.gitignore` and `.dockerignore` exclude secret files, backups and `node_modules`.

## Deployment notes and limits

- The Docker image installs FFmpeg/FFprobe and Chromaprint and runs as the unprivileged `node` user. AI Visual Change uploads the selected short clip to Runway Dev using an ephemeral provider asset; the provider may bill credits for the transformation.
- Set `TRUST_PROXY_HOPS` to the verified Enzonic ingress count before deploying. The app intentionally refuses to guess this in production; an incorrect setting can cause secure-cookie or rate-limit issues.
- PostgreSQL must allow the deployment host and present a valid TLS certificate. Certificate verification is enabled by default; do not weaken TLS to silence a warning.
- Job state and temporary media are currently held in process memory/local temporary disk. A restart or redeploy can lose active jobs and files. This build is single-instance and is not a durable distributed job queue.
- Large/high-resolution renders are CPU- and memory-intensive. The backend detects the container memory limit and blocks 4K output below 1.5 GB and 8K below 4 GB to reduce the risk of killing the app. A 512 MB host is therefore not expected to process 4K/8K; use a larger dedicated worker for those outputs. 2K remains resource-intensive and is still subject to actual CPU/memory availability.
- The browser upload progress is measured from actual transfer events (bytes, speed and network ETA). FFmpeg job progress is measured from FFmpeg's reported output time. Remaining-time values combine media metadata and observed render progress; they are estimates and can change with server load.
- No malware-scanning service or isolated worker container is included. Do not accept untrusted public uploads until these controls and durable quotas/storage are added.
- A media comparison score is not proof of ownership, infringement, or copyright clearance. No Content ID bypass or claim-free guarantee is provided.

## Release checks

Run `npm test` and `npm run check` before packaging. The smoke tests verify the five-page structure, 12 tool entries, protected API routes, JavaScript syntax, required media binaries, FFmpeg visual presets, a mocked Runway upload/submit/poll/download flow and secret exclusions. They do not replace live PostgreSQL, Gemini, email-provider, browser-device or production-host testing.
