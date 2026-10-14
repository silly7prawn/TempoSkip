// TempoSkip Content Script
// Runs at document_start across all frames to override playback speeds and Left/Right arrow skip durations.

(() => {
  if (window.__tempoSkipInitialized) return;
  window.__tempoSkipInitialized = true;

  const MIN_SPEED = 0.07;
  const MAX_SPEED = 16.0;

  let settings = {
    enabled: true,
    playbackSpeed: 1.0,
    forceSpeed: true,
    overrideArrowKeys: true,
    rewindSeconds: 5,
    forwardSeconds: 5,
    shiftMultiplierEnabled: true,
    shiftRewindSeconds: 15,
    shiftForwardSeconds: 15,
    enableSpeedHotkeys: true,
    speedStep: 0.25,
    showHud: true,
    disabledHosts: []
  };

  const trackedMedia = new Set();
  let lastActiveMedia = null;
  let internalRateUpdate = false;
  let hudHost = null;
  let hudLabel = null;
  let hudTimer = null;

  function isSiteEnabled() {
    if (!settings.enabled) return false;
    const host = (window.location.hostname || "").toLowerCase();
    if (!host) return true;
    return !(settings.disabledHosts || []).includes(host);
  }

  function clampSpeed(val) {
    const num = Number(val);
    if (Number.isNaN(num)) return 1.0;
    return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(num * 100) / 100));
  }

  // --- HUD Toast inside a closed Shadow Root so site CSS never interferes ---
  function showHudToast(text, targetMedia) {
    if (!settings.showHud || !document.body) return;

    if (!hudHost) {
      hudHost = document.createElement("div");
      hudHost.setAttribute("data-temposkip-hud", "true");
      hudHost.style.cssText = [
        "position: fixed !important",
        "z-index: 2147483647 !important",
        "pointer-events: none !important",
        "top: 24px !important",
        "left: 24px !important",
        "transition: opacity 0.18s ease, transform 0.18s ease !important",
        "opacity: 0 !important",
        "transform: translateY(-4px) !important"
      ].join(";");

      const shadow = hudHost.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        .toast {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: #f8fafc;
          background: rgba(15, 23, 42, 0.88);
          border: 1px solid rgba(99, 102, 241, 0.55);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          padding: 8px 14px;
          border-radius: 999px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
          display: inline-flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
        }
      `;
      hudLabel = document.createElement("div");
      hudLabel.className = "toast";
      shadow.appendChild(style);
      shadow.appendChild(hudLabel);
    }

    // Mount inside fullscreen element if active so HUD stays visible in fullscreen players
    const mountRoot = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (hudHost.parentNode !== mountRoot) {
      mountRoot.appendChild(hudHost);
    }

    // Position near top-left of the target video if visible in viewport
    if (targetMedia && typeof targetMedia.getBoundingClientRect === "function") {
      const rect = targetMedia.getBoundingClientRect();
      if (rect.width > 60 && rect.height > 60 && rect.bottom > 0 && rect.right > 0) {
        const topPx = Math.max(16, Math.min(window.innerHeight - 60, rect.top + 20));
        const leftPx = Math.max(16, Math.min(window.innerWidth - 180, rect.left + 20));
        hudHost.style.top = `${topPx}px`;
        hudHost.style.left = `${leftPx}px`;
      }
    }

    hudLabel.textContent = text;
    hudHost.style.opacity = "1";
    hudHost.style.transform = "translateY(0)";

    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      if (hudHost) {
        hudHost.style.opacity = "0";
        hudHost.style.transform = "translateY(-4px)";
      }
    }, 1150);
  }

  // --- Media Speed Application ---
  function applySpeedToMedia(media, speed) {
    if (!media || !isSiteEnabled()) return;
    const target = clampSpeed(speed);
    if (Math.abs(media.playbackRate - target) > 0.001) {
      internalRateUpdate = true;
      try {
        media.defaultPlaybackRate = target;
        media.playbackRate = target;
      } catch (_) {}
      setTimeout(() => {
        internalRateUpdate = false;
      }, 0);
    }
  }

  function applySpeedToAllMedia(speed, showToast = false) {
    scanAllMediaElements();
    const target = clampSpeed(speed);
    trackedMedia.forEach((media) => {
      if (!media.isConnected) {
        trackedMedia.delete(media);
        return;
      }
      applySpeedToMedia(media, target);
    });
    if (showToast) {
      const active = getBestMediaElement();
      showHudToast(`⚡ Speed: ${formatNumber(target)}x`, active);
    }
  }

  function attachMediaListeners(media) {
    if (!media || trackedMedia.has(media)) return;
    trackedMedia.add(media);
    lastActiveMedia = media;

    const enforceCurrentSpeed = () => {
      lastActiveMedia = media;
      if (!isSiteEnabled()) return;
      applySpeedToMedia(media, settings.playbackSpeed);
    };

    media.addEventListener("play", enforceCurrentSpeed, true);
    media.addEventListener("playing", enforceCurrentSpeed, true);
    media.addEventListener("loadedmetadata", enforceCurrentSpeed, true);
    media.addEventListener("durationchange", enforceCurrentSpeed, true);

    media.addEventListener(
      "ratechange",
      () => {
        if (internalRateUpdate || !isSiteEnabled()) return;
        const target = clampSpeed(settings.playbackSpeed);
        if (settings.forceSpeed && Math.abs(media.playbackRate - target) > 0.005) {
          applySpeedToMedia(media, target);
        }
      },
      true
    );

    if (isSiteEnabled()) {
      applySpeedToMedia(media, settings.playbackSpeed);
    }
  }

  // --- Recursive DOM & Shadow DOM Media Scanner ---
  function scanRootForMedia(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    const mediaNodes = root.querySelectorAll("video, audio");
    mediaNodes.forEach(attachMediaListeners);

    // Traverse open shadow roots
    const allElements = root.querySelectorAll("*");
    for (let i = 0; i < allElements.length; i++) {
      const sr = allElements[i].shadowRoot;
      if (sr) scanRootForMedia(sr);
    }
  }

  function scanAllMediaElements() {
    if (document.documentElement) {
      scanRootForMedia(document);
    }
  }

  // Hook attachShadow so web components created dynamically are also tracked
  try {
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const shadowRoot = origAttachShadow.call(this, init);
      setTimeout(() => scanRootForMedia(shadowRoot), 0);
      return shadowRoot;
    };
  } catch (_) {}

  // Pick the most relevant active media element on the page
  function getBestMediaElement() {
    scanAllMediaElements();
    const candidates = Array.from(trackedMedia).filter((m) => m.isConnected);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // 1. Prefer a currently playing video in the viewport
    const playingVideos = candidates.filter(
      (m) => m.tagName === "VIDEO" && !m.paused && !m.ended && m.readyState > 0
    );
    if (playingVideos.length > 0) return pickLargestVideo(playingVideos);

    // 2. Prefer the most recently interacted media element if still connected & ready
    if (lastActiveMedia && lastActiveMedia.isConnected && lastActiveMedia.readyState > 0) {
      return lastActiveMedia;
    }

    // 3. Prefer the largest visible video on screen
    const videos = candidates.filter((m) => m.tagName === "VIDEO");
    if (videos.length > 0) return pickLargestVideo(videos);

    // 4. Fallback to first audio element
    return candidates[0];
  }

  function pickLargestVideo(videos) {
    let best = videos[0];
    let bestArea = -1;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const visibleW = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      const visibleH = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      const area = visibleW * visibleH;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  // Check if the user is typing in a text box, search bar, or comment field
  function isEditableTarget(el) {
    if (!el) return false;
    // Traverse into activeElement if inside shadow DOM
    let target = el;
    while (target && target.shadowRoot && target.shadowRoot.activeElement) {
      target = target.shadowRoot.activeElement;
    }
    const tag = (target.tagName || "").toUpperCase();
    if (target.isContentEditable) return true;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const inputType = (target.type || "text").toLowerCase();
      // Allow arrow keys when focused on a player range slider or button, block when typing text
      const nonTextTypes = ["range", "button", "checkbox", "radio", "submit", "reset", "color", "file", "image"];
      return !nonTextTypes.includes(inputType);
    }
    const role = (target.getAttribute && target.getAttribute("role")) || "";
    if (["textbox", "searchbox", "combobox"].includes(role.toLowerCase())) {
      return true;
    }
    return false;
  }

  function formatNumber(n) {
    const num = Number(n);
    if (Number.isInteger(num)) return String(num);
    return num.toFixed(2).replace(/0$/, "");
  }

  function seekMediaByDelta(media, deltaSeconds) {
    if (!media) return;
    const current = Number(media.currentTime) || 0;
    const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : Infinity;
    const targetTime = Math.min(duration, Math.max(0, current + deltaSeconds));
    try {
      media.currentTime = targetTime;
    } catch (_) {}

    const sign = deltaSeconds >= 0 ? "+" : "-";
    const icon = deltaSeconds >= 0 ? "⏩" : "⏪";
    showHudToast(`${icon} ${sign}${formatNumber(Math.abs(deltaSeconds))}s`, media);
  }

  // --- Capture-Phase Keyboard Interception ---
  // Intercepts ArrowLeft / ArrowRight before YouTube, Netflix, Vimeo, Video.js, or custom scripts see the event.
  const suppressedKeys = new Set();

  window.addEventListener(
    "keydown",
    (e) => {
      if (!isSiteEnabled()) return;
      // Ignore shortcuts with Ctrl, Alt, or Meta (e.g., Alt+Left browser back)
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;

      const media = getBestMediaElement();
      if (!media) return;

      // 1. Left & Right Arrow Key Custom Skip Override
      if (settings.overrideArrowKeys && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        suppressedKeys.add(e.key);

        const useShift = e.shiftKey && settings.shiftMultiplierEnabled;
        if (e.key === "ArrowLeft") {
          const rewind = useShift
            ? Math.abs(Number(settings.shiftRewindSeconds) || 15)
            : Math.abs(Number(settings.rewindSeconds) || 5);
          seekMediaByDelta(media, -rewind);
        } else {
          const forward = useShift
            ? Math.abs(Number(settings.shiftForwardSeconds) || 15)
            : Math.abs(Number(settings.forwardSeconds) || 5);
          seekMediaByDelta(media, forward);
        }
        return;
      }

      // 2. Optional Speed Hotkeys: '[' slower, ']' faster, '\\' reset to 1.0x
      if (settings.enableSpeedHotkeys && !e.shiftKey) {
        if (e.key === "[" || e.key === "]" || e.key === "\\") {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          suppressedKeys.add(e.key);

          const step = Math.max(0.05, Number(settings.speedStep) || 0.25);
          let nextSpeed = Number(settings.playbackSpeed) || 1.0;
          if (e.key === "[") {
            nextSpeed = clampSpeed(nextSpeed - step);
          } else if (e.key === "]") {
            nextSpeed = clampSpeed(nextSpeed + step);
          } else if (e.key === "\\") {
            nextSpeed = 1.0;
          }

          settings.playbackSpeed = nextSpeed;
          applySpeedToAllMedia(nextSpeed, true);
          chrome.storage.sync.set({ playbackSpeed: nextSpeed });
        }
      }
    },
    { capture: true, passive: false }
  );

  // Also block keyup/keypress for intercepted keys so players listening on keyup don't double-skip
  const suppressFollowUpEvent = (e) => {
    if (suppressedKeys.has(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.type === "keyup") {
        suppressedKeys.delete(e.key);
      }
    }
  };

  window.addEventListener("keypress", suppressFollowUpEvent, { capture: true, passive: false });
  window.addEventListener("keyup", suppressFollowUpEvent, { capture: true, passive: false });

  // --- Storage & Messaging Synchronization ---
  chrome.storage.sync.get(null, (stored) => {
    if (stored) {
      settings = { ...settings, ...stored };
      if (isSiteEnabled()) {
        applySpeedToAllMedia(settings.playbackSpeed, false);
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let speedChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
      if (key === "playbackSpeed" || key === "enabled" || key === "disabledHosts") {
        speedChanged = true;
      }
    }
    if (speedChanged) {
      if (isSiteEnabled()) {
        applySpeedToAllMedia(settings.playbackSpeed, true);
      } else {
        // Restore 1.0x when disabled
        trackedMedia.forEach((m) => {
          try {
            m.playbackRate = 1.0;
          } catch (_) {}
        });
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "GET_STATUS") {
      scanAllMediaElements();
      const active = getBestMediaElement();
      sendResponse({
        mediaCount: trackedMedia.size,
        currentRate: active ? active.playbackRate : settings.playbackSpeed,
        hostname: window.location.hostname || ""
      });
      return true;
    }

    if (msg.type === "TRIGGER_SKIP") {
      const media = getBestMediaElement();
      if (media) {
        seekMediaByDelta(media, Number(msg.delta) || 0);
      }
      sendResponse({ ok: Boolean(media) });
      return true;
    }

    if (msg.type === "SET_SPEED_NOW") {
      settings.playbackSpeed = clampSpeed(msg.speed);
      applySpeedToAllMedia(settings.playbackSpeed, true);
      sendResponse({ ok: true, speed: settings.playbackSpeed });
      return true;
    }
  });

  // --- Observe DOM Mutations for Dynamically Injected Players (SPAs like YouTube, Netflix, Twitch) ---
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (let i = 0; i < m.addedNodes.length; i++) {
        const node = m.addedNodes[i];
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === "VIDEO" || node.tagName === "AUDIO") {
          attachMediaListeners(node);
        } else {
          scanRootForMedia(node);
        }
      }
    }
  });

  function startObserving() {
    if (document.documentElement) {
      scanAllMediaElements();
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } else {
      window.addEventListener("DOMContentLoaded", startObserving, { once: true });
    }
  }

  startObserving();
})();
