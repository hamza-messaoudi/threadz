import { useEffect, useRef } from 'react';

/**
 * transitions.dev "Tooltip open/close" for the whole app: one bubble, shared by every element with a
 * `data-tooltip` (add `data-tooltip-side="right"` to put it beside the trigger instead of above). As in
 * the snippet, moving between triggers while it shows makes the bubble travel; when hidden the geometry
 * snaps and only the delayed appear plays. It is fixed to the viewport, so clipped containers (the
 * sidebar rail) do not cut it off.
 */
export function TooltipLayer() {
  const tip = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const t = tip.current!;
    const label = text.current!;
    let current: HTMLElement | null = null;

    const hide = () => {
      current = null;
      t.setAttribute('data-show', 'false');
      t.setAttribute('aria-hidden', 'true');
    };

    const place = (trigger: HTMLElement) => {
      const showing = t.getAttribute('data-show') === 'true';
      current = trigger;
      label.textContent = trigger.getAttribute('data-tooltip') || '';
      const cs = getComputedStyle(t);
      const width = Math.ceil(label.scrollWidth + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight));
      const height = t.offsetHeight;
      const r = trigger.getBoundingClientRect();
      const side = trigger.getAttribute('data-tooltip-side') === 'right' ? 'right' : 'top';
      let x: number;
      let y: number;
      if (side === 'right') {
        x = r.right + 8;
        y = r.top + r.height / 2 - height / 2;
      } else {
        x = r.left + r.width / 2 - width / 2;
        y = r.top - height - 8;
        if (y < 8) y = r.bottom + 8; // no room above: below
      }
      x = Math.max(8, Math.min(x, window.innerWidth - width - 8));
      t.setAttribute('data-side', side);
      if (!showing) {
        // Snap the geometry while hidden so only the appear plays.
        t.style.transition = 'none';
        t.style.width = `${width}px`;
        t.style.setProperty('--tt-x', `${x}px`);
        t.style.setProperty('--tt-y', `${y}px`);
        void t.offsetWidth;
        t.style.transition = '';
      } else {
        t.style.width = `${width}px`;
        t.style.setProperty('--tt-x', `${x}px`);
        t.style.setProperty('--tt-y', `${y}px`);
      }
      t.setAttribute('data-show', 'true');
      t.setAttribute('aria-hidden', 'false');
    };

    const triggerOf = (n: EventTarget | null) => (n instanceof Element ? n.closest<HTMLElement>('[data-tooltip]') : null);
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const trigger = triggerOf(e.target);
      if (trigger === current) return;
      if (trigger && trigger.getAttribute('data-tooltip')) place(trigger);
      else hide();
    };
    const focusIn = (e: FocusEvent) => {
      const trigger = triggerOf(e.target);
      if (trigger && (e.target as Element).matches(':focus-visible')) place(trigger);
    };
    window.addEventListener('pointerover', over);
    document.documentElement.addEventListener('pointerleave', hide);
    window.addEventListener('pointerdown', hide);
    window.addEventListener('focusin', focusIn);
    window.addEventListener('focusout', hide);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('keydown', hide);
    return () => {
      window.removeEventListener('pointerover', over);
      document.documentElement.removeEventListener('pointerleave', hide);
      window.removeEventListener('pointerdown', hide);
      window.removeEventListener('focusin', focusIn);
      window.removeEventListener('focusout', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('keydown', hide);
    };
  }, []);

  return (
    <span ref={tip} className="t-tt is-global" role="tooltip" aria-hidden="true" data-show="false">
      <span ref={text} className="t-tt-text" />
    </span>
  );
}
