"""In-memory listening sessions + WebRTC signaling state."""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

import bcrypt
from fastapi import WebSocket

MAX_CONCURRENT_SESSIONS = 50
DEFAULT_FAMILIAR_COLOR = "#7dd3fc"
ALLOWED_FAMILIAR_VARIANTS = {"halo", "ember", "prism"}
ALLOWED_FAMILIAR_ACCENTS = {"drift", "orbit", "ripple"}


def utcnow() -> datetime:
    return datetime.now(UTC)


class SessionRole(StrEnum):
    HOST = "host"
    LISTENER = "listener"
    GUEST = "guest"


class SessionFull(Exception):
    """Raised when SessionManager has hit MAX_CONCURRENT_SESSIONS."""


@dataclass(frozen=True)
class Familiar:
    variant: str
    color: str
    accent: str
    seed: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "variant": self.variant,
            "color": self.color,
            "accent": self.accent,
            "seed": self.seed,
        }


def _normalize_color(value: Any) -> str:
    if not isinstance(value, str):
        return DEFAULT_FAMILIAR_COLOR
    text = value.strip()
    if len(text) == 7 and text.startswith("#") and all(c in "0123456789abcdefABCDEF" for c in text[1:]):
        return text.lower()
    return DEFAULT_FAMILIAR_COLOR


def sanitize_familiar(payload: Any, fallback_seed_source: str) -> Familiar:
    data = payload if isinstance(payload, dict) else {}
    variant = data.get("variant")
    if variant not in ALLOWED_FAMILIAR_VARIANTS:
        variant = "halo"
    accent = data.get("accent")
    if accent not in ALLOWED_FAMILIAR_ACCENTS:
        accent = "drift"
    seed_raw = data.get("seed")
    if not isinstance(seed_raw, int):
        seed_raw = sum(ord(ch) for ch in fallback_seed_source) % 10_000
    return Familiar(
        variant=variant,
        color=_normalize_color(data.get("color")),
        accent=accent,
        seed=max(0, seed_raw),
    )


@dataclass
class Participant:
    user_id: UUID
    username: str
    websocket: WebSocket
    role: SessionRole
    familiar: Familiar
    joined_at: datetime = field(default_factory=utcnow)
    webrtc_connected: bool = False
    peer_id: str | None = None


@dataclass
class PlaybackState:
    track_id: UUID | None = None
    is_playing: bool = False
    position_ms: int = 0
    updated_at: datetime = field(default_factory=utcnow)
    last_sync_broadcast_at: datetime | None = None


@dataclass
class ListeningSession:
    id: str
    code: str
    name: str
    host_id: UUID
    created_at: datetime = field(default_factory=utcnow)
    participants: dict[UUID, Participant] = field(default_factory=dict)
    playback_state: PlaybackState = field(default_factory=PlaybackState)
    webrtc_enabled: bool = True
    password_hash: str | None = None

    def to_dict(self, include_participants: bool = True) -> dict[str, Any]:
        result: dict[str, Any] = {
            "id": self.id,
            "code": self.code,
            "name": self.name,
            "host_id": str(self.host_id),
            "created_at": self.created_at.isoformat(),
            "participant_count": len(self.participants),
            "webrtc_enabled": self.webrtc_enabled,
            "has_password": self.password_hash is not None,
            "playback_state": {
                "track_id": str(self.playback_state.track_id) if self.playback_state.track_id else None,
                "is_playing": self.playback_state.is_playing,
                "position_ms": self.playback_state.position_ms,
            },
        }
        if include_participants:
            result["participants"] = [
                {
                    "user_id": str(p.user_id),
                    "username": p.username,
                    "role": p.role.value,
                    "familiar": p.familiar.to_dict(),
                    "joined_at": p.joined_at.isoformat(),
                    "webrtc_connected": p.webrtc_connected,
                }
                for p in self.participants.values()
            ]
        return result


