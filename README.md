# Vidora AI — Processing beta

Responsive dark/cyan media workspace with a Node.js API and FFmpeg processing backend.

## Features implemented
- Responsive browser UI with local preview and drag/drop upload.
- Real multipart upload to `POST /api/jobs`.
- FFprobe inspection before processing.
- FFmpeg export: MP4 (H.264/AAC), MOV, WEBM (VP9/Opus), MP3 and WAV.
- Compression quality presets, resize up to 1080p/720p/480p, audio extraction, loudness normalization and clip trimming.
- Job status polling, downloadable export, job deletion endpoint.
- Upload size cap, extension allowlist, rate limiting, Helmet headers, random job IDs, private temporary directories and automatic expiry cleanup.

## Run locally
Requirements: Node.js 20+ and FFmpeg + FFprobe installed and available on PATH.

```bash
npm install
cp .env.example .env   # optional; edit values if needed
npm start
```

Open http://localhost:3000. The frontend and API are served from the same origin. On Windows, install FFmpeg and add its `bin` directory to PATH, or set `FFMPEG_PATH` and `FFPROBE_PATH`.

## API
- `GET /api/health` — health check.
- `POST /api/jobs` — multipart form with `media`, `task`, `format`, `quality`, `resolution`; trim also accepts `startTime` and `duration`.
- `GET /api/jobs/:id` — job state.
- `GET /api/jobs/:id/download` — download completed export.
- `DELETE /api/jobs/:id` — delete a job and its output.

Task values: `convert`, `compress`, `resize`, `extract-audio`, `normalize-audio`, `trim`.
Format values: `mp4`, `mov`, `webm`, `mp3`, `wav`.
Quality values: `balanced`, `high`, `small`. Resolution values: `original`, `1080p`, `720p`, `480p`.

## Important current limitations
- Jobs are stored in an in-memory Map; restarting the server loses job status. This is a single-instance development implementation, not a production queue.
- Media is written to local temporary disk. Cleanup runs every 10 minutes and expires completed/failed jobs after `RETENTION_HOURS` (default 2). Deployments need durable private object storage and lifecycle rules.
- Upload validation uses extension allowlisting plus FFprobe parsing; production should add robust file-signature validation, malware scanning, per-user quotas/authentication, isolated worker containers, and stricter resource limits.
- The consent checkbox is a user declaration, not proof of ownership or a legal determination.
- No Content ID access, copyright bypass, or claim-free upload guarantee is provided. Processing a file does not grant rights to use it.

## Deploy from Android (Docker hosting)

The easiest phone-only path is to put this project in a GitHub repository, then connect that repository to a Docker-capable web host such as Render.

1. Extract the ZIP on your Android phone.
2. In your browser, create a GitHub repository (for example `vidora-ai`). Keep it private if you prefer.
3. Upload the files from the `vidora-ai` project folder to the repository root: `index.html`, `server.js`, `package.json`, `Dockerfile`, `.dockerignore`, `README.md`, and `.env.example`. Do not upload `.env` or `node_modules`.
4. In your hosting dashboard, create a new **Web Service** and connect the GitHub repository.
5. Choose **Docker** as the runtime/environment. The included Dockerfile installs FFmpeg and FFprobe in the server container.
6. Set the health-check path to `/api/health` if the host offers that setting. Set environment variables `MAX_UPLOAD_MB=100` and `RETENTION_HOURS=2` for a cautious first test. The Dockerfile already supplies defaults.
7. Deploy. Open the service URL on your phone and test `/api/health`; it should return JSON with `ok: true`.
8. Upload a short video you own or have permission to process. Try MP4 conversion first, then download the export.

### Deployment limitations — read before public launch

- This is an MVP/demo deployment, not production-ready for public users.
- Job state is held in memory and uploaded/exported media is stored in the container's temporary directory. A restart or redeploy can lose jobs and files. Do not add multiple instances until a persistent job queue and shared storage are implemented.
- Hosting plans differ in CPU, memory, request duration, disk persistence, bandwidth and sleeping behavior. Large media files may fail on low-resource plans. Start with short clips and a 100 MB upload cap.
- Before accepting public users, add authentication, per-user quotas, durable private object storage, a persistent queue, isolated processing workers, file-signature validation, malware scanning, stronger resource limits and privacy/retention controls.
- Processing media does not establish ownership or permission, and does not bypass Content ID or guarantee that a video will be claim-free.

## Audio fingerprint comparison
The Audio Fingerprint Analysis panel accepts two audio files and generates acoustic fingerprints with Chromaprint (`fpcalc`). It aligns the fingerprint sequences and reports an approximate similarity score. The Docker image installs `libchromaprint-tools` to provide `fpcalc`.

This is a comparison of the two uploaded files only. It does not query a global music/copyright database and must not be presented as a copyright clearance or infringement verdict. Uploaded comparison files are deleted after analysis.
