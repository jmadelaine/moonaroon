// Moonaroon — dark mode for Cybozu (Garoon / Kintone) on any *.cybozu.com host
//
// Colors are remapped in HSL: neutrals invert their lightness onto a charcoal
// hue, pale tints become dark surfaces, and accents go vivid (see remapRgb).
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
const PROCESSED = "data-moonaroon"; // marks links/styles/elements we've handled
const GEN = "data-moonaroon-gen"; // marks <style> nodes we injected

// Site-specific fixes for elements Garoon already styles dark in light mode —
// lightness-inversion wrongly flips these *light*, so we restore them by hand.
// The cloud header bar is dark (#4b4a4a) with light text by default.
const HEADER_BG = "#2d3338"; // charcoal — darker than the inverted result, not black
// Doubled class selectors (.x.x) raise specificity so these beat the remapped
// rules (some of which are !important) regardless of injection order.
const OVERRIDES = `
  .cloudHeader-grn.cloudHeader-grn { background:${HEADER_BG} !important; }
  .header_portal_title_grn.header_portal_title_grn,
  .cloudHeader-spaceApplicationTitle-grn.cloudHeader-spaceApplicationTitle-grn,
  .header_appmenu_title_grn.header_appmenu_title_grn,
  .cloudHeader-userName-grn.cloudHeader-userName-grn,
  .cloudHeader-startMenuTitle-grn.cloudHeader-startMenuTitle-grn,
  .cloudHeader-adminSettingsTitle-grn.cloudHeader-adminSettingsTitle-grn,
  .cloudHeader-grnNotificationTitle-grn.cloudHeader-grnNotificationTitle-grn { color:#fafafa !important; }

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
function neutralFor(l) {
  return hslToRgb(NEUTRAL_HUE, NEUTRAL_SAT, 0.95 - l * 0.85);
}

// Relative luminance, WCAG 2.1. Used to hold accent colors to a contrast floor
// against the dark canvas instead of trusting HSL lightness, which is not
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
// dull — Cybozu's #0e74dd sits at only 3.8:1 against the charcoal, and a navy
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
// Note this only lifts a color against the *canvas*. Where a saturated color is
// a button background, the label on top is usually white — a neutral, so it maps
// to near-black charcoal and stays readable as dark-on-bright. Pale tints are
// handled by the branch above and are never vivified: those are surfaces, and a
// vivid surface would swamp its own content.
const VIVID_SAT_FLOOR = 0.7; // even a muted accent ends up this saturated
const VIVID_SAT_GAIN = 1.35; // then everything gets pushed further up
const VIVID_SAT_CAP = 1.0; // full saturation is wanted here, not avoided
const VIVID_L_MIN = 0.54; // darkest an accent may end up
const VIVID_L_MAX = 0.68; // lightest, before the contrast climb
const MIN_CONTRAST = 4.0; // legibility floor that drives the per-hue lift
const VIVID_L_CEILING = 0.9; // never bleach an accent to near-white

function vividFor(h, s, l) {
  const sat = Math.min(
    VIVID_SAT_CAP,
    Math.max(s, VIVID_SAT_FLOOR) * VIVID_SAT_GAIN,
  );
  let light = VIVID_L_MIN + l * (VIVID_L_MAX - VIVID_L_MIN);
  let rgb = hslToRgb(h, sat, light);
  // Raising lightness raises luminance monotonically for a fixed hue and
  // saturation, so climbing in small steps converges on the floor.
  while (
    light < VIVID_L_CEILING &&
    contrastRatio(relLuminance(...rgb), canvasLuminance()) < MIN_CONTRAST
  ) {
    light = Math.min(VIVID_L_CEILING, light + 0.02);
    rgb = hslToRgb(h, sat, light);
  }
  return rgb;
}

// Map one light-theme color to its dark equivalent. Every branch returns a
// color; the null return is kept because remapParsed still treats null as
// "leave the authored text alone".
const remapCache = new Map();

function remapRgb(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  const hit = remapCache.get(key);
  if (hit !== undefined) return hit;
  const [h, s, l] = rgbToHsl(r, g, b);
  let out;
  if (s < 0.12) {
    out = neutralFor(l); // neutral gray -> charcoal
  } else if (l > 0.8) {
    // Pale colored tint (e.g. light-blue selection bg) -> dark tinted surface.
    // These are surfaces, not accents, so they must NOT be vivified.
    out = hslToRgb(h, Math.min(s, 0.5), 0.16 + (1 - l) * 0.6);
  } else {
    out = vividFor(h, s, l); // brand / accent / category color -> vivid
  }
  remapCache.set(key, out);
  return out;
}

const toHex = (n) => n.toString(16).padStart(2, "0");

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
function remapParsed(c) {
  const [r, g, b, a] = c;
  if (isProtectedTranslucent(r, g, b, a)) return null;
  const out = remapRgb(r, g, b);
  if (!out) return null;
  return a >= 0.999
    ? `#${toHex(out[0])}${toHex(out[1])}${toHex(out[2])}`
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
function remapTokens(value, baseHref) {
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
    const next = remapParsed(parsed);
    if (next === null) return tok;
    changed = true;
    return next;
  });
  out = out.replace(/\uE000(\d+)\uE001/g, (_, i) => stash[+i]);
  // Absolutizing alone isn't a reason to emit: the original sheet is still
  // enabled and resolves its own urls correctly.
  return changed ? out : null;
}

