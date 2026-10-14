// TempoSkip Content Script (v1.2.1)
// Runs at document_start across all frames to override playback speeds and Left/Right arrow skip durations.
// Precision MSE seek engine: zero buffer snapping, serialized in-flight seeks, and pause-seek-play stall recovery.

(() => {
  if (window.__tempoSkipInitialized) return;
  window.__tempoSkipInitialized = true;

  const MIN_SPEED = 0.07;
  const MAX_SPEED = 16.0;
  const RAPID_CLICK_WINDOW_MS = 260;
  const SEEK_COALESCE_DEBOUNCE_MS = 220;
  const IN_FLIGHT_SEEK_TIMEOUT_MS = 900;

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
    enableSpeedHotkeys: true,
    speedStep: 0.25,
    showHud: true,
    disabledHosts: []
  };

  const trackedMedia = new Set();
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
        cycleActive: false,          // True from first keypress until final seeked/canplay settles
        virtualTargetTime: null,     // Exact accumulated target timestamp across rapid clicks
        queuedTargetTime: null,      // Target waiting for an in-flight MSE seek (`media.seeking`) to finish
        accumulatedDelta: 0,         // Total +/- seconds shown in the HUD for the current burst
        wasPlayingBeforeSeek: false, // Preserved play state before the seek burst began
        pausedByUs: false,           // Whether we paused the media during rapid unbuffered scrubbing
        lastKeyTime: 0,              // Timestamp (performance.now) of the most recent skip keydown
        debounceTimer: null,         // Coalescing timer for rapid/unbuffered clicks
        inFlightWaitTimer: null,     // Fallback timer if `seeked` event is delayed while queuedTargetTime waits
        hudResetTimer: null,         // Resets accumulatedDelta after user stops pressing keys
        recoveryTimers: [],          // Post-seek stall detection timers
        recoveryCleanup: null,       // Listener cleanup function
        suspendRateEnforcement: false,
        originTime: 0                // currentTime when the seek cycle began (known-buffered anchor)
      };
      mediaSeekState.set(media, st);
    }
    return st;
  }

  function clearRecoveryWatchdog(st) {
    if (st.recoveryTimers && st.recoveryTimers.length) {
      st.recoveryTimers.forEach((id) => clearTimeout(id));
      st.recoveryTimers = [];
    }
    if (st.inFlightWaitTimer) {
      clearTimeout(st.inFlightWaitTimer);
      st.inFlightWaitTimer = null;
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

  // --- Precision MSE Seek & Serialization Engine (No Buffer Snapping) ---

  // Check if a target timestamp is inside any currently buffered TimeRange
  function isTimeBuffered(media, timeSec) {
    try {
      const buf = media.buffered;
      if (!buf || buf.length === 0) return false;
      for (let i = 0; i < buf.length; i++) {
        if (timeSec >= buf.start(i) + 0.05 && timeSec <= buf.end(i) - 0.1) {
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function getSeekableBounds(media) {
    let minSeek = 0;
    let maxSeek = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : Infinity;
    try {
      const seekable = media.seekable;
      if (seekable && seekable.length > 0) {
        minSeek = Math.max(0, seekable.start(0));
        maxSeek = seekable.end(seekable.length - 1);
      }
    } catch (_) {}
    // Avoid exact 0.000s PTS hole on MSE streams where first frame starts at ~0.04s
    if (minSeek < 0.05 && !isTimeBuffered(media, 0)) {
      minSeek = 0.05;
    }
    if (Number.isFinite(maxSeek) && maxSeek > minSeek + 0.1) {
      maxSeek = maxSeek - 0.05;
    }
    return { minSeek, maxSeek };
  }

  // Execute the actual `media.currentTime = exactTarget` mutation safely.
  // Never snaps to buffer boundaries; serializes if `media.seeking` is currently active.
  function executePrecisionSeek(media, exactTarget) {
    const st = getSeekState(media);
    clearRecoveryWatchdog(st);

    // If the browser/MSE player is ALREADY in the middle of an unbuffered seek (`media.seeking === true`),
    // do NOT overwrite `media.currentTime` mid-append (which corrupts Crunchyroll's MSE SourceBuffer).
    // Queue `exactTarget` and fire it the instant the current `seeked` event completes.
    if (settings.safeMseSeek && media.seeking) {
      st.queuedTargetTime = exactTarget;
      const onInFlightSeeked = () => {
        media.removeEventListener("seeked", onInFlightSeeked, true);
        if (st.inFlightWaitTimer) {
          clearTimeout(st.inFlightWaitTimer);
          st.inFlightWaitTimer = null;
        }
        if (st.queuedTargetTime !== null && st.debounceTimer === null) {
          const nextTarget = st.queuedTargetTime;
          st.queuedTargetTime = null;
          performRawSeekWithRecovery(media, nextTarget);
        }
      };
      media.addEventListener("seeked", onInFlightSeeked, true);
      st.inFlightWaitTimer = setTimeout(() => {
        media.removeEventListener("seeked", onInFlightSeeked, true);
        st.inFlightWaitTimer = null;
        if (st.queuedTargetTime !== null && st.debounceTimer === null) {
          const nextTarget = st.queuedTargetTime;
          st.queuedTargetTime = null;
          performRawSeekWithRecovery(media, nextTarget);
        }
      }, IN_FLIGHT_SEEK_TIMEOUT_MS);
      return;
    }

    st.queuedTargetTime = null;
    performRawSeekWithRecovery(media, exactTarget);
  }

  function performRawSeekWithRecovery(media, exactTarget) {
    const st = getSeekState(media);
    clearRecoveryWatchdog(st);

    const targetIsBuffered = isTimeBuffered(media, exactTarget);

    // Fast path when seeking inside an already-buffered range
    if (!settings.safeMseSeek || targetIsBuffered) {
      try {
        media.currentTime = exactTarget;
      } catch (_) {}
      st.virtualTargetTime = null;
      st.cycleActive = false;
      st.suspendRateEnforcement = false;
      if (isSiteEnabled()) {
        applySpeedToMedia(media, settings.playbackSpeed);
      }
      return;
    }

    // --- Out-of-Buffer Seek Path (Crunchyroll / Shaka / HLS / DASH) ---
    // We never pause()/play() the element ourselves: a native seek keeps `paused` untouched and the
    // browser resumes by itself once data arrives. If the page's player fails to fetch the new
    // position (the "hang"), we recover by issuing seeks to *different* timestamps, which is what
    // the player's built-in +/-10s buttons do and what makes its segment loader restart.
    st.suspendRateEnforcement = true;
    let seekSettled = false;
    let nudgeStage = 0;
    const { minSeek, maxSeek } = getSeekableBounds(media);

    const completeCycle = () => {
      if (seekSettled) return;
      seekSettled = true;
      clearRecoveryWatchdog(st);
      st.virtualTargetTime = null;
      st.cycleActive = false;
      st.suspendRateEnforcement = false;
      st.pausedByUs = false;
      if (isSiteEnabled()) {
        applySpeedToMedia(media, settings.playbackSpeed);
      }
    };

    const userIsPressingKeys = () => st.debounceTimer !== null || st.queuedTargetTime !== null;
    const isHealthy = () => !media.seeking && media.readyState >= 3;

    const onSeekedOrCanPlay = () => {
      if (userIsPressingKeys()) return;
      if (isHealthy()) completeCycle();
    };

    media.addEventListener("seeked", onSeekedOrCanPlay, true);
    media.addEventListener("canplay", onSeekedOrCanPlay, true);
    media.addEventListener("playing", onSeekedOrCanPlay, true);

    st.recoveryCleanup = () => {
      media.removeEventListener("seeked", onSeekedOrCanPlay, true);
      media.removeEventListener("canplay", onSeekedOrCanPlay, true);
      media.removeEventListener("playing", onSeekedOrCanPlay, true);
    };

    const setTime = (t) => {
      try {
        media.currentTime = Math.min(maxSeek, Math.max(minSeek, t));
      } catch (_) {}
    };

    // Issue the single exact seek
    setTime(exactTarget);

    const nudge = () => {
      nudgeStage++;
      if (nudgeStage === 1) {
        // Re-issue the seek at a slightly different time so the player treats it as a new seek.
        setTime(exactTarget + (exactTarget + 0.2 <= maxSeek ? 0.2 : -0.2));
      } else if (nudgeStage === 2) {
        // Hop back to the known-buffered origin, then seek to the target again once that settles.
        const anchor = Number.isFinite(st.originTime) ? st.originTime : minSeek;
        if (isTimeBuffered(media, anchor) && Math.abs(anchor - exactTarget) > 0.5) {
          let hopped = false;
          const hopBack = () => {
            if (hopped) return;
            hopped = true;
            media.removeEventListener("seeked", hopBack, true);
            if (!media.isConnected || seekSettled || userIsPressingKeys()) return;
            setTime(exactTarget);
          };
          media.addEventListener("seeked", hopBack, true);
          const tid = setTimeout(hopBack, 500);
          st.recoveryTimers.push(tid);
          setTime(anchor);
        } else {
          setTime(exactTarget - 0.3);
        }
      } else {
        // Last resort: the player may have left itself paused after the failed load.
        setTime(exactTarget);
        if (st.wasPlayingBeforeSeek && media.paused) {
          const tid = setTimeout(() => {
            if (media.isConnected && !seekSettled && media.paused && !userIsPressingKeys()) {
              media.play().catch(() => {});
            }
          }, 150);
          st.recoveryTimers.push(tid);
        }
      }
    };

    const checkStall = () => {
      if (!media.isConnected || seekSettled) return;
      if (userIsPressingKeys()) return;
      if (isHealthy()) {
        completeCycle();
        return;
      }
      nudge();
    };

    [900, 1900, 3200].forEach((ms) => {
      st.recoveryTimers.push(setTimeout(checkStall, ms));
    });
    st.recoveryTimers.push(setTimeout(completeCycle, 5000));
  }

  function seekMediaByDelta(media, deltaSeconds, isRepeatKey = false) {
    if (!media) return;
    const st = getSeekState(media);
    const now = performance.now();
    const isRapidBurst = now - st.lastKeyTime < RAPID_CLICK_WINDOW_MS;
    st.lastKeyTime = now;

    // Start a new seek cycle if one is not already active
    if (!st.cycleActive) {
      st.cycleActive = true;
      st.wasPlayingBeforeSeek = !media.paused && !media.ended;
      st.virtualTargetTime = Number(media.currentTime) || 0;
      st.originTime = st.virtualTargetTime;
    }

    // Reset HUD delta counter only if enough time elapsed since the last keypress
    if (st.hudResetTimer) {
      clearTimeout(st.hudResetTimer);
    }
    st.hudResetTimer = setTimeout(() => {
      st.accumulatedDelta = 0;
      st.hudResetTimer = null;
    }, 950);

    const baseTime =
      st.virtualTargetTime !== null ? st.virtualTargetTime : (Number(media.currentTime) || 0);
    const { minSeek, maxSeek } = getSeekableBounds(media);
    const targetTime = Math.min(maxSeek, Math.max(minSeek, baseTime + deltaSeconds));

    st.virtualTargetTime = targetTime;
    st.accumulatedDelta += deltaSeconds;

    const totalDelta = st.accumulatedDelta;
    const sign = totalDelta >= 0 ? "+" : "-";
    const icon = totalDelta >= 0 ? "⏩" : "⏪";
    showHudToast(`${icon} ${sign}${formatNumber(Math.abs(totalDelta))}s`, media);

    const targetIsBuffered = isTimeBuffered(media, targetTime);

    // Coalesce when Safe MSE Seek is enabled and:
    // 1. Target is outside `media.buffered`, OR
    // 2. User is clicking rapidly (`isRapidBurst` or `isRepeatKey`), OR
    // 3. Player is currently mid-seek (`media.seeking`), OR
    // 4. A debounce timer is already running for this burst.
    if (
      settings.safeMseSeek &&
      (!targetIsBuffered || isRapidBurst || isRepeatKey || media.seeking || st.debounceTimer !== null)
    ) {
      // Cancel any post-seek recovery from a prior seek while the user is still clicking
      clearRecoveryWatchdog(st);

      // NOTE: we deliberately never pause() the media here. Programmatic pause/play desyncs
      // the page player's own play-state tracking (Crunchyroll hangs waiting for a play that never comes).

      if (st.debounceTimer) {
        clearTimeout(st.debounceTimer);
      }
      st.debounceTimer = setTimeout(() => {
        st.debounceTimer = null;
        const finalTarget = st.virtualTargetTime !== null ? st.virtualTargetTime : targetTime;
        executePrecisionSeek(media, finalTarget);
      }, SEEK_COALESCE_DEBOUNCE_MS);
      return;
    }

    // Single click inside buffered range: execute immediately with zero delay
    executePrecisionSeek(media, targetTime);
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
