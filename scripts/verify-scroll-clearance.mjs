// H4 fix round 1, decision H4-10: the set-entry focus scroll keeps Save Set
// above the fixed bottom bars (bottom nav, rest timer) and the keyboard, and
// never pushes the focused field out of view. Pure geometry from
// src/lib/scrollClearance.js; the numbers of the first case are the measured
// ones of the defect (375 x 420, nav top 347, Save Set 347.9 - 391.9).
import assert from "node:assert/strict";

import {
  SCROLL_CLEARANCE_GAP_PX,
  getActionScrollDelta,
  getVisibleBand,
} from "../src/lib/scrollClearance.js";

assert.equal(SCROLL_CLEARANCE_GAP_PX, 8);

// Applies a delta the way window.scrollBy moves the page content.
function afterScroll(input, delta) {
  return {
    fieldTop: input.fieldTop - delta,
    fieldBottom: input.fieldBottom - delta,
    actionTop: input.actionBottom - 44 - delta,
    actionBottom: input.actionBottom - delta,
  };
}

// ---------------------------------------------------------------------------
// Visible band
// ---------------------------------------------------------------------------
assert.deepEqual(getVisibleBand({ viewportHeight: 420, obstructionTops: [347] }), { top: 0, bottom: 347 });
assert.deepEqual(getVisibleBand({ viewportHeight: 420, obstructionTops: [347, 232] }), { top: 0, bottom: 232 });
assert.deepEqual(getVisibleBand({ viewportHeight: 420, obstructionTops: [] }), { top: 0, bottom: 420 });
assert.deepEqual(getVisibleBand({ viewportHeight: 420 }), { top: 0, bottom: 420 });
// Bars behind the keyboard (visual viewport shorter than the layout viewport).
assert.deepEqual(getVisibleBand({ viewportHeight: 440, obstructionTops: [667, 552] }), { top: 0, bottom: 440 });
// A visual viewport that is offset inside the layout viewport (iOS keyboard).
assert.deepEqual(
  getVisibleBand({ viewportTop: 120, viewportHeight: 400, obstructionTops: [667] }),
  { top: 120, bottom: 520 },
);
assert.deepEqual(getVisibleBand({ viewportHeight: 420, obstructionTops: [NaN, null, "x", -5, 0] }), { top: 0, bottom: 420 });

// ---------------------------------------------------------------------------
// The defect: Save Set under the bottom nav after the focus scroll
// ---------------------------------------------------------------------------
{
  const input = {
    viewportHeight: 420,
    obstructionTops: [347],
    fieldTop: 188,
    fieldBottom: 232,
    actionBottom: 391.9,
  };
  const delta = getActionScrollDelta(input);
  assert.equal(delta, 53, "scrolls down by the overlap plus the gap");
  const after = afterScroll(input, delta);
  assert.ok(after.actionBottom <= 347 - SCROLL_CLEARANCE_GAP_PX + 0.5, "Save Set ends above the nav");
  assert.ok(after.actionTop >= 0, "Save Set is fully inside the viewport");
  assert.ok(after.fieldTop >= SCROLL_CLEARANCE_GAP_PX, "the focused field stays visible");
  assert.equal(getActionScrollDelta({ ...input, ...afterScroll(input, delta) }), 0, "a second focus does not move again");
}

// Already clear: nothing moves.
assert.equal(
  getActionScrollDelta({ viewportHeight: 740, obstructionTops: [667], fieldTop: 300, fieldBottom: 344, actionBottom: 500 }),
  0,
);

// With the rest timer above the nav the timer top is the limit.
{
  const input = {
    viewportHeight: 740,
    obstructionTops: [667, 571],
    fieldTop: 380,
    fieldBottom: 424,
    actionBottom: 600,
  };
  const delta = getActionScrollDelta(input);
  assert.equal(delta, 600 - (571 - 8));
  assert.ok(afterScroll(input, delta).actionBottom <= 563);
}

// Keyboard open on a phone, bars hidden behind it: the keyboard edge is the limit.
{
  const input = {
    viewportHeight: 440,
    obstructionTops: [667, 571],
    fieldTop: 250,
    fieldBottom: 294,
    actionBottom: 470,
  };
  assert.equal(getActionScrollDelta(input), 470 - (440 - 8));
}

// Not enough room for both (short viewport + rest timer): the field wins, the
// scroll goes as far as the field allows and no further.
{
  const input = {
    viewportHeight: 420,
    obstructionTops: [347, 232],
    fieldTop: 100,
    fieldBottom: 144,
    actionBottom: 384,
  };
  const delta = getActionScrollDelta(input);
  assert.equal(delta, 92, "limited to fieldTop - gap");
  const after = afterScroll(input, delta);
  assert.equal(after.fieldTop, SCROLL_CLEARANCE_GAP_PX, "the field is parked at the top of the band");
  assert.ok(after.fieldBottom <= 232 - SCROLL_CLEARANCE_GAP_PX, "and stays above the rest timer");
}

// The field itself sits under a bar while the button is even lower.
{
  const input = {
    viewportHeight: 420,
    obstructionTops: [347],
    fieldTop: 340,
    fieldBottom: 384,
    actionBottom: 560,
  };
  const delta = getActionScrollDelta(input);
  const after = afterScroll(input, delta);
  assert.ok(after.actionBottom <= 339 || after.fieldTop === SCROLL_CLEARANCE_GAP_PX);
  assert.ok(after.fieldBottom <= 339, "the field is brought above the nav");
  assert.ok(after.fieldTop >= SCROLL_CLEARANCE_GAP_PX);
}

// The field above the visible band (button visible): scroll up to the field.
assert.equal(
  getActionScrollDelta({ viewportHeight: 420, obstructionTops: [347], fieldTop: -30, fieldBottom: 14, actionBottom: 200 }),
  -38,
);

// Offset visual viewport: everything is measured against the visible part.
assert.equal(
  getActionScrollDelta({
    viewportTop: 100,
    viewportHeight: 400,
    obstructionTops: [667],
    fieldTop: 300,
    fieldBottom: 344,
    actionBottom: 520,
  }),
  520 - (500 - 8),
);

// Without a field only the button is placed; a custom gap is honoured.
assert.equal(getActionScrollDelta({ viewportHeight: 420, obstructionTops: [347], actionBottom: 391.9 }), 53);
assert.equal(getActionScrollDelta({ viewportHeight: 420, obstructionTops: [347], actionBottom: 391.9, gap: 0 }), 45);

// Unusable measurements never scroll.
assert.equal(getActionScrollDelta({ viewportHeight: 0, fieldTop: 1, fieldBottom: 2, actionBottom: 3 }), 0);
assert.equal(getActionScrollDelta({ viewportHeight: undefined, actionBottom: 300 }), 0);
assert.equal(getActionScrollDelta({ viewportHeight: 420, actionBottom: NaN }), 0);
assert.equal(getActionScrollDelta({ viewportHeight: 420, actionBottom: undefined }), 0);

console.log("Scroll clearance verification passed.");
