"""WebSocket integration tests for the public session relay."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.sessions import reset_session_manager


@pytest.fixture(autouse=True)
def _reset() -> None:
    reset_session_manager()
    yield
    reset_session_manager()


@pytest.fixture(scope="module")
def client() -> TestClient:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _send(ws: Any, message: dict[str, Any]) -> None:
    ws.send_json(message)


def _drain_until(ws: Any, msg_type: str, max_msgs: int = 12) -> dict[str, Any]:
    for _ in range(max_msgs):
        msg = ws.receive_json()
        if msg.get("type") == msg_type:
            return msg
    raise AssertionError(f"Did not receive {msg_type!r} within {max_msgs} messages")


def test_create_join_playback_leave(client: TestClient) -> None:
    with client.websocket_connect("/api/v1/sessions/ws") as host_ws:
        _send(host_ws, {"type": "create", "name": "Friday", "username": "Alice"})
        created = host_ws.receive_json()
        assert created["type"] == "session_created"
        code = created["session"]["code"]
        assert len(code) >= 8
        assert "your_user_id" in created
        assert created["session"]["has_password"] is False

        with client.websocket_connect("/api/v1/sessions/ws") as guest_ws:
            _send(guest_ws, {"type": "join_guest", "code": code, "guest_name": "Bob"})
            joined = guest_ws.receive_json()
            assert joined["type"] == "session_joined"
            assert joined["session"]["participant_count"] == 2

            # Drain host's notifications (guest_joined + user_joined)
            saw = {host_ws.receive_json()["type"], host_ws.receive_json()["type"]}
            assert saw == {"guest_joined", "user_joined"}

            track = "11111111-1111-1111-1111-111111111111"
            _send(
                host_ws,
                {"type": "playback", "track_id": track, "is_playing": True, "position_ms": 1234},
            )
            update = _drain_until(guest_ws, "playback_update")
            assert update["track_id"] == track
            assert update["is_playing"] is True
            assert update["position_ms"] == 1234

            _send(guest_ws, {"type": "leave"})
            assert guest_ws.receive_json()["type"] == "left"

        host_left = host_ws.receive_json()
        assert host_left["type"] == "user_left"


def test_invalid_code_rejected(client: TestClient) -> None:
    with client.websocket_connect("/api/v1/sessions/ws") as ws:
        _send(ws, {"type": "join_guest", "code": "DOESNOTEXIST", "guest_name": "X"})
        msg = ws.receive_json()
        assert msg["type"] == "error"
        assert "not found" in msg["message"].lower()


def test_password_required(client: TestClient) -> None:
    with client.websocket_connect("/api/v1/sessions/ws") as host_ws:
        _send(
            host_ws,
            {"type": "create", "name": "Locked", "username": "Host", "password": "open-sesame"},
        )
        created = host_ws.receive_json()
        assert created["session"]["has_password"] is True
        code = created["session"]["code"]

        with client.websocket_connect("/api/v1/sessions/ws") as ws:
            _send(ws, {"type": "join_guest", "code": code, "guest_name": "x"})
            err = ws.receive_json()
            assert err["type"] == "error"

        with client.websocket_connect("/api/v1/sessions/ws") as ws:
            _send(
                ws,
                {
                    "type": "join_guest",
                    "code": code,
                    "guest_name": "x",
                    "password": "open-sesame",
                },
            )
            ok = ws.receive_json()
            assert ok["type"] == "session_joined"


def test_kick(client: TestClient) -> None:
    with client.websocket_connect("/api/v1/sessions/ws") as host_ws:
        _send(host_ws, {"type": "create", "name": "T", "username": "Host"})
        code = host_ws.receive_json()["session"]["code"]

        with client.websocket_connect("/api/v1/sessions/ws") as guest_ws:
            _send(guest_ws, {"type": "join_guest", "code": code, "guest_name": "G"})
            joined = guest_ws.receive_json()
            target_id = joined["your_user_id"]
            host_ws.receive_json()
            host_ws.receive_json()

            _send(host_ws, {"type": "kick", "target_user_id": target_id})
            kicked = guest_ws.receive_json()
            assert kicked["type"] == "user_kicked"
            assert kicked["user_id"] == target_id

        host_left = host_ws.receive_json()
        assert host_left["type"] == "user_left"
        assert host_left.get("reason") == "kicked"


def test_by_code_excludes_participants_and_credentials(client: TestClient) -> None:
    with client.websocket_connect("/api/v1/sessions/ws") as host_ws:
        _send(host_ws, {"type": "create", "name": "T", "username": "Host"})
        code = host_ws.receive_json()["session"]["code"]

        resp = client.get(f"/api/v1/sessions/by-code/{code}")
        assert resp.status_code == 200
        body = resp.json()
        assert "participants" not in body
        assert "ice_servers" not in body
        assert body["has_password"] is False


def test_by_code_404(client: TestClient) -> None:
    resp = client.get("/api/v1/sessions/by-code/MISSING1234")
    assert resp.status_code == 404


def test_health(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "healthy"}
