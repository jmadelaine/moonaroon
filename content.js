// Moonaroon — dark mode for bozuman.cybozu.com (Garoon / Cybozu)
//
// Strategy: rather than mutate the live CSSOM (which throws SecurityError on
// cross-origin sheets and is fiddly to toggle), we FETCH each stylesheet's raw
// text, rewrite its colors, and inject the rewritten copy in place of the
// original. Only *neutrals* (grays/whites/blacks) get their lightness inverted,
// and *pale colored tints* get darkened; saturated brand/category colors (the
// Cybozu blue, alert red, calendar tags) are left untouched. url(...) paths are
// absolutized so images still resolve, and color rewriting is confined to
// declaration blocks so it can never corrupt selectors (e.g. an `#abc` id).

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
     scrollbars keep theirs (already themed by the remap, higher source order). */
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

// Map one light-theme color to its dark equivalent — NEUTRALS + PALE TINTS only.
// Returns null to signal "leave this color exactly as it is" (saturated colors).
function remapRgb(r, g, b) {
  let [h, s, l] = rgbToHsl(r, g, b);
  if (s < 0.12) {
    // Neutral grays: invert lightness onto a charcoal hue.
    // white -> ~0.10, black -> ~0.95, 0.5 -> ~0.525
    return hslToRgb(NEUTRAL_HUE, NEUTRAL_SAT, 0.95 - l * 0.85);
  }
  if (l > 0.8) {
    // Pale colored tint (e.g. light-blue selection bg) -> dark tinted surface.
    return hslToRgb(h, Math.min(s, 0.5), 0.16 + (1 - l) * 0.6);
  }
  return null; // saturated brand / accent / category color -> untouched
}

const COLOR_RE =
  /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)/g;

// Named CSS neutrals — the regex above only catches hex / rgb(), so these
// would otherwise stay flat gray / white / black.
const NAMED = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  gainsboro: [220, 220, 220],
  whitesmoke: [245, 245, 245],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
};
// Match a keyword only as a standalone token. \b is wrong here because it treats
// "-" as a boundary, so it would corrupt the color word inside CSS custom property
// identifiers like `--c-gray` or `var(--component-color-border-gray)` — breaking
// the reference and reflowing the layout. Require no adjacent word char or hyphen.
const NAMED_RE = new RegExp(
  "(?<![\\w-])(" + Object.keys(NAMED).join("|") + ")(?![\\w-])",
  "gi",
);

