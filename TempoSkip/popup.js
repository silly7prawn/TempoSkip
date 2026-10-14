// TempoSkip Popup Controller (v1.2.0)

const DEFAULT_SETTINGS = {
  enabled: true,
  playbackSpeed: 1.0,
  forceSpeed: true,
  overrideArrowKeys: true,
  rewindSeconds: 5,
  forwardSeconds: 5,
  shiftMultiplierEnabled: true,
  shiftRewindSeconds: 15,
  shiftForwardSeconds: 15,
  safeMseSeek: true,
  enableSpeedHotkeys: true,
  speedStep: 0.25,
  showHud: true,
  disabledHosts: []
};

const els = {
  enabledToggle: document.getElementById("enabledToggle"),
  playerStatus: document.getElementById("playerStatus"),
  currentHost: document.getElementById("currentHost"),
  toggleSiteBtn: document.getElementById("toggleSiteBtn"),
  speedNumber: document.getElementById("speedNumber"),
  speedRange: document.getElementById("speedRange"),
  speedPresets: document.getElementById("speedPresets"),
  forceSpeedToggle: document.getElementById("forceSpeedToggle"),
  overrideArrowsToggle: document.getElementById("overrideArrowsToggle"),
  rewindInput: document.getElementById("rewindInput"),
  forwardInput: document.getElementById("forwardInput"),
  testRewindBtn: document.getElementById("testRewindBtn"),
  testForwardBtn: document.getElementById("testForwardBtn"),
  skipPresets: document.getElementById("skipPresets"),
  shiftMultiplierToggle: document.getElementById("shiftMultiplierToggle"),
  shiftRewindInput: document.getElementById("shiftRewindInput"),
  shiftForwardInput: document.getElementById("shiftForwardInput"),
  shiftSkipRow: document.getElementById("shiftSkipRow"),
  safeMseSeekToggle: document.getElementById("safeMseSeekToggle"),
  speedHotkeysToggle: document.getElementById("speedHotkeysToggle"),
  showHudToggle: document.getElementById("showHudToggle"),
  resetDefaultsBtn: document.getElementById("resetDefaultsBtn")
};

let currentSettings = { ...DEFAULT_SETTINGS };
let activeHostname = "";
let activeTabId = null;

function clampSpeed(val) {
  const num = Number(val);
  if (Number.isNaN(num)) return 1.0;
  return Math.min(16.0, Math.max(0.07, Math.round(num * 100) / 100));
}

function clampSeconds(val, fallback = 5) {
  const num = Number(val);
  if (Number.isNaN(num) || num <= 0) return fallback;
  return Math.min(3600, Math.max(0.1, Math.round(num * 100) / 100));
}

function highlightActivePresets() {
  const speed = Number(currentSettings.playbackSpeed);
  els.speedPresets.querySelectorAll("button").forEach((btn) => {
    const btnSpeed = Number(btn.dataset.speed);
    btn.classList.toggle("active", Math.abs(btnSpeed - speed) < 0.005);
  });

  const rew = Number(currentSettings.rewindSeconds);
  const fwd = Number(currentSettings.forwardSeconds);
  els.skipPresets.querySelectorAll("button").forEach((btn) => {
    const s = Number(btn.dataset.skip);
    btn.classList.toggle("active", Math.abs(rew - s) < 0.005 && Math.abs(fwd - s) < 0.005);
  });
}

function renderSiteStatus() {
  if (!activeHostname) {
    els.currentHost.textContent = "Local / system page";
    els.toggleSiteBtn.style.display = "none";
    return;
  }
  els.currentHost.textContent = activeHostname;
  els.toggleSiteBtn.style.display = "inline-block";
  const isPaused = (currentSettings.disabledHosts || []).includes(activeHostname);
  els.toggleSiteBtn.textContent = isPaused ? "Paused on site" : "Active on site";
  els.toggleSiteBtn.classList.toggle("site-paused", isPaused);
}

function renderUI() {
  els.enabledToggle.checked = Boolean(currentSettings.enabled);
  const spd = clampSpeed(currentSettings.playbackSpeed);
  els.speedNumber.value = spd.toFixed(2).replace(/\.00$/, ".0");
  els.speedRange.value = Math.min(4.0, Math.max(0.25, spd));

  els.forceSpeedToggle.checked = Boolean(currentSettings.forceSpeed);
  els.overrideArrowsToggle.checked = Boolean(currentSettings.overrideArrowKeys);

  els.rewindInput.value = currentSettings.rewindSeconds;
  els.forwardInput.value = currentSettings.forwardSeconds;

  els.shiftMultiplierToggle.checked = Boolean(currentSettings.shiftMultiplierEnabled);
  els.shiftRewindInput.value = currentSettings.shiftRewindSeconds;
  els.shiftForwardInput.value = currentSettings.shiftForwardSeconds;
  els.shiftSkipRow.style.opacity = currentSettings.shiftMultiplierEnabled ? "1" : "0.45";

  els.safeMseSeekToggle.checked = Boolean(currentSettings.safeMseSeek);
  els.speedHotkeysToggle.checked = Boolean(currentSettings.enableSpeedHotkeys);
  els.showHudToggle.checked = Boolean(currentSettings.showHud);

  highlightActivePresets();
  renderSiteStatus();
}

