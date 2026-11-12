const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "vidora-ai-cloudflare-static-preview",
        backend: "not-migrated",
        message: "Static preview is online. Account, database and media APIs are not enabled in this preview."
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({
        error: "Vidora AI backend migration is not complete. This deployment is a static UI preview only; sign-in, uploads, comments and processing are intentionally unavailable."
      }, 503);
    }

    return env.ASSETS.fetch(request);
  }
};
