// Color math — the half of the theme that needs no DOM.
//
// These assert RELATIONSHIPS, not values. The tuning constants are meant to be
// adjusted, so a test pinned to `#0e74dd -> #3599ff` would fail on every honest
// retune and teach people to ignore failures. The pinned values live in one
// clearly-labelled block at the bottom, where a change is a decision to review
// rather than a bug.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadColorMath } = require("./slice.js");

const M = loadColorMath();
const {
  rgbToHsl,
  neutralFor,
  neutralSurfaceFor,
  relLuminance,
  contrastRatio,
  canvasLuminance,
  vividFor,
  remapRgb,
  inkFor,
  needsInk,
  hexOf,
  SURFACE_PEAK,
  VIVID_FILL,
  VIVID_INK,
  INK_LIGHT,
  INK_DARK,
  ROLE_LINE,
  ROLE_SURFACE,
  ROLE_INK,
} = M;

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const lightness = (rgb) => rgbToHsl(...rgb)[2];
const vsCanvas = (rgb) => contrastRatio(relLuminance(...rgb), canvasLuminance());
// 0..1 in steps, inclusive of both ends
const ramp = (n) => Array.from({ length: n + 1 }, (_, i) => i / n);

// ---------------------------------------------------------------------------
// Neutrals
// ---------------------------------------------------------------------------

test("a neutral background is never light, whatever it started as", () => {
  const peak = neutralFor(SURFACE_PEAK);
  const cap = lightness(peak) + 0.005; // rounding to bytes
  for (const l of ramp(200)) {
    const out = lightness(neutralSurfaceFor(l));
    assert.ok(
      out <= cap,
      `neutralSurfaceFor(${l.toFixed(3)}) -> l=${out.toFixed(3)}, above the ${cap.toFixed(3)} cap`,
    );
  }
});

test("the two halves of the surface curve meet at SURFACE_PEAK", () => {
  // Approaching the peak from below must land where neutralFor picks up, or a
  // pair of near-identical inputs would be themed far apart.
  const below = neutralSurfaceFor(SURFACE_PEAK - 0.001);
  const at = neutralSurfaceFor(SURFACE_PEAK);
  for (let i = 0; i < 3; i++)
    assert.ok(
      Math.abs(below[i] - at[i]) <= 1,
      `channel ${i} steps ${below[i]} -> ${at[i]} across the peak`,
    );
  assert.deepEqual(at, neutralFor(SURFACE_PEAK), "at the peak it IS neutralFor");
});

test("darker neutral backgrounds stay darker than lighter ones", () => {
  // Monotonic below the peak, so a #1a1a1a sidebar keeps its order against a
  // #4b4a4a header instead of collapsing onto it.
  let prev = -1;
  for (const l of ramp(150).filter((x) => x < SURFACE_PEAK)) {
    const cur = relLuminance(...neutralSurfaceFor(l));
    assert.ok(cur >= prev - 1e-9, `luminance dipped at l=${l.toFixed(3)}`);
    prev = cur;
  }
});

test("light-theme surfaces stay distinguishable from each other", () => {
  // #fff / #f7f7f7 / #eee sit within 0.07 of each other; if the curve crushed
  // them together every card would merge into the canvas.
  const seen = ["#ffffff", "#f7f7f7", "#eeeeee", "#e0e0e0"].map((h) =>
    relLuminance(...remapRgb(...hex(h), ROLE_SURFACE)),
  );
  for (let i = 1; i < seen.length; i++)
    assert.ok(
      seen[i] > seen[i - 1] * 1.05,
      `surfaces ${i - 1} and ${i} are within 5% luminance of each other`,
    );
});

test("neutral text inverts even where a neutral background would not", () => {
  // The same three numbers, opposite answers — the reason roles exist at all.
  const asText = remapRgb(...hex("#4b4a4a"), ROLE_INK);
  const asSurface = remapRgb(...hex("#4b4a4a"), ROLE_SURFACE);
  assert.ok(lightness(asText) > 0.5, "dark text must become light");
  assert.ok(lightness(asSurface) < 0.35, "a dark surface must stay dark");
});

test("the memo keeps roles apart", () => {
  // One packed rgb has different answers per role, so the role has to be part
  // of the cache key. Calling in either order must give the same pair.
  const a = remapRgb(40, 40, 40, ROLE_SURFACE);
  const b = remapRgb(40, 40, 40, ROLE_INK);
  assert.notDeepEqual(a, b);
  assert.deepEqual(remapRgb(40, 40, 40, ROLE_SURFACE), a, "surface re-read");
  assert.deepEqual(remapRgb(40, 40, 40, ROLE_INK), b, "ink re-read");
});

// ---------------------------------------------------------------------------
// Ink
// ---------------------------------------------------------------------------

test("light ink is left as authored", () => {
  // Near-white text only ever sits on something dark, so it is already correct.
  // This is the only thing that reaches text styled by a different rule.
  for (const h of ["#ffffff", "#f0f0f0", "#fafafa", "#e8f2ff"])
    assert.equal(remapRgb(...hex(h), ROLE_INK), null, `${h} as ink`);
});

test("a light border is NOT left alone", () => {
  // Borders can't share the ink rule: a white border is often a spacer on a
  // white card, and keeping it white draws a bright line across the page.
  assert.notEqual(remapRgb(255, 255, 255, ROLE_LINE), null);
  assert.ok(lightness(remapRgb(255, 255, 255, ROLE_LINE)) < 0.2);
});

