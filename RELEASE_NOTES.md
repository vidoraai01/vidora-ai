# Vidora AI — Master Release Notes

## Release contents

- Five-page Account → Upload → AI Tools → Processing → Results workflow.
- Video, Photo and Audio studios with 12 tools: 9 Video, 1 Photo and 2 Audio.
- AI Video Edit now chains Gemini-assisted frame analysis into an actual MP4 render, with confidence-gated AI cut suggestions, long-pause trimming and AI-guided conventional visual enhancement. The original upload remains unchanged.
- AI Visual Enhance is shown inside AI Video Edit.
- Separate AI Visual Change tool integrates Runway Dev video-to-video (Aleph 2) for prompt-based visual restyling and scene edits. It requires `RUNWAYML_API_SECRET` and paid provider credits; accepts 2–30 second, up-to-1080p, up-to-30-FPS clips no larger than 200 MB. Original audio is restored after the visual model completes.
- Session-only authentication, guest restrictions, account persistence, password reset, Help and public feedback/suggestions with administrator moderation.
- Server upload validation using extension, declared MIME, magic bytes, FFprobe streams, size and duration checks.
- Upload progress (bytes, speed and network ETA), FFmpeg/provider progress and heuristic processing estimates.
- Private temporary media storage, per-user job ownership, one active job per user, cancellation and retention cleanup.
- Fingerprint comparison reports with approximate matched segments, alignment, confidence and explicit limitations.
- Responsive dark interface and Page-4-only holographic brain animation.

## Checks performed in the build workspace

- `npm test`: 15 tests passed, including a generated-media auto-edit render test, FFmpeg visual-preset validation, mocked Runway ephemeral upload/task polling/download flow, and original-audio restoration test.
- `npm run check`: server, auth, frontend, auto-edit renderer and Runway provider JavaScript syntax checks passed.
- Dependency versions were resolved from the supplied source archive's installed packages and matched the declared semver ranges; `package.json` and `package-lock.json` root dependencies match.
- ZIP/source audits excluded `.env`, credentials, backups and `node_modules` from the release package.

## External checks still required before production launch

- Connect the deployment to the real PostgreSQL database and verify schema/session persistence.
- Configure and test a valid Gemini API key/model and Resend email credentials; live provider calls were not possible in this build environment.
- Configure `RUNWAYML_API_SECRET`, purchase the necessary Runway credits and run a real 2–30 second visual transformation; the provider integration was tested with a mock API, not a live paid request.
- Confirm `fpcalc` is installed in the target Linux runtime. The Dockerfile installs `libchromaprint-tools`; the bundled Windows executable is only for Windows.
- Run browser/device visual QA and a deployment smoke test on the actual Enzonic topology.
- Set `TRUST_PROXY_HOPS` to the verified number of trusted ingress proxies before production startup.
- The current 512 MB hosting tier is not sufficient for 4K/8K processing: the backend blocks 4K below 1.5 GB and 8K below 4 GB. Use a larger worker for those resolutions.

## Capability boundaries

- AI Video Edit renders an actual edited MP4 using AI-recommended cuts, safe pause trimming and AI-guided conventional FFmpeg visual filters. It does not yet perform full semantic scene rearrangement or generative transition creation.
- AI Visual Change is generative video-to-video, but is limited by Runway Aleph 2's current duration, frame-rate, resolution, file-size and credit requirements. Longer videos are rejected rather than silently truncated.
- Video/photo enhancement filters and video upscaling use conventional FFmpeg operations, not bundled neural restoration/upscaling models. Audio enhancement uses conventional filtering.
- Audio/video fingerprint matching compares only the supplied files; it is not a global copyright database or a copyright verdict.
- Jobs and upload references are process-local and are not durable across server restarts.
- No zero-error or unlimited-quality guarantee is claimed. Live cloud integrations and the actual production hosting topology still require validation.

## Review fixes
- Fixed: `task` was block-scoped inside the validation try block in `/api/jobs` but used by the render job, which could make every job fail with "task is not defined".
- Fixed: refresh/pagehide no longer logs the user out (this could kill running jobs).
- Added free Visual Change provider (Gradio / Hugging Face Space) and made it the default; Runway is optional.
- `/api/system-status` now requires sign-in. Rate limits are keyed per signed-in user instead of per IP.
- Unknown server errors now return 500 instead of 400. Bundled `fpcalc.exe` removed. Docker build no longer runs tests.
- Local setup docs now explain `DATABASE_SSL=disable`. Still to do: `npm install multer@2` (needs network to refresh the lockfile).
