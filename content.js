// Moonaroon — dark mode for any site on the user's list.
//
// This script is injected into every http(s) page, in every frame. It themes the
// page only where the master switch is on and the host is listed (see
// hostListed), and does nothing at all otherwise.
//
// Colors are remapped in HSL, branching on the color AND on the role the property
// paints in — background, text, or line. The same gray must stay dark as a
// background and turn light as text, and the color alone cannot say which it is
// (see PROP_ROLE and remapRgb).
//
// For every stylesheet we:
//
//   1. fetch its raw text — this is what gets past CORS, since reading
//      cssRules on a cross-origin sheet throws SecurityError;
//   2. hand that text to the browser's own CSS parser through a constructed
//      CSSStyleSheet, which is always readable unlike the original;
//   3. walk the parsed rule tree and emit an OVERLAY sheet holding only the
//      declarations whose colors changed, inserted right after the original.
//
// The original sheet is never disabled and never edited. Inline style=""
// attributes are the one exception — nothing outranks them short of !important,
// so those are rewritten in place.
//
// We do NOT pattern-match CSS structure with regexes. That approach silently
// misses whatever the regexes don't describe — native nesting (a rule's own
// declarations get skipped when it contains a nested block), modern color syntax
// (oklch/lab/color(), space-separated rgb/hsl, 4- and 8-digit hex), and anything
// CSS-in-JS injects through the CSSOM. A parser knows all of those, and keeps
// knowing them as the syntax grows. Regexes here only ever touch a single
// property VALUE, never a selector, identifier or block.

const STYLE_ID = "moonaroon-base-style";
const STORAGE_KEY = "moonaroonEnabled";
const SITES_KEY = "moonaroonSites"; // hosts the user has opted in, see hostListed
const PROCESSED = "data-moonaroon"; // marks links/styles/elements we've handled
const GEN = "data-moonaroon-gen"; // marks <style> nodes we injected

// Fixes for things the remap can't reach, because no stylesheet declares them:
// the browser draws them from its own defaults. Everything here has to hold on
// any site, so it's limited to native UI — no site's markup is named.
//
// A rule that targets one site's element belongs in a per-site overrides list,
// not here. Doubled class selectors (.x.x) are the trick to use there: equal
// specificity beats the remapped rules (some of which are !important) regardless
// of injection order.
const OVERRIDES = `
  /* Native form controls take their text color from the browser default
     (black), which our remap never sees — so force a dark field with
     readable light-gray text. Excludes non-text controls and buttons. */
  input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=file]),
  textarea, select {
    background-color:#20262a !important;
    color:#cdd3d6 !important;
    border-color:#3a4247 !important;
  }
  input::placeholder, textarea::placeholder { color:#8a9296 !important; }

  /* Scrollbars. The native/default scrollbar is drawn by the browser, not by any
     stylesheet, so the remap never reaches it — color-scheme tells the UA to draw
     it dark (also covers Firefox via scrollbar-color). The ::-webkit rules give a
     consistent charcoal scrollbar on Chrome; they only affect scrollbars that are
     actually present, so nothing new appears. Sites that style their own
     scrollbars keep theirs (already themed by the remap, higher source order).

     color-scheme:dark also makes the browser pick the second branch of any
     light-dark() the site uses — i.e. the site's own dark color, which the
     transform deliberately leaves alone. */
  :root { color-scheme: dark; scrollbar-color: #3e474c #20262a; }
  ::-webkit-scrollbar { width: 12px; height: 12px; }
  ::-webkit-scrollbar-track { background: #20262a; }
  ::-webkit-scrollbar-thumb { background: #3e474c; border-radius: 7px; border: 3px solid #20262a; }
  ::-webkit-scrollbar-thumb:hover { background: #525d64; }
  ::-webkit-scrollbar-corner { background: #20262a; }
`;

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------
function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0,
    s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

// Charcoal tint for neutrals: a cool blue-gray (hue ~200°, gently desaturated)
// instead of a flat gray, so dark surfaces read as charcoal rather than black.
const NEUTRAL_HUE = 200 / 360;
const NEUTRAL_SAT = 0.1;

// The single source of truth for what a neutral of lightness `l` becomes, so the
// canvas color and the neutral branch of remapRgb can never drift apart.
// white -> ~0.10, black -> ~0.95, 0.5 -> ~0.525
const NEUTRAL_L_BASE = 0.95;
const NEUTRAL_L_SPAN = 0.85;
function neutralFor(l) {
  return hslToRgb(NEUTRAL_HUE, NEUTRAL_SAT, NEUTRAL_L_BASE - l * NEUTRAL_L_SPAN);
}

// A neutral used as a BACKGROUND always ends up dark — inverting is only right
// for a neutral that was light to begin with. A site that paints an element dark
// in its light theme (a header bar at #4b4a4a, a footer, a code block) means it
// to be dark, and inverting turns it into a glaring light slab.
//
// Above SURFACE_PEAK this is just neutralFor: light-theme surfaces cluster in the
// top fifth of the range (#fff, #f7f7f7, #eee sit within 0.07 of each other), and
// inverting expands that into a usable spread instead of crushing it. Below the
// peak the curve rises from the canvas floor instead, so darker input stays
// darker and everything lands in the same charcoal family. The two meet exactly
// at the peak, so there's no step in the middle of the range.
const SURFACE_PEAK = 0.75;
function neutralSurfaceFor(l) {
  if (l >= SURFACE_PEAK) return neutralFor(l);
  const floor = NEUTRAL_L_BASE - NEUTRAL_L_SPAN; // = the canvas
  const peak = NEUTRAL_L_BASE - SURFACE_PEAK * NEUTRAL_L_SPAN;
  return hslToRgb(
    NEUTRAL_HUE,
    NEUTRAL_SAT,
    floor + (l / SURFACE_PEAK) * (peak - floor),
  );
}

