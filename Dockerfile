# DeepSeek Harness (team-mode fork) container.
#
# Single-stage for reliability: the pnpm workspace runtime resolves packages
# through workspace symlinks into packages/*/lib, so a naive multi-stage copy of
# `node_modules` alone would break resolution. Optimize to deps→build→runtime
# stages once the image layout is validated end to end.
#
# Build:  docker build -t dsh .
# Run:    docker run --rm -p 3080:3080 -e DEEPSEEK_API_KEY=... dsh

FROM node:24-slim

# pnpm is locked by packageManager in package.json; enable corepack to honor it.
RUN corepack enable

WORKDIR /app

# Copy the full workspace first so pnpm install can resolve every workspace:*.
COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm run build

# The web shell is served by `dsh web` (boots the `web` profile), which injects
# window.__DSH_BOOT__; do NOT run a bare Vite dev server as a stand-in.
# The listen port is `dsh web --port <n>` (default 8300); DSH_PORT is NOT read
# by the web server, so pass `--port` explicitly when a fixed port is required.
ENV NODE_ENV=production

EXPOSE 8300

CMD ["pnpm", "dsh", "web"]
