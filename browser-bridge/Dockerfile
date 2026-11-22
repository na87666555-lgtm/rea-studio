FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package*.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && chown -R node:node /app
COPY --chown=node:node . .
RUN apt-get update && apt-get install -y --no-install-recommends blender ffmpeg && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node", "server.cjs"]
