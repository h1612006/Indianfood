# Spice Smash app image
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install only what the app needs (cached unless package files change)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js db.js ./
COPY data ./data
COPY public ./public

# The built-in "node" user is not root; give it a folder for the optional file fallback
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV PORT=3000
EXPOSE 3000

# Healthy only if the app AND its storage (Postgres) answer
HEALTHCHECK --interval=30s --timeout=4s --start-period=25s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "server.js"]
