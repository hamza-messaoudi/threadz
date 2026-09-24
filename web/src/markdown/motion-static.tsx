// Stand-in for `motion/react`, aliased in web/vite.config.ts and vitest.config.ts. The vendored mdxcn
// components animate their entrance; the plan wants figures in their final state with no motion at
// runtime. `useReducedMotion()` from the real package reads only the OS setting (it ignores
// <MotionConfig reducedMotion="always">), so the components are given a static `motion` instead:
// `motion.<tag>` renders the plain element with the final `animate` / `whileInView` state as style.
import { createContext, createElement, forwardRef, useContext, type CSSProperties, type ReactNode } from 'react';

type Target = Record<string, unknown>;
type VariantValue = Target | ((custom: unknown) => Target);

/** Props that belong to motion and must not reach the DOM. */
const MOTION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'whileInView',
  'whileHover',
  'whileTap',
  'whileFocus',
  'whileDrag',
  'viewport',
  'variants',
  'transition',
  'custom',
  'layout',
  'layoutId',
  'layoutDependency',
  'inherit',
  'onAnimationStart',
  'onAnimationComplete',
  'onUpdate',
  'onViewportEnter',
  'onViewportLeave',
  'drag',
  'dragConstraints',
]);

const SKIP = new Set(['transition', 'transitionEnd']);
const TRANSFORMS: Record<string, (v: string) => string> = {
  x: (v) => `translateX(${v})`,
  y: (v) => `translateY(${v})`,
  scale: (v) => `scale(${v})`,
  scaleX: (v) => `scaleX(${v})`,
  scaleY: (v) => `scaleY(${v})`,
  rotate: (v) => `rotate(${v})`,
};
const px = (k: string, v: unknown) => (typeof v === 'number' && (k === 'x' || k === 'y') ? `${v}px` : typeof v === 'number' && k === 'rotate' ? `${v}deg` : String(v));

function resolve(target: unknown, variants: Record<string, VariantValue> | undefined, custom: unknown): Target {
  if (!target) return {};
  if (typeof target === 'string' || Array.isArray(target)) {
    const names = (Array.isArray(target) ? target : [target]) as string[];
    return Object.assign({}, ...names.map((n) => resolve(variants?.[n], variants, custom)));
  }
  if (typeof target === 'function') return resolve((target as (c: unknown) => Target)(custom), variants, custom);
  if (typeof target === 'object') return target as Target;
  return {};
}

/** Variant labels a parent is showing; children with `variants` and no target of their own follow them, as in motion. */
const Labels = createContext<string[] | null>(null);

const labelsOf = (v: unknown): string[] | null => (typeof v === 'string' ? [v] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);

/**
 * Final visual state as CSS: the animate target, then whileInView (the state a visible figure settles
 * in). Without either, the labels inherited from the parent pick from this element's own variants.
 */
export function finalStyle(props: Record<string, unknown>, inherited: string[] | null = null): CSSProperties {
  const variants = props.variants as Record<string, VariantValue> | undefined;
  const own = props.animate !== undefined || props.whileInView !== undefined;
  const merged = own
    ? { ...resolve(props.animate, variants, props.custom), ...resolve(props.whileInView, variants, props.custom) }
    : props.inherit !== false && inherited
      ? resolve(inherited, variants, props.custom)
      : {};
  const style: Record<string, unknown> = {};
  const transforms: string[] = [];
  for (const [k, raw] of Object.entries(merged)) {
    if (SKIP.has(k)) continue;
    const v = Array.isArray(raw) ? raw[raw.length - 1] : raw; // keyframes: the last one
    if (v === undefined || v === null || typeof v === 'object') continue;
    if (TRANSFORMS[k]) transforms.push(TRANSFORMS[k](px(k, v)));
    else if (k === 'pathLength' || k === 'pathOffset') continue;
    else style[k] = v;
  }
  if (transforms.length) style.transform = [style.transform, ...transforms].filter(Boolean).join(' ');
  return style as CSSProperties;
}

type AnyProps = Record<string, unknown> & { style?: CSSProperties; children?: ReactNode };
const cache = new Map<string, unknown>();

function component(tag: string) {
  let c = cache.get(tag);
  if (!c) {
    const Static = forwardRef<Element, AnyProps>(function Static(props, ref) {
      const dom: AnyProps = {};
      for (const [k, v] of Object.entries(props)) if (!MOTION_PROPS.has(k)) dom[k] = v;
      const inherited = useContext(Labels);
      const final = finalStyle(props, inherited);
      // The animation target wins over the static style, as it would once motion had run.
      if (Object.keys(final).length) dom.style = { ...(props.style ?? {}), ...final };
      const labels = labelsOf(props.whileInView) ?? labelsOf(props.animate) ?? (props.inherit !== false ? inherited : null);
      const el = createElement(tag, { ...dom, ref });
      return labels === inherited ? el : <Labels.Provider value={labels}>{el}</Labels.Provider>;
    });
    Static.displayName = `motion.${tag}`;
    c = Static;
    cache.set(tag, c);
  }
  return c;
}

/** `motion.div`, `motion.li`, …: the plain element in its final state. */
export const motion = new Proxy({} as Record<string, ReturnType<typeof forwardRef>>, {
  get: (_, tag: string) => component(tag),
});

/** Always true: every vendored component then takes its no-animation path. */
export function useReducedMotion(): boolean {
  return true;
}

export function MotionConfig({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
