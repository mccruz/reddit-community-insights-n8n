FROM node:22.22.0-bookworm-slim@sha256:7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3

ENV NODE_ENV=production
WORKDIR /app

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates=20250419~deb12u1 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node src ./src
RUN mkdir -p /work /var/lib/codex \
    && chown -R node:node /work /var/lib/codex /app

USER node
EXPOSE 8787
CMD ["node", "src/server.mjs"]
