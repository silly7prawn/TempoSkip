# Changelog

All notable changes to **TempoSkip** are documented in this file.

## [1.7.0] – 2026-10-27

### Added
- **Hold-to-speed**: hold Space or the left mouse button on the video for a temporary speed boost, then release to restore the normal speed
  - Configurable hold speed with presets (0.5×, 1.5×, 2×, 3×, 4×)
  - Separate toggles for Space and mouse triggers
  - Adjustable hold delay (120–1500 ms; shorter = easier to trigger)
  - While holding, `[` / `]` adjust the hold speed on the fly
  - A quick tap still plays/pauses; a quick click behaves normally
- New popup card **"Hold for Temporary Speed"** with full settings UI
- Sticky HUD toast that stays visible for the duration of a hold

### Changed
- Manifest description updated to mention the hold-to-speed feature
- Speed enforcement now uses `effectiveSpeed()` (hold speed when active, normal speed otherwise) throughout all rate-enforcement paths
- `page.html` test page re-added to the build

---

## [1.6.6] – 2026-10-20

### Fixed
- Skip-button learning now saves immediately on user press (via `flushLearned()`) instead of debouncing — prevents data loss when clicking "Skip Credits" navigates to the next episode before the timer fires
- Added `pagehide` listener to flush any pending learned skip buttons before page unload

### Changed
- Skip-button detection expanded: if the click target itself isn't a skip button, the code now checks all `[aria-label^="skip"]` elements whose bounding box contains the pointer (handles players with `pointer-events: none` overlays)

---

## [1.6.5] – 2026-10-20

### Fixed
- Toggling or forgetting a skip rule now resets the auto-click state (`skipState` WeakMap) so changes take effect immediately without reloading
- Duplicate learn events from `pointerdown` + `click` on the same press are now deduplicated (1-second window)
- Auto-click state tracking consolidated into a single `skipState` WeakMap per element (label, first-seen time, attempt count) for cleaner bookkeeping

### Added
- `pointerdown` listener added alongside `click` for faster skip-button learning
- Diagnostics export now includes `skipRules` alongside `learnedProfiles`

---

## [1.6.4] – 2026-10-20

### Changed
- Speed hotkey step input restyled: now a standalone row with a `<label>` and inline `×` unit badge instead of a check-row layout
- Improved CSS for the step-row (flex layout with gap, hint color)

---

## [1.6.3] – 2026-10-19

### Added
- **Speed hotkey step** is now configurable in the popup: a new number input lets you set the speed change per `[` / `]` press (0.01×–4×, default 0.25×)

### Changed
- Minimum speed step lowered from 0.05× to 0.01× for finer-grained control

---

## [1.6.2] – 2026-10-19

### Fixed
- Auto-click: when a skip button hides again (e.g. the skippable window passes), its attempt counter is now fully reset — the next appearance starts fresh
- Stale auto-click attempts expire after 8 seconds (handles players that reuse one button element across segments)

---

## [1.6.1] – 2026-10-18

### Changed
- **Skip-button learning redesigned**: buttons are no longer auto-scanned from the page; instead, the user clicks a "Skip …" button once and it is recorded per site
  - A HUD toast confirms the save and prompts the user to toggle auto-click in settings
  - User click events (`click`, `Enter`, `Space`) on any `button`, `[role="button"]`, or `<a>` with a "Skip …" label trigger learning
- **Auto-click engine rewritten**: instead of walking every button on the page, it queries only `[aria-label^="skip" i]` — much faster and less intrusive
- Skip availability now uses `effectiveOpacity()` (walks the ancestor chain) instead of raw `checkVisibility`, correctly handling Crunchyroll's always-in-DOM skip buttons (opacity 0 → hidden, opacity 1 → available)
- Added separate `isRendered()` (layout-visible) vs `isSkipAvailable()` (rendered + opacity > 0.5) helpers
- Popup hint text updated: "Click any 'Skip …' button yourself once and it is added here."

---

## [1.6.0] – 2026-10-18

### Changed
- **Auto-skip completely reworked** with a per-button learning system:
  - Every "Skip …" button that appears over a playing video is now discovered and recorded individually per site (`storage.local` → `skipRules`)
  - Each learned button gets its own toggle in the popup (off by default) — replaces the old blanket Intro/Credits checkboxes
  - Popup shows each button's label, how many times it has been seen, and a delete (×) button
  - Countdown digits in labels are folded (e.g. "Skip in 5" and "Skip in 3" share one rule)
  - Old `autoSkipSites` settings are automatically migrated to matching learned buttons
