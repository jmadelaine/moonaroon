# Moonaroon 🌙

A Chrome extension that toggles a coherent dark mode on **any `*.cybozu.com` site** — both **Garoon** (`/g/`) and **Kintone** (`/k/`).

## How it works

Rather than a blind `invert()` filter, Moonaroon rewrites the colors the site's own stylesheets actually use.

### The color mapping

Hue is always preserved — so the Cybozu blue stays blue, alert red stays red, and calendar category colors stay distinct — while lightness and saturation are remapped for a dark canvas:

- **Neutrals** (grays/whites/blacks) get their lightness inverted onto a charcoal hue.
- **Pale tints** (light-blue selection backgrounds and the like) become dark tinted surfaces.
- **Brand and accent colors are taken to full saturation and brightened.** A mid-tone blue that looks fine on white is dull on charcoal, and a dark navy is nearly invisible. Saturation is maxed first, then lightness rises only as far as legibility needs — which lifts blues much further than greens, since blue carries barely a tenth of green's luminance. Cybozu blue `#0e74dd` becomes `#3599ff`, alert red `#d0021b` becomes `#ff324b`, and a near-invisible navy `#1c3f6e` becomes `#2e84f9`.

Shadows are never read at all, and translucent near-black or near-white is left alone, so scrims and overlays don't turn into a white veil.

### Reading the stylesheets

For each sheet:

1. **Fetch its raw text.** This is what gets past CORS — reading `cssRules` on a cross-origin sheet throws `SecurityError`.
2. **Hand that text to the browser's own CSS parser** via `new CSSStyleSheet().replaceSync()`. A sheet the extension constructed is always readable, so the parser is used purely as a parser.
3. **Walk the parsed rule tree** and insert an **overlay** stylesheet holding only the declarations whose colors changed, placed directly after the original.

The overlay wins because it repeats the original's selector, at-rule nesting, `@layer` and `!important`, and comes later in source order. The original sheet is never disabled and never edited, so nothing the browser's parser rejected (legacy hacks and the like) can be lost on a round-trip — and switching dark mode off is just deleting the overlays.

Parsing rather than pattern-matching is what lets it reach nested CSS, modern color syntax (`oklch()`, `lab()`, `color()`, space-separated `rgb()`, hex with alpha), and design tokens defined as custom properties — remapping a token where it's defined themes every use of it at once. It also leaves `light-dark()` alone, so the site's own dark colors get used where it defines them.

Two cases work differently:

- **`<style>` elements** are same-origin, so their live CSSOM is read directly with no fetch. Their `textContent` is never written to — doing that makes the browser re-parse the element and wipe rules a CSS-in-JS library added through `insertRule`, which is what makes Kintone's styled-components colors reachable at all.
- **Inline `style=""` attributes** are rewritten in place, since nothing outranks them short of `!important`. The original values are stashed so they can be restored.

### Keeping up with the page

The content script runs at `document_start` in **all frames** (Garoon uses iframes heavily). After that:

- A `MutationObserver` picks up stylesheets, `<style>` elements and inline styles added later.
- A re-scan runs on `DOMContentLoaded`, on `load`, and on a few short timers, for sheets that aren't parsed yet on the first pass.
- A **1.5s poll** watches each tracked sheet's rule count. CSS-in-JS appends rules through `insertRule`, which fires no DOM mutation, so the observer cannot see it.

Any `url(...)` inside a value the overlay re-emits (a gradient, a mask) is made absolute, because the overlay is a `<style>` and a relative path would otherwise resolve against the document instead of the source sheet.

State lives in `chrome.storage.sync`, so it persists across reloads and tabs.

### Hand-written fixes

Some things no color remap can get right, so `OVERRIDES` in `content.js` handles them by hand:

- **Elements the site already styles dark in its light theme** — Garoon's cloud header is `#4b4a4a` with light text, and inverting lightness would wrongly turn it light. A color alone can't tell "dark background" from "dark text", so these are listed explicitly.
- **Native form controls**, which take their text color from the browser default and so are invisible to the remap.
- **Scrollbars**, via `color-scheme: dark` plus `::-webkit-scrollbar` rules. `color-scheme: dark` is also what makes the browser pick the dark branch of any `light-dark()`.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `moonaroon` folder.
4. Visit your Cybozu site (`https://<your-tenant>.cybozu.com`), click the Moonaroon toolbar icon, and flip the switch.

The toggle applies live — no reload needed.

## Files

| File                                    | Purpose                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `manifest.json`                         | Manifest V3 config. `all_frames`, plus `host_permissions` for `https://*.cybozu.com/*` — one pattern covering every tenant subdomain and the `static.cybozu.com` CDN the fetches read |
| `content.js`                            | All theming logic (see above)                                            |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup with the toggle                                            |
| `icons/`                                | Moon icons (16/32/48/128) + `moon.svg` for the popup switch              |

## Tweaking the look

All three branches live in `remapRgb()`.

**Overall darkness.** The neutral curve `0.95 - l * 0.85` in `neutralFor()` controls it — raise the constant for a lighter dark theme. `NEUTRAL_HUE` and `NEUTRAL_SAT` set the charcoal tint. The `s < 0.12` threshold decides what counts as a neutral, and the `l > 0.8` branch handles pale tinted surfaces.

**How much accents pop.** The `VIVID_*` constants and `MIN_CONTRAST` in `vividFor()`. Saturation is the lever for vividness; lightness is only for legibility — pushing lightness too high makes greens and olives go milky instead of bright.

**One specific element still looking wrong.** Add a rule to `OVERRIDES`. Use doubled-class selectors (`.x.x`) there to beat the site's own `!important`.

**Reaching more properties.** Add them to `DIRECT_COLOR` (single-color values) or `COMPOSITE_COLOR` (values with colors inside them, like gradients). No color-keyword list is needed — named colors are resolved by the parser already.

Background **images** with light colors painted into them are not remapped; there's no color token to rewrite, so those need a separate `filter` rule.