// Remap one declaration's value. Returns null when it should stay as authored.
function remapValue(prop, value, baseHref) {
  if (!value || SKIP_VALUE.test(value)) return null;
  const custom = prop.startsWith("--");
  if (DIRECT_COLOR.has(prop) || custom) {
    const parsed = parseColor(value.trim());
    // A custom property holding a bare color is the highest-value case there
    // is: remapping the token at its definition themes every use of it at once.
    if (parsed) return remapParsed(parsed);
  }
  if (COMPOSITE_COLOR.has(prop) || custom)
    return remapTokens(value, baseHref);
  return null;
}

// Serialize just the declarations of `style` whose colors changed.
function changedDecls(style, baseHref) {
  let out = "";
  for (const prop of style) {
    const value = style.getPropertyValue(prop);
    const next = remapValue(prop, value, baseHref);
    if (next === null) continue;
    const priority = style.getPropertyPriority(prop);
    // Match the original's priority rather than fight it: equal specificity and
    // equal priority means later source order wins, and the overlay is later.
    out += `${prop}:${next}${priority ? " !" + priority : ""};`;
  }
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
  // apply on screen — Garoon's print.css forces the header position:static,
  // which overrides its fixed positioning and breaks the layout.
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

// Rewrite inline style="" attributes (Garoon sets some colors via JS).
function processInlineStyles(root) {
  const els = root.querySelectorAll ? root.querySelectorAll("[style]") : [];
  for (const el of els) {
    if (el.getAttribute(PROCESSED) || el.getAttribute(GEN)) continue;
    let changed = false;
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
      if (!val) continue;
      // Inline styles can't be overlaid — nothing outranks them short of
      // !important — so these are rewritten in place.
      const next = remapValue(prop, val, document.baseURI);
      if (next !== null && next !== val) {
        el.dataset.moonaroonOrig =
          (el.dataset.moonaroonOrig || "") + `${prop}::${val}||`;
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
  const [cr, cg, cb] = remapRgb(255, 255, 255);
  const canvas = `#${toHex(cr)}${toHex(cg)}${toHex(cb)}`;
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

function sync(enabled) {
  if (enabled) applyDark();
  else removeDark();
}

// Initial state
chrome.storage.sync.get({ [STORAGE_KEY]: false }, (res) =>
  sync(res[STORAGE_KEY]),
);

// React to toggles from the popup live
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes[STORAGE_KEY])
    sync(changes[STORAGE_KEY].newValue);
});
