import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { Crown } from 'lucide-react';

export type FamiliarVariant = 'halo' | 'ember' | 'prism';
export type FamiliarAccent = 'drift' | 'orbit' | 'ripple';
export type ReactionKind = 'cheer' | 'pulse' | 'wave' | 'spark';

export interface FamiliarConfig {
  variant: FamiliarVariant;
  color: string;
  accent: FamiliarAccent;
  seed: number;
}

export interface SessionParticipant {
  user_id: string;
  username: string;
  role: 'host' | 'listener' | 'guest';
  familiar: FamiliarConfig;
  joined_at?: string;
  webrtc_connected?: boolean;
}

export interface SessionReaction {
  user_id: string;
  username?: string;
  kind: ReactionKind;
  timestamp: number;
}

export const FAMILIAR_VARIANTS: FamiliarVariant[] = ['halo', 'ember', 'prism'];
export const FAMILIAR_ACCENTS: FamiliarAccent[] = ['drift', 'orbit', 'ripple'];
export const REACTION_KINDS: ReactionKind[] = ['cheer', 'pulse', 'wave', 'spark'];

const STORAGE_KEY = 'familiar-sessions:guest-familiar';
const DEFAULT_PALETTE = ['#7dd3fc', '#a7f3d0', '#c4b5fd', '#f9a8d4', '#fcd34d', '#fdba74'];

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function withAlpha(hex: string, alpha: string): string {
  return `${hex}${alpha}`;
}

function normalizeColor(value?: string | null): string | null {
  if (!value) return null;
  return /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toLowerCase() : null;
}

export function createGeneratedFamiliar(name: string, color?: string | null): FamiliarConfig {
  const seed = hashString(name || 'Guest');
  return {
    variant: FAMILIAR_VARIANTS[seed % FAMILIAR_VARIANTS.length],
    color: normalizeColor(color) ?? DEFAULT_PALETTE[seed % DEFAULT_PALETTE.length],
    accent: FAMILIAR_ACCENTS[Math.floor(seed / 3) % FAMILIAR_ACCENTS.length],
    seed: seed % 10_000,
  };
}

export function sanitizeFamiliar(
  value: Partial<FamiliarConfig> | null | undefined,
  fallbackName: string,
  fallbackColor?: string | null,
): FamiliarConfig {
  const fallback = createGeneratedFamiliar(fallbackName, fallbackColor);
  return {
    variant: FAMILIAR_VARIANTS.includes(value?.variant as FamiliarVariant)
      ? (value?.variant as FamiliarVariant)
      : fallback.variant,
    color: normalizeColor(value?.color ?? fallbackColor) ?? fallback.color,
    accent: FAMILIAR_ACCENTS.includes(value?.accent as FamiliarAccent)
      ? (value?.accent as FamiliarAccent)
      : fallback.accent,
    seed:
      typeof value?.seed === 'number' && Number.isFinite(value.seed)
        ? Math.max(0, Math.floor(value.seed))
        : fallback.seed,
  };
}

export function loadStoredGuestFamiliar(): FamiliarConfig | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitizeFamiliar(JSON.parse(raw), 'Guest');
  } catch {
    return null;
  }
}

export function saveStoredGuestFamiliar(familiar: FamiliarConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(familiar));
  } catch {
    // Ignore localStorage failures.
  }
}

export interface BeatAnchor {
  bpm: number | null;
  positionMs: number;
  receivedAt: number;
  isPlaying: boolean;
  trackId: string | null;
}

export const FALLBACK_BOB_PERIOD_MS = 2600;
export const BOB_AMPLITUDE_CROWD_PX = 3;
export const BOB_AMPLITUDE_HOST_PX = 4;
export const TRACK_GLOW_DURATION_MS = 1200;

export function computeBeatPhase(anchor: BeatAnchor | null, now: number): number {
  if (!anchor) return 0;
  const elapsed = anchor.isPlaying
    ? Math.max(0, anchor.positionMs + (now - anchor.receivedAt))
    : Math.max(0, now - anchor.receivedAt);
  const period =
    anchor.bpm && anchor.bpm > 0 && Number.isFinite(anchor.bpm)
      ? 60_000 / anchor.bpm
      : FALLBACK_BOB_PERIOD_MS;
  const phase = (elapsed % period) / period;
  return phase >= 0 ? phase : phase + 1;
}

