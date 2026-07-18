FROM node:18-bookworm-slim

# System ffmpeg as fallback; static binaries from npm also used by assembler
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/workers/assembly/package.json ./
RUN npm install --omit=dev

# Ranking assembler + Gemini commentary (Whisper via openai) + storage/trial helpers
COPY server/studio/formats/ranking ./lib/ranking
COPY server/workers/storage.js ./lib/storage.js
COPY server/studio/trial.js ./lib/trial.js
COPY server/workers/assembly/index.js ./index.js

ENV NODE_ENV=production

CMD ["node", "index.js"]