// Relative luminance, WCAG 2.1. Holds accent colors to a contrast floor against
// the dark canvas rather than trusting HSL lightness, which is not
// perceptual — yellow at l=0.65 is glaring where blue at l=0.65 is still dim.
function relLuminance(r, g, b) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrastRatio = (a, b) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

// Luminance of the page canvas, computed once from the neutral curve.
let canvasLum = null;
function canvasLuminance() {
  if (canvasLum === null) canvasLum = relLuminance(...neutralFor(1));
  return canvasLum;
}

// Accent handling. On a dark canvas an unmodified mid-tone brand color reads
// dull — a blue like #0e74dd sits at only 3.8:1 against the charcoal, and a navy
// like #1c3f6e at 1.65:1 is effectively invisible.
//
// Hue is preserved. Saturation is taken to (or near) full, lightness is lifted
// into a vivid band, and then raised further while the result is still below
// MIN_CONTRAST — which is what rescues the darkest accents, since the band alone
// doesn't move them far enough.
//
// That contrast step is also what encodes "blue is hard to see, green is easy". It
// measures real luminance, not HSL lightness, and the sRGB weights are wildly
// uneven — blue contributes 0.0722 of a color's luminance where green
// contributes 0.7152. So the same nominal lightness leaves a blue dim and a
// green already glaring, and the climb lifts blues much further than greens
// without either being special-cased.
//
// The ordering matters: saturation is set first and lightness only rises as far
// as legibility demands. Past l≈0.72 an HSL color is mixing in white, so leading
// with lightness makes greens and olives read *milky* rather than brighter.
//
// Note this only lifts a color against the *canvas*. A vivified color used as a
// background is far brighter than the one the site authored, so whatever text
// sits on it is not guaranteed to read — that's what inkFor handles. Pale
// tints are excluded by the branch above and are never vivified: those are
// surfaces, and a vivid surface would swamp its own content.
// Accent text is tuned harder than an accent fill. A fill is a large block, so
// its color carries on area alone; text is thin strokes and has to carry on the
// color itself, so it gets the more aggressive set below.
const MIN_CONTRAST = 4.0; // legibility floor that drives the per-hue lift
const INK_MIN_CONTRAST = 5.5; // text is thin strokes, so it's held higher

// Fills, borders, and everything that isn't text.
const VIVID_FILL = {
  satFloor: 0.7, // even a muted accent ends up this saturated
  satGain: 1.35, // then everything gets pushed further up
  satCap: 1.0, // full saturation is wanted here, not avoided
  lMin: 0.54, // darkest an accent may end up
  lMax: 0.68, // lightest, before the contrast climb
  lCeiling: 0.9, // never bleach an accent to near-white
  minContrast: MIN_CONTRAST,
};

// Text. Brighter, and ONLY brighter — the saturation curve is deliberately
// identical to the fill one.
//
// Saturation has no useful headroom here: the fill floor and gain already put
// every accent at ~0.945 of a possible 1.0, so raising them buys about 5% and
// costs real contrast, because in sRGB the only way to add chroma above l=0.5 is
// to take lightness away — measured, a more saturated ink tuning costs brand blue
// 6.0:1 -> 5.2:1 and orange 9.9:1 -> 9.3:1 for a difference too small to see. The
// band carries the change instead, and the higher contrast floor lifts whichever
// hues fall short of it.
//
// lMax stops at 0.74 on purpose. Past l≈0.72 an HSL color is mixing in white, so
// greens and olives start reading milky rather than brighter — a couple of steps
// past the line is worth it for the luminance, much more is not.
const VIVID_INK = {
  satFloor: 0.7, // same as the fill: saturation is already effectively maxed
  satGain: 1.35,
  satCap: 1.0,
  lMin: 0.6, // the whole band sits above the fill's 0.54-0.68
  lMax: 0.74,
  lCeiling: 0.92,
  minContrast: INK_MIN_CONTRAST,
};

function vividFor(h, s, l, t) {
  const sat = Math.min(t.satCap, Math.max(s, t.satFloor) * t.satGain);
  let light = t.lMin + l * (t.lMax - t.lMin);
  let rgb = hslToRgb(h, sat, light);
  // Raising lightness raises luminance monotonically for a fixed hue and
  // saturation, so climbing in small steps converges on the floor.
  while (
    light < t.lCeiling &&
    contrastRatio(relLuminance(...rgb), canvasLuminance()) < t.minContrast
  ) {
    light = Math.min(t.lCeiling, light + 0.02);
    rgb = hslToRgb(h, sat, light);
  }
  return rgb;
}

// Map one light-theme color to its dark equivalent. Every branch returns a
// color, or null. remapParsed reads null as "leave the authored text alone".
//
// The role says what the color is painted as. The same gray needs opposite
// treatment depending on it, and nothing about the three numbers can tell the
// difference — the property name can, so remapValue passes it down.
//
//   SURFACE  a background. A dark one must stay dark; inverting it produces a
//            glaring light slab in the middle of a dark page.
//   INK      text, or an SVG fill. A light one must stay light: light text only
//            ever exists on top of something dark, so it is already correct.
//   LINE     borders and outlines, where plain inversion is right. A white
//            border is often a spacer on a white card, so it can't share INK's
//            rule without turning invisible separators into bright lines.
const ROLE_LINE = 0;
const ROLE_SURFACE = 1;
const ROLE_INK = 2;

const remapCache = new Map();

