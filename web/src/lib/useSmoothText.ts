import { useEffect, useRef, useState } from 'react';

/** How far the shown text runs behind what has arrived. Bursts spread out over about this long. */
const LAG_S = 0.5;
/** Once the reply is complete, the rest is shown within about this long. */
const FINISH_S = 0.35;
/** How quickly the pace follows a change in backlog; a longer time gives steadier speed. */
const EASE_S = 0.35;
/** Never slower than this, in characters per second. */
const MIN_CPS = 40;

/**
 * Text that arrives in bursts, shown at a steady pace: a frame loop reveals it a little behind the
 * stream, at a speed that eases toward backlog / LAG_S, and always up to the end of a word. Text
 * already there on mount shows at once. `done` once the stream has ended and everything is shown.
 */
export function useSmoothText(text: string, live: boolean): { text: string; done: boolean } {
  const [shown, setShown] = useState(text.length);
  const s = useRef({ pos: text.length, cps: 0, last: 0, frame: 0 }).current;
  const latest = useRef({ text, live });
  latest.current = { text, live };
  // A reply that got shorter was replaced, not appended to: show it as is.
  if (text.length < s.pos) s.pos = text.length;

  useEffect(() => {
    if (s.frame || s.pos >= text.length) return;
    const tick = (now: number) => {
      const { text, live } = latest.current;
      const dt = s.last ? Math.min((now - s.last) / 1000, 0.1) : 1 / 60;
      s.last = now;
      const backlog = text.length - s.pos;
      if (backlog <= 0) {
        s.frame = s.last = 0;
        return;
      }
      const target = Math.max(backlog / (live ? LAG_S : FINISH_S), MIN_CPS);
      s.cps += (target - s.cps) * Math.min(1, dt / EASE_S);
      s.pos = Math.min(text.length, s.pos + Math.max(s.cps, MIN_CPS) * dt);
      const cut = wordEnd(text, s.pos);
      setShown((prev) => (cut > prev ? cut : prev));
      s.frame = requestAnimationFrame(tick);
    };
    s.frame = requestAnimationFrame(tick);
  }, [s, text]);

  useEffect(
    () => () => {
      cancelAnimationFrame(s.frame);
      s.frame = s.last = 0;
    },
    [s],
  );

  const visible = Math.min(shown, text.length);
  return { text: visible === text.length ? text : text.slice(0, visible), done: !live && visible === text.length };
}

/** The end of the last whole word before `pos` (just past its trailing space), or the text's end. */
function wordEnd(text: string, pos: number): number {
  const p = Math.floor(pos);
  if (p >= text.length) return text.length;
  for (let i = p; i > 0; i--) if (/\s/.test(text[i - 1])) return i;
  return 0;
}
