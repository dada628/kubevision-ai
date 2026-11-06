/**
 * KubeVision AI - pointer-transparency for drei `<Html>` overlays.
 *
 * THE BUG THIS WORKS AROUND
 * `<Html pointerEvents="none">` does NOT make a non-`transform` Html transparent to
 * the pointer. Reading drei's `web/Html.js`:
 *
 * - the `transform` branch writes `pointer-events:none` into the container's
 *   `cssText` AND uses the prop on its inner wrapper;
 * - the NON-`transform` branch (the one this project uses, so the labels billboard
 *   without a 3D transform matrix) writes only
 *   `position:absolute;top:0;left:0;transform:translate3d(...)`.
 *
 * The prop is therefore silently dropped, the container stays `pointer-events:auto`
 * and every 3D nameplate (master plate, three rack plates, the pod tooltip) becomes
 * a DOM hit target sitting on top of the canvas. Measured on the overview framing:
 * ~4.5% of all canvas pixels were captured by those containers, so orbit drags and
 * raycast picks over a label were swallowed.
 *
 * THE FIX
 * `wrapperClass` is applied to that same container by drei, so a Tailwind class
 * here reaches the element that actually needs it. Pair it with an inline
 * `pointerEvents: 'none'` on the child content and the whole label subtree is
 * pointer-transparent.
 *
 * Keep using `pointerEvents="none"` on the component as well: it documents intent
 * and it still takes effect if a label ever switches to `transform` mode.
 */

/**
 * Class applied through drei's `wrapperClass` to make the Html container
 * pointer-transparent.
 *
 * Declared as a constant rather than an inline literal so every 3D label uses the
 * exact same token - a typo in one call site would silently reintroduce the bug.
 */
export const HTML_OVERLAY_WRAPPER_CLASS = 'pointer-events-none';

/**
 * Inline style fragment for the label's own content root.
 *
 * A DOM overlay may only receive clicks when it is an actual control. 3D labels are
 * decoration, so their content must opt out too - `wrapperClass` alone leaves the
 * child element hit-testable.
 */
export const HTML_OVERLAY_CONTENT_STYLE = { pointerEvents: 'none' } as const;