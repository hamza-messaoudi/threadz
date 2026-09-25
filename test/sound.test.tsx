// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as retro from '../web/src/audio/retro.ts';
import { DEFAULT_VOLUME, play, playFromGesture, readSoundSettings, resetSoundForTests, setSoundSettings, turnSettled, useSoundSettings } from '../web/src/lib/sound.ts';

const audio = vi.hoisted(() => ({
  played: [] as { def: unknown; opts: { volume?: number } | undefined }[],
  ensureReady: vi.fn(),
  fail: false,
}));

// The real library needs Web Audio, which jsdom lacks; record what would have played instead.
vi.mock('@web-kits/audio', () => ({
  defineSound: (def: unknown) => (opts?: { volume?: number }) => {
    if (audio.fail) throw new Error('audio device gone');
    audio.played.push({ def, opts });
  },
  ensureReady: audio.ensureReady,
}));


const KEY = 'agent-chat.sound';
let reducedMotion = false;
const running = { state: 'running' };

function gesture() {
  window.dispatchEvent(new Event('pointerdown'));
  return flush();
}
const flush = () => act(async () => {});

beforeEach(() => {
  localStorage.clear();
  reducedMotion = false;
  window.matchMedia = ((q: string) => ({ matches: q.includes('reduced-motion') && reducedMotion })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('AudioContext', class {});
  audio.played.length = 0;
  audio.fail = false;
  audio.ensureReady.mockReset().mockResolvedValue(running);
  resetSoundForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sound settings', () => {
  it('are on by default, at the default volume', () => {
    expect(readSoundSettings()).toEqual({ on: true, volume: DEFAULT_VOLUME });
  });

  it('are off by default when the system asks for reduced motion, but an explicit choice wins', () => {
    reducedMotion = true;
    expect(readSoundSettings().on).toBe(false);
    setSoundSettings({ on: true });
    resetSoundForTests();
    expect(readSoundSettings().on).toBe(true);
  });

  it('persist the toggle and the volume across reloads', () => {
    const { result } = renderHook(() => useSoundSettings());
    act(() => result.current[1]({ on: false }));
    act(() => result.current[1]({ volume: 0.25 }));
    expect(result.current[0]).toEqual({ on: false, volume: 0.25 });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ on: false, volume: 0.25 });

    resetSoundForTests(); // a fresh page load
    expect(readSoundSettings()).toEqual({ on: false, volume: 0.25 });
  });

  it('clamp the volume and fall back to defaults on a bad stored value', () => {
    setSoundSettings({ volume: 3 });
    expect(readSoundSettings().volume).toBe(1);
    localStorage.setItem(KEY, '{not json');
    expect(readSoundSettings()).toEqual({ on: true, volume: DEFAULT_VOLUME });
    localStorage.setItem(KEY, JSON.stringify({ on: 'yes', volume: 'loud' }));
    expect(readSoundSettings()).toEqual({ on: true, volume: DEFAULT_VOLUME });
  });

  it('still apply for the visit when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readSoundSettings()).toEqual({ on: true, volume: DEFAULT_VOLUME });
    const { result } = renderHook(() => useSoundSettings());
    expect(() => act(() => result.current[1]({ volume: 0.8 }))).not.toThrow();
    expect(result.current[0].volume).toBe(0.8);
  });

  it('follow a change made in another tab', () => {
    const { result } = renderHook(() => useSoundSettings());
    localStorage.setItem(KEY, JSON.stringify({ on: false, volume: 0.3 }));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: KEY })));
    expect(result.current[0]).toEqual({ on: false, volume: 0.3 });
  });
});

describe('playback', () => {
  it('stays silent until a user gesture unlocks audio, then plays at the chosen volume', async () => {
    play('sent');
    expect(audio.played).toHaveLength(0);
    expect(audio.ensureReady).not.toHaveBeenCalled();

    setSoundSettings({ volume: 0.4 });
    await gesture();
    play('sent');
    expect(audio.played).toEqual([{ def: retro.send, opts: { volume: 0.4 } }]);
  });

  it('never starts audio while sounds are off', async () => {
    setSoundSettings({ on: false });
    await gesture();
    play('reply');
    expect(audio.ensureReady).not.toHaveBeenCalled();
    expect(audio.played).toHaveLength(0);
  });

  it('does not try to start audio outside a user activation', async () => {
    vi.stubGlobal('navigator', { ...navigator, userActivation: { isActive: false } });
    await gesture();
    expect(audio.ensureReady).not.toHaveBeenCalled();
  });

  it('is silent, without throwing or logging, when the browser blocks audio', async () => {
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')];
    audio.ensureReady.mockRejectedValue(new DOMException('not allowed', 'NotAllowedError'));
    await gesture();
    expect(() => play('sent')).not.toThrow();

    audio.ensureReady.mockResolvedValue({ state: 'suspended' });
    await gesture();
    expect(() => play('sent')).not.toThrow();
    expect(audio.played).toHaveLength(0);

    audio.ensureReady.mockResolvedValue(running);
    await gesture();
    audio.fail = true;
    expect(() => play('sent')).not.toThrow();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('where browsers have no Web Audio at all', async () => {
    vi.stubGlobal('AudioContext', undefined);
    await gesture();
    expect(() => play('sent')).not.toThrow();
    expect(audio.ensureReady).not.toHaveBeenCalled();
  });

  it('plays a preview from the gesture that turns sounds on', async () => {
    setSoundSettings({ on: false });
    setSoundSettings({ on: true });
    playFromGesture('on');
    await flush();
    expect(audio.played.map((p) => p.def)).toEqual([retro.toggleOn]);
  });

  it('chimes once per finished agent turn and uses the error cue for failures', async () => {
    await gesture();
    turnSettled({ id: 'a', authorKind: 'agent', status: 'done' });
    turnSettled({ id: 'a', authorKind: 'agent', status: 'done' }); // same message again (two panels, a replay)
    turnSettled({ id: 'b', authorKind: 'user', status: 'done' });
    turnSettled({ id: 'c', authorKind: 'agent', status: 'cancelled' }); // the user stopped it
    turnSettled({ id: 'd', authorKind: 'agent', status: 'error' });
    expect(audio.played.map((p) => p.def)).toEqual([retro.notification, retro.error]);
  });

  it('merges a burst of the same cue into one', async () => {
    await gesture();
    play('reply');
    play('reply');
    expect(audio.played).toHaveLength(1);
  });
});
