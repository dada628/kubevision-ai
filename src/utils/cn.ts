import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * `cn` - conditional class name composer with Tailwind conflict resolution.
 *
 * Layer 1 - `clsx`: flattens every accepted input shape into a class string.
 *   Accepts strings, numbers (ignored in class output by clsx semantics for
 *   0-value keys), arrays, nested arrays, and `{ [className]: boolean }` maps.
 *   Falsy entries (`false`, `null`, `undefined`, `''`, `0`) are dropped.
 *
 * Layer 2 - `twMerge`: resolves conflicting Tailwind utilities so the LAST
 *   declaration in the list wins. This is what makes component prop overrides
 *   predictable:
 *
 *     cn('px-4 py-2 bg-slate-900', 'px-6')
 *     // -> 'py-2 bg-slate-900 px-6'   (px-6 beats px-4)
 *
 *   Without the merge step, both `px-4` and `px-6` would land in `class` and
 *   the winner would be decided by CSS source order in the compiled stylesheet,
 *   which is not stable across Tailwind purges.
 *
 * Design notes:
 * - No `any`: the input is `ClassValue` from clsx, the output is `string`.
 * - Pure and side-effect free, so it is safe to call during render in Server
 *   Components and Client Components alike.
 * - `twMerge` caches its internal config on first call; no per-call allocation
 *   of merge tables. Cost is a string parse, which is negligible at HUD scale.
 * - Custom tokens from `tailwind.config.ts` (`shadow-glow-cyan`,
 *   `shadow-glow-emerald`, `shadow-glow-rose`, `shadow-glow-amber`) are NOT in
 *   tailwind-merge's default class registry. They are still emitted correctly
 *   because unknown classes pass through untouched - they simply won't be
 *   de-duplicated against a same-property default shadow. If you later need
 *   `cn('shadow-glow-cyan', 'shadow-glow-rose')` to collapse to the rose glow,
 *   register an `extendTailwindMerge` group:
 *
 *     const twMerge = extendTailwindMerge({
 *       extend: { classGroups: { shadow: [{ shadow: ['glow-cyan', 'glow-emerald', 'glow-rose', 'glow-amber'] }] } },
 *     });
 *
 * @param inputs - Any mix of class values accepted by clsx.
 * @returns A single space-joined class string with Tailwind conflicts resolved.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export default cn;