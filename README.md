# Moonaroon 🌙

A Chrome extension that toggles a coherent dark mode on **https://bozuman.cybozu.com** (Garoon / Cybozu).

## How it works

Rather than a blind `invert()` filter, Moonaroon rewrites the colors the site's own stylesheets actually use:

1. For each `<link>` stylesheet it **fetches the raw CSS text**, and for inline `<style>` blocks it reads them directly.
2. It converts every color to HSL and **inverts only the lightness, preserving hue + saturation** — so the Cybozu blue stays blue, alert red stays red, and calendar category colors are kept. Only **neutrals** (grays/whites/blacks) and **pale tints** are remapped; saturated brand/accent colors pass through untouched.
3. The rewritten CSS is injected in place of the original (which is disabled), with all `url(...)` paths absolutized so images still resolve. Color rewriting is confined to declaration blocks, so it can never corrupt selectors.

It runs in **all frames** (Garoon uses iframes heavily) and a `MutationObserver` catches dynamically-loaded stylesheets and inline styles. Shadows and translucent scrims are left dark to avoid white-glow artifacts. State is saved in `chrome.storage.sync`, so it persists across reloads and tabs, and toggling off restores the originals live.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `moonaroon` folder.
4. Visit https://bozuman.cybozu.com, click the Moonaroon toolbar icon, and flip the switch.

The toggle applies live — no reload needed.

## Files

| File                                    | Purpose                                              |
| --------------------------------------- | ---------------------------------------------------- |
| `manifest.json`                         | Manifest V3 config                                   |
| `content.js`                            | Fetches, remaps and reinjects the site's stylesheets |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup with the toggle                        |
| `icons/`                                | Moon icons (16/32/48/128)                            |

## Tweaking the look

The color mapping lives in `remapRgb()` in `content.js`. The neutral curve `0.95 - l * 0.85` controls overall brightness (raise the constant for a lighter dark theme). The `s < 0.12` threshold decides what counts as a neutral, and the `l > 0.8` branch handles pale tinted surfaces. Saturated colors return `null` (left untouched) — widen that branch if you want brand colors adjusted too. Background **images** with baked-in light colors are not remapped; those need a separate `filter` rule.