function parseHex(h) {
  h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
const toHex = (n) => n.toString(16).padStart(2, "0");

// Replace every color token in a string with its dark equivalent.
function remapColors(value) {
  value = value.replace(COLOR_RE, (tok) => {
    let r,
      g,
      b,
      a = null;
    if (tok[0] === "#") {
      [r, g, b] = parseHex(tok);
    } else {
      const nums = tok.match(/[\d.]+/g).map(Number);
      [r, g, b] = nums;
      if (nums.length === 4) a = nums[3];
    }
    // Leave translucent near-black / near-white untouched — backdrops, scrims
    // and overlays should stay dark; inverting them yields a white veil.
    if (a !== null && a < 0.95) {
      const neutral = Math.abs(r - g) < 12 && Math.abs(g - b) < 12;
      const extreme = (r + g + b) / 3 < 40 || (r + g + b) / 3 > 215;
      if (neutral && extreme) return tok;
    }
    const out = remapRgb(r, g, b);
    if (!out) return tok; // saturated -> keep
    const [nr, ng, nb] = out;
    return a === null
      ? `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`
      : `rgba(${nr}, ${ng}, ${nb}, ${a})`;
  });
  // Named neutrals. (Callers protect quoted strings / urls so we only hit
  // genuine color keywords, never font names or content.)
  return value.replace(NAMED_RE, (tok) => {
    const out = remapRgb(...NAMED[tok.toLowerCase()]);
    return out ? `#${toHex(out[0])}${toHex(out[1])}${toHex(out[2])}` : tok;
  });
}

// ---------------------------------------------------------------------------
// CSS text transform
// ---------------------------------------------------------------------------
function absUrl(u, base) {
  if (/^(data:|https?:|\/\/|#)/i.test(u)) return null; // already absolute / inline
  try {
    return new URL(u, base).href;
  } catch (e) {
    return null;
  }
}

// Rewrite a whole stylesheet's text: absolutize urls, remap colors inside
// declaration blocks only, and never touch box-shadow / text-shadow or the
// contents of url(...) (which may embed colors in data: SVGs).
function transformCss(text, baseHref) {
  // Absolutize @import urls (they live outside declaration blocks).
  text = text.replace(
    /@import\s+url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    (m, q, u) => {
      const abs = absUrl(u, baseHref);
      return abs ? `@import url("${abs}")` : m;
    },
  );
  // Remap colors only within { ... } declaration blocks (innermost match first,
  // so @media / @keyframes wrappers are skipped and selectors are never hit).
  return text.replace(
    /\{([^{}]*)\}/g,
    (m, body) => "{" + remapDecls(body, baseHref) + "}",
  );
}

function remapDecls(body, baseHref) {
  const stash = [];
  const hold = (s) => {
    stash.push(s);
    return "\uE000" + (stash.length - 1) + "\uE001";
  };
  // Absolutize + protect url(...) so its contents aren't treated as colors.
  body = body.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    const abs = absUrl(u, baseHref);
    return hold(abs ? `url("${abs}")` : m);
  });
  // Protect quoted strings (content:, font-family:) so color keywords inside
  // them aren't mistaken for colors.
  body = body.replace(/"[^"]*"|'[^']*'/g, (m) => hold(m));
  // Protect shadows — dark shadows read fine on dark; inverting them glows.
  body = body.replace(/(box-shadow|text-shadow)\s*:[^;]*/gi, (m) => hold(m));
  body = remapColors(body);
  return body.replace(/\uE000(\d+)\uE001/g, (_, i) => stash[+i]);
}

// ---------------------------------------------------------------------------
// Apply / remove
// ---------------------------------------------------------------------------
let observer = null;
let retryTimers = [];
const injectedStyles = []; // <style> nodes we added
const disabledLinks = []; // original <link> nodes we disabled
const styleOriginals = new Map(); // page <style> -> original text
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

// Fetch a <link> stylesheet, rewrite it, inject the dark copy, disable original.
async function processLink(link) {
  if (!link.href || link.getAttribute(PROCESSED)) return;
  link.setAttribute(PROCESSED, "1");
  let text;
  try {
    const res = await fetch(link.href);
    if (!res.ok) throw new Error(res.status);
    text = await res.text();
  } catch (e) {
    return; // cross-origin without permission, 404, etc. — leave the original.
  }
  if (!document.getElementById(STYLE_ID)) return; // toggled off while fetching
  const css = transformCss(text, link.href);
  const style = document.createElement("style");
  style.setAttribute(GEN, "1");
  style.setAttribute("data-moonaroon-from", link.href);
  // Preserve the link's media scope. Without this a media="print" sheet would
  // apply on screen — e.g. Garoon's print.css forces the header position:static,
  // overriding its fixed positioning.
  if (link.media) style.media = link.media;
  style.textContent = css;
  link.parentNode.insertBefore(style, link.nextSibling); // preserve cascade order
  link.disabled = true;
  injectedStyles.push(style);
  disabledLinks.push(link);
}

// Rewrite a page-authored <style> element's text in place.
function processStyleEl(style) {
  if (style.getAttribute(GEN) || style.getAttribute(PROCESSED)) return;
  style.setAttribute(PROCESSED, "1");
  const orig = style.textContent || "";
  const next = transformCss(orig, document.baseURI);
  // CRITICAL: only write back when the text actually changed. CSS-in-JS
  // (styled-components, Emotion) injects rules through the CSSOM (insertRule)
  // and leaves textContent empty; re-assigning textContent — even the same
  // empty string — makes the browser re-parse the element and WIPE those
  // injected rules, which destroys the page's layout (e.g. Kintone's nav).
  if (next === orig) return;
  styleOriginals.set(style, orig);
  style.textContent = next;
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
      const next = remapColors(val);
      if (next !== val) {
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
  // Synchronous DOM rewrites (page <style> + inline attrs) — pause observer.
  withPaused(() => {
    document
      .querySelectorAll(`style:not([${GEN}]):not([${PROCESSED}])`)
      .forEach(processStyleEl);
    processInlineStyles(document);
  });
  // Stylesheet links — async fetch; our injected nodes carry GEN so the
  // observer ignores them, so no pause needed here.
  document
    .querySelectorAll("link[rel~='stylesheet']")
    .forEach((l) => processLink(l));
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

  for (const style of injectedStyles) style.remove();
  injectedStyles.length = 0;
  for (const link of disabledLinks) {
    try {
      link.disabled = false;
    } catch (e) {}
    link.removeAttribute(PROCESSED);
  }
  disabledLinks.length = 0;
  for (const [style, orig] of styleOriginals) {
    style.textContent = orig;
    style.removeAttribute(PROCESSED);
  }
  styleOriginals.clear();

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
