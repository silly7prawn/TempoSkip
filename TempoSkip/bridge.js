// TempoSkip MAIN-world bridge (v1.3.0)
// Runs in the PAGE's JS world (not the isolated content-script world) so it can reach the web player's
// own controller object and call its native seek API. Some players (Crunchyroll) run their MSE engine
// behind a message boundary and only re-target their segment loader when seeks go through that API; a raw
// `video.currentTime = x` into an unbuffered range behind the playhead freezes them.
//
// Protocol with content.js (same frame, over document CustomEvents carrying JSON strings):
//   content -> bridge : "temposkip:req"  { id, op: "seek", t }
//   bridge  -> content: "temposkip:res"  { id, ok, reason?, via? }
// Console helper (select the player's iframe context in DevTools):  __temposkipProbe()

(() => {
  if (window.__tempoSkipBridge) return;
  window.__tempoSkipBridge = true;

  const SEEK_NAMES = /^(seekToTimelineTime|seekTo|seek|seekToTime|setCurrentTime)$/i;
  const CLOCK_NAMES = /^(currentTime|timelineTime|currentTimelineTime|playhead|position|currentPosition|playheadTime)$/i;
  const CLOCK_GETTERS = /^(getCurrentTime|getTimelineTime|getCurrentTimelineTime|getPosition|getPlayhead|getPlayheadTime|currentTime)$/i;
  const MAX_NODES = 25000;

  let cached = null; // { owner, seekFn, name, path, clock: { a, b } | null }

  function isDom(o) {
    try { return o instanceof Node || o === window || o === document; } catch (_) { return false; }
  }

  function getFiberKey(el) {
    for (const k in el) {
      if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return k;
    }
    return null;
  }

  // Collect starting objects from the React fiber chain above/around the <video>.
  function collectRoots(video) {
    const roots = [];
    const seenFibers = new Set();
    let el = video;
    for (let i = 0; el && i < 40; i++, el = el.parentElement) {
      const key = getFiberKey(el);
      if (!key) continue;
      let f = el[key];
      for (let hops = 0; f && hops < 400 && !seenFibers.has(f); hops++, f = f.return) {
        seenFibers.add(f);
        if (f.memoizedProps && typeof f.memoizedProps === "object") roots.push({ o: f.memoizedProps, p: "props" });
        if (f.stateNode && !isDom(f.stateNode) && typeof f.stateNode === "object") roots.push({ o: f.stateNode, p: "stateNode" });
        let h = f.memoizedState;
        for (let n = 0; h && typeof h === "object" && n < 60; n++, h = h.next) {
          if (h.memoizedState && typeof h.memoizedState === "object") roots.push({ o: h.memoizedState, p: "hook" });
          if (h.queue && h.queue.lastRenderedState && typeof h.queue.lastRenderedState === "object") {
            roots.push({ o: h.queue.lastRenderedState, p: "hookState" });
          }
        }
      }
    }
    // Also anything the page hung directly on window that looks like a player.
    try {
      for (const k of Object.keys(window)) {
        if (/player|vilos|engine|controller/i.test(k) && window[k] && typeof window[k] === "object") {
          roots.push({ o: window[k], p: "window." + k });
        }
      }
    } catch (_) {}
    return roots;
  }

  function methodNames(o) {
    const names = new Set();
    let cur = o;
    for (let d = 0; cur && cur !== Object.prototype && d < 4; d++, cur = Object.getPrototypeOf(cur)) {
      for (const k of Object.getOwnPropertyNames(cur)) names.add(k);
    }
    return Array.from(names);
  }

  function safeGet(o, k) {
    try { return o[k]; } catch (_) { return undefined; }
  }

  // BFS over objects looking for owners that expose a seek-like function.
  function findOwners(video) {
    const found = [];
    const visited = new WeakSet();
    const queue = collectRoots(video).map((r) => ({ o: r.o, p: r.p, d: 0 }));
    let nodes = 0;
    while (queue.length && nodes < MAX_NODES) {
      const { o, p, d } = queue.shift();
      if (!o || typeof o !== "object" || visited.has(o) || isDom(o)) continue;
      visited.add(o);
      nodes++;
      if (o.$$typeof || o._owner) continue; // React elements / internals

      const names = methodNames(o);
      const seekNames = names.filter((n) => SEEK_NAMES.test(n) && typeof safeGet(o, n) === "function");
      if (seekNames.length) found.push({ owner: o, seekNames, path: p, names });

      if (d >= 4) continue;
      let keys = [];
      try { keys = Object.keys(o); } catch (_) {}
      for (const k of keys.slice(0, 80)) {
        const v = safeGet(o, k);
        if (v && typeof v === "object") queue.push({ o: v, p: p + "." + k, d: d + 1 });
      }
    }
    return { found, nodes };
  }

  // Work out how the player's clock relates to video.currentTime: timeline = a * currentTime + b
  function calibrate(owner, video) {
    const ct = video.currentTime;
    const probes = [];
    const tryVal = (label, v) => {
      if (typeof v === "number" && Number.isFinite(v)) probes.push({ label, v });
    };
    for (const n of methodNames(owner)) {
      const v = safeGet(owner, n);
      if (CLOCK_NAMES.test(n) && typeof v === "number") tryVal(n, v);
      else if (CLOCK_GETTERS.test(n) && typeof v === "function" && v.length === 0) {
        try { tryVal(n + "()", v.call(owner)); } catch (_) {}
      }
    }
    for (const pr of probes) {
      for (const a of [1, 1000]) {
        const b = pr.v - a * ct;
        // Accept only a clean mapping: offset must be tiny compared to the unit (clock moves in real time).
        if (Math.abs(b) <= (a === 1 ? 2 : 2000)) return { a, b, via: pr.label };
      }
    }
    return { a: null, b: null, via: null, probes: probes.map((p) => p.label + "=" + p.v) };
  }

  function discover(video) {
    const { found, nodes } = findOwners(video);
    const report = { nodes, candidates: [] };
    let best = null;
    for (const c of found) {
      const cal = calibrate(c.owner, video);
      const entry = { path: c.path, seekNames: c.seekNames, calibrated: cal.a !== null, via: cal.via, units: cal.a, probes: cal.probes };
      report.candidates.push(entry);
      if (cal.a === null) continue;
      // Prefer seekToTimelineTime, then seekTo, then seek.
      const pref = ["seektotimelinetime", "seekto", "seek", "seektotime", "setcurrenttime"];
      const name = c.seekNames.slice().sort((x, y) => pref.indexOf(x.toLowerCase()) - pref.indexOf(y.toLowerCase()))[0];
      const rank = pref.indexOf(name.toLowerCase());
      if (!best || rank < best.rank) best = { owner: c.owner, name, rank, clock: cal, path: c.path };
    }
    report.chosen = best ? { path: best.path, fn: best.name, units: best.clock.a } : null;
    return { best, report };
  }

  function getVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (!vids.length) return null;
    return vids.find((v) => !v.paused) || vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }

  function ensure(video) {
    if (cached && cached.video === video) return cached;
    const { best, report } = discover(video);
    cached = best ? { ...best, video, report } : { video, owner: null, report };
    return cached;
  }

  function doSeek(t) {
    const video = getVideo();
    if (!video) return { ok: false, reason: "no video" };
    const c = ensure(video);
    if (!c.owner) return { ok: false, reason: "no calibrated seek API found" };
    // Re-calibrate every call: the offset is cheap to measure and guards against drift / ads.
    const cal = calibrate(c.owner, video);
    if (cal.a === null) return { ok: false, reason: "clock lost" };
    const arg = cal.a * t + cal.b;
    try {
      c.owner[c.name](arg);
      return { ok: true, via: c.path + "." + c.name + "(" + arg.toFixed(2) + ")" };
    } catch (e) {
      return { ok: false, reason: "seek threw: " + (e && e.message) };
    }
  }

  document.addEventListener("temposkip:req", (ev) => {
    let req;
    try { req = JSON.parse(ev.detail); } catch (_) { return; }
    if (!req || req.op !== "seek") return;
    const res = doSeek(Number(req.t));
    res.id = req.id;
    document.dispatchEvent(new CustomEvent("temposkip:res", { detail: JSON.stringify(res) }));
  });

  // Manual diagnostics from the DevTools console (choose the player iframe in the context dropdown).
  window.__temposkipProbe = () => {
    const video = getVideo();
    if (!video) return "no <video> in this frame";
    cached = null;
    const c = ensure(video);
    const out = {
      frame: location.href.slice(0, 120),
      fiberKeyOnVideoOrAncestors: (() => { for (let e = video; e; e = e.parentElement) { const k = getFiberKey(e); if (k) return k.slice(0, 20); } return null; })(),
      report: c.report,
      jumpishButtons: Array.from(document.querySelectorAll("button,[role=button]"))
        .filter((b) => /jump|10|seek|rewind|replay|forward|back|skip/i.test((b.getAttribute("aria-label") || "") + (b.getAttribute("title") || "") + (b.getAttribute("data-testid") || "") + (b.className || "")))
        .slice(0, 12)
        .map((b) => b.outerHTML.slice(0, 260))
    };
    const txt = JSON.stringify(out, null, 2);
    try { console.log("[TempoSkip probe]\n" + txt); } catch (_) {}
    try { navigator.clipboard.writeText(txt); } catch (_) {}
    return out;
  };
})();
