"""WebSocket signaling + public lookup endpoint."""

from __future__ import annotations

import asyncio
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status

from app.cloudflare_turn import get_cloudflare_ice_servers
from app.config import settings
from app.sessions import (
    SessionFull,
    SessionRole,
    get_session_manager,
    utcnow,
)

HEARTBEAT_TIMEOUT_SECONDS = 5.0
ALLOWED_REACTIONS = {"cheer", "pulse", "wave", "spark"}

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


async def get_ice_servers() -> list[dict[str, Any]]:
    """STUN + TURN. Cloudflare creds are minted/cached per-process. Static
    TURN_SERVER_* env vars are appended for compatibility with self-hosted coturn."""
    servers: list[dict[str, Any]] = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
    ]
    if settings.turn_server_url:
        turn_config: dict[str, Any] = {"urls": settings.turn_server_url}
        if settings.turn_server_username:
            turn_config["username"] = settings.turn_server_username
        if settings.turn_server_credential:
            turn_config["credential"] = settings.turn_server_credential
        servers.append(turn_config)
    servers.extend(await get_cloudflare_ice_servers())
    return servers


@router.get("/by-code/{code}")
async def get_session_by_code(code: str) -> dict[str, Any]:
    """Public lookup — never includes participants or TURN credentials."""
    manager = get_session_manager()
    session = manager.get_session_by_code(code)
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return session.to_dict(include_participants=False)


async def _broadcast_heartbeat(manager: Any, current_user_id: UUID) -> None:
    session = manager.get_user_session(current_user_id)
    if session is None or session.host_id != current_user_id:
        return
    state = session.playback_state
    last = state.last_sync_broadcast_at
    if last is not None and last >= state.updated_at:
        return
    state.last_sync_broadcast_at = utcnow()
    await manager.broadcast(
        session,
        {
            "type": "playback_update",
            "track_id": str(state.track_id) if state.track_id else None,
            "is_playing": state.is_playing,
            "position_ms": state.position_ms,
            "heartbeat": True,
        },
        exclude_user=current_user_id,
    )


