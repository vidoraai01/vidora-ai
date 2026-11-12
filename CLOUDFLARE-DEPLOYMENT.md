# Vidora AI — Cloudflare static preview package

This package is a **safe staging preview**, not the complete production application.

## What this package does
- Deploys the existing `public/index.html`, `public/assets/app.css`, and `public/assets/app.js` through Cloudflare Workers Static Assets.
- Adds a Worker entry point and explicit `/health` endpoint.
- Returns a clear HTTP 503 response for `/api/*` so the preview never pretends authentication, database, uploads, comments, or processing work when the backend is not migrated.
- Preserves the original Express/PostgreSQL/FFmpeg source files for audit and future migration. It does not run `server.js` on Workers.

## Deploy to a separate preview Worker
1. Install Node.js 20+ and run `npm install` (this installs Wrangler from the dev dependency only if added; alternatively use `npx wrangler@latest`).
2. Run `npx wrangler@latest login`.
3. From this folder run `npx wrangler@latest deploy --config wrangler.jsonc`.
4. Open the preview URL printed by Wrangler. Check `/`, `/assets/app.css`, `/assets/app.js`, and `/health`.
5. Confirm the UI is styled. Do not switch the production Worker/domain to this preview yet.

## Important limitations
The source backend uses Express sessions, PostgreSQL, Multer/local temporary files, Node `child_process.spawn`, FFmpeg/FFprobe and Chromaprint. These are not made Worker-compatible by this static preview. `/api/*` deliberately returns 503 until a real Cloudflare-compatible API/data/storage and media-processing implementation is completed and tested.

Do not add secrets to this ZIP or commit `.env`. Do not point the production domain at this preview.