function remapRgb(r, g, b, role) {
  const key = (role << 24) | (r << 16) | (g << 8) | b;
  const hit = remapCache.get(key);
  if (hit !== undefined) return hit;
  const [h, s, l] = rgbToHsl(r, g, b);
  let out;
  // Light ink is already right. Nobody writes near-white text on a light
  // background — it would be invisible — so it was sitting on something dark
  // and still is. This is what covers text whose background is set by a
  // different rule, or by an image the remap can't read at all.
  if (role === ROLE_INK && l > 0.8) {
    out = null; // leave the authored value
  } else if (s < 0.12) {
    out = role === ROLE_SURFACE ? neutralSurfaceFor(l) : neutralFor(l);
  } else if (l > 0.8) {
    // Pale colored tint (e.g. light-blue selection bg) -> dark tinted surface.
    // These are surfaces, not accents, so they must NOT be vivified.
    out = hslToRgb(h, Math.min(s, 0.5), 0.16 + (1 - l) * 0.6);
  } else {
    // brand / accent / category color -> vivid, harder for text than for a fill
    out = vividFor(h, s, l, role === ROLE_INK ? VIVID_INK : VIVID_FILL);
  }
  remapCache.set(key, out);
  return out;
}

const toHex = (n) => n.toString(16).padStart(2, "0");
const hexOf = ([r, g, b]) => `#${toHex(r)}${toHex(g)}${toHex(b)}`;

// The two ends of the neutral ramp, reused as the text colors for a background
// whose own text can't be trusted to still read. Taking them from neutralFor
// rather than picking literal white and black keeps them in the theme's charcoal
// family, and INK_DARK is exactly the canvas.
const INK_LIGHT = neutralFor(0);
const INK_DARK = neutralFor(1);

// Whichever end reads better on this background. Bright vivified fills need dark
// text; dark surfaces need light text.
function inkFor(bg) {
  const lum = relLuminance(...bg);
  return contrastRatio(lum, relLuminance(...INK_LIGHT)) >=
    contrastRatio(lum, relLuminance(...INK_DARK))
    ? INK_LIGHT
    : INK_DARK;
}

// Does a background of this ORIGINAL color force us to restate the text color?
// Only where the remap moves the background somewhere its text can't follow:
//
//   neutral and already dark  the background stays dark, but the light text the
//                             site put on it inverts to near-black
//   non-neutral, not pale     vividFor makes it much brighter than authored
//
// A light neutral (the overwhelming majority) is left alone: it inverts to dark
// and its dark text inverts to light, which is already correct. Restating text
// there would overwrite inherited colors for no gain.
function needsInk(r, g, b, a) {
  if (a !== null && a < 0.95) return false; // see-through: not what sets the text
  const [, s, l] = rgbToHsl(r, g, b);
  return s < 0.12 ? l < 0.5 : l <= 0.8;
}