- Auto-click now retries once if the button is still visible after the first click (`AUTOSKIP_MAX_ATTEMPTS = 2`)
- Skip rules live-update in the popup while it's open (new buttons appear as the video plays)

### Removed
- Old "Intro / opening / recap" and "Credits / ending" blanket toggles replaced by per-button toggles

---

## [1.5.0] – 2026-10-17

### Added
- **Auto-skip intro & credits** (opt-in per site):
  - Clicks the player's own "Skip Intro/Opening/Recap" or "Skip Credits/Ending/Outro" button automatically while the video is playing
  - Strictly label-matched: only buttons starting with "Skip" + a recognized keyword; never clicks ad-skip, trial, or "next episode" buttons
  - The button must sit visually over the video and stay visible for ≥ 500 ms (ignores transient flashes)
  - Cooldown of 2.5 s between auto-clicks
  - New popup card with per-site hostname display, separate Intro and Credits toggles
- New default setting `autoSkipSites: {}` stored in `chrome.storage.sync`

---

## [1.4.5] – 2026-10-14

### Changed
- Learned-sites popup polish: the mode selector (`<select>`) now only appears for sites where a player API was actually found
- Tags simplified to "player API" / "no API found" with clearer tooltips explaining what each means
- Layout: conditional `row.append(name, tag, sel, del)` vs `row.append(name, tag, del)` based on API availability

---

## [1.4.4] – 2026-10-14

