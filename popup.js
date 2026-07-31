const STORAGE_KEY = "moonaroonEnabled";
const LANG_KEY = "moonaroonLang";

const toggle = document.getElementById("toggle");
const label = document.getElementById("label");
const langSelect = document.getElementById("lang");
const report = document.getElementById("report");

let lang = LANGS[0];
let enabled = false;

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
  langSelect.value = lang;
  report.href = issueUrl(s);

  toggle.checked = enabled;
  // The "on" label is picked at random each time it's rendered — so it changes both
  // when the switch is flipped and when the popup is reopened. The switch itself is
  // what actually reports state; these just have to read as celebratory.
  label.textContent = enabled
    ? s.on[Math.floor(Math.random() * s.on.length)]
    : s.off;
}

// Load current state
chrome.storage.sync.get({ [STORAGE_KEY]: false, [LANG_KEY]: null }, (res) => {
  enabled = res[STORAGE_KEY];
  lang = STRINGS[res[LANG_KEY]] ? res[LANG_KEY] : browserLang();
  render();
});

// Persist on change (content script reacts via storage.onChanged)
toggle.addEventListener("change", () => {
  enabled = toggle.checked;
  chrome.storage.sync.set({ [STORAGE_KEY]: enabled }, render);
});

langSelect.addEventListener("change", () => {
  lang = langSelect.value;
  chrome.storage.sync.set({ [LANG_KEY]: lang }, render);
});
