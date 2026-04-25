"""Familiar Sessions — public WebRTC signaling relay + guest entry point."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.routes import router

app = FastAPI(
    title="Familiar Sessions",
    description="Public WebRTC signaling relay for Familiar listening sessions.",
    version="0.1.0",
)

# WebSocket origin checks aren't enforced by browsers, but the HTTP fetch from
# the host's Familiar page (e.g. https://nas.tail-XXXX.ts.net) needs CORS to call
# /api/v1/sessions/by-code/{code}. Allow any origin — the endpoint exposes nothing sensitive.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

app.include_router(router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "healthy"}


# ------------------------------------------------------------------
# Guest SPA — built into guest/dist by Vite, mounted as static files.
# In dev (no dist yet), serve a fallback page.
# ------------------------------------------------------------------

GUEST_DIST = Path(settings.guest_dist_path).resolve()


@app.get("/", response_class=HTMLResponse)
async def splash() -> HTMLResponse:
    index = GUEST_DIST / "index.html"
    if index.exists():
        return HTMLResponse(index.read_text())
    return HTMLResponse(
        "<!doctype html><html><body style='font-family:system-ui;padding:2rem;background:#0a0a0a;color:#eee'>"
        "<h1>Familiar Sessions</h1>"
        "<p>Guest SPA is not built. Run <code>pnpm -C guest install &amp;&amp; pnpm -C guest build</code>.</p>"
        "</body></html>"
    )


@app.get("/listen/{code}", response_class=HTMLResponse)
async def listen(code: str) -> HTMLResponse:  # noqa: ARG001 — code consumed by SPA via URL
    index = GUEST_DIST / "index.html"
    if not index.exists():
        return HTMLResponse(
            "<!doctype html><html><body style='font-family:system-ui;padding:2rem;background:#0a0a0a;color:#eee'>"
            "<h1>Guest page not built</h1>"
            "<p>Run <code>pnpm -C guest install &amp;&amp; pnpm -C guest build</code> first.</p>"
            "</body></html>",
            status_code=503,
        )
    return HTMLResponse(index.read_text())


if GUEST_DIST.exists():
    # Mount built assets under /assets (Vite's default base output dir for chunks).
    assets_dir = GUEST_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="guest-assets")

    @app.get("/{filename}", response_model=None)
    async def root_static(filename: str):
        """Serve root-level static files (favicon, manifest) without shadowing /listen/*."""
        target = GUEST_DIST / filename
        if target.is_file():
            return FileResponse(target)
        index = GUEST_DIST / "index.html"
        return HTMLResponse(index.read_text() if index.exists() else "Not found", status_code=404)
