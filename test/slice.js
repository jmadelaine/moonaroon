// Loads the color math out of content.js so it can run under `node --test`.
//
// Everything above the "Reading stylesheets" banner is pure arithmetic. Below it
// the transform needs a DOM — parseColor paints into a <canvas> and buildOverlay
// walks live CSSOM rule objects — so those parts are covered by test/browser
// against real Chromium instead.
//
// A Function wrapper rather than eval: this file and the slice both declare
// top-level names like rgbToHsl, and re-declaring one is a SyntaxError that
// takes the whole file down before its first line runs.

const fs = require("node:fs");
const path = require("node:path");

const BANNER = "// " + "-".repeat(75) + "\n// Reading stylesheets";

const EXPORTS = [
  "rgbToHsl",
  "hslToRgb",
  "neutralFor",
  "neutralSurfaceFor",
  "relLuminance",
  "contrastRatio",
  "canvasLuminance",
  "vividFor",
  "remapRgb",
  "inkFor",
  "needsInk",
  "isProtectedTranslucent",
  "hexOf",
  "NEUTRAL_HUE",
  "NEUTRAL_SAT",
  "NEUTRAL_L_BASE",
  "NEUTRAL_L_SPAN",
  "SURFACE_PEAK",
  "MIN_CONTRAST",
  "INK_MIN_CONTRAST",
  "VIVID_FILL",
  "VIVID_INK",
  "INK_LIGHT",
  "INK_DARK",
  "ROLE_LINE",
  "ROLE_SURFACE",
  "ROLE_INK",
];

function loadColorMath() {
  const file = path.join(__dirname, "..", "content.js");
  const src = fs.readFileSync(file, "utf8");
  const cut = src.indexOf(BANNER);
  if (cut === -1)
    throw new Error(
      "content.js has no 'Reading stylesheets' banner — the slice point moved",
    );
  return new Function(
    src.slice(0, cut) + `\nreturn {${EXPORTS.join(",")}};`,
  )();
}

module.exports = { loadColorMath, EXPORTS };