function parseHex(h) {
  h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

// Translucent near-black / near-white are backdrops, scrims and overlays. They
// should stay dark; inverting them yields a white veil over the page.
function isProtectedTranslucent(r, g, b, a) {
  if (a === null || a >= 0.95) return false;
  const neutral = Math.abs(r - g) < 12 && Math.abs(g - b) < 12;
  const extreme = (r + g + b) / 3 < 40 || (r + g + b) / 3 > 215;
  return neutral && extreme;
}

function absUrl(u, base) {
  if (/^(data:|https?:|\/\/|#)/i.test(u)) return null; // already absolute / inline
  try {
    return new URL(u, base).href;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reading stylesheets — parse with the browser, emit an overlay of changed decls
// ---------------------------------------------------------------------------

// A 1x1 canvas is a universal color parser: assign any CSS color the browser
// understands to fillStyle, read the painted pixel, get sRGB bytes. That covers
// oklch(), lab(), color(), color-mix() and hex-with-alpha — none of which a
// regex can evaluate — and keeps covering whatever syntax ships next.
// Memoized: a stylesheet reuses the same handful of colors thousands of times.
const colorCache = new Map();
let paintCtx = null;

function paint() {
  if (!paintCtx) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    paintCtx = c.getContext("2d", { willReadFrequently: true });
  }
  return paintCtx;
}

// Parse any CSS color string to [r, g, b, a], or null if it isn't a color.
function parseColor(value) {
  if (colorCache.has(value)) return colorCache.get(value);
  const ctx = paint();
  // Two sentinels: an unparseable value leaves fillStyle at whatever preceded
  // it, so the two reads disagree. A single sentinel can't tell "invalid" apart
  // from "the value happens to equal the sentinel".
  ctx.fillStyle = "#000";
  ctx.fillStyle = value;
  const first = ctx.fillStyle;
  ctx.fillStyle = "#fff";
  ctx.fillStyle = value;
  let out = null;
  if (first === ctx.fillStyle) {
    // fillStyle already serializes sRGB colors to #rrggbb / rgba(...). Only
    // fall back to painting a pixel for wide-gamut and perceptual color spaces,
    // which it echoes back verbatim.
    const hex = /^#([0-9a-f]{6})$/i.exec(first);
    const rgba =
      /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
        first,
      );
    if (hex) {
      out = [...parseHex("#" + hex[1]), 1];
    } else if (rgba) {
      out = [
        +rgba[1],
        +rgba[2],
        +rgba[3],
        rgba[4] === undefined ? 1 : +rgba[4],
      ];
    } else {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      out = [d[0], d[1], d[2], d[3] / 255];
    }
  }
  colorCache.set(value, out);
  return out;
}

// Remap a parsed color and serialize it. null = leave the original text alone.
function remapParsed(c, role) {
  const [r, g, b, a] = c;
  if (isProtectedTranslucent(r, g, b, a)) return null;
  const out = remapRgb(r, g, b, role);
  if (!out) return null;
  return a >= 0.999
    ? hexOf(out)
    : `rgba(${out[0]}, ${out[1]}, ${out[2]}, ${Math.round(a * 1000) / 1000})`;
}

// Longhands whose whole value is a single color. The CSSOM expands shorthands
// for us, so reading longhands can never double-remap the way reading both
// `background` and `background-color` would.
const DIRECT_COLOR = new Set([
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-block-start-color",
  "border-block-end-color",
  "border-inline-start-color",
  "border-inline-end-color",
  "outline-color",
  "text-decoration-color",
  "text-emphasis-color",
  "caret-color",
  "column-rule-color",
  "fill",
  "stroke",
  "stop-color",
  "flood-color",
  "lighting-color",
  "accent-color",
  "-webkit-text-fill-color",
  "-webkit-text-stroke-color",
]);

// Values that embed colors inside a larger expression (gradients). box-shadow
// and text-shadow are deliberately absent: a dark shadow reads fine on a dark
// surface, and inverting one turns it into a white glow.
const COMPOSITE_COLOR = new Set([
  "background-image",
  "border-image-source",
  "mask-image",
  "-webkit-mask-image",
  "list-style-image",
]);

// Values we can't resolve, or must not touch:
//   var()/env()  — the referenced token gets remapped at its own definition
//   currentColor — resolves per element; a canvas would read it as black
//   light-dark() — OVERRIDES sets color-scheme:dark, so the browser already
//                  picks the site's own dark branch. Rewriting it would invert
//                  that branch into a light color, i.e. worse than doing nothing.
//   CSS-wide keywords — not colors, and `initial` is what the CSSOM fills
//                       unset longhands of an expanded shorthand with.
const SKIP_VALUE =
  /(^|[^\w-])(var|env|light-dark)\(|currentcolor|(^|\s)(inherit|initial|unset|revert|revert-layer)(\s|$)/i;

// Loose candidate matcher for colors embedded in a larger value. It does NOT
// need to be accurate — every candidate is validated by parseColor, so a false
// positive like `repeat` or `linear` is simply rejected. That inverts the usual
// risk: a sloppy regex costs nothing here, where a regex run loose over whole
// stylesheet text would silently corrupt CSS.
const COLOR_FN = "rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix";
const CAND_RE = new RegExp(
  "#[0-9a-fA-F]{3,8}\\b" +
    "|(?:" +
    COLOR_FN +
    ")\\((?:[^()]|\\([^()]*\\))*\\)" +
    "|(?<![\\w-])[a-zA-Z]{3,20}(?![\\w-(])",
  "gi",
);

// Rewrite color tokens inside a composite value (gradients, custom properties).
// Returns null when nothing changed.
function remapTokens(value, baseHref, role) {
  const stash = [];
  const hold = (s) => {
    stash.push(s);
    return "\uE000" + (stash.length - 1) + "\uE001";
  };
  // url() must be absolutized: the overlay is a <style>, so a relative path
  // would resolve against the document instead of the source sheet. Stashing it
  // also keeps a data: URI's embedded colors out of the token pass.
  let out = value.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => {
    const abs = absUrl(u, baseHref);
    return hold(abs ? `url("${abs}")` : m);
  });
  // Quoted strings may hold color words (font names, generated content).
  out = out.replace(/"[^"]*"|'[^']*'/g, (m) => hold(m));

  let changed = false;
  out = out.replace(CAND_RE, (tok) => {
    const parsed = parseColor(tok);
    if (!parsed) return tok;
    const next = remapParsed(parsed, role);
    if (next === null) return tok;
    changed = true;
    return next;
  });
  out = out.replace(/\uE000(\d+)\uE001/g, (_, i) => stash[+i]);
  // Absolutizing alone isn't a reason to emit: the original sheet is still
  // enabled and resolves its own urls correctly.
  return changed ? out : null;
}

// Which role each property paints in. Anything unlisted is ROLE_LINE, the plain
// lightness inversion.
//
// Custom properties are deliberately absent: a --token has no role until it is
// used, and one token may back both a fill and a label. LINE is the safe default
// for them — a token holding a light color inverts to dark, which is right for a
// surface and for text alike.
const PROP_ROLE = new Map([
  ["background-color", ROLE_SURFACE],
  ["background-image", ROLE_SURFACE],
  ["color", ROLE_INK],
  ["-webkit-text-fill-color", ROLE_INK],
  ["fill", ROLE_INK],
  ["stroke", ROLE_INK],
]);

// Remap one declaration's value. Returns null when it should stay as authored.
function remapValue(prop, value, baseHref) {
  if (!value || SKIP_VALUE.test(value)) return null;
  const custom = prop.startsWith("--");
  const role = PROP_ROLE.get(prop) ?? ROLE_LINE;
  if (DIRECT_COLOR.has(prop) || custom) {
    const parsed = parseColor(value.trim());
    // A custom property holding a bare color is the highest-value case there
    // is: remapping the token at its definition themes every use of it at once.
    if (parsed) return remapParsed(parsed, role);
  }
  if (COMPOSITE_COLOR.has(prop) || custom)
    return remapTokens(value, baseHref, role);
  return null;
}

// The text color to force on a declaration block, or null to leave text alone.
// A background and the text on it have to be decided together: keeping a dark
// bar dark while its white label inverts to black is worse than the light bar we
// started with.
//
// Returns the remapped background too, so a caller can test whether a text color
// the site actually declared still reads against it.
function inkForBlock(style) {
  const bgValue = style.getPropertyValue("background-color");
  if (!bgValue || SKIP_VALUE.test(bgValue)) return null;
  const parsed = parseColor(bgValue.trim());
  if (!parsed || !needsInk(...parsed)) return null;
  const bg = remapRgb(parsed[0], parsed[1], parsed[2], ROLE_SURFACE);
  return { ink: inkFor(bg), bg };
}

// Keep a text color the site declared if it's an accent that still reads on the
// new background — flattening every label to plain ink would lose colored text
// on colored panels. A neutral is always replaced: it was chosen to read against
// the site's light background, which is not what sits behind it here.
function inkOverride(value, block) {
  if (!value || SKIP_VALUE.test(value)) return hexOf(block.ink);
  const parsed = parseColor(value.trim());
  if (!parsed) return hexOf(block.ink);
  const [r, g, b, a] = parsed;
  const [, s] = rgbToHsl(r, g, b);
  if (s < 0.12 || a < 0.95) return hexOf(block.ink);
  // null means ROLE_INK left it as authored (a pale accent), so test that.
  const out = remapRgb(r, g, b, ROLE_INK) || [r, g, b];
  return contrastRatio(relLuminance(...out), relLuminance(...block.bg)) >=
    INK_MIN_CONTRAST
    ? hexOf(out)
    : hexOf(block.ink);
}

// Serialize just the declarations of `style` whose colors changed.
function changedDecls(style, baseHref) {
  const block = inkForBlock(style);
  let out = "";
  let restated = false;
  for (const prop of style) {
    const value = style.getPropertyValue(prop);
    const priority = style.getPropertyPriority(prop);
    if (prop === "color" && block) {
      restated = true;
      out += `color:${inkOverride(value, block)}${
        priority ? " !" + priority : ""
      };`;
      continue;
    }
    const next = remapValue(prop, value, baseHref);
    if (next === null) continue;
    // Match the original's priority rather than fight it: equal specificity and
    // equal priority means later source order wins, and the overlay is later.
    out += `${prop}:${next}${priority ? " !" + priority : ""};`;
  }
  // A rule that paints a background but names no text color still needs one:
  // the text it inherits was picked against the light theme. This adds a
  // declaration the site didn't have, which is why needsInk is narrow — it fires
  // only where the inherited text would otherwise be unreadable.
  if (block && !restated) out += `color:${hexOf(block.ink)};`;
  return out;
}

// Take an at-rule's prelude straight off its cssText, so rule types this code
// has never heard of (@container, @scope, future ones) still round-trip.
function atPrelude(rule) {
  const text = rule.cssText || "";
  const i = text.indexOf("{");
  return i < 0 ? "" : text.slice(0, i).trim();
}

// Emit only what changed, mirroring the original's structure: same selector,
// same at-rule nesting, same @layer. Mirroring the layer matters — an unlayered
// overlay would beat layered rules unconditionally, including later ones that
// ought to win.
function emitRule(rule, baseHref) {
  const kids = rule.cssRules;
  const hasSelector = typeof rule.selectorText === "string";
  const decls = rule.style;

  // @import inside a live sheet: follow it if the imported sheet is readable.
  // (Sheets we fetch ourselves never reach here — replaceSync drops @import, so
  // injectOverlayFromText extracts and fetches them instead.)
  if (!kids && !decls && rule.styleSheet) {
    try {
      return buildOverlay(
        rule.styleSheet.cssRules,
        rule.styleSheet.href || baseHref,
      );
    } catch (e) {
      return ""; // cross-origin
    }
  }

  // @keyframes: a partial overlay is impossible, because a later block with the
  // same name replaces the earlier one wholesale. Emit every keyframe, with
  // remapped values substituted in.
  //
  // Identify it by its children carrying keyText, NOT by the rule having a
  // `name` — @layer blocks have a `name` too, and treating one as keyframes
  // emits `undefined{...}` for each child, so the whole layer goes unthemed.
  if (kids && kids.length && typeof kids[0].keyText === "string") {
    let inner = "",
      changed = false;
    for (const frame of kids) {
      let body = "";
      for (const prop of frame.style) {
        const value = frame.style.getPropertyValue(prop);
        const next = remapValue(prop, value, baseHref);
        if (next !== null) changed = true;
        const priority = frame.style.getPropertyPriority(prop);
        body += `${prop}:${next === null ? value : next}${
          priority ? " !" + priority : ""
        };`;
      }
      inner += `${frame.keyText}{${body}}`;
    }
    return changed ? `${atPrelude(rule)}{${inner}}` : "";
  }

  // Declaration-only at-rules (@font-face, @property, @counter-style): no colors
  // worth remapping, and emitting their declarations bare would leak them into
  // the enclosing block.
  if (decls && !hasSelector && !kids && (rule.cssText || "").trim()[0] === "@")
    return "";

  let body = decls ? changedDecls(decls, baseHref) : "";
  // A style rule holds its own declarations first, then its nested children;
  // emitting in tree order preserves which one wins on source order.
  if (kids) for (const child of kids) body += emitRule(child, baseHref);
  if (!body) return "";

  // CSSNestedDeclarations — the bare declarations that follow a nested rule.
  // They have no prelude; they belong to the enclosing block.
  if (!hasSelector && !kids) return body;

  const prelude = hasSelector ? rule.selectorText : atPrelude(rule);
  return prelude ? `${prelude}{${body}}` : body;
}

function buildOverlay(rules, baseHref) {
  let out = "";
  for (const rule of rules) out += emitRule(rule, baseHref);
  return out;
}

const IMPORT_RE =
  /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)/gi;

function extractImports(text, baseHref) {
  const found = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text))) {
    const raw = m[2] || m[4];
    if (raw) found.push(absUrl(raw, baseHref) || raw);
  }
  return found;
}