export type SessionRole = 'host' | 'listener' | 'guest';

export interface RoomPosition {
  xPct: number;
  yPct: number;
}

export const STAGE_HOST_POSITION: RoomPosition = { xPct: 50, yPct: 22 };

const CROWD_ROW_Y_PCTS: Record<1 | 2 | 3, number[]> = {
  1: [66],
  2: [56, 80],
  3: [50, 68, 84],
};
const CROWD_X_INSET = 10;

function pickRowCount(totalCrowd: number): 1 | 2 | 3 {
  if (totalCrowd <= 4) return 1;
  if (totalCrowd <= 8) return 2;
  return 3;
}

export function computeRoomPosition(
  participant: { user_id: string; role: SessionRole },
  indexAmongCrowd: number,
  totalCrowd: number,
): RoomPosition {
  if (participant.role === 'host') {
    return { ...STAGE_HOST_POSITION };
  }
  const safeTotal = Math.max(1, totalCrowd);
  const rows = pickRowCount(safeTotal);
  const perRow = Math.ceil(safeTotal / rows);
  const row = Math.min(rows - 1, Math.floor(indexAmongCrowd / perRow));
  const col = indexAmongCrowd % perRow;
  const innerWidth = 100 - 2 * CROWD_X_INSET;
  const colCenter =
    perRow === 1 ? 50 : CROWD_X_INSET + (col + 0.5) * (innerWidth / perRow);
  const yBase = CROWD_ROW_Y_PCTS[rows][row];
  const seed = hashString(participant.user_id);
  const xJitter = ((seed % 100) / 100 - 0.5) * 6;
  const yJitter = (((seed >> 8) % 100) / 100 - 0.5) * 4;
  const xPct = Math.max(6, Math.min(94, colCenter + xJitter));
  const yPct = Math.max(50, Math.min(96, yBase + yJitter));
  return { xPct, yPct };
}

function familiarSurfaceStyle(familiar: FamiliarConfig): CSSProperties {
  return {
    background: `radial-gradient(circle at 30% 30%, ${withAlpha(familiar.color, 'cc')}, ${withAlpha(familiar.color, '0d')} 65%, transparent 100%)`,
    boxShadow: `0 0 0 1px ${withAlpha(familiar.color, '33')}, 0 18px 35px ${withAlpha(familiar.color, '22')}`,
  };
}

function FamiliarGlyph({ familiar, size = 'md' }: { familiar: FamiliarConfig; size?: 'sm' | 'md' }) {
  const wrapperSize = size === 'sm' ? 'w-9 h-9' : 'w-14 h-14';
  const coreSize = size === 'sm' ? 'w-4 h-4' : 'w-6 h-6';
  return (
    <div className={`${wrapperSize} relative rounded-full backdrop-blur-sm overflow-hidden`} style={familiarSurfaceStyle(familiar)}>
      <div
        className={`absolute inset-2 rounded-full border ${familiar.accent === 'ripple' ? 'animate-pulse' : ''}`}
        style={{ borderColor: withAlpha(familiar.color, '55') }}
      />
      {familiar.accent === 'orbit' && (
        <div className="absolute inset-1 rounded-full border border-white/10 animate-[spin_10s_linear_infinite]">
          <span
            className="absolute -top-0.5 left-1/2 w-1.5 h-1.5 -translate-x-1/2 rounded-full"
            style={{ backgroundColor: familiar.color }}
          />
        </div>
      )}
      <div className="absolute inset-0 flex items-center justify-center">
        {familiar.variant === 'halo' && (
          <div
            className={`${coreSize} rounded-full border`}
            style={{ borderColor: familiar.color, boxShadow: `0 0 18px ${withAlpha(familiar.color, '55')}` }}
          />
        )}
        {familiar.variant === 'ember' && (
          <>
            <div className={`${coreSize} rounded-full blur-sm opacity-75`} style={{ backgroundColor: withAlpha(familiar.color, '88') }} />
            <div className={`${coreSize} absolute rounded-full`} style={{ backgroundColor: withAlpha(familiar.color, 'dd') }} />
          </>
        )}
        {familiar.variant === 'prism' && (
          <div
            className={`${coreSize} rotate-45 rounded-[0.4rem] border`}
            style={{ borderColor: familiar.color, backgroundColor: withAlpha(familiar.color, '33') }}
          />
        )}
      </div>
      {familiar.accent === 'drift' && (
        <div className="absolute inset-x-3 bottom-2 h-px rounded-full opacity-80" style={{ backgroundColor: withAlpha(familiar.color, 'aa') }} />
      )}
    </div>
  );
}

