# PWA Separation

![GNOME Shell 45-50](https://img.shields.io/badge/GNOME%20Shell-45--50-blue)
![Version 1.0](https://img.shields.io/badge/version-1.0-blue)

**English** | [Deutsch](README.de.md)

## Table of Contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Debugging](#debugging)
- [Limitations](#limitations)
- [Credits](#credits)
- [Changelog](CHANGELOG.md)

A GNOME Shell extension that makes Progressive Web Apps (PWAs) show up as their own distinct apps, with
their own icon, instead of being grouped under the parent browser's generic icon in the Overview, Alt-Tab,
the Dash, and third-party taskbar-style extensions. Supports PWAs installed from any Chromium-family
browser (Chrome, Chromium, Edge, Brave, Vivaldi, Opera) and provides best-effort support for Firefox PWAs
installed via the third-party firefoxpwa addon.

## The problem

Installing a PWA in a Chromium-family browser already generates a correct per-app desktop file with the
right name and icon. Despite that, a running PWA window still shows the browser's generic icon and gets
grouped with regular browser windows everywhere GNOME Shell displays window/app identity. This is most
visible when a browser is installed as a Flatpak: `Shell.WindowTracker` resolves sandboxed app windows via
the Flatpak sandbox app ID (identical for every window the Flatpak opens), which is the same for PWA
windows and regular browser windows. As a result, the correct per-PWA desktop file is never consulted for
window-to-app matching, no matter how correct it is on disk.

## How it works

The extension monkey-patches `Shell.WindowTracker.prototype.get_window_app` (the method most GNOME Shell
UI — window list, Alt-Tab, Overview — uses to resolve a window's app and icon) to correctly identify PWA
windows before falling back to the original implementation for everything else.

It uses two parallel detection paths:

**For Chromium-family browsers** (Chrome, Chromium, Edge, Brave, Vivaldi, Opera):

1. Resolve the owning process's real executable via `/proc/<pid>/exe` and match its basename against known
   Chromium-family binary names across all install methods and channels (Flatpak, native package,
   Stable/Beta/Dev/Canary/Nightly).
2. Extract the window's own app-id from its `WM_CLASS` (Chromium sets this to `crx_<app-id>` individually
   per window), falling back to `/proc/<pid>/cmdline`'s `--app-id=` flag only if `WM_CLASS` is
   unavailable. Reading it per-window (rather than per-process) matters because Chromium-family browsers
   can reuse a single browser process for multiple PWAs launched under the same profile, in which case the
   process's cmdline only ever reflects whichever PWA launched it first.
3. Map that app-id to an installed desktop entry by enumerating `Gio.AppInfo.get_all()` and matching
   `--app-id=` in each entry's `Exec` line, rather than assuming any particular desktop-file naming
   scheme.
4. If a match is found, return the corresponding `Shell.App`; otherwise, continue to the Firefox path or
   fall through to the original `get_window_app()` behavior.

**For Firefox PWAs** (installed via firefoxpwa addon):

1. Check the window's `WM_CLASS` against the strict ULID format that firefoxpwa uses (`FFPWA-<ULID>`).
2. If a match is found, map it to an installed desktop entry by enumerating `Gio.AppInfo.get_all()` and
   matching `StartupWMClass` in the entry metadata.
3. If a match is found, return the corresponding `Shell.App`; otherwise, fall through to the original
   behavior.

Since `Shell.App.get_windows()`/`get_n_windows()` and `Shell.AppSystem.get_running()` are backed by
separate, internal C-side tracking that doesn't re-consult the JS-overridden `get_window_app()`, the
extension also monkey-patches those three methods so that a PWA pinned to the Dash correctly shows as
"running" when one of its windows is open.

The extension also includes two additional fixes that are implemented but not yet confirmed working in a
live GNOME Shell session: clicking a Dash-pinned PWA icon now attempts to focus its existing window
instead of behaving as if the app is not running (via a `Shell.App.prototype.activate` override), and the
Dash's running-indicator dot should reflect a running PWA (via a feature-detected override of the
`Shell.App:state` property that gracefully falls back if your GNOME Shell version does not expose it as a
patchable accessor).

## Requirements

- GNOME Shell 45–50.
- One or more Chromium-family browsers (Chrome, Chromium, Edge, Brave, Vivaldi, Opera) with PWAs
  installed, any installation method (Flatpak, native package) and channel (Stable/Beta/Dev/Canary/
  Nightly).
- Optionally, Firefox with the firefoxpwa addon for best-effort Firefox PWA support.

## Install

```bash
./install.sh
```

This detects your package manager, symlinks the repo into
`~/.local/share/gnome-shell/extensions/pwa-separation@pat9496`, and enables the extension. GNOME Shell only
loads a brand-new extension UUID at session start, so if this is a fresh install, you'll need to start a
nested session or log out and back in before it takes effect:

```bash
dbus-run-session -- gnome-shell --nested --wayland   # X11 host required
```

Manual equivalent of what the script does:

```bash
ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/pwa-separation@pat9496
gnome-extensions enable pwa-separation@pat9496
```

## Debugging

Extensions have no logging mechanism other than the system journal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Quick syntax/lint check without a Shell session (does not test actual behavior):

```bash
node --check extension.js
python3 -c "import json; json.load(open('metadata.json'))"
```

## Limitations

- No preferences UI — nothing to configure yet.
- If a window's identity doesn't correspond to any installed desktop entry (e.g. the PWA was installed
  but its launcher wasn't created/synced yet), the window is left untouched rather than assigned a
  fabricated identity.
- The Dash's running-indicator dot and Dash-click activation (focusing an existing PWA window instead of
  launching a new one) are implemented but not yet confirmed working in a live GNOME Shell session.
- Chromium-family browser generalization (Chrome, Chromium, Brave, Vivaldi, Opera): development and
  live testing has focused on Microsoft Edge, driven by the maintainer's primary use case of Teams and
  Outlook installed as PWAs. The extension's detection logic is designed generically to work with any
  installed PWA across all Chromium-family browsers, but remains unverified for browsers other than Edge.
- Firefox/firefoxpwa support is WM_CLASS-only with no cmdline fallback. When multiple firefoxpwa PWAs
  share one Firefox profile, a known upstream bug (filips123/PWAsForFirefox#80) can merge all their
  windows into a single WM_CLASS, defeating per-window identification — this extension has no workaround
  for that case.
- The exact `FFPWA-<ULID>` WM_CLASS format that firefoxpwa sets has not been independently confirmed in
  a live session. If firefoxpwa changes this format, Firefox PWA detection silently stops working and
  falls through to default, ungrouped-by-this-extension behavior.

## Credits

This extension's monkey-patch approach and installation structure were adapted from OverviewPrivacy, a
sibling GNOME Shell extension by the same maintainer.