const seenHrefs = new Set(); // hrefs already fetched (also breaks @import cycles)
const trackedSheets = []; // live sheets to re-check for rules added via insertRule
let pollTimer = null;

// Insert an overlay after `cursor.node` and advance the cursor, so a sheet and
// the sheets it imports land in source order rather than reversed.
function insertOverlay(css, cursor, media, from) {
  const style = document.createElement("style");
  style.setAttribute(GEN, "1");
  if (from) style.setAttribute("data-moonaroon-from", from);
  // Keep the source's media scope. Without this a media="print" sheet would
  // apply on screen — the print stylesheet forces the cloud header to
  // position:static, which overrides its fixed positioning and breaks the layout.
  if (media) style.media = media;
  style.textContent = css;
  cursor.node.parentNode.insertBefore(style, cursor.node.nextSibling);
  cursor.node = style;
  injectedStyles.push(style);
  return style;
}

// Parse fetched CSS with the browser and inject its overlay. A constructed
// sheet is always readable, unlike a cross-origin one — that's the whole trick:
// fetch gets past CORS, replaceSync gets us a real rule tree.
async function injectOverlayFromText(text, baseHref, cursor, media) {
  // replaceSync silently DROPS @import rules, so follow them ourselves.
  // Imported rules come first in the cascade, hence before this sheet's overlay.
  for (const href of extractImports(text, baseHref))
    await processSheetHref(href, cursor, media);

  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
  } catch (e) {
    return;
  }
  const css = buildOverlay(sheet.cssRules, baseHref);
  if (css) insertOverlay(css, cursor, media, baseHref);
}

