// TempoSkip Background Service Worker (Manifest V3 - v1.2.0)

const DEFAULT_SETTINGS = {
  enabled: true,
  playbackSpeed: 1.0,
  forceSpeed: true,           // Re-apply custom speed if the web player tries to reset it
  overrideArrowKeys: true,    // Intercept Left & Right arrow keys on any player
  rewindSeconds: 5,           // Left Arrow skip duration (seconds)
  forwardSeconds: 5,          // Right Arrow skip duration (seconds)
  shiftMultiplierEnabled: true,
  shiftRewindSeconds: 15,     // Shift + Left Arrow skip duration (seconds)
  shiftForwardSeconds: 15,    // Shift + Right Arrow skip duration (seconds)
  safeMseSeek: true,          // Coalesce rapid/unbuffered seeks & serialize in-flight MSE seeks without snapping
  enableSpeedHotkeys: true,   // '[' slower, ']' faster, '\\' reset speed
  speedStep: 0.25,            // Step size for '[' and ']' hotkeys
  showHud: true,              // Show sleek on-video HUD toast when speed/skip triggers
  disabledHosts: [],          // Array of hostnames where overrides are paused
  autoSkipSites: {}           // { [hostname]: { intro, credits } } auto-click the player's Skip button (opt-in)
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(null);
  const merged = { ...DEFAULT_SETTINGS, ...existing };
  await chrome.storage.sync.set(merged);
  updateBadge(merged.playbackSpeed, merged.enabled);
});

function updateBadge(speed, enabled) {
  if (!enabled) {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
    return;
  }
  const numericSpeed = Number(speed) || 1.0;
  const label = numericSpeed === 1.0 ? "" : `${numericSpeed.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}x`;
  chrome.action.setBadgeText({ text: label });
  chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    chrome.storage.sync.get(["playbackSpeed", "enabled"], (data) => {
      updateBadge(data.playbackSpeed ?? 1.0, data.enabled ?? true);
    });
  }
});

// Relay commands from popup or subframes to all frames in the tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "BROADCAST_TO_TAB" && message.tabId) {
    chrome.tabs.sendMessage(message.tabId, message.payload).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "SYNC_BADGE") {
    updateBadge(message.speed, message.enabled);
    sendResponse({ ok: true });
    return true;
  }
});
