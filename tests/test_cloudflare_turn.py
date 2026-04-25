"""Tests for the Cloudflare Realtime TURN credential cache."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

import app.cloudflare_turn as cf
from app.config import settings


class _FakeResponse:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "boom",
                request=httpx.Request("POST", "https://example"),
                response=httpx.Response(self.status_code),
            )

    def json(self) -> Any:
        return self._payload


def _install_fake_client(monkeypatch: pytest.MonkeyPatch, responses: list[Any]) -> list[dict[str, Any]]:
    """Replace httpx.AsyncClient with a fake that pops from `responses` per POST.
    Returns a list that records each call as {url, json, headers}."""
    calls: list[dict[str, Any]] = []
    queue = list(responses)

    class _FakeClient:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> "_FakeClient":
            return self

        async def __aexit__(self, *_exc: Any) -> bool:
            return False

        async def post(
            self, url: str, json: Any = None, headers: dict[str, str] | None = None
        ) -> Any:
            calls.append({"url": url, "json": json, "headers": headers})
            if not queue:
                raise AssertionError("Unexpected extra HTTP call")
            value = queue.pop(0)
            if isinstance(value, Exception):
                raise value
            return value

    monkeypatch.setattr(cf.httpx, "AsyncClient", _FakeClient)
    return calls


@pytest.fixture(autouse=True)
def _reset_cache_and_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    cf.reset_cloudflare_cache()
    monkeypatch.setattr(settings, "cloudflare_turn_token_id", None)
    monkeypatch.setattr(settings, "cloudflare_turn_api_token", None)
    yield
    cf.reset_cloudflare_cache()


async def test_returns_empty_when_unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _install_fake_client(monkeypatch, [])
    result = await cf.get_cloudflare_ice_servers()
    assert result == []
    assert calls == []


async def test_fetches_and_caches_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "cloudflare_turn_token_id", "tok-id")
    monkeypatch.setattr(settings, "cloudflare_turn_api_token", "api-token")
    payload = {
        "iceServers": [
            {"urls": ["turn:turn.cloudflare.com:3478"], "username": "u", "credential": "c"}
        ]
    }
    calls = _install_fake_client(monkeypatch, [_FakeResponse(200, payload)])

    first = await cf.get_cloudflare_ice_servers()
    second = await cf.get_cloudflare_ice_servers()

    assert first == payload["iceServers"]
    assert second == payload["iceServers"]
    assert len(calls) == 1, "Second call should have hit the cache, not the API"
    assert "tok-id" in calls[0]["url"]
    assert calls[0]["headers"]["Authorization"] == "Bearer api-token"


async def test_falls_back_to_stale_cache_on_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "cloudflare_turn_token_id", "tok-id")
    monkeypatch.setattr(settings, "cloudflare_turn_api_token", "api-token")
    good_payload = {"iceServers": [{"urls": ["turn:t1"], "username": "u", "credential": "c"}]}
    _install_fake_client(monkeypatch, [_FakeResponse(200, good_payload)])
    first = await cf.get_cloudflare_ice_servers()
    assert first == good_payload["iceServers"]

    # Force the cache to look expired so the next call re-fetches and hits the error
    cf._cache_expires_at = 0.0
    _install_fake_client(monkeypatch, [httpx.ConnectError("network down")])

    second = await cf.get_cloudflare_ice_servers()
    assert second == good_payload["iceServers"], "Should serve stale cache when refresh fails"


async def test_returns_empty_on_error_with_no_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "cloudflare_turn_token_id", "tok-id")
    monkeypatch.setattr(settings, "cloudflare_turn_api_token", "api-token")
    _install_fake_client(monkeypatch, [httpx.ConnectError("network down")])

    result = await cf.get_cloudflare_ice_servers()
    assert result == []


async def test_returns_empty_on_malformed_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "cloudflare_turn_token_id", "tok-id")
    monkeypatch.setattr(settings, "cloudflare_turn_api_token", "api-token")
    _install_fake_client(monkeypatch, [_FakeResponse(200, {"unexpected": "shape"})])

    result = await cf.get_cloudflare_ice_servers()
    assert result == []