async function processSheetHref(href, cursor, media) {
  if (seenHrefs.has(href)) return;
  seenHrefs.add(href);
  let text;
  try {
    const res = await fetch(href);
    if (!res.ok) throw new Error(res.status);
    text = await res.text();
  } catch (e) {
    return; // cross-origin without permission, 404, etc. — leave the original.
  }
  if (!document.getElementById(STYLE_ID)) return; // toggled off while fetching
  await injectOverlayFromText(text, href, cursor, media);
}

function processLink(link) {
  if (!link.href || link.getAttribute(PROCESSED)) return;
  link.setAttribute(PROCESSED, "1");
  processSheetHref(link.href, { node: link }, link.media);
}

// A same-document <style> is same-origin, so its live CSSOM is readable — no
// fetch needed, and crucially no touching of its textContent. Re-assigning that
// makes the browser re-parse the element and WIPE rules a CSS-in-JS library
// inserted through insertRule, which destroys the layout. Reading cssRules and
// writing a separate overlay avoids the problem entirely, and also leaves the
// library's own rule indices undisturbed.
function processStyleEl(styleEl) {
  if (styleEl.getAttribute(GEN) || styleEl.getAttribute(PROCESSED)) return;
  const sheet = styleEl.sheet;
  if (!sheet) return; // not parsed yet — a later scan picks it up
  let rules;
  try {
    rules = sheet.cssRules;
  } catch (e) {
    return;
  }
  styleEl.setAttribute(PROCESSED, "1");
  const base = document.baseURI;
  const cursor = { node: styleEl };
  // Always create the node, even when empty: CSS-in-JS sheets start with no
  // rules, and this reserves their overlay's place in the cascade.
  const overlay = insertOverlay(
    buildOverlay(rules, base),
    cursor,
    styleEl.media,
    null,
  );
  trackedSheets.push({ sheet, base, overlay, count: rules.length });
}

// CSS-in-JS appends rules through insertRule, which fires no DOM mutation, so
// the observer never sees them. Watch the rule count instead.
function pollTrackedSheets() {
  for (const tracked of trackedSheets) {
    let rules;
    try {
      rules = tracked.sheet.cssRules;
    } catch (e) {
      continue;
    }
    if (rules.length === tracked.count) continue;
    tracked.count = rules.length;
    const css = buildOverlay(rules, tracked.base);
    // Writing to our own overlay is safe — it holds plain text, not CSSOM rules.
    if (css !== tracked.overlay.textContent) tracked.overlay.textContent = css;
  }
}

// ---------------------------------------------------------------------------
// Apply / remove
// ---------------------------------------------------------------------------
let observer = null;
let retryTimers = [];
const injectedStyles = []; // <style> nodes we added
const OBS_OPTS = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["style"],
};

function withPaused(fn) {
  if (observer) observer.disconnect();
  try {
    fn();
  } finally {
    if (observer) {
      observer.takeRecords();
      observer.observe(document.documentElement, OBS_OPTS);
    }
  }
}

// Rewrite inline style="" attributes (some colors are set via JS at runtime).
function processInlineStyles(root) {
  const els = root.querySelectorAll ? root.querySelectorAll("[style]") : [];
  for (const el of els) {
    if (el.getAttribute(PROCESSED) || el.getAttribute(GEN)) continue;
    let changed = false;
    // Same background/text pairing as a stylesheet rule. An inline background is
    // if anything more likely to be a hand-placed dark box than a rule is.
    const block = inkForBlock(el.style);
    const stash = (prop, val) => {
      el.dataset.moonaroonOrig =
        (el.dataset.moonaroonOrig || "") + `${prop}::${val}||`;
    };
    // Longhands only — never a shorthand AND its longhand together. A shorthand
    // like `background:` or `border-color:` sets the longhands, so reading the
    // longhand catches the same color; processing both would remap it twice
    // (e.g. background:#fff -> dark -> light again).
    for (const prop of [
      "color",
      "background-color",
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
      "outline-color",
      "fill",
      "stroke",
    ]) {
      const val = el.style.getPropertyValue(prop);
      if (!val && !(prop === "color" && block)) continue;
      // Inline styles can't be overlaid — nothing outranks them short of
      // !important — so these are rewritten in place.
      const next =
        prop === "color" && block
          ? inkOverride(val, block)
          : remapValue(prop, val, document.baseURI);
      if (next !== null && next !== val) {
        // An empty stashed value restores as a removeProperty, which is what
        // undoes a color we added to an element that had none.
        stash(prop, val);
        el.style.setProperty(prop, next, el.style.getPropertyPriority(prop));
        changed = true;
      }
    }
    if (changed) el.setAttribute(PROCESSED, "1");
  }
}

function scan() {
  // Synchronous DOM writes (page <style> + inline attrs) — pause the observer.
  // Overlay nodes are inserted here too, hence the same pause.
  withPaused(() => {
    document
      .querySelectorAll(`style:not([${GEN}]):not([${PROCESSED}])`)
      .forEach(processStyleEl);
    processInlineStyles(document);
  });
  // Stylesheet links — async fetch; our injected nodes carry GEN so the
  // observer ignores them, so no pause needed here.
  document.querySelectorAll("link[rel~='stylesheet']").forEach(processLink);
}

