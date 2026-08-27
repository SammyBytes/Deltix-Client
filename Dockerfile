# syntax=docker/dockerfile:1
#
# Deltix-Client is a CLI, not a long-running service. This image exists for
# operators who want to run `deltix` from automation (CI pipelines, cron
# jobs, other containers) without installing Bun locally. For interactive/
# human use, prefer the compiled binary from a GitHub Release (see
# .github/workflows/release.yml) — no container needed.
#
# Unlike Deltix-Server, this CLI has no `Bun.file(import.meta.dir, ...)`
# runtime asset reads, so `bun build --compile` works cleanly here.

FROM oven/bun:1.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home --uid 10001 deltix
USER deltix
WORKDIR /home/deltix

COPY --from=build --chown=deltix:deltix /app/dist/deltix /usr/local/bin/deltix

ENTRYPOINT ["/usr/local/bin/deltix"]
CMD ["--help"]

# pino-pretty's dynamic worker-thread transport does not resolve inside a
# bun-compiled binary (confirmed while building this image — same root
# cause affects Deltix-Server). Force plain JSON logging by default; this
# is also the correct choice for a container running non-interactively.
ENV LOG_PRETTY=false
