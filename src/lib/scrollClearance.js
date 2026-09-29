// Keeping an action button clear of the fixed bottom bars (Phase H4, decision
// H4-10). Pure geometry, no DOM: the component measures, this decides. All
// values are CSS pixels in layout-viewport coordinates (getBoundingClientRect).

export const SCROLL_CLEARANCE_GAP_PX = 8;

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * The part of the viewport the user can see and tap: from the top of the
 * visual viewport down to the first fixed bar (bottom nav, rest timer) that
 * starts inside it, or to the viewport bottom (the on-screen keyboard) when
 * the bars are behind the keyboard or absent.
 */
export function getVisibleBand({ viewportTop = 0, viewportHeight, obstructionTops = [] }) {
  const top = finite(viewportTop, 0);
  const viewportBottom = top + Math.max(0, finite(viewportHeight, 0));
  const bottom = (Array.isArray(obstructionTops) ? obstructionTops : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > top && value < viewportBottom)
    .reduce((lowest, value) => Math.min(lowest, value), viewportBottom);

  return { top, bottom };
}

/**
 * How far the page has to scroll (positive = down) so that the action button
 * (Save Set) ends above the fixed bars, without pushing the focused field out
 * of view: the field wins when both do not fit. 0 when nothing has to move.
 */
export function getActionScrollDelta({
  viewportTop = 0,
  viewportHeight,
  obstructionTops = [],
  fieldTop,
  fieldBottom,
  actionBottom,
  gap = SCROLL_CLEARANCE_GAP_PX,
}) {
  const band = getVisibleBand({ viewportTop, viewportHeight, obstructionTops });
  const margin = Math.max(0, finite(gap, 0));
  const visibleTop = band.top + margin;
  const visibleBottom = band.bottom - margin;

  if (!(visibleBottom > visibleTop) || !Number.isFinite(Number(actionBottom))) {
    return 0;
  }

  const hasField = Number.isFinite(Number(fieldTop)) && Number.isFinite(Number(fieldBottom));
  let delta = Math.max(0, Number(actionBottom) - visibleBottom);

  if (hasField) {
    // Never scroll the field above the visible band to show the button.
    delta = Math.min(delta, Math.max(0, Number(fieldTop) - visibleTop));

    const fieldBottomAfter = Number(fieldBottom) - delta;
    const fieldTopAfter = Number(fieldTop) - delta;

    if (fieldBottomAfter > visibleBottom) {
      // The field itself is under a bar: bring it up as far as its top allows.
      delta += Math.min(fieldBottomAfter - visibleBottom, Math.max(0, fieldTopAfter - visibleTop));
    } else if (delta === 0 && fieldTopAfter < visibleTop) {
      delta = fieldTopAfter - visibleTop;
    }
  }

  return Math.round(delta);
}
