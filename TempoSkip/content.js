// TempoSkip Content Script (v1.1.0)
// Runs at document_start across all frames to override playback speeds and Left/Right arrow skip durations.
// Includes Smart MSE/DRM Out-of-Buffer Seek Protection for players like Crunchyroll, Shaka, Bitmovin, and HLS/DASH.

(() => {
  if (window.__tempoSkipInitialized) return;
  window.__tempoSkipInitialized = true;

  const MIN_SPEED = 0.07;
  const MAX_SPEED = 16.0;
  const OUT_OF_BUFFER_DEBOUNCE_MS = 150;

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
    safeMseSeek: true,
    clampRewindToBuffer: false,
    enableSpeedHotkeys: true,
    speedStep: 0.25,
    showHud: true,
    disabledHosts: []
  };

  const trackedMedia = new Set();
  // Per-media state for coalescing rapid/out-of-buffer seeks and recovering from MSE stalls
  const mediaSeekState = new WeakMap();

  let lastActiveMedia = null;
  let internalRateUpdate = false;
  let hudHost = null;
  let hudLabel = null;
  let hudTimer = null;

  function getSeekState(media) {
    let st = mediaSeekState.get(media);
    if (!st) {
      st = {
        pendingTargetTime: null,
        accumulatedDelta: 0,
        wasPlayingBeforeSeek: false,
        debounceTimer: null,
        recoveryTimers: [],
        suspendRateEnforcement: false,
        recoveryCleanup: null
      };
      mediaSeekState.set(media, st);
    }
    return st;
  }

  function clearRecoveryTimers(st) {
    if (st.recoveryTimers && st.recoveryTimers.length) {
      st.recoveryTimers.forEach((id) => clearTimeout(id));
      st.recoveryTimers = [];
    }
    if (typeof st.recoveryCleanup === "function") {
      st.recoveryCleanup();
      st.recoveryCleanup = null;
    }
  }

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

    const mountRoot = document.fullscreenElement || document.webkitFullscreenElement || document.body;
    if (hudHost.parentNode !== mountRoot) {
      mountRoot.appendChild(hudHost);
    }

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
    const st = getSeekState(media);
    // Avoid forcing non-1x speed in the middle of an unbuffered MSE seek, which can deadlock DRM/MSE decoders
    if (st.suspendRateEnforcement) return;

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
        const st = getSeekState(media);
        if (st.suspendRateEnforcement) return;
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

  try {
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const shadowRoot = origAttachShadow.call(this, init);
      setTimeout(() => scanRootForMedia(shadowRoot), 0);
      return shadowRoot;
    };
  } catch (_) {}

  function getBestMediaElement() {
    scanAllMediaElements();
    const candidates = Array.from(trackedMedia).filter((m) => m.isConnected);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const playingVideos = candidates.filter(
      (m) => m.tagName === "VIDEO" && !m.paused && !m.ended && m.readyState > 0
    );
    if (playingVideos.length > 0) return pickLargestVideo(playingVideos);

    if (lastActiveMedia && lastActiveMedia.isConnected && lastActiveMedia.readyState > 0) {
      return lastActiveMedia;
    }

    const videos = candidates.filter((m) => m.tagName === "VIDEO");
    if (videos.length > 0) return pickLargestVideo(videos);

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

  function isEditableTarget(el) {
    if (!el) return false;
    let target = el;
    while (target && target.shadowRoot && target.shadowRoot.activeElement) {
      target = target.shadowRoot.activeElement;
    }
    const tag = (target.tagName || "").toUpperCase();
    if (target.isContentEditable) return true;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const inputType = (target.type || "text").toLowerCase();
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

  // --- MSE Buffer Inspection & Out-of-Buffer Protection Helpers ---

  // Check if a target timestamp is inside any currently buffered TimeRange (with a small margin)
  function isTimeBuffered(media, timeSec, margin = 0.15) {
    try {
      const buf = media.buffered;
      if (!buf || buf.length === 0) return false;
      for (let i = 0; i < buf.length; i++) {
        const start = buf.start(i);
        const end = buf.end(i);
        if (timeSec >= start - 0.05 && timeSec <= Math.max(start, end - margin)) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  // Find the buffered range containing or closest to currentTime
  function getCurrentBufferedFloor(media, referenceTime) {
    try {
      const buf = media.buffered;
      if (!buf || buf.length === 0) return null;
      for (let i = 0; i < buf.length; i++) {
        const start = buf.start(i);
        const end = buf.end(i);
        if (referenceTime >= start - 0.25 && referenceTime <= end + 0.5) {
          // Leave a tiny 0.08s pad after chunk start so we don't hit an unbuffered boundary
          return Math.min(referenceTime, start + 0.08);
        }
      }
    } catch (_) {}
    return null;
  }

  // Get safe [minSeek, maxSeek] bounds respecting media.seekable & avoiding MSE 0.000s PTS hole
  function getSafeSeekBounds(media) {
    let minSeek = 0;
    let maxSeek = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : Infinity;

    try {
      const seekable = media.seekable;
      if (seekable && seekable.length > 0) {
        minSeek = seekable.start(0);
        maxSeek = seekable.end(seekable.length - 1);
      }
    } catch (_) {}

    // Many MSE streams (Crunchyroll, Shaka, HLS/DASH) have a first video keyframe PTS slightly > 0 (e.g. 0.042s).
    // Seeking to exact 0.0 when 0.0 is unbuffered causes MSE to wait indefinitely for [0, 0.042).
    if (minSeek <= 0.08) {
      try {
        const buf = media.buffered;
        if (buf && buf.length > 0 && buf.start(0) > 0 && buf.start(0) < 0.5) {
          minSeek = Math.max(minSeek, buf.start(0) + 0.02);
        } else {
          minSeek = Math.max(minSeek, 0.05);
        }
      } catch (_) {
        minSeek = Math.max(minSeek, 0.05);
      }
    }

    if (Number.isFinite(maxSeek) && maxSeek > minSeek + 0.2) {
      maxSeek = maxSeek - 0.05;
    }

    return { minSeek, maxSeek };
  }

  // If MSE appended a new segment starting slightly AFTER media.currentTime (keyframe gap),
  // return the start of that buffered range so we can bridge the gap and unfreeze playback.
  function findKeyframeGapTarget(media) {
    try {
      const cur = Number(media.currentTime) || 0;
      const buf = media.buffered;
      if (!buf || buf.length === 0) return null;

      // If cur is already comfortably inside a buffered range, no gap exists
      for (let i = 0; i < buf.length; i++) {
        if (cur >= buf.start(i) && cur < buf.end(i) - 0.05) {
          return null;
        }
      }

      // Check if a buffered chunk starts slightly ahead of cur (within 3.5 seconds)
      let closestStart = null;
      let minDiff = Infinity;
      for (let i = 0; i < buf.length; i++) {
        const start = buf.start(i);
        const end = buf.end(i);
        const diff = start - cur;
        if (diff > -0.02 && diff <= 3.5 && end - start > 0.15 && diff < minDiff) {
          minDiff = diff;
          closestStart = start;
        }
      }
      if (closestStart !== null) {
        return closestStart + 0.03;
      }
    } catch (_) {}
    return null;
  }

  // Commit the seek to the media element and run the MSE recovery watchdog if out of buffer
  function commitSeek(media, targetTime, wasOutOfBuffer) {
    const st = getSeekState(media);
    clearRecoveryTimers(st);

    const wasPlaying = st.wasPlayingBeforeSeek;
    st.pendingTargetTime = null;
    st.accumulatedDelta = 0;
    st.debounceTimer = null;

    if (!settings.safeMseSeek || !wasOutOfBuffer) {
      // Fast path for in-buffer seeks
      try {
        media.currentTime = targetTime;
      } catch (_) {}
      if (wasPlaying && media.paused) {
        media.play().catch(() => {});
      }
      return;
    }

    // --- Safe Out-of-Buffer MSE Seek Path (Crunchyroll / Shaka / Bitmovin / HLS / DASH) ---
    // 1. Temporarily suspend custom playbackRate forcing during unbuffered segment negotiation
    st.suspendRateEnforcement = true;

    let lastObservedTime = targetTime;
    let bridgedGapCount = 0;

    const finishRecovery = () => {
      clearRecoveryTimers(st);
      st.suspendRateEnforcement = false;
      if (isSiteEnabled()) {
        applySpeedToMedia(media, settings.playbackSpeed);
      }
      if (wasPlaying && media.paused && media.readyState >= 2) {
        media.play().catch(() => {});
      }
    };

    const attemptUnfreeze = () => {
      if (!media.isConnected) {
        clearRecoveryTimers(st);
        return;
      }

      // A. Check if MSE buffered a chunk starting at an IDR keyframe slightly ahead of media.currentTime
      const gapTarget = findKeyframeGapTarget(media);
      if (gapTarget !== null && bridgedGapCount < 2) {
        bridgedGapCount++;
        try {
          media.currentTime = gapTarget;
        } catch (_) {}
      }

      // B. If the target range IS now buffered and readyState >= 3, resume playback & speed
      if (isTimeBuffered(media, media.currentTime, 0.05) && media.readyState >= 3) {
        if (wasPlaying && media.paused) {
          media.play().catch(() => {});
        }
        // Check if playback is actually advancing or if the MSE decoder is stalled on a frame
        const nowTime = Number(media.currentTime) || 0;
        if (wasPlaying && !media.paused && Math.abs(nowTime - lastObservedTime) < 0.001) {
          // Micro-nudge by +0.04s to kick stalled MSE/EME pipeline
          try {
            media.currentTime = nowTime + 0.04;
          } catch (_) {}
        }
        lastObservedTime = Number(media.currentTime) || 0;
      }
    };

    const onCanPlayOrPlaying = () => {
      if (media.readyState >= 3) {
        finishRecovery();
      }
    };

    const onProgressOrWaiting = () => {
      attemptUnfreeze();
    };

    media.addEventListener("canplay", onCanPlayOrPlaying, true);
    media.addEventListener("playing", onCanPlayOrPlaying, true);
    media.addEventListener("progress", onProgressOrWaiting, true);
    media.addEventListener("waiting", onProgressOrWaiting, true);
    media.addEventListener("stalled", onProgressOrWaiting, true);

    st.recoveryCleanup = () => {
      media.removeEventListener("canplay", onCanPlayOrPlaying, true);
      media.removeEventListener("playing", onCanPlayOrPlaying, true);
      media.removeEventListener("progress", onProgressOrWaiting, true);
      media.removeEventListener("waiting", onProgressOrWaiting, true);
      media.removeEventListener("stalled", onProgressOrWaiting, true);
    };

    // Perform the single coalesced seek
    try {
      media.currentTime = targetTime;
    } catch (_) {}

    // Schedule staged recovery checks to bridge MSE keyframe gaps and unstick frozen pipelines
    [220, 500, 950, 1600].forEach((delayMs) => {
      const tid = setTimeout(attemptUnfreeze, delayMs);
      st.recoveryTimers.push(tid);
    });

    // Final safety cleanup after 2.6 seconds
    const finalTid = setTimeout(finishRecovery, 2600);
    st.recoveryTimers.push(finalTid);
  }

  function seekMediaByDelta(media, deltaSeconds, isRepeatKey = false) {
    if (!media) return;
    const st = getSeekState(media);

    // Record whether the video was playing before a burst of seeks started
    if (st.pendingTargetTime === null && st.debounceTimer === null) {
      st.wasPlayingBeforeSeek = !media.paused && !media.ended;
      st.accumulatedDelta = 0;
    }

    const baseTime = st.pendingTargetTime !== null ? st.pendingTargetTime : (Number(media.currentTime) || 0);
    const { minSeek, maxSeek } = getSafeSeekBounds(media);
    let targetTime = Math.min(maxSeek, Math.max(minSeek, baseTime + deltaSeconds));

    // Optional strict mode: clamp backward rewinds to the start of the active buffered chunk
    let clampedToBuffer = false;
    if (deltaSeconds < 0 && settings.clampRewindToBuffer) {
      const floor = getCurrentBufferedFloor(media, Number(media.currentTime) || 0);
      if (floor !== null && targetTime < floor) {
        targetTime = floor;
        clampedToBuffer = true;
      }
    }

    st.pendingTargetTime = targetTime;
    st.accumulatedDelta += deltaSeconds;

    const totalDelta = st.accumulatedDelta;
    const sign = totalDelta >= 0 ? "+" : "-";
    const icon = totalDelta >= 0 ? "⏩" : "⏪";
    const bufferNote = clampedToBuffer ? " (buffered limit)" : "";
    showHudToast(`${icon} ${sign}${formatNumber(Math.abs(totalDelta))}s${bufferNote}`, media);

    const targetIsBuffered = isTimeBuffered(media, targetTime);

    // If Safe MSE Seek is enabled and:
    // - the target timestamp is outside the currently buffered chunk, OR
    // - the player is already mid-seek (`media.seeking`), OR
    // - the user is holding down the arrow key (`isRepeatKey`) or already debouncing,
    // coalesce rapid presses into a single clean seek so the MSE SourceBuffer never thrashes or freezes.
    if (
      settings.safeMseSeek &&
      (!targetIsBuffered || media.seeking || isRepeatKey || st.debounceTimer !== null)
    ) {
      if (st.debounceTimer) {
        clearTimeout(st.debounceTimer);
      }
      st.debounceTimer = setTimeout(() => {
        const finalTarget = st.pendingTargetTime !== null ? st.pendingTargetTime : targetTime;
        const stillOutOfBuffer = !isTimeBuffered(media, finalTarget);
        commitSeek(media, finalTarget, stillOutOfBuffer);
      }, OUT_OF_BUFFER_DEBOUNCE_MS);
      return;
    }

    // Immediate seek when target is safely inside the existing buffer
    commitSeek(media, targetTime, false);
  }

  // --- Capture-Phase Keyboard Interception ---
  const suppressedKeys = new Set();

  window.addEventListener(
    "keydown",
    (e) => {
      if (!isSiteEnabled()) return;
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
          seekMediaByDelta(media, -rewind, Boolean(e.repeat));
        } else {
          const forward = useShift
            ? Math.abs(Number(settings.shiftForwardSeconds) || 15)
            : Math.abs(Number(settings.forwardSeconds) || 5);
          seekMediaByDelta(media, forward, Boolean(e.repeat));
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
        seekMediaByDelta(media, Number(msg.delta) || 0, false);
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

  // --- Observe DOM Mutations for Dynamically Injected Players ---
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
