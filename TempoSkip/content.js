// TempoSkip Content Script (v1.6.0)
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
    disabledHosts: [],
    autoSkipSites: {} // legacy (v1.5): { [hostname]: { intro, credits } } - only used to migrate old ticks
  };

  // Opt-in diagnostics: run  localStorage.temposkipDebug = "1"  in the player frame's console, then reload.
  let DEBUG = false;
  try { DEBUG = localStorage.getItem("temposkipDebug") === "1"; } catch (_) {}
  const dbg = (...a) => { if (DEBUG) console.log("[TempoSkip]", ...a); };
  function bufStr(m) {
    try {
      const out = [];
      for (let i = 0; i < m.buffered.length; i++) out.push(m.buffered.start(i).toFixed(1) + "-" + m.buffered.end(i).toFixed(1));
      return out.join(",");
    } catch (_) { return "?"; }
  }

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
    st.nativeToken = (st.nativeToken || 0) + 1; // cancels any in-progress native-assisted seek
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

  // --- Learned per-site profiles (chrome.storage.local) ---
  // { [hostname]: { bridge: "ok" | "none", path, fn, via, fail, fallback, ts } }
  // "ok"   = the page-world bridge found the player's native seek API at `path`; reused as a hint next time.
  // "none" = no usable API was found; skip the (costly) search for NEG_TTL_MS, then try again.
  const HOST_KEY = (window.location.hostname || "").toLowerCase();
  const NEG_TTL_MS = 6 * 60 * 60 * 1000;
  let siteProfiles = {};
  function loadSiteProfiles() {
    try {
      chrome.storage.local.get("siteProfiles", (r) => {
        if (chrome.runtime.lastError) return;
        siteProfiles = (r && r.siteProfiles) || {};
      });
    } catch (_) {}
  }
  loadSiteProfiles();
  function updateSiteProfile(patch) {
    if (!HOST_KEY) return;
    try {
      // Read-modify-write so several frames/tabs don't clobber each other's entries.
      chrome.storage.local.get("siteProfiles", (r) => {
        if (chrome.runtime.lastError) return;
        const all = (r && r.siteProfiles) || {};
        const cur = all[HOST_KEY] || {};
        const p = typeof patch === "function" ? patch(cur) : patch;
        const next = { ...cur, ...p, ts: Date.now() };
        if (JSON.stringify({ ...cur, ts: 0 }) === JSON.stringify({ ...next, ts: 0 })) return; // nothing new
        all[HOST_KEY] = next;
        siteProfiles = all;
        chrome.storage.local.set({ siteProfiles: all });
      });
    } catch (_) {}
  }

  // --- MAIN-world bridge client (see bridge.js) ---
  let bridgeReqId = 0;
  function bridgeSeek(t, hint) {
    return new Promise((resolve) => {
      const id = ++bridgeReqId;
      const onRes = (ev) => {
        let r;
        try { r = JSON.parse(ev.detail); } catch (_) { return; }
        if (!r || r.id !== id) return;
        document.removeEventListener("temposkip:res", onRes);
        clearTimeout(to);
        resolve(r);
      };
      const to = setTimeout(() => {
        document.removeEventListener("temposkip:res", onRes);
        resolve({ ok: false, reason: "bridge timeout" });
      }, 400);
      document.addEventListener("temposkip:res", onRes);
      document.dispatchEvent(new CustomEvent("temposkip:req", { detail: JSON.stringify({ id, op: "seek", t, hint: hint || null }) }));
    });
  }

  // --- Player-native seek assist ---
  // Crunchyroll's engine only re-targets its segment loader when the seek goes through ITS API
  // (its +/-10s buttons -> seekTo -> engine). A raw `video.currentTime = x` into an unbuffered range
  // *behind* the playhead leaves the loader fetching at the old position and the video freezes.
  // So for unbuffered backward seeks we click the player's own "jump back" button until we are at or
  // before the target (the engine now loads that area), then finish with a raw forward seek to the
  // exact target, which the engine handles fine.
  function findNativeJumpButton(media, dir) {
    const back = dir < 0;
    const roots = [document];
    try {
      const r = media.getRootNode && media.getRootNode();
      if (r && r !== document && typeof r.querySelectorAll === "function") roots.unshift(r);
    } catch (_) {}
    const include = back ? /(back|rewind|replay|backward)/i : /(forward|ahead|fast)/i;
    const exclude = back ? /(forward|ahead)/i : /(back|rewind|replay)/i;
    const kind = /(jump|10|sec|rewind|replay|seek)/i;
    const reject = /(intro|credit|outro|recap|episode|next|previous|prev|volume|caption|subtitle|setting|fullscreen)/i;
    for (const root of roots) {
      const nodes = root.querySelectorAll('button, [role="button"], [data-testid]');
      for (const el of nodes) {
        if (el.disabled || !el.isConnected) continue;
        const cls = typeof el.className === "string" ? el.className : "";
        const label = [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("data-testid"), cls].join(" ");
        if (!kind.test(label) || !include.test(label) || exclude.test(label) || reject.test(label)) continue;
        return el;
      }
    }
    return null;
  }

  function nativeAssistedBackSeek(media, target, st, onDone, onFail) {
    const token = (st.nativeToken = (st.nativeToken || 0) + 1);
    const alive = () => token === st.nativeToken && media.isConnected;
    let clicks = 0;

    const waitSeeked = (cb) => {
      let fired = false;
      const go = () => {
        if (fired) return;
        fired = true;
        media.removeEventListener("seeked", go, true);
        cb();
      };
      media.addEventListener("seeked", go, true);
      setTimeout(go, 2500);
    };

    const finish = () => {
      const t0 = performance.now();
      const tryForward = () => {
        if (!alive()) return;
        if (isTimeBuffered(media, target) || performance.now() - t0 > 3000) {
          dbg("native assist: final raw forward seek", { target, cur: media.currentTime, buffered: bufStr(media) });
          try { media.currentTime = target; } catch (_) {}
          onDone();
          return;
        }
        setTimeout(tryForward, 100);
      };
      tryForward();
    };

    const step = () => {
      if (!alive()) return;
      if (media.currentTime <= target + 0.05) return finish();
      if (clicks >= 6) return onFail("too many clicks");
      const btn = findNativeJumpButton(media, -1);
      if (!btn) return onFail("no jump-back button");
      const before = media.currentTime;
      clicks++;
      dbg("native assist: click jump-back", { n: clicks, cur: before, target });
      btn.click();
      waitSeeked(() => {
        setTimeout(() => {
          if (!alive()) return;
          if (Math.abs(media.currentTime - before) < 0.5) return onFail("click did not move playhead");
          step();
        }, 150);
      });
    };
    step();
  }

  function performRawSeekWithRecovery(media, exactTarget) {
    const st = getSeekState(media);
    clearRecoveryWatchdog(st);

    const targetIsBuffered = isTimeBuffered(media, exactTarget);

    // Fast path when seeking inside an already-buffered range
    if (targetIsBuffered) {
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
    const origin = Number.isFinite(st.originTime) ? st.originTime : minSeek;
    const goingBack = exactTarget < origin;
    let lastCheckTime = exactTarget;

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
    // Healthy = not seeking, has data, and (paused or the clock is really advancing).
    const isHealthy = () =>
      !media.seeking &&
      media.readyState >= 3 &&
      (media.paused || Math.abs(media.currentTime - lastCheckTime) > 0.02);

    const setTime = (t) => {
      try {
        media.currentTime = Math.min(maxSeek, Math.max(minSeek, t));
      } catch (_) {}
    };

    dbg("seek", { origin, target: exactTarget, goingBack, buffered: bufStr(media), seeking: media.seeking, rs: media.readyState });
    let startWatchdog = () => {};
    let watchdogStarted = false;
    const beginWatchdog = () => {
      if (watchdogStarted) return;
      watchdogStarted = true;
      startWatchdog();
    };

    // ---- Strategy for unbuffered targets (either direction) ----
    // "auto": plain seek first. Only if the player really hangs (stalled AND its buffer stopped growing)
    //         do we seek through the player's own API, and we remember per site + direction that it needs that.
    // "raw": never touch the player's API (per-site override in the popup). Learned sites are API-first.
    const dirKey = goingBack ? "back" : "fwd";
    const profNow = () => siteProfiles[HOST_KEY] || null;
    const siteMode = () => (profNow() && profNow().mode === "raw" ? "raw" : "auto"); // legacy "api" == auto
    let lastBuf = bufStr(media);
    let apiTried = false;
    let recovering = false;

    // Seek through the page-world bridge (player's own controller API) and verify the video actually lands.
    const attemptBridge = (onLanded, onFailed) => {
      const prof = profNow();
      const mode = siteMode();
      const knownNone = prof && prof.bridge === "none" && Date.now() - (prof.ts || 0) < NEG_TTL_MS;
      if (mode === "raw" || knownNone) {
        dbg("player API skipped:", mode === "raw" ? "site set to plain seeks" : "cached: no API on this site");
        onFailed("skipped");
        return;
      }
      const token = (st.nativeToken = (st.nativeToken || 0) + 1);
      const hint = prof && prof.bridge === "ok" && prof.path && prof.fn ? { path: prof.path, fn: prof.fn } : null;
      bridgeSeek(exactTarget, hint).then((res) => {
        if (seekSettled || token !== st.nativeToken) return;
        if (!res.ok) {
          dbg("bridge unavailable:", res.reason);
          if (/^no calibrated seek API/.test(res.reason || "")) updateSiteProfile({ bridge: "none", path: null, fn: null, via: null });
          onFailed(res.reason);
          return;
        }
        dbg("bridge seek issued:", res.via);
        const t0 = performance.now();
        const verify = () => {
          if (seekSettled || token !== st.nativeToken || !media.isConnected) return;
          if (!media.seeking && media.readyState >= 3 && Math.abs(media.currentTime - exactTarget) < 1.5) {
            dbg("bridge seek landed", { cur: media.currentTime });
            const p = res.profile || {};
            updateSiteProfile({ bridge: "ok", path: p.path, fn: p.fn, via: p.via, fail: 0 });
            onLanded(res);
            return;
          }
          if (performance.now() - t0 > 3000) {
            dbg("bridge seek did not land", { cur: media.currentTime, seeking: media.seeking, rs: media.readyState });
            const fails = ((profNow() && profNow().fail) || 0) + 1;
            updateSiteProfile(fails >= 3 ? { bridge: "none", fail: fails } : { fail: fails }); // stop trusting it for a while
            onFailed("did not land");
            return;
          }
          setTimeout(verify, 100);
        };
        setTimeout(verify, 150);
      });
    };

    // Legacy fallback when the API isn't usable: player's jump-back button (backward only), else a plain seek.
    const plainOrButton = () => {
      if (seekSettled) return;
      if (goingBack && siteMode() !== "raw" && findNativeJumpButton(media, -1)) {
        nativeAssistedBackSeek(
          media,
          exactTarget,
          st,
          () => { updateSiteProfile({ fallback: "button" }); lastCheckTime = exactTarget; beginWatchdog(); },
          (why) => { dbg("native assist failed -> plain seek:", why); updateSiteProfile({ fallback: "raw" }); setTime(exactTarget); lastCheckTime = exactTarget; beginWatchdog(); }
        );
      } else {
        setTime(exactTarget);
        lastCheckTime = exactTarget;
        beginWatchdog();
      }
    };

    // needsApi is one flag per site (older saved profiles stored {back, fwd}: either one counts).
    const needsApiLearned = (p) => !!p && (p.needsApi === true || (!!p.needsApi && typeof p.needsApi === "object" && Object.values(p.needsApi).some(Boolean)));
    const prefersApi = siteMode() !== "raw" && needsApiLearned(profNow());
    if (prefersApi) {
      apiTried = true;
      dbg("learned/forced: this site needs the player API for unbuffered seeks");
      attemptBridge(() => { lastCheckTime = media.currentTime; beginWatchdog(); }, plainOrButton);
    } else {
      setTime(exactTarget); // plain seek first
    }

    // Seek to a known-buffered anchor (this revives the player: buffered seeks always work),
    // then seek to the real target again once that settles.
    const hopViaAnchor = (finalTarget) => {
      const anchor = origin;
      if (!isTimeBuffered(media, anchor) || Math.abs(anchor - finalTarget) < 0.5) {
        setTime(finalTarget);
        return;
      }
      let done = false;
      const next = () => {
        if (done) return;
        done = true;
        media.removeEventListener("seeked", next, true);
        if (!media.isConnected || seekSettled || userIsPressingKeys()) return;
        setTimeout(() => {
          if (!media.isConnected || seekSettled || userIsPressingKeys()) return;
          setTime(finalTarget);
          lastCheckTime = finalTarget;
        }, 120);
      };
      media.addEventListener("seeked", next, true);
      st.recoveryTimers.push(setTimeout(next, 600));
      setTime(anchor);
    };

    const nudge = () => {
      nudgeStage++;
      dbg("stall -> nudge", nudgeStage, { cur: media.currentTime, seeking: media.seeking, rs: media.readyState, paused: media.paused, buffered: bufStr(media) });
      if (nudgeStage === 1) {
        // Re-issue at a slightly different time so the player treats it as a brand-new seek.
        const d = goingBack ? -0.25 : 0.25;
        const t = exactTarget + d;
        setTime(t >= minSeek && t <= maxSeek ? t : exactTarget - d);
        lastCheckTime = media.currentTime;
      } else if (nudgeStage === 2) {
        hopViaAnchor(exactTarget);
      } else {
        hopViaAnchor(Math.max(minSeek, exactTarget - 1));
        if (st.wasPlayingBeforeSeek) {
          st.recoveryTimers.push(setTimeout(() => {
            if (media.isConnected && !seekSettled && media.paused && !userIsPressingKeys()) {
              media.play().catch(() => {});
            }
          }, 900));
        }
      }
    };

    const checkStall = () => {
      if (!media.isConnected || seekSettled) return;
      if (userIsPressingKeys() || recovering) return;
      if (isHealthy()) {
        dbg("healthy, done", { cur: media.currentTime });
        completeCycle();
        return;
      }
      // Is data still arriving? Then it's a slow load, not a hang: leave it alone.
      const nowBuf = bufStr(media);
      const flowing = nowBuf !== lastBuf;
      lastBuf = nowBuf;
      if (flowing) {
        dbg("slow load (buffer still growing) - waiting", { buffered: nowBuf });
        return;
      }
      // Real hang. First try the player's own API once, then remember that this site needs it.
      if (!apiTried && siteMode() !== "raw") {
        apiTried = true;
        recovering = true;
        dbg("hang detected (stalled, buffer not growing) -> trying player API", { dir: dirKey });
        attemptBridge(
          (res) => {
            recovering = false;
            const p = (res && res.profile) || {};
            updateSiteProfile({ bridge: "ok", path: p.path, fn: p.fn, via: p.via, fail: 0, needsApi: true });
            lastCheckTime = media.currentTime;
          },
          () => {
            if (goingBack && siteMode() !== "raw" && findNativeJumpButton(media, -1)) {
              nativeAssistedBackSeek(
                media, exactTarget, st,
                () => { recovering = false; updateSiteProfile({ fallback: "button" }); lastCheckTime = media.currentTime; },
                () => { recovering = false; }
              );
            } else {
              recovering = false;
            }
          }
        );
        return;
      }
      nudge();
    };

    // Only the first 'seeked' in a fresh cycle is logged; completion is decided by checkStall (progress-based).
    if (DEBUG) {
      ["seeking", "seeked", "waiting", "stalled", "playing", "pause", "play", "error"].forEach((ev) =>
        media.addEventListener(ev, () => dbg("ev", ev, media.currentTime.toFixed(2), "rs", media.readyState, "buf", bufStr(media)), { capture: true, once: true })
      );
    }

    startWatchdog = () => {
      [700, 1500, 2500, 3800].forEach((ms) => {
        st.recoveryTimers.push(setTimeout(() => { checkStall(); lastCheckTime = media.currentTime; }, ms));
      });
      st.recoveryTimers.push(setTimeout(completeCycle, 6000));
    };
    // Plain-seek path starts watching immediately; the API-first path starts once its seek has landed.
    if (!prefersApi) beginWatchdog();
    st.recoveryTimers.push(setTimeout(completeCycle, 15000));
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

          const step = Math.max(0.01, Number(settings.speedStep) || 0.25);
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
    if (area === "local") {
      if (changes.siteProfiles) siteProfiles = changes.siteProfiles.newValue || {};
      if (changes.skipRules) {
        skipRules = changes.skipRules.newValue || {};
        skipState = new WeakMap(); // any rule change (toggle / forget / learn) starts auto-click fresh
        lastAutoSkipAt = 0;
      }
      return;
    }
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


  // --- Skip-button learning + auto-click ---
  // Every "Skip ..." button the user clicks is recorded per site (storage.local `skipRules`),
  // switched OFF by default. The popup lists them with one toggle each; only enabled ones are ever clicked.
  const AUTOSKIP_MIN_VISIBLE_MS = 500;   // must stay on screen this long (ignores transient flashes)
  const AUTOSKIP_COOLDOWN_MS = 2500;     // at most one auto-click per window
  const AUTOSKIP_MAX_ATTEMPTS = 2;       // retry once if the button is still there afterwards
  let skipRules = {};                    // { [host]: { [key]: { label, enabled, seen, lastSeen } } }
  let skipState = new WeakMap();         // element -> { label, first, n, last }
  let pendingLearn = new Map();
  let learnTimer = null;
  let lastAutoSkipAt = 0;

  function loadSkipRules() {
    try {
      chrome.storage.local.get("skipRules", (r) => {
        if (chrome.runtime.lastError) return;
        skipRules = (r && r.skipRules) || {};
      });
    } catch (_) {}
  }
  loadSkipRules();

  function skipPrimaryLabel(el) {
    const aria = (el.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (txt) return txt.slice(0, 60);
    return (el.getAttribute("title") || "").trim();
  }
  // Strictly "Skip ...". (Accessibility links like "Skip to main content" are not player buttons.)
  function isSkipLabel(label) {
    return /^skip\b/i.test(label) && !/^skip\s+(to|navigation|nav)\b/i.test(label);
  }
  // Countdown digits vary ("Skip in 5"), so they are folded out of the identity key.
  function skipKey(label) {
    return label.toLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#").trim();
  }
  // Carry over the older Intro / Credits ticks (settings.autoSkipSites) to the matching learned buttons.
  function legacyEnabledFor(label) {
    const cfg = settings.autoSkipSites && settings.autoSkipSites[HOST_KEY];
    if (!cfg) return false;
    const l = label.toLowerCase();
    if (/intro|opening|recap|previously|title sequence/.test(l)) return !!cfg.intro;
    if (/credits?|ending|outro/.test(l)) return !!cfg.credits;
    return false;
  }

  // "Rendered" = could be seen if its opacity were up (not display:none / visibility:hidden).
  function isRendered(el) {
    try {
      if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
    } catch (_) {}
    return el.getClientRects().length > 0;
  }
  function effectiveOpacity(el) {
    let o = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity || "1");
    return o;
  }
  // Players like Crunchyroll keep the button in the DOM permanently (opacity 0, aria-hidden="true")
  // and reveal it when a segment is skippable. Learning needs only presence; clicking needs availability.
  function isSkipAvailable(el) {
    if (!isRendered(el)) return false;
    return effectiveOpacity(el) > 0.5;
  }

  function flushLearned() {
    learnTimer = null;
    const batch = pendingLearn;
    pendingLearn = new Map();
    if (!batch.size || !HOST_KEY) return;
    try {
      // Read-modify-write so frames/tabs don't clobber each other and the user's toggles are preserved.
      chrome.storage.local.get("skipRules", (r) => {
        if (chrome.runtime.lastError) return;
        const all = (r && r.skipRules) || {};
        const host = (all[HOST_KEY] = all[HOST_KEY] || {});
        for (const [key, label] of batch) {
          const cur = host[key];
          if (cur) {
            cur.seen = (cur.seen || 0) + 1;
            cur.lastSeen = Date.now();
          } else {
            host[key] = { label, enabled: legacyEnabledFor(label), seen: 1, lastSeen: Date.now() };
          }
        }
        skipRules = all;
        chrome.storage.local.set({ skipRules: all });
      });
    } catch (_) {}
  }

  function learnSkipButton(key, label, immediate) {
    // Create the rule in memory straight away so a carried-over (legacy) enable works on first sight.
    const host = (skipRules[HOST_KEY] = skipRules[HOST_KEY] || {});
    if (!host[key]) host[key] = { label, enabled: legacyEnabledFor(label), seen: 0, lastSeen: Date.now() };
    pendingLearn.set(key, label);
    if (immediate) {
      // A user press can navigate away (e.g. "Skip Credits" -> next episode): save before the page unloads.
      if (learnTimer) { clearTimeout(learnTimer); learnTimer = null; }
      flushLearned();
    } else if (!learnTimer) learnTimer = setTimeout(flushLearned, 800);
  }

  function playingMedia() {
    for (const m of trackedMedia) if (m.isConnected && !m.paused && !m.ended) return m;
    return null;
  }

  // LEARNING: only from the user's own interaction. A real (trusted) click on any "Skip ..." button
  // adds it to this site's list and flashes a hint. No page scanning.
  const lastLearnAt = {};
  // The element the press was aimed at: normally the event target's button, but also any Skip button whose
  // box contains the pointer (covers players whose Skip button has pointer-events:none or sits under an overlay).
  function skipButtonForPress(e) {
    const t = e.target;
    const hit = t && t.closest ? t.closest('button, [role="button"], a') : null;
    if (hit && isSkipLabel(skipPrimaryLabel(hit))) return hit;
    if (typeof e.clientX !== "number" || (e.clientX === 0 && e.clientY === 0)) return null;
    let list;
    try { list = document.querySelectorAll('[aria-label^="skip" i]'); } catch (_) { return null; }
    for (const el of list) {
      if (!isSkipLabel(skipPrimaryLabel(el)) || !isSkipAvailable(el)) continue;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return el;
    }
    return null;
  }
  function onUserInteract(e) {
    if (!e.isTrusted || !HOST_KEY) return;
    const el = skipButtonForPress(e);
    if (!el) return;
    const label = skipPrimaryLabel(el);
    if (!label || !isSkipLabel(label)) return;
    const key = skipKey(label);
    const nowMs = Date.now();
    if (lastLearnAt[key] && nowMs - lastLearnAt[key] < 1000) return; // pointerdown + click of one press
    lastLearnAt[key] = nowMs;
    const host = skipRules[HOST_KEY] || {};
    const isNew = !host[key];
    learnSkipButton(key, label, true);
    if (isNew && !skipRules[HOST_KEY][key].enabled) {
      showHudToast("\u23ED \u201C" + label.slice(0, 24) + "\u201D saved \u2014 toggle Auto-click for it in TempoSkip settings", el.closest("video") || playingMedia() || [...trackedMedia][0]);
    }
  }
  window.addEventListener("pagehide", () => { if (learnTimer) { clearTimeout(learnTimer); flushLearned(); } });
  window.addEventListener("pointerdown", onUserInteract, true);
  window.addEventListener("click", onUserInteract, true);
  window.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") onUserInteract(e); }, true);

  // AUTO-CLICK: runs only while this site has an enabled rule and media is playing, and only looks
  // for buttons with a matching aria-label (one native attribute query, not a page walk).
  function hasEnabledRule() {
    const host = skipRules[HOST_KEY];
    if (!host) return false;
    for (const k in host) if (host[k].enabled) return true;
    return false;
  }
  function autoClickTick() {
    if (!HOST_KEY || !hasEnabledRule() || !isSiteEnabled()) return;
    const media = playingMedia();
    if (!media) return;
    const rules = skipRules[HOST_KEY];
    const now = performance.now();
    let cands;
    try { cands = document.querySelectorAll('[aria-label^="skip" i]'); } catch (_) { return; }
    for (const el of cands) {
      const label = skipPrimaryLabel(el);
      if (!label || !isSkipLabel(label)) continue;
      // Bookkeeping first, for ALL skip buttons (enabled or not): a hidden button always starts fresh.
      if (!isSkipAvailable(el)) { skipState.delete(el); continue; }
      const rule = rules[skipKey(label)];
      if (!rule || !rule.enabled) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue; // e.g. "Skip in 5" countdown
      let st = skipState.get(el);
      if (!st || st.label !== label) { st = { label, first: now, n: 0, last: 0 }; skipState.set(el, st); continue; }
      if (st.n && now - st.last > 8000) st.n = 0; // stale attempts expire (the player reuses one element)
      if (now - st.first < AUTOSKIP_MIN_VISIBLE_MS) continue;
      if (now - lastAutoSkipAt < AUTOSKIP_COOLDOWN_MS) continue;
      if (st.n >= AUTOSKIP_MAX_ATTEMPTS || (st.n > 0 && now - st.last < 2500)) continue;
      st.n++; st.last = now;
      lastAutoSkipAt = now;
      dbg("auto-skip click:", JSON.stringify(label), "attempt", st.n);
      try { el.click(); } catch (_) {}
      showHudToast("\u23ED " + label.slice(0, 32), media);
      return;
    }
  }
  setInterval(autoClickTick, 300);

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
