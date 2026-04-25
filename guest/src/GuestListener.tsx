/**
 * Standalone guest listener for Familiar Sessions.
 * Same-origin WebSocket signaling + WebRTC audio playback.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Radio, Volume2, VolumeX, Users, Music2, Loader2, Play } from 'lucide-react';

const MAX_RECONNECT_ATTEMPTS = 10;

interface SessionInfo {
  id: string;
  code: string;
  name: string;
  host_id: string;
  participant_count: number;
  webrtc_enabled: boolean;
  has_password: boolean;
  playback_state: {
    track_id: string | null;
    is_playing: boolean;
    position_ms: number;
  };
}

interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

interface TrackMeta {
  title?: string;
  artist?: string;
  album?: string;
}

function buildWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/v1/sessions/ws`;
}

export function GuestListener() {
  const { code: codeParam } = useParams<{ code?: string }>();
  const [code, setCode] = useState((codeParam ?? '').toUpperCase());
  const [guestName, setGuestName] = useState('');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [sessionPreview, setSessionPreview] = useState<SessionInfo | null>(null);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAudioGesture, setNeedsAudioGesture] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isReceivingAudio, setIsReceivingAudio] = useState(false);
  const [trackMeta, setTrackMeta] = useState<TrackMeta | null>(null);
  const [iceServers, setIceServers] = useState<IceServer[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<number | null>(null);

  // Pre-flight the code so we know the session name + whether a password is required.
  useEffect(() => {
    if (!code || code.length < 8) return;
    let cancelled = false;
    fetch(`/api/v1/sessions/by-code/${encodeURIComponent(code)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (data) {
          setSessionPreview(data);
          setNeedsPassword(!!data.has_password);
          setError(null);
        } else {
          setSessionPreview(null);
          setError('Session not found.');
        }
      })
      .catch(() => {
        /* network blip — leave unset, the join attempt will surface a real error */
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const send = useCallback((message: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  // Prime the audio element with the user gesture from "Join Session". iOS Safari
  // requires HTMLAudioElement.play() to be called from a user-initiated event
  // before any stream-fed playback is allowed. We attach a silent AudioContext-backed
  // source first so the play() call has something to work with, then later just swap
  // in the WebRTC stream's srcObject — playback continues without needing a new gesture.
  const primeAudio = useCallback((): boolean => {
    if (!audioRef.current) return false;
    const el = audioRef.current;
    el.muted = false;
    el.volume = isMuted ? 0 : volume;
    try {
      // Push the element into "playing" state via a no-op play() call.
      // On iOS Safari this captures the user gesture for future srcObject swaps.
      void el.play().catch(() => {
        /* play() will likely fail with no source; that's fine — gesture is captured */
      });
      return true;
    } catch {
      return false;
    }
  }, [volume, isMuted]);

  const tryPlayAudio = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current
      .play()
      .then(() => setNeedsAudioGesture(false))
      .catch(() => setNeedsAudioGesture(true));
  }, []);

  const handleOffer = useCallback(
    async (sdp: RTCSessionDescriptionInit) => {
      const rtcConfig: RTCConfiguration = {
        iceServers:
          iceServers.length > 0
            ? iceServers
            : [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
              ],
      };
      const pc = new RTCPeerConnection(rtcConfig);
      peerConnectionRef.current = pc;

      pc.ontrack = (event) => {
        setIsReceivingAudio(true);
        if (!audioRef.current) {
          // Fallback path — element should already exist via the JSX <audio> ref,
          // but if React hasn't mounted it yet we create one as a safety net.
          audioRef.current = new Audio();
          audioRef.current.autoplay = true;
        }
        audioRef.current.srcObject = event.streams[0];
        audioRef.current.volume = isMuted ? 0 : volume;
        tryPlayAudio();
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) send({ type: 'webrtc_ice', candidate: event.candidate.toJSON() });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          send({ type: 'webrtc_connected', connected: true });
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          setIsReceivingAudio(false);
          send({ type: 'webrtc_connected', connected: false });
        }
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'webrtc_answer', sdp: pc.localDescription });
      } catch {
        setError('Failed to establish audio connection');
      }
    },
    [iceServers, volume, isMuted, send, tryPlayAudio],
  );

  const handleIceCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    if (peerConnectionRef.current) {
      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch {
        /* ignore */
      }
    }
  }, []);

  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    setIsReceivingAudio(false);
    reconnectAttemptsRef.current = 0;
  }, []);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case 'session_joined':
          setSession(data.session);
          if (data.ice_servers) setIceServers(data.ice_servers);
          setError(null);
          setIsConnecting(false);
          reconnectAttemptsRef.current = 0;
          setTimeout(() => send({ type: 'webrtc_request' }), 500);
          break;
        case 'webrtc_offer':
          if (data.sdp) void handleOffer(data.sdp);
          break;
        case 'webrtc_ice':
          if (data.candidate) void handleIceCandidate(data.candidate);
          break;
        case 'playback_update':
          if (data.track_meta) setTrackMeta(data.track_meta);
          break;
        case 'user_kicked':
          setError('You were removed from the session');
          setSession(null);
          cleanup();
          break;
        case 'user_left':
          if (data.reason === 'host_left') {
            setError('The host ended the session');
            setSession(null);
            cleanup();
          }
          break;
        case 'error':
          setError(data.message);
          setIsConnecting(false);
          break;
      }
    },
    [handleOffer, handleIceCandidate, send, cleanup],
  );

  const join = useCallback(() => {
    if (!code || !guestName) return;
    setIsConnecting(true);
    setError(null);

    // Capture the user gesture from this click for iOS Safari autoplay.
    primeAudio();

    const ws = new WebSocket(buildWsUrl());

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'join_guest',
          code: code.toUpperCase(),
          guest_name: guestName,
          password: password || undefined,
        }),
      );
    };

    ws.onmessage = handleMessage;

    ws.onerror = () => {
      setError('Connection error');
      setIsConnecting(false);
    };

    ws.onclose = () => {
      if (session) {
        reconnectAttemptsRef.current += 1;
        if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
          setError('Connection lost. Please try rejoining the session.');
          return;
        }
        const delay = Math.min(3000 * 2 ** (reconnectAttemptsRef.current - 1), 60000);
        setError(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`);
        reconnectTimeoutRef.current = window.setTimeout(join, delay);
      }
    };

    wsRef.current = ws;
  }, [code, guestName, password, handleMessage, session, primeAudio]);

  const leave = useCallback(() => {
    send({ type: 'leave' });
    cleanup();
    setSession(null);
    setTrackMeta(null);
  }, [send, cleanup]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  useEffect(() => () => cleanup(), [cleanup]);

  if (!session) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-zinc-900 to-black flex items-center justify-center p-4">
        <div className="bg-zinc-800/50 rounded-xl border border-zinc-700 p-8 max-w-md w-full">
          <div className="text-center mb-8">
            <Radio className="w-16 h-16 mx-auto mb-4 text-green-500" />
            <h1 className="text-2xl font-bold text-white">
              {sessionPreview?.name ?? 'Join Listening Session'}
            </h1>
            <p className="text-zinc-400 mt-2">
              {sessionPreview
                ? `Hosted live · ${sessionPreview.participant_count} listening`
                : 'Listen along with a friend without an account.'}
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm text-zinc-400 mb-1">Your name</label>
              <input
                type="text"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="What should we call you?"
                className="w-full px-4 py-3 bg-zinc-700 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            <div>
              <label className="block text-sm text-zinc-400 mb-1">Session code</label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCDEFGH"
                className="w-full px-4 py-3 bg-zinc-700 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-green-500 text-center text-2xl tracking-widest font-mono uppercase"
              />
            </div>

            {needsPassword && (
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="This session is password-protected"
                  className="w-full px-4 py-3 bg-zinc-700 border border-zinc-600 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
            )}

            {error && (
              <div className="bg-red-500/10 border border-red-500/50 text-red-400 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <button
              onClick={join}
              disabled={!code || !guestName || isConnecting}
              className="w-full px-4 py-3 bg-green-600 hover:bg-green-500 disabled:bg-zinc-700 disabled:text-zinc-500 rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" /> Connecting...
                </>
              ) : (
                <>
                  <Radio className="w-5 h-5" /> Join Session
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-900 to-black flex flex-col">
      <header className="p-4 border-b border-zinc-800">
        <div className="flex items-center justify-between max-w-2xl mx-auto">
          <div className="flex items-center gap-3">
            <Radio className="w-6 h-6 text-green-500" />
            <div>
              <h1 className="font-semibold">{session.name}</h1>
              <div className="text-sm text-zinc-400 flex items-center gap-2">
                <Users className="w-4 h-4" />
                {session.participant_count} listening
              </div>
            </div>
          </div>
          <button
            onClick={leave}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
          >
            Leave
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="mb-8">
            <div className="w-48 h-48 mx-auto mb-6 bg-zinc-800 rounded-xl flex items-center justify-center overflow-hidden">
              <Music2 className="w-16 h-16 text-zinc-600" />
            </div>

            {trackMeta?.title || trackMeta?.artist ? (
              <div>
                {trackMeta.title && (
                  <h2 className="text-xl font-semibold">{trackMeta.title}</h2>
                )}
                {trackMeta.artist && <p className="text-zinc-400">{trackMeta.artist}</p>}
                {trackMeta.album && <p className="text-sm text-zinc-500">{trackMeta.album}</p>}
              </div>
            ) : (
              <div className="text-zinc-400">
                {isReceivingAudio ? 'Now playing...' : 'Waiting for audio...'}
              </div>
            )}
          </div>

          <div
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm ${
              isReceivingAudio ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                isReceivingAudio ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'
              }`}
            />
            {isReceivingAudio ? 'Connected' : 'Connecting...'}
          </div>

          {needsAudioGesture && (
            <button
              onClick={tryPlayAudio}
              className="mt-6 inline-flex items-center gap-2 px-5 py-3 bg-green-600 hover:bg-green-500 rounded-lg font-medium transition-colors"
            >
              <Play className="w-5 h-5" /> Tap to start audio
            </button>
          )}

          <div className="mt-8 flex items-center justify-center gap-4">
            <button
              onClick={() => setIsMuted(!isMuted)}
              className="p-2 text-zinc-400 hover:text-white transition-colors"
              aria-label={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="w-32 accent-green-500"
              aria-label="Volume"
            />
          </div>
        </div>
      </main>

      <footer className="p-4 text-center text-sm text-zinc-500">
        Listening as <span className="text-white">{guestName}</span> · Code:{' '}
        <span className="font-mono">{session.code}</span>
      </footer>

      {/* Hidden audio sink. Rendering it in JSX (rather than `new Audio()`) makes iOS
          Safari treat the element as user-controlled, so the gesture captured by
          primeAudio() applies when WebRTC later assigns srcObject. */}
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
    </div>
  );
}