def _hash_password(plaintext: str) -> str:
    return bcrypt.hashpw(plaintext.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def _check_password(plaintext: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plaintext.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, ListeningSession] = {}
        self._user_sessions: dict[UUID, str] = {}
        self._code_to_session: dict[str, str] = {}

    def _generate_code(self) -> str:
        for _ in range(20):
            raw = secrets.token_urlsafe(8).replace("-", "").replace("_", "")
            code = raw.upper()[:11]
            if len(code) >= 8 and code not in self._code_to_session:
                return code
        raise RuntimeError("Could not generate a unique session code")

    def create_session(
        self,
        host_username: str,
        name: str,
        websocket: WebSocket,
        password: str | None = None,
        familiar_payload: Any = None,
    ) -> ListeningSession:
        if len(self._sessions) >= MAX_CONCURRENT_SESSIONS:
            raise SessionFull(f"Server is at the {MAX_CONCURRENT_SESSIONS}-session limit")

        host_id = uuid4()
        session_id = secrets.token_urlsafe(16)
        code = self._generate_code()

        session = ListeningSession(
            id=session_id,
            code=code,
            name=name,
            host_id=host_id,
            password_hash=_hash_password(password) if password else None,
        )
        host = Participant(
            user_id=host_id,
            username=host_username,
            websocket=websocket,
            role=SessionRole.HOST,
            familiar=sanitize_familiar(familiar_payload, host_username),
        )
        session.participants[host_id] = host

        self._sessions[session_id] = session
        self._user_sessions[host_id] = session_id
        self._code_to_session[code] = session_id

        return session

    def get_session(self, session_id: str) -> ListeningSession | None:
        return self._sessions.get(session_id)

    def get_session_by_code(self, code: str) -> ListeningSession | None:
        session_id = self._code_to_session.get(code.upper())
        return self._sessions.get(session_id) if session_id else None

    def get_user_session(self, user_id: UUID) -> ListeningSession | None:
        session_id = self._user_sessions.get(user_id)
        return self._sessions.get(session_id) if session_id else None

    def check_password(self, session: ListeningSession, password: str | None) -> bool:
        if session.password_hash is None:
            return True
        if not password:
            return False
        return _check_password(password, session.password_hash)

    def join_session(
        self,
        session: ListeningSession,
        username: str,
        websocket: WebSocket,
        role: SessionRole = SessionRole.LISTENER,
        familiar_payload: Any = None,
    ) -> Participant:
        user_id = uuid4()
        peer_id = secrets.token_urlsafe(8)
        participant = Participant(
            user_id=user_id,
            username=username,
            websocket=websocket,
            role=role,
            familiar=sanitize_familiar(familiar_payload, username),
            peer_id=peer_id,
        )
        session.participants[user_id] = participant
        self._user_sessions[user_id] = session.id
        return participant

    def get_host(self, session: ListeningSession) -> Participant | None:
        return session.participants.get(session.host_id)

    async def send_to_user(
        self,
        session: ListeningSession,
        user_id: UUID,
        message: dict[str, Any],
    ) -> bool:
        participant = session.participants.get(user_id)
        if not participant:
            return False
        try:
            await participant.websocket.send_json(message)
            return True
        except Exception:
            self.remove_user(user_id)
            return False

    async def send_to_host(self, session: ListeningSession, message: dict[str, Any]) -> bool:
        return await self.send_to_user(session, session.host_id, message)

    def update_webrtc_state(self, user_id: UUID, connected: bool) -> None:
        session = self.get_user_session(user_id)
        if session:
            participant = session.participants.get(user_id)
            if participant:
                participant.webrtc_connected = connected

    def update_familiar(self, user_id: UUID, payload: Any) -> Participant | None:
        session = self.get_user_session(user_id)
        if session is None:
            return None
        participant = session.participants.get(user_id)
        if participant is None:
            return None
        participant.familiar = sanitize_familiar(payload, participant.username)
        return participant

    def remove_user(self, user_id: UUID) -> ListeningSession | None:
        session_id = self._user_sessions.pop(user_id, None)
        if not session_id:
            return None
        session = self._sessions.get(session_id)
        if not session:
            return None
        session.participants.pop(user_id, None)
        if user_id == session.host_id or not session.participants:
            self._end_session(session)
        return session

    async def kick(
        self,
        session: ListeningSession,
        target_id: UUID,
        requester_id: UUID,
    ) -> bool:
        if requester_id != session.host_id:
            return False
        if target_id == session.host_id or target_id not in session.participants:
            return False

        target = session.participants[target_id]
        try:
            await target.websocket.send_json(
                {"type": "user_kicked", "user_id": str(target_id), "reason": "host_kicked"}
            )
            await target.websocket.close(code=1000, reason="kicked")
        except Exception:
            pass

        self.remove_user(target_id)
        await self.broadcast(
            session,
            {"type": "user_left", "user_id": str(target_id), "reason": "kicked"},
        )
        return True

    def _end_session(self, session: ListeningSession) -> None:
        self._code_to_session.pop(session.code, None)
        self._sessions.pop(session.id, None)
        for user_id in list(session.participants.keys()):
            self._user_sessions.pop(user_id, None)

    def update_playback(
        self,
        session: ListeningSession,
        track_id: UUID | None = None,
        is_playing: bool | None = None,
        position_ms: int | None = None,
    ) -> None:
        if track_id is not None:
            session.playback_state.track_id = track_id
        if is_playing is not None:
            session.playback_state.is_playing = is_playing
        if position_ms is not None:
            session.playback_state.position_ms = position_ms
        session.playback_state.updated_at = utcnow()

    async def broadcast(
        self,
        session: ListeningSession,
        message: dict[str, Any],
        exclude_user: UUID | None = None,
    ) -> None:
        disconnected = []
        for user_id, participant in session.participants.items():
            if user_id == exclude_user:
                continue
            try:
                await participant.websocket.send_json(message)
            except Exception:
                disconnected.append(user_id)
        for user_id in disconnected:
            self.remove_user(user_id)


_session_manager: SessionManager | None = None


def get_session_manager() -> SessionManager:
    global _session_manager
    if _session_manager is None:
        _session_manager = SessionManager()
    return _session_manager


def reset_session_manager() -> None:
    global _session_manager
    _session_manager = None
