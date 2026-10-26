# TempoSkip

**Custom Video Speed & Arrow Key Skip Controller** — a Chrome extension that overrides any web video or audio player with custom playback speeds (0.07×–16×), hold-to-speed (hold Space or mouse for a temporary boost), and precision Left/Right arrow key skip durations.

## Features

- 🎚️ **Custom Playback Speed** — 0.07× to 16× with one-click presets and speed lock across navigations
- ⏩ **Precision Arrow Key Skipping** — override Left/Right arrow with custom skip durations (default ±5s), Shift for longer skips
- 🖱️ **Hold-to-Speed** — hold Space or the left mouse button for a temporary speed boost; release to restore normal speed
- ⏭️ **Auto-Skip Buttons** — learns "Skip Intro / Credits" buttons per site and clicks them automatically (opt-in)
- 🔧 **Smart MSE Seeking** — serialized precision seeks that prevent freezing on Crunchyroll, HLS/DASH, and DRM players
- 🌐 **Works Everywhere** — all frames, iframes, shadow DOM, SPAs (YouTube, Netflix, Crunchyroll, Twitch, etc.)
- ⌨️ **Speed Hotkeys** — `[` / `]` to decrease/increase speed by a configurable step

## Installation

1. Download or clone this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `TempoSkip` folder

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` / `→` | Skip backward/forward (custom duration) |
| `Shift` + `←` / `→` | Longer skip (custom duration) |
| `[` / `]` | Decrease/increase playback speed |
| Hold `Space` | Temporary speed boost (tap = play/pause) |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## License

MIT
