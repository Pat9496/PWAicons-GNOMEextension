# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0] - 2026-08-20

### Added

- Progressive Web App (PWA) detection and window-to-app identity resolution in GNOME Shell (Overview, Alt-Tab, Dash, and third-party taskbar extensions).
- Support for PWAs installed from Chromium-family browsers (Chrome, Chromium, Edge, Brave, Vivaldi, Opera) across all installation methods (Flatpak, native package) and release channels (Stable, Beta, Dev, Canary, Nightly).
- Best-effort support for Firefox PWAs installed via the firefoxpwa addon.
- Per-window app-id extraction from `WM_CLASS` and `/proc/<pid>/cmdline` for Chromium-family browsers.
- Desktop entry mapping for PWAs via enumeration of installed applications.
- Running-indicator display on Dash-pinned PWA icons.
- PWA window activation (clicking a Dash-pinned PWA icon focuses the most-recently-used existing window).
- Focus-app tracking for dock extensions (correct window manager highlighting of focused PWA windows).
- Graceful fallback to original behavior for non-PWA windows and applications.
- Support for GNOME Shell versions 45–50.

### Known Limitations

See [README.md](README.md#limitations) for a detailed list of known limitations and caveats.
