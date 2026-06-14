FROM node:22-bookworm-slim

ARG KINDLEGEN_URL=https://github.com/lapwat/papeer/releases/download/kindlegen/kindlegen_linux_2.6_i386_v2_9.tar.gz

RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      calibre \
      curl \
      fontconfig \
      fonts-dejavu \
      fonts-liberation \
      fonts-noto-core \
      ffmpeg \
      libc6:i386 \
      libstdc++6:i386 \
      pandoc \
      python3-pip \
      tar \
      weasyprint \
      zip \
 && curl -fsSL "$KINDLEGEN_URL" -o /tmp/kindlegen.tar.gz \
 && tar -xzf /tmp/kindlegen.tar.gz -C /tmp \
 && install -m 0755 /tmp/kindlegen /usr/local/bin/kindlegen \
 && rm -rf /tmp/kindlegen* /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN corepack enable && corepack prepare pnpm@9 --activate
RUN pnpm install --no-frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc
RUN pnpm prune --prod

ENV PORT=8787
EXPOSE 8787
CMD ["node", "dist/index.js"]
