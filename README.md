# Edge PWA Icon

![GNOME Shell 45-50](https://img.shields.io/badge/GNOME%20Shell-45--50-blue)
![Version 0.4](https://img.shields.io/badge/version-0.4-blue)

**English** | [Deutsch](README.de.md)

## Table of Contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Debugging](#debugging)
- [Limitations](#limitations)
- [Credits](#credits)

A GNOME Shell extension that makes Microsoft Edge Progressive Web Apps (installed via Edge's "Install
site as app" — e.g. Outlook, Teams) show up as their own distinct apps, with their own icon, instead of
being grouped under the generic Microsoft Edge icon in the Overview, Alt-Tab, the Dash, and third-party
taskbar-style extensions.

## The problem

Installing a PWA in Edge already generates a correct per-app desktop file with the right name and icon.
Despite that, a running PWA window still shows Edge's generic icon and gets grouped with regular Edge
browser windows everywhere GNOME Shell displays window/app identity. This is most visible when Edge is
installed as a Flatpak: `Shell.WindowTracker` resolves sandboxed app windows via the Flatpak sandbox app
ID (`com.microsoft.Edge`), which is identical for every window the Edge Flatpak opens — PWA or not — so
the correct per-PWA desktop file is never consulted for window-to-app matching, no matter how correct it
is on disk.

## How it works

The extension monkey-patches `Shell.WindowTracker.prototype.get_window_app` (the method most GNOME Shell
UI — window list, Alt-Tab, Overview — uses to resolve a window's app and icon) to correctly identify Edge
PWA windows before falling back to the original implementation for everything else:

1. For each window, resolve the owning process's real executable via `/proc/<pid>/exe` and match its
   basename against known Edge binary names across install methods and channels (Flatpak, native
   package, Stable/Beta/Dev/Canary).
2. Extract the window's own app-id from its `WM_CLASS` (Chromium sets this to `crx__<app-id>`
   individually per window), falling back to `/proc/<pid>/cmdline`'s `--app-id=` flag only if `WM_CLASS`
   is unavailable. Reading it per-window (rather than per-process) matters because Edge can reuse a
   single browser process for multiple PWAs launched under the same profile, in which case the process's
   cmdline only ever reflects whichever PWA launched it first.
3. Map that app-id to an installed desktop entry by enumerating `Gio.AppInfo.get_all()` and matching
   `--app-id=` in each entry's `Exec` line, rather than assuming any particular desktop-file naming
   scheme — this works regardless of how the PWA's desktop file was created (Flatpak portal, native
   package post-install script, or manual install).
4. If a match is found, return the corresponding `Shell.App`; otherwise, fall through to the original
   `get_window_app()` behavior unchanged.

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
- Microsoft Edge, any installation method (Flatpak, native `.deb`/`.rpm`, distro repackaging) and channel
  (Stable/Beta/Dev/Canary), with one or more sites installed as PWAs via Edge's "Install site as app".

## Install

```bash
./install.sh
```

This detects your package manager, symlinks the repo into
`~/.local/share/gnome-shell/extensions/pwa-icons@pat9496`, and enables the extension. GNOME Shell only
loads a brand-new extension UUID at session start, so if this is a fresh install, you'll need to start a
nested session or log out and back in before it takes effect:

```bash
dbus-run-session -- gnome-shell --nested --wayland   # X11 host required
```

Manual equivalent of what the script does:

```bash
ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/pwa-icons@pat9496
gnome-extensions enable pwa-icons@pat9496
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
- If a window's app-id doesn't correspond to any installed desktop entry (e.g. the PWA was installed but
  its launcher wasn't created/synced yet), the window is left untouched rather than assigned a
  fabricated identity.
- The Dash's running-indicator dot may not update correctly for PWAs. The extension includes patches for
  both `Shell.App.get_windows()` (to recognize a PWA as running) and `Shell.App:state` (the property that
  drives the visual indicator), but whether the dot actually updates live depends on your GNOME Shell
  version and internal implementation — neither patch has been confirmed working in a live session yet.
- The Dash-click activation fix (focusing an existing PWA window instead of launching a new one) is
  implemented but not yet confirmed working in a live session.

## Credits

This extension's monkey-patch approach and installation structure were adapted from OverviewPrivacy, a
sibling GNOME Shell extension by the same maintainer.