function applyDark() {
  if (document.getElementById(STYLE_ID)) return;
  const base = document.createElement("style");
  base.id = STYLE_ID;
  base.setAttribute(GEN, "1"); // ours — never feed it back through the remapper
  // Canvas = the same charcoal that a white surface remaps to, so the page
  // background matches the themed surfaces instead of being a flat gray.
  const canvas = hexOf(remapRgb(255, 255, 255, ROLE_SURFACE));
  base.textContent = `html { background:${canvas}; }` + OVERRIDES;
  (document.head || document.documentElement).appendChild(base);

  scan();

  observer = new MutationObserver((mutations) => {
    const styleEls = [],
      inlineRoots = [],
      links = [];
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1 || node.getAttribute(GEN)) continue;
        if (node.tagName === "LINK" && /stylesheet/i.test(node.rel || ""))
          links.push(node);
        else if (node.tagName === "STYLE") styleEls.push(node);
        if (node.querySelectorAll) {
          node
            .querySelectorAll("link[rel~='stylesheet']")
            .forEach((l) => links.push(l));
          node
            .querySelectorAll(`style:not([${GEN}])`)
            .forEach((s) => styleEls.push(s));
        }
        inlineRoots.push(node);
      }
      if (
        m.type === "attributes" &&
        m.target.nodeType === 1 &&
        m.target.tagName !== "STYLE" &&
        m.target.tagName !== "LINK" &&
        !m.target.getAttribute(GEN)
      ) {
        m.target.removeAttribute(PROCESSED);
        delete m.target.dataset.moonaroonOrig;
        inlineRoots.push(m.target);
      }
    }
    withPaused(() => {
      for (const s of styleEls) processStyleEl(s);
      for (const r of inlineRoots) processInlineStyles(r);
    });
    for (const l of links) processLink(l);
  });
  observer.observe(document.documentElement, OBS_OPTS);

  document.addEventListener("DOMContentLoaded", scan);
  window.addEventListener("load", scan);
  for (const ms of [300, 1000, 2500]) retryTimers.push(setTimeout(scan, ms));
  pollTimer = setInterval(pollTrackedSheets, 1500);
}

function removeDark() {
  const base = document.getElementById(STYLE_ID);
  if (base) base.remove();
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  document.removeEventListener("DOMContentLoaded", scan);
  window.removeEventListener("load", scan);
  retryTimers.forEach(clearTimeout);
  retryTimers = [];
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  for (const style of injectedStyles) style.remove();
  injectedStyles.length = 0;
  trackedSheets.length = 0;
  seenHrefs.clear();
  // No source sheet was ever disabled or edited, so there is nothing to
  // restore beyond our own nodes and the inline styles below.
  for (const el of document.querySelectorAll(`[${PROCESSED}]`)) {
    if (el.dataset.moonaroonOrig) {
      for (const entry of el.dataset.moonaroonOrig.split("||")) {
        if (!entry) continue;
        const idx = entry.indexOf("::");
        el.style.setProperty(entry.slice(0, idx), entry.slice(idx + 2));
      }
      delete el.dataset.moonaroonOrig;
    }
    el.removeAttribute(PROCESSED);
  }
}

// ---------------------------------------------------------------------------
// Toggle-on splash
// ---------------------------------------------------------------------------
// A moon spins out of the centre of the window, grows until it covers
// everything, then fades. The theme is applied at the moment of full cover, so
// the swap from light to dark happens hidden behind the moon.
const SPLASH_ID = "moonaroon-splash";
const SPLASH_MS = 1000;
const SPLASH_COVER = 0.72; // fraction of the run at which the moon covers the window
let splashTimer = null;

// The growth and spin curve, sampled into segments the animation walks linearly.
//
// **Every segment must be faster than the one before it, including the last.**
// The moon has to read as still rushing at the viewer when it vanishes, so
// nothing here may ease out, and no segment may even hold steady — a rate that
// stops climbing looks like the moon braking just short of the screen. Sampling
// is what makes that checkable: the rate of a segment is
// `(next - current) / (next offset - current offset)`, so it can be read off the
// table. A bezier can't be checked by eye, and most of them flatten at the end.
//
// `scale: 1` is exactly window-covering (see `size` in `playSplash`), so the
// `SPLASH_COVER` row must be 1 — that frame is what `applyDark` hides behind.
// Everything past it is off-screen overshoot, seen only through the crater
// texture streaming outwards, which is what sells the last few frames.
// Spin climbs far more gently than scale — roughly 610°/s to 1375°/s across the
// whole run, where scale goes up by 250×. They are separate curves on purpose:
// the zoom is what should feel like it's accelerating at you, and a spin that
// accelerates to match just reads as a frantic blur.
// prettier-ignore
const SPLASH_RAMP = [
  // offset,      scale, spin°, opacity (null = interpolate)
  [0,             0.03,      0, 1],
  [0.18,          0.06,    110, null],
  [0.34,          0.11,    220, null],
  [0.48,          0.2,     330, null],
  [0.6,           0.38,    440, null],
  [0.68,          0.65,    520, null],
  [SPLASH_COVER,  1,       565, null], // covers the window; theme swaps here
  [0.84,          2.3,     710, 1],    // fade starts after cover, so it's a wipe
  [0.92,          3.6,     815, null],
  [1,             7,       925, 0],
];