### Changed
- Simplified per-site seek mode: removed the "API first" option; sites now use "Auto" (learned sites with `needsApi` use the API first) or "Plain only" (never use the player API)
- Legacy `"api"` mode values treated as `"auto"`
- The bridge is no longer called for `knownNone` sites even in auto mode (previously it was skipped only when mode wasn't "api")

---

## [1.4.2] – 2026-10-14

### Changed
- **Seek strategy reworked to "auto-learn"**: plain `video.currentTime` seeks are tried first on every site; the player's API is only used if a real hang is detected (stalled + buffer stopped growing)
  - The site profile now stores `needsApi` per direction (backward/forward) and remembers which approach worked
  - Per-site mode selector in the popup: Auto / API first / Plain only
- `updateSiteProfile()` now uses functional `patch` argument (read-modify-write) to prevent race conditions
- Legacy fallback chain (native jump-back button → raw seek) still used when the API is unavailable
- After 3 consecutive API failures on a site, it's marked `bridge: "none"` and skipped for the negative TTL period

---

## [1.4.0] – 2026-10-14

### Added
- **Learned per-site seek profiles** (`chrome.storage.local` → `siteProfiles`):
  - After the first successful MAIN-world bridge seek on a site, the controller path and seek function are saved
  - On subsequent visits, the bridge uses the saved hint to find the controller instantly without a full search
  - Negative caching: if no usable API is found, the bridge search is skipped for 6 hours
  - Profiles survive across sessions and sync across tabs via `storage.onChanged`
- **Popup "Learned sites" card**: lists every site with its seek profile status, a per-site "Forget" button, and a "Forget all" link
- Bridge `doSeek()` now accepts a `hint` parameter and returns a `profile` object for storage
- Bridge `ensure()` with `tryHint()`: resolves a previously learned path without a full fiber/property walk
- Stale controller auto-recovery: if a cached controller's calibration fails (e.g. the player remounted for a new episode), a full rediscovery is triggered once
- Diagnostics export now includes `learnedProfiles`

---

## [1.3.3] – 2026-10-14

### Changed
- Bridge time-domain converter detection generalized: instead of hard-coding `streamTimeToTimelineTime`, the bridge now finds all `*TimeToTimelineTime()` methods and picks the one whose input domain is most likely `video.currentTime`'s domain (ranked: stream > media > video > element > presentation > player > current)
- Round-trip validation: if an inverse `timelineTimeTo*Time()` exists, the converter must produce a clean round trip (error < 0.05 s) to be accepted
- Seek function ranking now also gives priority to `*ToTimelineTime`-style seek methods
- `SEEK_NAMES` regex broadened to match `seek*ToTimelineTime` variants

---

## [1.3.2] – 2026-10-14

### Added
- Content script: re-introduced `hopViaAnchor()` — seeks to a known-buffered anchor first (revives stalled players), then seeks to the real target once that settles

### Changed
- Bridge: added support for Crunchyroll "katamari" players that keep media/stream time and timeline time separate — finds `streamTimeToTimelineTime()` converters on the orchestrator or one level below
- Bridge calibration now returns `mode: "convert"` when using a converter, with the sample value and `"clock"` when using the linear clock model
- Seek via the bridge now calls the converter function at seek time (not the linear approximation) for `"convert"` mode
- Bridge diagnostic report includes `mode`, `sample`, and near-miss methods in the probe output

---

## [1.3.1] – 2026-10-14

### Added
- **"Copy diagnostics" button** in the popup: runs the bridge's `__temposkipProbe()` in every frame of the active tab and copies the JSON result to the clipboard (includes video metadata, player API probe, near-miss methods, React detection)
- Bridge probe report now includes near-miss methods (objects with seek/timeline/playhead-related function names) for debugging sites where the controller isn't found
- Bridge probe report now includes video metadata (src, duration, currentTime, rate, buffered ranges) and React detection

---

## [1.3.0] – 2026-10-14

### Added
- **MAIN-world bridge** (`bridge.js`): a new script injected into the page's JavaScript world that can reach web players' own controller objects and call their native seek APIs
  - Protocol: content script ↔ bridge communicate via `CustomEvent` messages (`temposkip:req` / `temposkip:res`)
  - Discovers seek functions by walking React fiber chains above the `<video>` element and scanning for `seekTo`, `seek`, `seekToTime`, `setCurrentTime`, etc.
  - Calibrates the seek function's time units against `video.currentTime` using a two-point linear probe
  - Console helper: `__temposkipProbe()` to inspect what the bridge found
- Content script now uses the bridge for backward unbuffered seeks: bridge first → native button fallback → raw seek
- Manifest updated: `bridge.js` added as a MAIN-world content script with `match_about_blank: true`
- `page.html` test file added

### Changed
- Unbuffered backward seek chain reorganized: bridge API → native jump-back button → raw seek (with watchdog)
- Smart MSE seek label updated in popup: "Smart seeking on streaming sites (batch rapid skips, recover stalls)"

---

## [1.2.3] – 2026-10-14

### Added
- **Native button-assisted backward seeks**: for players like Crunchyroll where raw `video.currentTime` into an unbuffered range behind the playhead freezes the player, the extension now clicks the player's own "jump back" button repeatedly until the target is at or before the desired time, then finishes with a single raw forward seek
  - Searches for buttons matching patterns like `rewind`, `replay`, `backward`, `jump`, `10sec` while excluding `intro`, `credit`, `next`, `volume`, etc.
  - Supports buttons in shadow roots (e.g. the video's root node)
  - Falls back to raw seek if no suitable button is found
- `nativeToken` cancellation: starting a new seek cycle invalidates any in-progress native-assisted seek

---

## [1.2.2] – 2026-10-14

### Added
- **Opt-in diagnostics**: run `localStorage.temposkipDebug = "1"` in the player frame's console to enable verbose logging (`[TempoSkip]` prefix) of seek state, buffer ranges, stall detection, and recovery steps
- `bufStr()` helper for human-readable buffered-range logging

### Changed
- Stall recovery reworked: "healthy" now requires the playback clock to actually advance (not just `readyState ≥ 3`), preventing false "recovered" signals on frozen players
- `hopViaAnchor()` recovery path: seeks to the known-buffered origin first (revives the player), then seeks to the real target — replaces the old multi-stage nudge approach for backward seeks
- Stall watchdog nudge stages refined: stage 1 re-issues at a slightly different time; stage 2 hops via the buffered anchor; stage 3 hops to a nearby time; last resort plays if paused
- Recovery timers changed from `[900, 1900, 3200]` with 5000 ms final to progress-based checking

### Removed
- `page.html` test file removed from build

---

## [1.2.1] – 2026-10-14

### Changed
- **Stall recovery rewritten** to avoid pause/play manipulation:
  - The extension no longer calls `media.pause()` or `media.play()` during out-of-buffer seeks — a native seek keeps the `paused` state untouched and the browser resumes by itself once data arrives
  - New recovery strategy uses timestamp "nudges" to different positions to restart the player's segment loader (mimics what built-in ±10 s buttons do)
  - Stage 1: re-seeks at `target ± 0.2` so the player treats it as a new seek
  - Stage 2: hops back to the known-buffered `originTime`, waits for `seeked`, then seeks forward to the target
  - Stage 3: seeks to `target - 0.3` as a last attempt
  - Final fallback: if still paused after all nudges, calls `play()` once after 150 ms
- Seek state now tracks `originTime` (the `currentTime` when the seek cycle began) as a known-buffered anchor for recovery hops
- Recovery timers changed to `[900, 1900, 3200]` with a 5000 ms hard deadline
- Removed: explicit `media.pause()` during rapid unbuffered scrubbing (was fighting the MSE decoder)

---

## [1.2.0] – 2026-10-14

### Changed
- **Precision MSE seek engine**: complete rewrite of the seeking system
  - Serialized in-flight seeks: if the browser is already seeking (`media.seeking === true`), the new target is queued and fired the instant the current `seeked` event completes — prevents corrupting Crunchyroll's MSE SourceBuffer by overwriting `currentTime` mid-append
  - Rapid-click coalescing: multiple arrow-key presses within 260 ms are accumulated into a single seek with a 220 ms debounce
  - Virtual target tracking: an exact accumulated target timestamp is maintained across rapid clicks (no buffer snapping)
  - In-flight seek timeout (900 ms): if `seeked` is delayed, the queued seek fires anyway
  - HUD accumulation: during a rapid burst, the HUD shows the total accumulated delta (e.g. "⏩ +15s") instead of individual steps
  - Out-of-buffer stall recovery with pause-seek-play wake cycles and multi-stage watchdog (450 ms, 1100 ms, 2000 ms, 2900 ms final)

### Removed
- `clampRewindToBuffer` setting and toggle (replaced by the precision engine that never snaps to buffer boundaries)

---

## [1.1.0] – 2026-10-14

### Added
- **Smart MSE/DRM out-of-buffer seek protection**: prevents freezing on Crunchyroll, Shaka Player, Bitmovin, HLS.js, and DASH.js when seeking outside the currently buffered range
  - Buffer inspection: `isTimeBuffered()` and `getCurrentBufferedFloor()` helpers check whether a target timestamp is inside any loaded `TimeRange`
  - Safe seek bounds: `getSafeSeekBounds()` respects `media.seekable` and avoids the MSE PTS hole at 0.000 s (where the first video keyframe starts at ~0.04 s)
  - Debounced seek coalescing (150 ms) to batch rapid arrow-key presses into a single seek
  - Per-media seek state tracked via `WeakMap` with pending target, accumulated delta, recovery timers, and rate-enforcement suspension
  - Keyframe gap bridging: `findKeyframeGapTarget()` detects when MSE appended a new segment slightly after `currentTime` and bridges the gap
  - Rate enforcement suspended during unbuffered seeks to prevent deadlocking DRM/MSE decoders
- New popup toggles:
  - "Smart out-of-buffer seek protection (fixes Crunchyroll freezes)" — on by default
  - "Clamp rewinds to currently buffered chunk only" — off by default
- New default settings: `safeMseSeek: true`, `clampRewindToBuffer: false`

---

## [1.0.0] – 2026-10-14

### Added
- Initial release of TempoSkip
- Custom playback speeds from 0.07× to 16× with speed presets
- Lock speed across page navigations (`forceSpeed`)
- Override Left/Right arrow keys with custom skip durations (default ±5 s)
- Shift + Arrow for longer skips (default ±15 s)
- Speed hotkeys: `[` / `]` to decrease/increase speed by a configurable step
- On-screen HUD toast showing speed changes and seek actions
- Per-site enable/disable toggle
- Works across all frames (iframes, shadow DOM, SPAs)
- Automatic detection of dynamically injected media elements via MutationObserver
- Shadow DOM traversal and `attachShadow` hooking for web components
- Smart media element selection: prefers playing video in viewport → recently interacted → largest visible → first audio
- Manifest V3 Chrome extension with service worker
