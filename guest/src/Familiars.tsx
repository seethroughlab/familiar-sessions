import type { CSSProperties } from 'react';

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

export function FamiliarRoom({
  participants,
  reactions,
  myUserId,
}: {
  participants: SessionParticipant[];
  reactions: SessionReaction[];
  myUserId?: string | null;
}) {
  const latestReactionByUser = new Map<string, SessionReaction>();
  for (const reaction of reactions) latestReactionByUser.set(reaction.user_id, reaction);

  return (
    <div className="rounded-2xl border border-zinc-800 bg-[radial-gradient(circle_at_top,_rgba(39,39,42,0.92),_rgba(9,9,11,0.98))] p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-zinc-100">Mini Room</div>
          <div className="text-xs text-zinc-500">Familiars brighten briefly when someone reacts</div>
        </div>
        <div className="text-xs text-zinc-500">{participants.length} present</div>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        {participants.map((participant) => {
          const reaction = latestReactionByUser.get(participant.user_id);
          const isLive = participant.role === 'host' || participant.webrtc_connected;
          const isSelf = participant.user_id === myUserId;
          return (
            <div
              key={participant.user_id}
              className={`relative w-24 rounded-xl border border-zinc-800 bg-black/20 px-2 py-3 text-center ${isSelf ? 'ring-1 ring-emerald-500/40' : ''}`}
            >
              {reaction && (
                <div className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-zinc-200">
                  {reactionCopy[reaction.kind]}
                </div>
              )}
              <div className="mb-2 flex justify-center">
                <FamiliarGlyph familiar={participant.familiar} />
              </div>
              <div className="truncate text-xs font-medium text-zinc-200">{participant.username}</div>
              <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-zinc-500">{participant.role}</div>
              <div className="mt-2 flex items-center justify-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.7)]' : 'bg-zinc-500'}`} />
                <span className="text-[10px] text-zinc-500">{isLive ? 'Live' : 'Idle'}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