async function savePatch(patch) {
  currentSettings = { ...currentSettings, ...patch };
  renderUI();
  await chrome.storage.sync.set(patch);
}

async function queryActiveTabStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    activeTabId = tab.id;
    if (tab.url) {
      try {
        const u = new URL(tab.url);
        if (u.protocol.startsWith("http")) {
          activeHostname = u.hostname.toLowerCase();
        }
      } catch (_) {}
    }
    renderSiteStatus();

    chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        els.playerStatus.textContent = "Ready (applies to any player on page)";
        return;
      }
      const count = resp.mediaCount || 0;
      if (count > 0) {
        els.playerStatus.textContent = `${count} media player${count > 1 ? "s" : ""} hooked (${Number(resp.currentRate || 1).toFixed(2).replace(/\.00$/, "")}×)`;
      } else {
        els.playerStatus.textContent = "Waiting for video/audio player...";
      }
    });
  } catch (_) {}
}

// --- Event Listeners ---
els.enabledToggle.addEventListener("change", () => {
  savePatch({ enabled: els.enabledToggle.checked });
});

els.toggleSiteBtn.addEventListener("click", () => {
  if (!activeHostname) return;
  const list = new Set(currentSettings.disabledHosts || []);
  if (list.has(activeHostname)) {
    list.delete(activeHostname);
  } else {
    list.add(activeHostname);
  }
  savePatch({ disabledHosts: Array.from(list) });
});

els.speedRange.addEventListener("input", () => {
  const spd = clampSpeed(els.speedRange.value);
  savePatch({ playbackSpeed: spd });
});

els.speedNumber.addEventListener("change", () => {
  const spd = clampSpeed(els.speedNumber.value);
  savePatch({ playbackSpeed: spd });
});

els.speedPresets.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-speed]");
  if (!btn) return;
  const spd = clampSpeed(btn.dataset.speed);
  savePatch({ playbackSpeed: spd });
});

els.forceSpeedToggle.addEventListener("change", () => {
  savePatch({ forceSpeed: els.forceSpeedToggle.checked });
});

els.overrideArrowsToggle.addEventListener("change", () => {
  savePatch({ overrideArrowKeys: els.overrideArrowsToggle.checked });
});

els.rewindInput.addEventListener("change", () => {
  savePatch({ rewindSeconds: clampSeconds(els.rewindInput.value, 5) });
});

els.forwardInput.addEventListener("change", () => {
  savePatch({ forwardSeconds: clampSeconds(els.forwardInput.value, 5) });
});

els.skipPresets.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-skip]");
  if (!btn) return;
  const sec = clampSeconds(btn.dataset.skip, 5);
  savePatch({ rewindSeconds: sec, forwardSeconds: sec });
});

els.testRewindBtn.addEventListener("click", () => {
  if (!activeTabId) return;
  const delta = -Math.abs(Number(currentSettings.rewindSeconds) || 5);
  chrome.tabs.sendMessage(activeTabId, { type: "TRIGGER_SKIP", delta });
});

els.testForwardBtn.addEventListener("click", () => {
  if (!activeTabId) return;
  const delta = Math.abs(Number(currentSettings.forwardSeconds) || 5);
  chrome.tabs.sendMessage(activeTabId, { type: "TRIGGER_SKIP", delta });
});

els.shiftMultiplierToggle.addEventListener("change", () => {
  savePatch({ shiftMultiplierEnabled: els.shiftMultiplierToggle.checked });
});

els.shiftRewindInput.addEventListener("change", () => {
  savePatch({ shiftRewindSeconds: clampSeconds(els.shiftRewindInput.value, 15) });
});

els.shiftForwardInput.addEventListener("change", () => {
  savePatch({ shiftForwardSeconds: clampSeconds(els.shiftForwardInput.value, 15) });
});

els.safeMseSeekToggle.addEventListener("change", () => {
  savePatch({ safeMseSeek: els.safeMseSeekToggle.checked });
});

els.speedHotkeysToggle.addEventListener("change", () => {
  savePatch({ enableSpeedHotkeys: els.speedHotkeysToggle.checked });
});

