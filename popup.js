const STORAGE_KEY = "moonaroonEnabled";
const LANG_KEY = "moonaroonLang";
const SITES_KEY = "moonaroonSites";

const toggle = document.getElementById("toggle");
const label = document.getElementById("label");
const langSelect = document.getElementById("lang");
const report = document.getElementById("report");
const siteList = document.getElementById("site-list");
const siteForm = document.getElementById("site-add");
const siteInput = document.getElementById("site-input");

let lang = LANGS[0];
let enabled = false;
let sites = [];

// Built once. The names are endonyms, so they don't change when the UI language
// does — only which one is selected changes.
for (const code of LANGS) {
  const opt = document.createElement("option");
  opt.value = code;
  opt.textContent = LANG_NAMES[code];
  langSelect.append(opt);
}

// The browser UI language is the starting point; once a language is picked in the
// dropdown, that pick is stored and wins from then on. There's no separate "auto"
// entry in the list — with the browser language preselected, "auto" and "the
// language currently shown" are the same thing until the user disagrees, and once
// they disagree they want their pick, not a way back to the browser's.
function browserLang() {
  const ui = chrome.i18n.getUILanguage().toLowerCase();
  return LANGS.find((l) => ui.startsWith(l)) || LANGS[0];
}

// Prefill the issue with the version and browser, so a report says which build it
// came from. The anchor's plain href already works on its own if this doesn't run.
function issueUrl(s) {
  const body = [
    s.issueWhat,
    "",
    "",
    s.issueWhere,
    "",
    "",
    `Moonaroon ${chrome.runtime.getManifest().version}`,
    navigator.userAgent,
  ].join("\n");
  return (
    "https://github.com/jmadelaine/moonaroon/issues/new" +
    `?labels=bug&body=${encodeURIComponent(body)}`
  );
}

// A dot with something either side. Rules out `localhost` and typos like `.`,
// and lets through anything real without trying to know every TLD.
const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// Accept whatever people actually paste. A full URL, a bare host, `www.`, `*.`,
// a trailing slash, mixed case — all name the same site, so all normalize to one
// bare lowercase host. Returns null if nothing usable is left.
function normalizeHost(raw) {
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  // `*.` has to go before the URL parser sees it: `*` is not a legal host
  // character, so `*.example.com` would throw and be reported as a typo. It
  // means nothing here anyway — an entry already covers its subdomains.
  v = v.replace(/^([a-z][a-z0-9+.-]*:\/\/)?\*\./, "$1");
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(v)) v = "https://" + v;
  let host;
  try {
    host = new URL(v).hostname;
  } catch (e) {
    return null;
  }
  host = host.replace(/\.+$/, "");
  // Store the registrable host, not the `www` in front of it. Since an entry
  // covers subdomains, `example.com` matches `www.example.com` as well — keeping
  // the prefix would store a narrower rule than the one people mean. Guarded so
  // a host that is only `www.<tld>` isn't stripped down to nothing.
  const bare = host.replace(/^www\./, "");
  if (HOST_RE.test(bare)) host = bare;
  return HOST_RE.test(host) ? host : null;
}

// The same rule the content script matches with, so "already covered" means the
// same thing in the popup as it does on the page.
function covered(host) {
  return sites.some((s) => host === s || host.endsWith("." + s));
}

function saveSites() {
  chrome.storage.sync.set({ [SITES_KEY]: sites }, renderSites);
}

function renderSites() {
  const s = STRINGS[lang];
  siteList.replaceChildren();

  for (const host of sites) {
    const li = document.createElement("li");
    li.className = "site";

    const name = document.createElement("span");
    name.className = "site-host";
    name.textContent = host;
    // The full host on hover, since a long one is truncated in the row.
    name.title = host;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "site-remove";
    btn.title = `${s.removeSite} ${host}`;
    btn.setAttribute("aria-label", btn.title);
    // Inline SVG cross rather than a "×" character: the glyph's size and
    // baseline vary by font, and the Japanese fallback draws it noticeably
    // bigger.
    btn.innerHTML =
      '<svg viewBox="0 0 10 10" aria-hidden="true">' +
      '<path d="M1 1 9 9M9 1 1 9"/></svg>';
    btn.addEventListener("click", () => {
      sites = sites.filter((h) => h !== host);
      saveSites();
    });

    li.append(name, btn);
    siteList.append(li);
  }

  // Rebuilt with the list so it can't be left showing beside a filled list.
  const old = document.querySelector(".site-empty");
  if (old) old.remove();
  if (!sites.length) {
    const p = document.createElement("p");
    p.className = "site-empty";
    p.textContent = s.sitesEmpty;
    siteList.after(p);
  }
}

function addSite() {
  const host = normalizeHost(siteInput.value);
  if (!host) {
    siteInput.classList.add("invalid");
    siteInput.focus();
    return;
  }
  siteInput.classList.remove("invalid");
  siteInput.value = "";
  // Nothing to save for a host the list already reaches — either the same entry
  // or a parent of it. Adding `gist.github.com` under an existing `github.com`
  // would be a second row that changes nothing.
  if (covered(host)) return;
  // Sorted, so the list doesn't depend on the order things were added and an
  // edited entry doesn't jump to the end.
  sites = [...sites, host].sort();
  saveSites();
}

function render() {
  const s = STRINGS[lang];

  // lang on <html> so the browser picks Japanese font fallbacks and line breaking.
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = s[el.dataset.i18n];
  }
  // Icon-only controls have no text node to fill, so their string becomes the
  // tooltip and the accessible name instead.
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    const text = s[el.dataset.i18nTitle];
    el.title = text;
    el.setAttribute("aria-label", text);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = s[el.dataset.i18nPlaceholder];
  }
  langSelect.value = lang;
  report.href = issueUrl(s);
  renderSites();

  toggle.checked = enabled;
  // The "on" label is picked at random each time it's rendered — so it changes both
  // when the switch is flipped and when the popup is reopened. The switch itself is
  // what actually reports state; these just have to read as celebratory.
  label.textContent = enabled
    ? s.on[Math.floor(Math.random() * s.on.length)]
    : s.off;
}

// Load current state
chrome.storage.sync.get(
  { [STORAGE_KEY]: false, [LANG_KEY]: null, [SITES_KEY]: [] },
  (res) => {
    enabled = res[STORAGE_KEY];
    lang = STRINGS[res[LANG_KEY]] ? res[LANG_KEY] : browserLang();
    // Sorted on load as well as on add: storage.sync merges across profiles, so
    // what comes back is not necessarily in the order this popup last wrote.
    sites = (Array.isArray(res[SITES_KEY]) ? res[SITES_KEY] : []).sort();
    render();
  },
);

// Persist on change (content script reacts via storage.onChanged)
toggle.addEventListener("change", () => {
  enabled = toggle.checked;
  chrome.storage.sync.set({ [STORAGE_KEY]: enabled }, render);
});

langSelect.addEventListener("change", () => {
  lang = langSelect.value;
  chrome.storage.sync.set({ [LANG_KEY]: lang }, render);
});

siteForm.addEventListener("submit", (e) => {
  e.preventDefault(); // a popup has nowhere to navigate to
  addSite();
});

// Clear the invalid mark as soon as the field is edited — leaving it red while
// someone is fixing the typo reads as if the new text is wrong too.
siteInput.addEventListener("input", () => {
  siteInput.classList.remove("invalid");
});
