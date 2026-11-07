# Vidora AI processing service: Node.js + FFmpeg in one container.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    MAX_UPLOAD_MB=100 \
    RETENTION_HOURS=2

# Install FFmpeg/FFprobe and remove package-manager cache.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --chown=node:node . .
USER node

EXPOSE 3000
CMD ["npm", "start"]