test("inkFor returns whichever end of the ramp reads better", () => {
  for (const h of ["#ffffff", "#000000", "#3599ff", "#ffc83e", "#2c3033"]) {
    const bg = hex(h);
    const lum = relLuminance(...bg);
    const picked = inkFor(bg);
    const other = picked === INK_LIGHT ? INK_DARK : INK_LIGHT;
    assert.ok(
      contrastRatio(lum, relLuminance(...picked)) >=
        contrastRatio(lum, relLuminance(...other)),
      `inkFor(${h}) picked the dimmer end`,
    );
  }
});

test("needsInk fires only where the background moves out from under its text", () => {
  const cases = [
    ["#ffffff", false, "plain light surface — its dark text inverts correctly"],
    ["#f7f7f7", false, "off-white surface"],
    ["#fdecea", false, "pale tint becomes a dark surface; dark text inverts"],
    ["#4b4a4a", true, "already dark: stays dark, its light text would invert"],
    ["#111111", true, "near-black surface"],
    ["#0e74dd", true, "vivified far brighter than authored"],
    ["#d0021b", true, "same, warm"],
  ];
  for (const [h, want, why] of cases)
    assert.equal(needsInk(...hex(h), 1), want, `${h}: ${why}`);
});

test("a see-through background does not dictate the text color", () => {
  assert.equal(needsInk(...hex("#4b4a4a"), 0.5), false);
});

// ---------------------------------------------------------------------------
// Accents
// ---------------------------------------------------------------------------

test("hue survives the accent branch", () => {
  for (const h of ramp(36).slice(0, 36))
    for (const l of [0.2, 0.4, 0.6]) {
      const out = vividFor(h, 0.6, l, VIVID_FILL);
      const [outH, outS] = rgbToHsl(...out);
      if (outS < 0.05) continue; // hue is meaningless without saturation
      const drift = Math.min(Math.abs(outH - h), 1 - Math.abs(outH - h)) * 360;
      assert.ok(
        drift < 3,
        `hue ${(h * 360).toFixed(0)}deg drifted ${drift.toFixed(1)}deg at l=${l}`,
      );
    }
});

test("the contrast climb terminates and reaches its floor", () => {
  // The climb is a while loop; this is the proof it can't spin, and that every
  // hue either clears the floor or is stopped by the ceiling.
  for (const tuning of [VIVID_FILL, VIVID_INK])
    for (const h of ramp(24).slice(0, 24))
      for (const l of [0.1, 0.3, 0.5, 0.7]) {
        const out = vividFor(h, 0.6, l, tuning);
        const met = vsCanvas(out) >= tuning.minContrast - 0.01;
        const capped = lightness(out) >= tuning.lCeiling - 0.01;
        assert.ok(
          met || capped,
          `h=${(h * 360).toFixed(0)} l=${l} ended at ${vsCanvas(out).toFixed(2)}:1 ` +
            `and l=${lightness(out).toFixed(2)}, below the floor and under the ceiling`,
        );
      }
});

test("accent text is at least as legible as the same accent as a fill", () => {
  // The whole point of VIVID_INK: text is thin strokes, a fill carries on area.
  for (const h of ramp(36).slice(0, 36))
    for (const l of [0.2, 0.45, 0.7]) {
      const fill = vsCanvas(vividFor(h, 0.6, l, VIVID_FILL));
      const ink = vsCanvas(vividFor(h, 0.6, l, VIVID_INK));
      assert.ok(
        ink >= fill - 0.01,
        `h=${(h * 360).toFixed(0)} l=${l}: ink ${ink.toFixed(2)}:1 is dimmer than fill ${fill.toFixed(2)}:1`,
      );
    }
});

test("saturation is spent — both tunings sit near the sRGB ceiling", () => {
  // Documents why lightness is the only lever left. If this starts failing,
  // there is headroom in saturation again and the tuning advice should change.
  for (const tuning of [VIVID_FILL, VIVID_INK]) {
    const sat = Math.min(tuning.satCap, tuning.satFloor * tuning.satGain);
    assert.ok(sat >= 0.9, `floor*gain reaches only ${sat.toFixed(3)}`);
  }
});

test("pale tints become surfaces, not accents", () => {
  // A vivid surface swamps its own content, so l > 0.8 must not be vivified.
  const out = remapRgb(...hex("#e8f2ff"), ROLE_SURFACE);
  assert.ok(lightness(out) < 0.35, "pale tint should land dark");
  assert.ok(rgbToHsl(...out)[1] <= 0.5, "and must not be taken to full chroma");
});

// ---------------------------------------------------------------------------
// Characterisation — a change here is a decision to review, not a failure.
// Update the table deliberately; do not "fix" it to make CI green.
// ---------------------------------------------------------------------------

test("[characterisation] current output for a reference palette", () => {
  const actual = {};
  for (const h of ["#0e74dd", "#d0021b", "#2e7d32", "#1c3f6e"]) {
    actual[h] = {
      fill: hexOf(remapRgb(...hex(h), ROLE_LINE)),
      ink: hexOf(remapRgb(...hex(h), ROLE_INK)),
    };
  }
  actual.canvas = hexOf(remapRgb(255, 255, 255, ROLE_SURFACE));
  actual.darkBar = hexOf(remapRgb(...hex("#4b4a4a"), ROLE_SURFACE));

  assert.deepEqual(actual, {
    "#0e74dd": { fill: "#3599ff", ink: "#54a8ff" },
    "#d0021b": { fill: "#ff324b", ink: "#ff5b6f" },
    "#2e7d32": { fill: "#32f93c", ink: "#50fa59" },
    "#1c3f6e": { fill: "#2e84f9", ink: "#4b96fa" },
    canvas: "#171a1c",
    darkBar: "#2a3033",
  });
});
