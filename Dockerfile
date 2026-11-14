# Vidora AI — Node/FFmpeg service. Keep the runtime non-root and small.
FROM node:20-bookworm-slim
ENV NODE_ENV=production PORT=3000 MAX_UPLOAD_MB=250 RETENTION_HOURS=2
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
# package-lock.json is regenerated at build time (multer 2 upgrade). Commit the new lockfile later for reproducible builds.
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node . .
RUN npm run check
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
