# Render container for spooool's recorder pipeline (sub-project #1).
# Runs @remotion/renderer which needs Chromium + ffmpeg available on PATH.
# Built and deployed via `wrangler deploy` (see wrangler.toml [[containers]]).

FROM node:22-bookworm-slim

# System dependencies. Chromium is installed via Debian's chromium package.
# ffmpeg comes from main; both ship recent-enough versions for Remotion 4.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libatk-bridge2.0-0 \
      libdrm2 \
      libxkbcommon0 \
      libgbm1 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Point Remotion at the system Chromium so it doesn't try to download one.
ENV REMOTION_CHROME_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Install all deps (including devDeps) so tsc is available for the compile step.
COPY package.json package-lock.json* ./
RUN npm ci

# Copy app sources + Remotion compositions, then compile.
COPY tsconfig.json ./
COPY src ./src
COPY remotion ./remotion
RUN ./node_modules/.bin/tsc

# Prune devDeps so the final image only ships production dependencies.
RUN npm prune --omit=dev

EXPOSE 8080
CMD ["node", "dist/server.js"]