export function FamiliarPicker({
  value,
  onChange,
}: {
  value: FamiliarConfig;
  onChange: (next: FamiliarConfig) => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-800/70 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-zinc-100">Your familiar</div>
          <div className="text-xs text-zinc-500">A minimal presence object others will see in the room</div>
        </div>
        <FamiliarGlyph familiar={value} size="sm" />
      </div>

      <div className="grid grid-cols-3 gap-2">
        {FAMILIAR_VARIANTS.map((variant) => (
          <button
            key={variant}
            type="button"
            onClick={() => onChange({ ...value, variant })}
            className={`rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs capitalize text-zinc-200 transition-colors ${
              value.variant === variant ? 'ring-1 ring-emerald-500/50' : ''
            }`}
          >
            {variant}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        {DEFAULT_PALETTE.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Set familiar color ${color}`}
            onClick={() => onChange({ ...value, color })}
            className={`h-8 flex-1 rounded-full border ${value.color === color ? 'ring-2 ring-emerald-500/50 ring-offset-1 ring-offset-zinc-900' : ''}`}
            style={{ backgroundColor: color, borderColor: withAlpha(color, '66') }}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {FAMILIAR_ACCENTS.map((accent) => (
          <button
            key={accent}
            type="button"
            onClick={() => onChange({ ...value, accent })}
            className={`rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-xs capitalize text-zinc-200 transition-colors ${
              value.accent === accent ? 'ring-1 ring-emerald-500/50' : ''
            }`}
          >
            {accent}
          </button>
        ))}
      </div>
    </div>
  );
}

const reactionCopy: Record<ReactionKind, string> = {
  cheer: 'Cheer',
  pulse: 'Pulse',
  wave: 'Wave',
  spark: 'Spark',
};

export function ReactionBar({ onReact }: { onReact: (kind: ReactionKind) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {REACTION_KINDS.map((reaction) => (
        <button
          key={reaction}
          type="button"
          onClick={() => onReact(reaction)}
          className="rounded-full border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-zinc-200 transition-colors hover:bg-zinc-700"
        >
          {reactionCopy[reaction]}
        </button>
      ))}
    </div>
  );
}

function useStageBeat(
  anchor: BeatAnchor | null | undefined,
  stageRef: RefObject<HTMLDivElement | null>,
) {
  const lastTrackIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let raf = 0;
    const loop = () => {
      const now = Date.now();
      const phase = computeBeatPhase(anchor ?? null, now);
      const sinPhase = Math.sin(phase * 2 * Math.PI);
      stage.style.setProperty('--bob-y', `${sinPhase * BOB_AMPLITUDE_CROWD_PX}px`);
      stage.style.setProperty('--bob-y-host', `${sinPhase * BOB_AMPLITUDE_HOST_PX}px`);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [anchor, stageRef]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const trackId = anchor?.trackId ?? null;
    const previous = lastTrackIdRef.current;
    lastTrackIdRef.current = trackId;
    if (previous === undefined) return;
    if (previous === trackId) return;
    if (!trackId) return;
    stage.classList.add('familiar-room-glowing');
    const timer = window.setTimeout(() => {
      stage.classList.remove('familiar-room-glowing');
    }, TRACK_GLOW_DURATION_MS);
    return () => {
      window.clearTimeout(timer);
      stage.classList.remove('familiar-room-glowing');
    };
  }, [anchor?.trackId, stageRef]);
}

export function FamiliarRoom({
  participants,
  reactions,
  myUserId,
  beatAnchor,
}: {
  participants: SessionParticipant[];
  reactions: SessionReaction[];
  myUserId?: string | null;
  beatAnchor?: BeatAnchor | null;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  useStageBeat(beatAnchor, stageRef);

  const latestReactionByUser = new Map<string, SessionReaction>();
  for (const reaction of reactions) latestReactionByUser.set(reaction.user_id, reaction);

  const host = participants.find((p) => p.role === 'host') ?? null;
  const crowd = participants
    .filter((p) => p.role !== 'host')
    .slice()
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));

  return (
    <div className="rounded-2xl border border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">The Room</div>
        <div className="text-xs text-zinc-500">{participants.length} present</div>
      </div>
      <div ref={stageRef} className="relative w-full aspect-[3/2] bg-[radial-gradient(ellipse_at_top,_rgba(39,39,42,0.95),_rgba(17,17,20,0.98)_55%,_rgba(9,9,11,1))]">
        <div
          className="absolute left-0 right-0 h-px bg-zinc-700/40"
          style={{ top: '44%' }}
          aria-hidden
        />
        <div
          className="absolute left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.28em] text-zinc-500"
          style={{ top: '4%' }}
          aria-hidden
        >
          DJ Booth
        </div>

        {host && (
          <RoomAvatar
            participant={host}
            position={computeRoomPosition(host, 0, 0)}
            isHost
            isSelf={host.user_id === myUserId}
            isLive
            reaction={latestReactionByUser.get(host.user_id)}
          />
        )}

        {crowd.map((participant, index) => (
          <RoomAvatar
            key={participant.user_id}
            participant={participant}
            position={computeRoomPosition(participant, index, crowd.length)}
            isHost={false}
            isSelf={participant.user_id === myUserId}
            isLive={participant.webrtc_connected ?? false}
            reaction={latestReactionByUser.get(participant.user_id)}
          />
        ))}
      </div>
    </div>
  );
}

function RoomAvatar({
  participant,
  position,
  isHost,
  isSelf,
  isLive,
  reaction,
}: {
  participant: SessionParticipant;
  position: RoomPosition;
  isHost: boolean;
  isSelf: boolean;
  isLive: boolean;
  reaction?: SessionReaction;
}) {
  const bobVar = isHost ? 'var(--bob-y-host, 0px)' : 'var(--bob-y, 0px)';
  const wrapperStyle: CSSProperties = {
    left: `${position.xPct}%`,
    top: `${position.yPct}%`,
    transform: `translate(-50%, calc(-50% + ${bobVar}))`,
  };
  const reactionKey = reaction
    ? `${reaction.user_id}-${reaction.kind}-${reaction.timestamp}`
    : undefined;

  return (
    <div className="absolute pointer-events-none" style={wrapperStyle}>
      {reaction && (
        <div
          key={reactionKey}
          className="absolute left-1/2 -top-3 rounded-full px-1.5 py-px text-[9px] uppercase tracking-[0.18em] whitespace-nowrap border bg-zinc-950 text-zinc-200 border-zinc-700"
          style={{ animation: 'familiar-reaction-rise 4s ease-out forwards' }}
          aria-hidden
        >
          {reactionCopy[reaction.kind]}
        </div>
      )}
      {isHost && (
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded-[50%]"
          style={{
            top: 'calc(100% - 8px)',
            width: '64px',
            height: '14px',
            background: `radial-gradient(ellipse at center, ${withAlpha(participant.familiar.color, '55')}, transparent 70%)`,
            filter: 'blur(2px)',
          }}
          aria-hidden
        />
      )}
      <div
        className={`relative ${isSelf ? 'ring-2 ring-emerald-400/60 ring-offset-2 ring-offset-transparent rounded-full' : ''}`}
      >
        <FamiliarGlyph familiar={participant.familiar} size={isHost ? 'md' : 'sm'} />
        {isHost && (
          <Crown
            className="absolute -top-3 left-1/2 -translate-x-1/2 w-3.5 h-3.5 text-yellow-400"
            aria-hidden
          />
        )}
        {!isLive && !isHost && (
          <div className="absolute inset-0 rounded-full bg-black/30" aria-hidden />
        )}
      </div>
      <div
        className="absolute left-1/2 -translate-x-1/2 mt-1 text-[9px] font-medium truncate max-w-[64px] text-center text-zinc-300"
        style={{ top: '100%' }}
      >
        {participant.username}
        {isSelf && <span className="ml-1 text-zinc-500">(you)</span>}
      </div>
    </div>
  );
}