@router.websocket("/ws")
async def session_websocket(websocket: WebSocket) -> None:
    """Public signaling WebSocket. Anyone can create or join — the code is the auth.

    Messages — client → server:
      create        {name, username, password?, familiar?}
      join          {code, username, password?, familiar?}            (alias for join_guest)
      join_guest    {code, guest_name, password?, familiar?}
      update_familiar {familiar}
      playback      {track_id, is_playing, position_ms}               (host only)
      sync_request  {}
      chat          {message}
      reaction      {kind}
      kick          {target_user_id}                                  (host only)
      leave         {}
      webrtc_request {}
      webrtc_offer  {target_user_id, sdp}                             (host)
      webrtc_answer {sdp}                                             (guest)
      webrtc_ice    {target_user_id?, candidate}
      webrtc_connected {connected}
    """
    await websocket.accept()
    manager = get_session_manager()
    current_user_id: UUID | None = None

    try:
        while True:
            try:
                data = await asyncio.wait_for(
                    websocket.receive_json(), timeout=HEARTBEAT_TIMEOUT_SECONDS
                )
            except TimeoutError:
                if current_user_id is not None:
                    await _broadcast_heartbeat(manager, current_user_id)
                continue

            msg_type = data.get("type")

            if msg_type == "create":
                username = data.get("username", "Host")
                name = data.get("name", "Listening Session")
                password = data.get("password") or None
                try:
                    session = manager.create_session(
                        host_username=username,
                        name=name,
                        websocket=websocket,
                        password=password,
                        familiar_payload=data.get("familiar"),
                    )
                except SessionFull as e:
                    await websocket.send_json({"type": "error", "message": str(e)})
                    continue

                current_user_id = session.host_id
                await websocket.send_json(
                    {
                        "type": "session_created",
                        "session": session.to_dict(),
                        "your_user_id": str(current_user_id),
                        "ice_servers": await get_ice_servers(),
                    }
                )

            elif msg_type in ("join", "join_guest"):
                code = data.get("code", "").upper()
                username = data.get("guest_name") or data.get("username") or "Guest"
                password = data.get("password") or None

                session = manager.get_session_by_code(code)
                if session is None:
                    await websocket.send_json({"type": "error", "message": "Session not found"})
                    continue

                if not session.webrtc_enabled:
                    await websocket.send_json(
                        {"type": "error", "message": "This session does not allow guest listeners"}
                    )
                    continue

                if not manager.check_password(session, password):
                    await websocket.send_json(
                        {"type": "error", "message": "Invalid session password"}
                    )
                    continue

                role = SessionRole.GUEST if msg_type == "join_guest" else SessionRole.LISTENER
                participant = manager.join_session(
                    session=session,
                    username=username,
                    websocket=websocket,
                    role=role,
                    familiar_payload=data.get("familiar"),
                )
                current_user_id = participant.user_id

                await websocket.send_json(
                    {
                        "type": "session_joined",
                        "session": session.to_dict(),
                        "your_user_id": str(current_user_id),
                        "your_peer_id": participant.peer_id,
                        "ice_servers": await get_ice_servers(),
                    }
                )

                await manager.send_to_host(
                    session,
                    {
                        "type": "guest_joined",
                        "user_id": str(current_user_id),
                        "username": username,
                        "peer_id": participant.peer_id,
                        "familiar": participant.familiar.to_dict(),
                        "participant_count": len(session.participants),
                    },
                )

                await manager.broadcast(
                    session,
                    {
                        "type": "user_joined",
                        "user": {
                            "user_id": str(current_user_id),
                            "username": username,
                            "role": role.value,
                            "familiar": participant.familiar.to_dict(),
                        },
                        "participant_count": len(session.participants),
                    },
                    exclude_user=current_user_id,
                )

            elif msg_type == "playback":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None:
                    continue
                if session.host_id != current_user_id:
                    await websocket.send_json(
                        {"type": "error", "message": "Only the host can control playback"}
                    )
                    continue

                track_id = UUID(data["track_id"]) if data.get("track_id") else None
                is_playing = data.get("is_playing")
                position_ms = data.get("position_ms")
                track_meta = data.get("track_meta")

                manager.update_playback(
                    session,
                    track_id=track_id,
                    is_playing=is_playing,
                    position_ms=position_ms,
                )

                payload: dict[str, Any] = {
                    "type": "playback_update",
                    "track_id": str(track_id) if track_id else None,
                    "is_playing": is_playing,
                    "position_ms": position_ms,
                }
                if isinstance(track_meta, dict):
                    payload["track_meta"] = {
                        k: track_meta.get(k) for k in ("title", "artist", "album") if k in track_meta
                    }
                await manager.broadcast(session, payload, exclude_user=current_user_id)

            elif msg_type == "sync_request":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None:
                    continue
                state = session.playback_state
                await websocket.send_json(
                    {
                        "type": "sync_response",
                        "track_id": str(state.track_id) if state.track_id else None,
                        "is_playing": state.is_playing,
                        "position_ms": state.position_ms,
                    }
                )

            elif msg_type == "chat":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None:
                    continue
                participant = session.participants.get(current_user_id)
                if participant is None:
                    continue
                await manager.broadcast(
                    session,
                    {
                        "type": "chat",
                        "user_id": str(current_user_id),
                        "username": participant.username,
                        "message": data.get("message", ""),
                    },
                )

            elif msg_type == "update_familiar":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None:
                    continue
                participant = manager.update_familiar(current_user_id, data.get("familiar"))
                if participant is None:
                    continue
                await manager.broadcast(
                    session,
                    {
                        "type": "user_updated",
                        "user": {
                            "user_id": str(current_user_id),
                            "username": participant.username,
                            "role": participant.role.value,
                            "familiar": participant.familiar.to_dict(),
                            "joined_at": participant.joined_at.isoformat(),
                            "webrtc_connected": participant.webrtc_connected,
                        },
                    },
                )

            elif msg_type == "reaction":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None:
                    continue
                participant = session.participants.get(current_user_id)
                if participant is None:
                    continue
                kind = data.get("kind")
                if kind not in ALLOWED_REACTIONS:
                    continue
                await manager.broadcast(
                    session,
                    {
                        "type": "user_reaction",
                        "user_id": str(current_user_id),
                        "username": participant.username,
                        "kind": kind,
                        "timestamp": utcnow().isoformat(),
                    },
                )

            elif msg_type == "kick":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None:
                    continue
                target_raw = data.get("target_user_id")
                if not target_raw:
                    continue
                try:
                    target_id = UUID(target_raw)
                except ValueError:
                    continue
                ok = await manager.kick(session, target_id, current_user_id)
                if not ok:
                    await websocket.send_json(
                        {"type": "error", "message": "Cannot kick that participant"}
                    )

            elif msg_type == "webrtc_request":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None:
                    continue
                participant = session.participants.get(current_user_id)
                if participant is None:
                    continue
                await manager.send_to_host(
                    session,
                    {
                        "type": "webrtc_create_offer",
                        "target_user_id": str(current_user_id),
                        "peer_id": participant.peer_id,
                    },
                )

            elif msg_type == "webrtc_offer":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None or session.host_id != current_user_id:
                    continue
                target_user_id = UUID(data.get("target_user_id"))
                await manager.send_to_user(
                    session,
                    target_user_id,
                    {
                        "type": "webrtc_offer",
                        "sdp": data.get("sdp"),
                        "from_user_id": str(current_user_id),
                    },
                )

            elif msg_type == "webrtc_answer":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None:
                    continue
                await manager.send_to_host(
                    session,
                    {
                        "type": "webrtc_answer",
                        "sdp": data.get("sdp"),
                        "from_user_id": str(current_user_id),
                    },
                )

            elif msg_type == "webrtc_ice":
                if not current_user_id:
                    continue
                session = manager.get_user_session(current_user_id)
                if session is None:
                    continue
                target_user_id = data.get("target_user_id")
                if target_user_id:
                    await manager.send_to_user(
                        session,
                        UUID(target_user_id),
                        {
                            "type": "webrtc_ice",
                            "candidate": data.get("candidate"),
                            "from_user_id": str(current_user_id),
                        },
                    )
                else:
                    await manager.send_to_host(
                        session,
                        {
                            "type": "webrtc_ice",
                            "candidate": data.get("candidate"),
                            "from_user_id": str(current_user_id),
                        },
                    )

            elif msg_type == "webrtc_connected":
                if not current_user_id:
                    continue
                connected = data.get("connected", False)
                manager.update_webrtc_state(current_user_id, connected)
                session = manager.get_user_session(current_user_id)
                if session is not None:
                    await manager.broadcast(
                        session,
                        {
                            "type": "webrtc_state_changed",
                            "user_id": str(current_user_id),
                            "connected": connected,
                        },
                        exclude_user=current_user_id,
                    )

            elif msg_type == "leave":
                if current_user_id:
                    session = manager.remove_user(current_user_id)
                    if session is not None and session.participants:
                        await manager.broadcast(
                            session,
                            {
                                "type": "user_left",
                                "user_id": str(current_user_id),
                                "participant_count": len(session.participants),
                            },
                        )
                    current_user_id = None
                await websocket.send_json({"type": "left"})

    except WebSocketDisconnect:
        if current_user_id:
            session = manager.remove_user(current_user_id)
            if session is not None and session.participants:
                await manager.broadcast(
                    session,
                    {
                        "type": "user_left",
                        "user_id": str(current_user_id),
                        "participant_count": len(session.participants),
                        "reason": "disconnected",
                    },
                )
