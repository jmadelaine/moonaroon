// Loaded by every case page, before content.js. Collects assertions and POSTs
// them to the runner, which is what turns a rendered page into an exit code.
//
// Wrapped in an IIFE and exposing a single global: a case page and content.js
// share one lexical scope, so re-declaring any top-level name from content.js is
// a SyntaxError that kills the whole file before its first line runs.
window.T = (function () {
  const results = [];

  const ok = (name, pass, detail) =>
    results.push({ name, pass: !!pass, detail: detail == null ? "" : String(detail) });

  const lin = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };

  // Luminance of a computed color string. Alpha is ignored: everything measured
  // here is opaque, and a translucent value would need its backdrop anyway.
  const lum = (css) => {
    const p = (css || "").match(/[\d.]+/g);
    if (!p) return null;
    return 0.2126 * lin(+p[0]) + 0.7152 * lin(+p[1]) + 0.0722 * lin(+p[2]);
  };

  const contrast = (a, b) => {
    const x = lum(a),
      y = lum(b);
    if (x == null || y == null) return null;
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  const isTransparent = (c) => !c || /rgba\(0, 0, 0, 0\)|transparent/.test(c);

  // The background actually behind an element: walk up to the first opaque one.
  // `rgba(0,0,0,0)` reads as pure black to any naive lightness check, so
  // "transparent because nothing applied" and "correctly themed dark" would
  // otherwise look identical.
  const bgOf = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (!isTransparent(c)) return c;
    }
    return "rgb(255, 255, 255)";
  };

  const dark = (css) => {
    const l = lum(css);
    return l != null && l < 0.12;
  };

  // Every color-ish computed property of one element, for round-trip snapshots.
  const PROPS = [
    "color",
    "backgroundColor",
    "backgroundImage",
    "borderTopColor",
    "borderRightColor",
    "borderBottomColor",
    "borderLeftColor",
    "outlineColor",
    "fill",
    "stroke",
  ];
  const snapshot = (root) => {
    const out = [];
    for (const el of (root || document).querySelectorAll("*")) {
      if (el.hasAttribute("data-moonaroon-gen")) continue;
      if (el.tagName === "STYLE" || el.tagName === "SCRIPT") continue;
      const cs = getComputedStyle(el);
      out.push(PROPS.map((p) => cs[p]).join("|"));
    }
    return out;
  };

  return {
    ok,
    lum,
    contrast,
    bgOf,
    dark,
    isTransparent,
    snapshot,
    // Themed and readable: report the raw values so a failure says what it saw.
    readable(name, el, floor) {
      const c = getComputedStyle(el).color;
      const bg = bgOf(el);
      const r = contrast(c, bg);
      ok(
        name,
        r != null && r >= (floor || 4),
        `bg=${bg} text=${c} contrast=${r == null ? "?" : r.toFixed(2)}:1`,
      );
    },
    done() {
      return fetch("/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: location.pathname, results }),
      });
    },
  };
})();
