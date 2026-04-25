# Stage 1: build the guest SPA
FROM node:22-slim AS guest-build
WORKDIR /guest
RUN corepack enable && corepack prepare pnpm@10 --activate
COPY guest/package.json guest/pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false
COPY guest/ ./
RUN pnpm build

# Stage 2: Python app, with built guest dist baked in
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev --frozen 2>/dev/null || uv sync --no-dev

COPY app ./app
COPY --from=guest-build /guest/dist ./guest/dist

RUN useradd -m -u 1000 sessions && chown -R sessions:sessions /app
USER sessions

ENV GUEST_DIST_PATH=/app/guest/dist

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