els.showHudToggle.addEventListener("change", () => {
  savePatch({ showHud: els.showHudToggle.checked });
});

els.resetDefaultsBtn.addEventListener("click", async () => {
  currentSettings = { ...DEFAULT_SETTINGS };
  await chrome.storage.sync.set(DEFAULT_SETTINGS);
  renderUI();
});

// --- Learned per-site seek profiles ---
function renderLearned(profiles) {
  const list = document.getElementById("learnedList");
  list.textContent = "";
  const hosts = Object.keys(profiles || {}).sort();
  if (!hosts.length) {
    const e = document.createElement("div");
    e.className = "learned-empty";
    e.textContent = "Nothing learned yet. Sites appear here after an out-of-buffer rewind.";
    list.appendChild(e);
    return;
  }
  for (const host of hosts) {
    const p = profiles[host] || {};
    const row = document.createElement("div");
    row.className = "learned-row";
    const name = document.createElement("span");
    name.className = "host";
    name.textContent = host;
    name.title = p.path ? p.path + "." + p.fn : "";
    const tag = document.createElement("span");
    tag.className = "tag" + (p.bridge === "ok" ? " ok" : "");
    const needs = !!p.needsApi && (p.needsApi === true || Object.values(p.needsApi).some(Boolean));
    tag.textContent = p.bridge === "ok" ? (needs ? "API needed" : "API ready") : "plain seeks" + (p.fallback ? " (" + p.fallback + ")" : "");
    tag.title = "API needed = a plain seek hung here, so out-of-buffer seeks go through the player's own API.";
    const sel = document.createElement("select");
    sel.className = "mode-sel";
    sel.title = needs
      ? "API first: out-of-buffer seeks here go through the player's own API. Plain only: never use the player's API on this site."
      : "Plain first: a normal seek is tried first; the player's API is only used if the player hangs. Plain only: never use the player's API on this site.";
    for (const [val, label] of [["auto", needs ? "API first" : "Plain first"], ["raw", "Plain only"]]) {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = label;
      if ((p.mode === "raw" ? "raw" : "auto") === val) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      chrome.storage.local.get("siteProfiles", (r) => {
        const all = (r && r.siteProfiles) || {};
        all[host] = { ...(all[host] || {}), mode: sel.value, ts: Date.now() };
        chrome.storage.local.set({ siteProfiles: all });
      });
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.title = "Forget this site";
    del.textContent = "\u2715";
    del.addEventListener("click", () => {
      chrome.storage.local.get("siteProfiles", (r) => {
        const all = (r && r.siteProfiles) || {};
        delete all[host];
        chrome.storage.local.set({ siteProfiles: all }, () => renderLearned(all));
      });
    });
    row.append(name, tag, sel, del);
    list.appendChild(row);
  }
}
function loadLearned() {
  chrome.storage.local.get("siteProfiles", (r) => renderLearned((r && r.siteProfiles) || {}));
}
document.getElementById("forgetAllBtn").addEventListener("click", () => {
  chrome.storage.local.set({ siteProfiles: {} }, () => renderLearned({}));
});

// Diagnostics: run the page-world probe in every frame of the active tab and copy the result.
document.getElementById("copyDiagBtn").addEventListener("click", async () => {
  const status = document.getElementById("diagStatus");
  status.textContent = "Collecting…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: "MAIN",
      func: () => {
        try {
          if (typeof window.__temposkipProbe !== "function") return { bridge: false, frame: location.href.slice(0, 120) };
          const r = window.__temposkipProbe();
          return typeof r === "string" ? { bridge: true, note: r, frame: location.href.slice(0, 120) } : r;
        } catch (e) {
          return { error: String(e && e.message) };
        }
      }
    });
    const useful = results
      .filter((r) => r && r.result && !(r.result.note && /no <video>/.test(r.result.note)))
      .map((r) => ({ frameId: r.frameId, ...r.result }));
    const learned = await new Promise((res) => chrome.storage.local.get("siteProfiles", (r) => res((r && r.siteProfiles) || {})));
    const text = JSON.stringify({ version: chrome.runtime.getManifest().version, tab: tab.url, learnedProfiles: learned, frames: useful }, null, 2);
    await navigator.clipboard.writeText(text);
    status.textContent = useful.length ? "Copied – paste it into the chat." : "Copied (no video found in this tab).";
  } catch (e) {
    status.textContent = "Failed: " + (e && e.message ? e.message : e);
  }
});

// Initialize popup state
chrome.storage.sync.get(null, (stored) => {
  currentSettings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  renderUI();
  queryActiveTabStatus();
  loadLearned();
});
