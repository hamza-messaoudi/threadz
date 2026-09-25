import { useCallback, useSyncExternalStore } from 'react';
import { defineSound, ensureReady } from '@web-kits/audio';
import * as retro from '../audio/retro.ts';

/**
 * UI sounds from the @web-kits/audio retro kit. A few cues for moments worth hearing; every one has a
 * visual equivalent, so muting loses nothing. Off by default under prefers-reduced-motion (there is no
 * reduced-audio query); an explicit choice in Settings wins either way.
 */
export interface SoundSettings {
  on: boolean;
  /** 0 – 1, on top of each cue's own (quiet) gain and the system volume. */
  volume: number;
}

export const DEFAULT_VOLUME = 0.5;
const KEY = 'agent-chat.sound';

// Compiled once, played many times.
const CUES = {
  sent: defineSound(retro.send),
  reply: defineSound(retro.notification),
  thread: defineSound(retro.expand),
  error: defineSound(retro.error),
  on: defineSound(retro.toggleOn),
};
export type Cue = keyof typeof CUES;

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
const clamp = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME);

export function readSoundSettings(): SoundSettings {
  let stored: Partial<SoundSettings> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {};
  } catch {
    // Blocked storage or a bad value: defaults.
  }
  return { on: typeof stored.on === 'boolean' ? stored.on : !reducedMotion(), volume: clamp(stored.volume) };
}

let current: SoundSettings | null = null;
const settings = () => (current ??= readSoundSettings());
const listeners = new Set<() => void>();

export function setSoundSettings(patch: Partial<SoundSettings>): void {
  const next = { ...settings(), ...patch };
  next.volume = clamp(next.volume);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: the choice still applies for this visit.
  }
  current = next;
  for (const fn of listeners) fn();
}

let ctx: AudioContext | null = null;

/**
 * Browsers keep audio suspended until a user gesture. Resume it from one, and only while sounds are on:
 * starting it any other way makes the browser log a warning.
 */
function unlock(): Promise<void> {
  if (ctx?.state === 'running') return Promise.resolve();
  if (!settings().on || typeof AudioContext === 'undefined' || navigator.userActivation?.isActive === false) return Promise.resolve();
  return ensureReady().then(
    (c) => {
      ctx = c;
    },
    () => {},
  );
}

const lastPlayed: Partial<Record<Cue, number>> = {};

/** Plays a cue if sounds are on and audio has been unlocked; otherwise (or if audio fails) does nothing. */
export function play(cue: Cue): void {
  const s = settings();
  if (!s.on || s.volume <= 0 || ctx?.state !== 'running') return;
  // Several replies landing together are one chime, not a chord.
  const now = performance.now();
  if (now - (lastPlayed[cue] ?? -Infinity) < 300) return;
  lastPlayed[cue] = now;
  try {
    CUES[cue]({ volume: s.volume });
  } catch {
    // Sound is a nicety; never let it break the action it accompanies.
  }
}

const settled = new Set<string>();

/** An agent's turn ended: a chime when it answered, the error cue when it failed; nothing when stopped. */
export function turnSettled(m: { id: string; authorKind: string; status: string }): void {
  if (m.authorKind !== 'agent' || settled.has(m.id)) return;
  settled.add(m.id); // the same message can reach two open panels, or arrive again
  if (m.status === 'done') play('reply');
  else if (m.status === 'error') play('error');
}

/** Plays a cue from a click or key press, unlocking audio first if this is the first gesture (Settings previews). */
export function playFromGesture(cue: Cue): void {
  unlock().then(() => play(cue));
}

if (typeof window !== 'undefined') {
  const onGesture = () => void unlock();
  for (const type of ['pointerdown', 'pointerup', 'keydown'] as const) window.addEventListener(type, onGesture, { capture: true, passive: true });
  // Another tab changed the setting.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    current = null;
    for (const fn of listeners) fn();
  });
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSoundSettings(): [SoundSettings, (patch: Partial<SoundSettings>) => void] {
  const s = useSyncExternalStore(subscribe, settings);
  return [s, useCallback(setSoundSettings, [])];
}

/** Tests only: forget cached settings, the audio context and the per-cue throttle. */
export function resetSoundForTests(): void {
  current = null;
  ctx = null;
  settled.clear();
  for (const k of Object.keys(lastPlayed) as Cue[]) delete lastPlayed[k];
}
