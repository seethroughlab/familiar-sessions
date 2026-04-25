"""Mint and cache short-lived Cloudflare Realtime TURN credentials.

Cloudflare's TURN doesn't use static credentials — the API key is used to mint
ephemeral creds via their REST API. We cache them per-process and refresh
~10 minutes before expiry to avoid hitting Cloudflare on every session join.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from app.config import settings

_cache: list[dict[str, Any]] | None = None
_cache_expires_at: float = 0.0
_lock = asyncio.Lock()

# Mint creds with a long TTL and refresh well before expiry. 24 h * 0.9 = 21.6 h cache.
_TTL_SECONDS = 86400
_REFRESH_BEFORE_EXPIRY_SECONDS = 600


async def get_cloudflare_ice_servers() -> list[dict[str, Any]]:
    """Return Cloudflare's iceServers list (cached). Empty list if unconfigured or on error."""
    global _cache, _cache_expires_at

    if not settings.cloudflare_turn_token_id or not settings.cloudflare_turn_api_token:
        return []

    if _cache is not None and time.time() < _cache_expires_at - _REFRESH_BEFORE_EXPIRY_SECONDS:
        return _cache

    async with _lock:
        # Double-checked under lock so concurrent callers don't all hit the API
        if _cache is not None and time.time() < _cache_expires_at - _REFRESH_BEFORE_EXPIRY_SECONDS:
            return _cache

        url = (
            f"https://rtc.live.cloudflare.com/v1/turn/keys/"
            f"{settings.cloudflare_turn_token_id}/credentials/generate-ice-servers"
        )
        headers = {
            "Authorization": f"Bearer {settings.cloudflare_turn_api_token}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(url, json={"ttl": _TTL_SECONDS}, headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except Exception:
            # On failure, keep any prior cache so the service stays up
            return _cache or []

        servers = data.get("iceServers")
        if not isinstance(servers, list):
            return _cache or []

        _cache = servers
        _cache_expires_at = time.time() + _TTL_SECONDS
        return servers


def reset_cloudflare_cache() -> None:
    """Test helper."""
    global _cache, _cache_expires_at
    _cache = None
    _cache_expires_at = 0.0
