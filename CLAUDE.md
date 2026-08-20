# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A GNOME Shell extension (`pwa-separation@pat9496`) that makes installed Progressive Web Apps show up as
their own distinct apps, with their own icon, instead of being grouped under the parent browser's generic
icon in the Overview, Alt-Tab, the Dash, and third-party taskbar-style extensions. Supports all
Chromium-family browsers (Edge, Chrome, Chromium, Brave, Vivaldi, Opera, across Stable/Beta/Dev/Canary/
Nightly channels and both Flatpak and native-package installs) and provides best-effort support for
Firefox PWAs installed via the third-party firefoxpwa addon (PWAsForFirefox).

Plain GJS (ESM) GNOME Shell extension — no build step, no package manager, no test suite.

## Commands

```bash
./install.sh                                          # symlinks repo into ~/.local/share/gnome-shell/extensions/pwa-separation@pat9496 and enables it
gnome-extensions enable pwa-separation@pat9496        # manual enable (after install.sh has symlinked it once)
dbus-run-session -- gnome-shell --nested --wayland    # test in a nested session (X11 host required); otherwise a full logout/login is required
journalctl -f -o cat /usr/bin/gnome-shell             # only logging mechanism — extensions have no other log output
gnome-extensions pack                                 # package for distribution
```

Quick syntax/lint checks without a live Shell session (do not test actual behavior):

```bash
node --check extension.js
gjs -m extension.js   # expected to fail at the resource:// import — that's normal outside a Shell process
python3 -c "import json; json.load(open('metadata.json'))"
```

GNOME Shell only scans its extensions directory and loads a given extension UUID at session start.
After any fresh install or UUID change, a nested session or full logout/login is required before changes
take effect — reloading/disabling the extension is not enough.

## Architecture

Everything lives in `extension.js`. There is no `prefs.js` or `schemas/` — the extension has nothing to
configure.

**The core problem**: GNOME Shell's `Shell.WindowTracker` resolves window→app identity in a way that
never distinguishes a browser-installed PWA window from a regular browser window, even though Chromium-
family browsers already write a correct, distinct `.desktop` file (with `StartupWMClass=crx_<app-id>`)
for every installed PWA, and firefoxpwa writes one with `StartupWMClass=FFPWA-<ULID>`. This is most
visible when a browser is installed as a Flatpak, where window resolution goes through the Flatpak sandbox
app ID (identical for every window the Flatpak opens) instead of consulting `StartupWMClass` at all.

**Fix approach — monkey-patch, not replace**: `enable()` saves the original method/property descriptor
before overriding, and `disable()` restores exactly what was saved. Every override falls through to the
original implementation whenever the window/app isn't a resolved PWA, so non-PWA behavior is untouched.
Five separate call sites need patching because GNOME Shell tracks window↔app associations through
multiple independent paths that don't consult each other:

1. `Shell.WindowTracker.prototype.get_window_app` — the primary choke point most Shell UI (window list,
   Alt-Tab, Overview) uses to resolve a window's app/icon. Patched to return the correct `Shell.App` for
   a resolved PWA window before falling back to the original implementation.
2. `Shell.App.prototype.get_windows` / `get_n_windows` and `Shell.AppSystem.prototype.get_running` — these
   are backed by separate internal C-side tracking built from the *original*, unpatched
   `get_window_app()`, so they don't automatically pick up the fix above. Patched so a PWA pinned to the
   Dash correctly shows as running when one of its windows is open.
3. `Shell.App.prototype.activate` — overridden only for resolved PWA apps, to focus the most-recently-used
   existing window (`Main.activateWindow()`) instead of the original implementation, which relies on the
   same broken internal state as `Shell.App:state` and so never recognizes the PWA as already running.
4. The `Shell.App:state` property getter — feature-detected via `Object.getOwnPropertyDescriptor` before
   patching (skipped with a `console.warn` if a given GNOME Shell version doesn't expose it as a plain
   accessor, rather than risking breaking property access for every `Shell.App`). Reports `RUNNING` for a
   resolved PWA with open windows; `PwaResolver` calls `app.notify('state')` whenever a PWA's window
   count crosses zero so the Dash's running-indicator dot (which listens for `notify::state`) has a
   chance to update live.
5. The `Shell.WindowTracker:focus-app` property getter — same feature-detection pattern as `Shell.App:state`.
   Backed by the same broken internal C-side tracking (built from the original, unpatched
   `get_window_app()`), so without this patch a dock (Dash-to-Dock/Ubuntu Dock, or any other extension that
   highlights the focused app's icon) keeps highlighting the parent browser's icon while a PWA window
   actually has focus. Also forwards every `global.display` `notify::focus-window` as a manual
   `windowTracker.notify('focus-app')`, since the C side only emits its own `notify::focus-app` when its
   (unpatched) idea of the focused app changes — which never happens when focus moves between a PWA
   window and its parent browser, since both resolve to the same app internally.

**`PwaResolver`** is the class that does the actual window→app resolution, called by all five patches
above. It has two parallel detection paths:

**Chromium path** (gated on executable basename):
- `isChromiumExecutable(pid)` — resolves the window's real executable via `/proc/<pid>/exe` (not
  `argv[0]`, which varies by install method) and matches its basename against known Chromium-family
  binary names across browsers (Chrome, Chromium, Edge, Brave, Vivaldi, Opera), channels (Stable/Beta/
  Dev/Canary/Nightly/Unstable/Snapshot), and install methods (Flatpak, native package).
- App-id extraction prefers the window's own `WM_CLASS` (`extractAppIdFromWindow` — Chromium-family
  browsers set this to `crx_<app-id>` individually **per window**), falling back to
  `/proc/<pid>/cmdline`'s `--app-id=` flag (`extractAppIdFromCmdline`) only if `WM_CLASS` is
  unavailable. This ordering matters: Chromium-family browsers can reuse a single browser process for
  multiple PWAs launched under the same `--profile-directory`, in which case the shared process's cmdline
  only ever reflects whichever PWA launched it first.
