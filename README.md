# Moonaroon 🌕

A Chrome extension that applies dark mode to **any site you add to its list**.

## How to install

1. **Download it.** Go to [github.com/jmadelaine/moonaroon](https://github.com/jmadelaine/moonaroon), click the green **"Code"** button near the top-right, then **"Download ZIP"**.
2. **Unpack it.** Find `moonaroon-main.zip` in your Downloads folder and double-click it (Mac) or right-click → **"Extract All"** (Windows). You get a folder called `moonaroon-main`.
3. **Open the extensions page.** In Chrome, type `chrome://extensions` in the address bar and press Enter.
4. **Turn on Developer mode** with the switch in the top-right corner.
5. **Click "Load unpacked"** (top-left), then select the `moonaroon-main` folder and confirm. Moonaroon now appears in your list of extensions.
6. **Use it.** Click the puzzle-piece **Extensions** icon at the top-right of Chrome and pick the yellow moon. Paste a URL into the box at the bottom, press **Add**, then flip the switch.

**To update later:** repeat the steps above, replacing the old folder.

## How it works

Moonaroon rewrites the colors in the site's own stylesheets, rather than laying a blind `invert()` filter over the page.

### Color mapping

All of it lives in `remapRgb()`. Hue is always preserved — so a brand blue stays blue, alert red stays red, and a set of category colors stays distinguishable — while lightness and saturation are remapped for a dark canvas:

- **Neutrals** (grays/whites/blacks, anything under the `s < 0.12` threshold) get their lightness inverted onto a charcoal hue. The curve in `neutralFor()` sets the overall darkness, and `NEUTRAL_HUE` / `NEUTRAL_SAT` set the charcoal tint. As a _background_ the curve is `neutralSurfaceFor()` instead, which never returns a light result — see below.
- **Pale tints** (`l > 0.8` — light-blue selection backgrounds and the like) become dark tinted surfaces.
- **Brand and accent colors are taken to full saturation and brightened.** A mid-tone blue that looks fine on white is dull on charcoal, and a dark navy is nearly invisible. Saturation is maxed first, then lightness rises only as far as legibility needs — which lifts blues much further than greens, since blue carries barely a tenth of green's luminance. As a fill, a mid blue `#0e74dd` becomes `#3599ff`, alert red `#d0021b` becomes `#ff324b`, and a near-invisible navy `#1c3f6e` becomes `#2e84f9`.
- **Accent _text_ is pushed harder than an accent fill.** A fill is a large block and carries on area; text is thin strokes and has to carry on the color alone. So text uses a higher lightness band and a higher contrast floor — the same blue reaches `#54a8ff` at 7.0:1 instead of 6.0:1, and a dim purple goes from 4.0:1 to 5.7:1. Only the brightness differs: saturation is already effectively maxed for both, and raising it further would _cost_ contrast, since above mid-lightness sRGB can only add chroma by taking away lightness.

Both are tuned by the `VIVID_FILL` and `VIVID_INK` objects in `content.js`. Lightness is the lever; pushed too high, greens and olives go milky instead of bright.

Shadows are never read at all, and translucent near-black or near-white is left alone, so scrims and overlays don't turn into a white veil. Background **images** with light colors painted into them aren't remapped either — there's no color token to rewrite, so those need a separate `filter` rule.

### Backgrounds and text are decided together

A color on its own can't be remapped correctly, because the same gray means opposite things in different places. A header bar that a site paints `#4b4a4a` in its _light_ theme is meant to be dark, and inverting it produces a glaring light slab. Dark _text_ at the same `#4b4a4a` must invert, or it disappears. The property name is what tells them apart, so it's part of the input:

- **A dark background stays dark**, re-tinted into the same charcoal family as everything else, so it sits with the theme instead of standing out.
- **Near-white text is left as authored.** Nobody writes white text on a white page, so it was already sitting on something dark — including where that something is a background image the remap can't read at all.
- **Text on a background that moved** is restated. A brand blue used as a button fill comes out much brighter than the site authored it, so the label is set to whichever end of the neutral ramp reads better on the result — usually dark. Colored text on a colored panel is kept if it still clears the contrast floor.

### Reading stylesheets

For each sheet:

1. **Fetch its raw text.** This is what gets past CORS — reading `cssRules` on a cross-origin sheet throws `SecurityError`.
2. **Hand that text to the browser's own CSS parser** via `new CSSStyleSheet().replaceSync()`. A sheet the extension constructed is always readable, so the parser is used purely as a parser.
3. **Walk the parsed rule tree** and insert an **overlay** stylesheet holding only the declarations whose colors changed, placed directly after the original.

The overlay wins because it repeats the original's selector, at-rule nesting, `@layer` and `!important`, and comes later in source order. The original sheet is never disabled and never edited, so nothing the browser's parser rejected (legacy hacks and the like) can be lost on a round-trip — and switching dark mode off is just deleting the overlays.

Parsing rather than pattern-matching is what lets it reach nested CSS, modern color syntax (`oklch()`, `lab()`, `color()`, space-separated `rgb()`, hex with alpha), and design tokens defined as custom properties — remapping a token where it's defined themes every use of it at once. It also leaves `light-dark()` alone, so the site's own dark colors get used where it defines them.

Two cases work differently:

- **`<style>` elements** are same-origin, so their live CSSOM is read directly with no fetch. Their `textContent` is never written to — doing that makes the browser re-parse the element and wipe rules a CSS-in-JS library added through `insertRule`, which is what makes styled-components colors reachable at all.
- **Inline `style=""` attributes** are rewritten in place, since nothing outranks them short of `!important`. The original values are stashed so they can be restored.

Which properties get read is `DIRECT_COLOR` (single-color values) and `COMPOSITE_COLOR` (values with colors inside them, like gradients); add to those to reach more, and give a new property a role in `PROP_ROLE` unless plain inversion is right for it. No color-keyword list is needed — named colors are resolved by the parser already.

### Keeping up with the page

The content script runs at `document_start` in **all frames**, since a page's content can sit entirely inside iframes. After that:

- A `MutationObserver` picks up stylesheets, `<style>` elements and inline styles added later.
- A re-scan runs on `DOMContentLoaded`, on `load`, and on a few short timers, for sheets that aren't parsed yet on the first pass.
- A **1.5s poll** watches each tracked sheet's rule count. CSS-in-JS appends rules through `insertRule`, which fires no DOM mutation, so the observer cannot see it.

Any `url(...)` inside a value the overlay re-emits (a gradient, a mask) is made absolute, because the overlay is a `<style>` and a relative path would otherwise resolve against the document instead of the source sheet.

State lives in `chrome.storage.sync` — the on/off switch, the site list and the popup language — so it persists across reloads and tabs. The content script is injected on every page but does nothing until the switch is on _and_ the host matches the list; adding or removing a site takes effect immediately in any open tab, with no reload.

### Hand-written fixes

Two things have no color in any stylesheet, so the remap can never see them. `OVERRIDES` in `content.js` sets them directly, and both hold on every site:

- **Native form controls**, which take their text color from the browser default.
- **Scrollbars**, via `color-scheme: dark` plus `::-webkit-scrollbar` rules. `color-scheme: dark` is also what makes the browser pick the dark branch of any `light-dark()`.

### Known limits

Three kinds of color the transform can't get right. All three come down to the same thing: it can only work with a color it can read out of a stylesheet, as a value it knows the role of.

- **A site with its own dark mode ends up darkened twice.** `color-scheme: dark` makes the browser serve that site's dark colors, and the remap then pushes those back toward light. Keep such sites off the list.
- **A color held in a custom property gets the plain inversion.** A `--token` has no role until something uses it, and one token can back both a fill and a label, so there's nothing to branch on. A background defined only through a token misses the dark-background rule.
- **A background painted by an image is invisible to it.** There's no color value to rewrite, so a light photo stays light — and dark text over it still inverts. Text that was already near-white survives, because that rule leaves it alone.

## Files

| File                                    | Purpose                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                         | Manifest V3 config. `all_frames`, plus `host_permissions` for `http://*/*` and `https://*/*` — broad enough to also fetch sheets from whatever CDN a page loads them from. The site list, not the manifest, decides where the theme applies |
| `content.js`                            | All theming logic (see above)                                                                                                                                                                                                               |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup: the on/off switch, the editable site list, and the language picker                                                                                                                                                           |
| `strings.js`                            | Popup UI text in English and Japanese                                                                                                                                                                                                       |
| `_locales/`                             | Manifest text (extension description, toolbar tooltip) in English and Japanese                                                                                                                                                              |
| `icons/`                                | Moon icons (16/32/48/128) + `moon.svg` for the popup switch                                                                                                                                                                                 |