// Inlined rather than loaded from icons/moon.svg: an extension URL would need a
// web_accessible_resources entry and can still be blocked by the page's CSP.
// The clip-path id is namespaced because it resolves against the whole document.
const MOON_SVG = `<svg viewBox="0 0 600 600" width="100%" height="100%" style="display:block" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<defs><clipPath id="moonaroon-splash-clip"><circle cx="300" cy="300" r="300"/></clipPath></defs>
<g clip-path="url(#moonaroon-splash-clip)">
<rect x="0" y="0" width="600" height="600" fill="#fce183"/>
<circle cx="150" cy="90" r="72" fill="#e8bc48"/>
<circle cx="245" cy="175" r="30" fill="#e8bc48"/>
<circle cx="510" cy="135" r="52" fill="#e8bc48"/>
<circle cx="95" cy="290" r="44" fill="#e8bc48"/>
<circle cx="135" cy="470" r="84" fill="#e8bc48"/>
<circle cx="445" cy="510" r="40" fill="#e8bc48"/>
<circle cx="535" cy="430" r="58" fill="#e8bc48"/>
<path d="M 165 415 L 165 190 L 300 340 L 435 190 L 435 415" fill="none" stroke="#b6861e" stroke-width="82" stroke-linecap="round" stroke-linejoin="round"/>
</g></svg>`;

// Whether this toggle is a splash toggle. Deliberately frame-agnostic: every
// frame must agree, because a subframe has to hold its own theme apply until the
// moon covers the window even though only the top frame draws the moon. Each
// condition reads the same in a subframe — visibilityState reflects the tab, and
// the media query reflects the OS.
function splashWanted() {
  return (
    // Storage changes broadcast to every open tab, not just the one the popup
    // was opened over. A hidden tab has nobody to entertain.
    document.visibilityState === "visible" &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches &&
    typeof Element.prototype.animate === "function"
  );
}

// Hold the theme until the moon covers the window. Shared by both frame roles so
// the whole page — top document and every iframe — flips at the same instant.
function applyAtCover() {
  splashTimer = setTimeout(() => {
    splashTimer = null;
    applyDark();
  }, SPLASH_MS * SPLASH_COVER);
}

function clearSplash() {
  if (splashTimer) {
    clearTimeout(splashTimer);
    splashTimer = null;
  }
  const el = document.getElementById(SPLASH_ID);
  if (el) withPaused(() => el.remove());
}

function playSplash() {
  const el = document.createElement("div");
  el.id = SPLASH_ID;
  el.setAttribute(GEN, "1"); // ours — the remapper must not theme the moon
  // The moon is a circle, so covering a rectangular viewport takes a diameter
  // of at least its diagonal.
  const size = Math.hypot(window.innerWidth, window.innerHeight) * 1.06;
  el.style.cssText =
    `position:fixed;left:50%;top:50%;width:${size}px;height:${size}px;` +
    `margin:0;padding:0;border:0;pointer-events:none;` +
    `z-index:2147483647;will-change:transform,opacity;`;
  el.innerHTML = MOON_SVG;
  withPaused(() => (document.body || document.documentElement).appendChild(el));

  // Web Animations rather than a @keyframes <style>: no extra injected node and
  // no animation-name that could collide with the page's own keyframes.
  const frames = SPLASH_RAMP.map(([offset, scale, spin, opacity]) => {
    const frame = {
      offset,
      transform: `translate(-50%,-50%) rotate(${spin}deg) scale(${scale})`,
      // Linear between samples, so the ramp above is the whole story — the speed
      // of each segment is exactly what it looks like.
      easing: "linear",
    };
    // Omitted rather than null: opacity then interpolates between the frames
    // that do set it, which is how the fade gets its own timing.
    if (opacity !== null) frame.opacity = opacity;
    return frame;
  });
  const anim = el.animate(frames, { duration: SPLASH_MS, fill: "forwards" });

  applyAtCover();

  const done = () => {
    if (el.isConnected) withPaused(() => el.remove());
  };
  anim.addEventListener("finish", done);
  anim.addEventListener("cancel", done);
}

function sync(enabled, animate) {
  clearSplash();
  if (!enabled) {
    removeDark();
    return;
  }
  if (!animate || !splashWanted()) applyDark();
  // all_frames means every iframe runs this script. Only the top frame
  // draws the moon — otherwise one toggle spawns a moon per iframe — but the
  // frames still wait for cover, so they don't visibly turn dark ahead of it.
  else if (window.top === window) playSplash();
  else applyAtCover();
}

// The theme applies where the master switch is on AND this host is on the user's
// list. The script itself is injected everywhere — matching here rather than
// through dynamically registered content scripts keeps the whole decision in one
// readable place, and costs nothing on a host that isn't listed: this file does
// no work at all until sync() is called with true.
let enabledPref = false;
let siteList = [];
let applied = false;

// An entry covers the bare host and every subdomain, so `example.com` matches
// `www.example.com` too — the same reach a `*.example.com` match pattern has,
// which is what someone typing one host into a list expects it to mean.
function hostListed() {
  const host = location.hostname.toLowerCase();
  return siteList.some((s) => host === s || host.endsWith("." + s));
}

// Act only on a real change of state. A storage write for some OTHER site's
// entry reaches this tab too, and re-running sync() on it would replay the
// splash and re-apply an already-applied theme on every unrelated edit.
function refresh(animate) {
  const want = enabledPref && hostListed();
  if (want === applied) return;
  applied = want;
  sync(want, animate);
}

// Initial state — no splash, the page was already loading dark.
chrome.storage.sync.get({ [STORAGE_KEY]: false, [SITES_KEY]: [] }, (res) => {
  enabledPref = res[STORAGE_KEY];
  siteList = res[SITES_KEY] || [];
  refresh(false);
});

// React to the popup live: the master switch, and edits to the site list.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (!changes[STORAGE_KEY] && !changes[SITES_KEY]) return;
  if (changes[STORAGE_KEY]) enabledPref = changes[STORAGE_KEY].newValue;
  if (changes[SITES_KEY]) siteList = changes[SITES_KEY].newValue || [];
  refresh(true);
});