- A resolved app-id is mapped to an installed desktop entry via the shared `buildIdMap(extractIdFromAppInfo)`
  helper (parameterized by a per-family extractor — `extractChromiumAppIdFromAppInfo` matches `--app-id=`
  in each entry's `Exec` line) and looked up through `PwaResolver._lookupDesktopId('chromium', appId)`,
  rather than assuming any particular desktop-file naming scheme. Both this map and the Firefox one below
  are cached in `this._idMaps` and invalidated together via `Gio.AppInfoMonitor`'s `changed` signal (with
  a cache-miss refresh fallback in case that signal is missed).

**Firefox/firefoxpwa path** (WM_CLASS-only, no executable gate):
- `extractFirefoxPwaSiteId(window)` — checks both `window.get_wm_class_instance()` and
  `window.get_wm_class()` against `FFPWA_WM_CLASS_RE` (strict ULID charset, 26 characters). Returns
  the matched site ID uppercased, or null. No executable-basename gate is used because firefoxpwa's
  runtime binary basename is just `firefox`, shared with regular non-PWA Firefox windows — the strict
  ULID regex alone is treated as sufficient signal.
- The matching desktop entry is found via the same `buildIdMap()` helper, this time parameterized with
  `extractFirefoxPwaSiteIdFromAppInfo` (reads each entry's `StartupWMClass` via
  `appInfo.get_startup_wm_class()` — guarded by a `typeof` check, since this `Gio.DesktopAppInfo` method
  may not exist on every GJS/GLib version; if it's missing, the map is simply empty and Firefox detection
  is silently disabled), looked up via `_lookupDesktopId('firefoxPwa', siteId)`.
- There is no cmdline fallback for the Firefox path — the exact firefoxpwa-launched process cmdline/flag
  format was not confirmed.

**Resolution flow in `_computeAppForWindow()`**: after resolving the window's PID, the Chromium path is
tried first (gated on `isChromiumExecutable(pid)`). If the process is not a Chromium executable, the
Firefox path is tried. Either path's resolved desktop-id is finalized through the shared
`_resolveDesktopId()` helper (records the id in `_pwaDesktopIds` and looks up the `Shell.App`). If neither
path resolves, null is returned and the window is left untouched.

**Shared infrastructure**:
- Results are cached per-window in a `WeakMap`; a `window::unmanaged` signal clears the cache entry and
  triggers `_maybeNotifyStateChange()` so the running-dot fix stays in sync as windows close.
- If a window's identity doesn't correspond to any installed desktop entry, it is left untouched — the
  extension never fabricates an app identity without a real backing desktop file.
- Both desktop-entry maps are invalidated together by the single `Gio.AppInfoMonitor` `changed` signal.

**Portability constraints** (do not violate these when modifying the resolver):
- Never hardcode a specific Flatpak app ID, a `.desktop`-file naming scheme, an icon path, a browser
  binary path, or a profile directory name — these vary by distro, install method, and channel.
- Identity resolution must rely only on things that are stable across all of the above: the `--app-id=`
  command-line flag itself (Chromium), `StartupWMClass` (firefoxpwa), `/proc/<pid>/exe` +
  `/proc/<pid>/cmdline`, and `Gio.AppInfo.get_all()`.

## Files

- `extension.js` — the entire extension: `PwaResolver` (Chromium + Firefox/firefoxpwa dual-path window→app
  resolution) plus the `PwaSeparationExtension` `enable()`/`disable()` monkey-patch lifecycle described
  above.
- `metadata.json` — UUID `pwa-separation@pat9496`, `shell-version` 45--50, no `settings-schema`, no
  `gettext-domain`, no `url`.
- `install.sh` — package-manager-detecting installer: symlinks (never copies) the repo into
  `~/.local/share/gnome-shell/extensions/pwa-separation@pat9496` and enables it; refuses to touch the
  target directory if it's already a symlink elsewhere or contains unrelated data.
- `README.md` / `README.de.md` — English master / German translation, cross-linking each other.

## Known limitations (do not present these as fixed without live verification)

- No preferences UI.
- The Dash running-indicator dot and dock-click-focuses-existing-window behavior depend on the
  `Shell.App:state` property patch actually reaching the Dash's rendered UI, which is not guaranteed
  across GNOME Shell versions — treat as unconfirmed unless verified in an actual nested/live session.
- The `Shell.WindowTracker:focus-app` patch (fixes a dock highlighting the parent browser as focused
  instead of a running PWA) has not been live-tested against a real dock extension (Dash-to-Dock/Ubuntu
  Dock) — treat as unconfirmed unless verified in an actual nested/live session with one installed.
- Chromium-family generalization (Chrome, Chromium, Brave, Vivaldi, Opera) has not been live-tested with
  any browser besides Microsoft Edge; treat as unverified until confirmed in an actual session with each
  specific browser.
- Firefox/firefoxpwa support is WM_CLASS-only with no cmdline fallback; when multiple firefoxpwa PWAs
  share one Firefox profile, the known upstream bug (filips123/PWAsForFirefox#80) can merge all their
  windows into a single WM_CLASS, defeating per-window identification — this extension has no workaround
  for that case.
- The exact `FFPWA-<ULID>` WM_CLASS format firefoxpwa sets has not been independently confirmed in a live
  session (based on desktop-file-naming research, not direct observation); if firefoxpwa changes this
  format, Firefox PWA detection silently stops working (falls through to default, ungrouped-by-this-
  extension behavior — never breaks anything, just stops helping).
