FROM ghcr.io/puppeteer/puppeteer:22.15.0

USER root
WORKDIR /app

COPY server/workers/scraper/package.json ./
RUN npm install --omit=dev

COPY server/workers/scraper/index.js ./index.js
COPY server/workers/scraper/enrich.js ./enrich.js
COPY server/lib/calculate-enhanced-metrics.js ./calculate-enhanced-metrics.js
COPY server/lib/scrape-notify.js ./scrape-notify.js

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true

USER pptruser
CMD ["node", "index.js"]
