import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CHROMIUM_BINARY_RE = /^(google-chrome|chrome|chromium|chromium-browser|brave|brave-browser|vivaldi|vivaldi-stable|opera|microsoft-edge|msedge)(-(beta|dev|canary|nightly|unstable|snapshot))?$/i;
const APP_ID_RE = /--app-id=([A-Za-z0-9]+)/;
const CRX_WM_CLASS_RE = /^crx_+([A-Za-z0-9]+)$/i;
const FFPWA_WM_CLASS_RE = /^FFPWA-([0-9A-HJKMNP-TV-Z]{26})$/i;

function isChromiumExecutable(pid) {
    let exePath;
    try {
        exePath = GLib.file_read_link(`/proc/${pid}/exe`);
    } catch (e) {
        return false;
    }
    if (!exePath)
        return false;

    const basename = GLib.path_get_basename(exePath);
    return CHROMIUM_BINARY_RE.test(basename);
}

function extractAppIdFromCmdline(pid) {
    let contents;
    try {
        [, contents] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
    } catch (e) {
        return null;
    }
    if (!contents)
        return null;

    let cmdline;
    try {
        cmdline = new TextDecoder().decode(contents);
    } catch (e) {
        return null;
    }

    // /proc/<pid>/cmdline is normally NUL-separated argv, but some sandboxed
    // Chromium processes (observed with Flatpak's zypak-helper) rewrite
    // their own cmdline into a single space-joined string for a friendlier
    // process title, collapsing the NUL separators. Matching the flag pattern
    // against the raw decoded string (NUL bytes included) works for both forms.
    const match = APP_ID_RE.exec(cmdline);
    return match ? match[1] : null;
}

function extractAppIdFromWindow(window) {
    // WM_CLASS is an instance/class pair. Chromium-family browsers set the
    // per-app "crx_<app-id>" value on the *instance* part
    // (get_wm_class_instance()) and leave the *class* part (get_wm_class())
    // as a generic string shared by every window -- reading get_wm_class()
    // here never matches any window, PWA or not.
    let wmClassInstance;
    try {
        wmClassInstance = window.get_wm_class_instance();
    } catch (e) {
        return null;
    }
    if (!wmClassInstance)
        return null;

    // This is what desktop files record as StartupWMClass, set individually
    // per window at window-creation time. This stays correct even when
    // several PWAs installed under the same --profile-directory get merged by
    // the browser into a single shared process ("Opening in existing browser
    // session") whose /proc/<pid>/cmdline only ever reflects whichever PWA
    // first launched that process -- confirmed live with Edge: opening a
    // second PWA under the same profile does not spawn a new --app-id=...
    // process, so cmdline-based extraction alone misidentifies every PWA
    // window in that process as the first one launched.
    const match = CRX_WM_CLASS_RE.exec(wmClassInstance);
    return match ? match[1] : null;
}

function extractFirefoxPwaSiteId(window) {
    let wmClassInstance;
    try {
        wmClassInstance = window.get_wm_class_instance();
    } catch (e) {
        wmClassInstance = null;
    }
    if (wmClassInstance) {
        const match = FFPWA_WM_CLASS_RE.exec(wmClassInstance);
        if (match)
            return match[1].toUpperCase();
    }

    let wmClass;
    try {
        wmClass = window.get_wm_class();
    } catch (e) {
        wmClass = null;
    }
    if (wmClass) {
        const match = FFPWA_WM_CLASS_RE.exec(wmClass);
        if (match)
            return match[1].toUpperCase();
    }

    return null;
}

function buildAppIdMap() {
    const map = new Map();
    for (const appInfo of Gio.AppInfo.get_all()) {
        const commandline = appInfo.get_commandline();
        if (!commandline)
            continue;

        const match = APP_ID_RE.exec(commandline);
        if (match)
            map.set(match[1], appInfo.get_id());
    }
    return map;
}

function buildFirefoxPwaMap() {
    const map = new Map();
    for (const appInfo of Gio.AppInfo.get_all()) {
        const getStartupWmClass = appInfo.get_startup_wm_class?.bind(appInfo);
        if (!getStartupWmClass)
            return map;

        const startupWmClass = getStartupWmClass();
        if (!startupWmClass)
            continue;

        const match = FFPWA_WM_CLASS_RE.exec(startupWmClass);
        if (match)
            map.set(match[1].toUpperCase(), appInfo.get_id());
    }
    return map;
}

class PwaResolver {
    constructor() {
        this._chromiumAppIdMap = null;
        this._firefoxPwaSiteIdMap = null;
        this._appCache = new WeakMap();
        this._windowSignalIds = new Map();
        this._pwaDesktopIds = new Set();
        this._pwaAppWindowCounts = new Map();

        this._appInfoMonitor = Gio.AppInfoMonitor.get();
        this._appInfoChangedId = this._appInfoMonitor.connect('changed', () => {
            this._chromiumAppIdMap = null;
            this._firefoxPwaSiteIdMap = null;
        });
    }

    _ensureChromiumAppIdMap() {
        if (!this._chromiumAppIdMap)
            this._chromiumAppIdMap = buildAppIdMap();
        return this._chromiumAppIdMap;
    }

    _lookupChromiumDesktopId(appId) {
        const map = this._ensureChromiumAppIdMap();
        let desktopId = map.get(appId);
        if (!desktopId) {
            this._chromiumAppIdMap = buildAppIdMap();
            desktopId = this._chromiumAppIdMap.get(appId);
        }
        return desktopId ?? null;
    }

    _ensureFirefoxPwaMap() {
        if (!this._firefoxPwaSiteIdMap)
            this._firefoxPwaSiteIdMap = buildFirefoxPwaMap();
        return this._firefoxPwaSiteIdMap;
    }

    _lookupFirefoxPwaDesktopId(siteId) {
        const map = this._ensureFirefoxPwaMap();
        let desktopId = map.get(siteId);
        if (!desktopId) {
            this._firefoxPwaSiteIdMap = buildFirefoxPwaMap();
            desktopId = this._firefoxPwaSiteIdMap.get(siteId);
        }
        return desktopId ?? null;
    }

    _computeAppForWindow(window) {
        let pid;
        try {
            pid = window.get_pid();
        } catch (e) {
            return null;
        }
        if (!pid || pid <= 0)
            return null;

        if (isChromiumExecutable(pid)) {
            // Prefer the window's own WM_CLASS instance (per-window ground
            // truth). Only fall back to the process cmdline's --app-id= when
            // this process currently owns exactly one window: Chromium-family
            // browsers can reuse a single shared process for multiple PWAs
            // (and regular tabs) opened under the same --profile-directory,
            // in which case cmdline only ever reflects whichever PWA launched
            // the process first -- trusting it for a shared process's *other*
            // windows would misattribute them to that first PWA instead of
            // leaving them unresolved.
            let appId = extractAppIdFromWindow(window);
            let source = 'wm_class';
            if (!appId) {
                const otherCount = this._countOtherWindowsForPid(pid, window);
                if (otherCount > 0) {
                    console.debug(
                        `[pwa-separation] pid=${pid} wm_class_instance=${window.get_wm_class_instance()} ` +
                        `title="${window.get_title()}" -> no app-id from WM_CLASS, ${otherCount} ` +
                        'other window(s) share this pid, refusing cmdline fallback');
                    return null;
                }
                appId = extractAppIdFromCmdline(pid);
                source = 'cmdline';
            }
            if (!appId) {
                console.debug(
                    `[pwa-separation] pid=${pid} wm_class_instance=${window.get_wm_class_instance()} ` +
                    `title="${window.get_title()}" -> no app-id resolved`);
                return null;
            }

            const desktopId = this._lookupChromiumDesktopId(appId);
            console.debug(
                `[pwa-separation] pid=${pid} wm_class_instance=${window.get_wm_class_instance()} ` +
                `title="${window.get_title()}" appId=${appId} (via ${source}) -> ` +
                `desktopId=${desktopId ?? 'none'}`);
            if (!desktopId)
                return null;

            this._pwaDesktopIds.add(desktopId);
            return Shell.AppSystem.get_default().lookup_app(desktopId) ?? null;
        }

        const siteId = extractFirefoxPwaSiteId(window);
        if (siteId) {
            const desktopId = this._lookupFirefoxPwaDesktopId(siteId);
            console.debug(
                `[pwa-separation] pid=${pid} wm_class=${window.get_wm_class()} ` +
                `siteId=${siteId} -> desktopId=${desktopId ?? 'none'}`);
            if (!desktopId)
                return null;

            this._pwaDesktopIds.add(desktopId);
            return Shell.AppSystem.get_default().lookup_app(desktopId) ?? null;
        }

        return null;
    }

    _countOtherWindowsForPid(pid, excludeWindow) {
        let count = 0;
        for (const other of global.display.list_all_windows()) {
            if (other === excludeWindow)
                continue;
            let otherPid;
            try {
                otherPid = other.get_pid();
            } catch (e) {
                continue;
            }
            if (otherPid === pid)
                count++;
        }
        return count;
    }

    _trackWindow(window) {
        if (this._windowSignalIds.has(window))
            return;

        const id = window.connect('unmanaged', () => {
            const app = this._appCache.get(window);
            this._appCache.delete(window);
            this._windowSignalIds.delete(window);
            this._maybeNotifyStateChange(app);
        });
        this._windowSignalIds.set(window, id);
    }

    resolveApp(window) {
        if (!window)
            return null;
        // Cache positive resolutions permanently, but keep retrying after a
        // null result: an early call (e.g. right at window creation, before
        // WM_CLASS/PID info has settled, or while a sibling window still
        // makes this process's identity ambiguous -- see
        // _countOtherWindowsForPid) can resolve to null prematurely, and
        // never revisiting it would lock that window out of PWA detection
        // for its entire lifetime.
        if (this._appCache.has(window)) {
            const cached = this._appCache.get(window);
            if (cached)
                return cached;
        }

        const app = this._computeAppForWindow(window);
        if (app)
            this._appCache.set(window, app);
        this._trackWindow(window);
        if (app)
            this._maybeNotifyStateChange(app);
        return app;
    }

    // Shell.App:state is a GObject property computed from Shell.WindowTracker's
    // internal C-side window<->app bookkeeping, which (like get_windows(), above)
    // never re-consults the JS-overridden get_window_app(). Reading app.state
    // for a PWA app therefore always reports STOPPED even while its windows are
    // open, unless something else notifies listeners (e.g. the Dash running-dot)
    // that it may have changed. Call this after any window gets added to, or
    // removed from, a PWA app's resolved window set.
    _maybeNotifyStateChange(app) {
        if (!app)
            return;

        const id = app.get_id();
        if (!this._pwaDesktopIds.has(id))
            return;

        const count = app.get_windows().length;
        const previousCount = this._pwaAppWindowCounts.get(id) ?? 0;
        this._pwaAppWindowCounts.set(id, count);

        if ((previousCount === 0) !== (count === 0)) {
            try {
                app.notify('state');
            } catch (e) {
                // Best-effort: if notify() ever throws, the dot just won't
                // update live -- not worth surfacing as an extension error.
            }
        }
    }

    isPwaApp(app) {
        return !!app && this._pwaDesktopIds.has(app.get_id());
    }

    // Shell.WindowTracker's own C-side window->app tracking (which backs
    // Shell.App.get_windows()/get_n_windows() and Shell.AppSystem.get_running())
    // is built at window-creation time by calling its original, unpatched
    // get_window_app() internally -- it never consults the JS-overridden
    // version above, so it always attributes every PWA window to the generic
    // browser app instead. get_windows()/get_running() are patched separately
    // (below) to correct for this, using the same per-window resolution.
    getWindowsForApp(app, originalWindows) {
        if (!app)
            return originalWindows;

        const targetId = app.get_id();
        const seen = new Set(originalWindows);
        const result = [];

        for (const window of originalWindows) {
            const resolved = this.resolveApp(window);
            if (resolved && resolved.get_id() !== targetId)
                continue;
            result.push(window);
        }

        for (const window of global.display.list_all_windows()) {
            if (seen.has(window))
                continue;
            const resolved = this.resolveApp(window);
            if (resolved && resolved.get_id() === targetId)
                result.push(window);
        }

        return result;
    }

    getRunningApps(originalApps) {
        const result = [];
        const seenIds = new Set();

        for (const app of originalApps) {
            if (app.get_windows().length === 0)
                continue;
            result.push(app);
            seenIds.add(app.get_id());
        }

        for (const window of global.display.list_all_windows()) {
            const resolved = this.resolveApp(window);
            if (!resolved || seenIds.has(resolved.get_id()))
                continue;
            seenIds.add(resolved.get_id());
            result.push(resolved);
        }

        return result;
    }

    destroy() {
        if (this._appInfoChangedId) {
            this._appInfoMonitor.disconnect(this._appInfoChangedId);
            this._appInfoChangedId = null;
        }
        this._appInfoMonitor = null;

        for (const [window, id] of this._windowSignalIds)
            window.disconnect(id);
        this._windowSignalIds.clear();

        this._appCache = new WeakMap();
        this._chromiumAppIdMap = null;
        this._firefoxPwaSiteIdMap = null;
        this._pwaDesktopIds.clear();
        this._pwaAppWindowCounts.clear();
    }
}

export default class PwaSeparationExtension extends Extension {
    enable() {
        this._resolver = new PwaResolver();

        const extension = this;
        this._originalGetWindowApp = Shell.WindowTracker.prototype.get_window_app;
        this._patchedGetWindowApp = function (...args) {
            const app = extension._resolver.resolveApp(args[0]);
            if (app)
                return app;
            return extension._originalGetWindowApp.call(this, ...args);
        };
        Shell.WindowTracker.prototype.get_window_app = this._patchedGetWindowApp;

        this._originalAppGetWindows = Shell.App.prototype.get_windows;
        this._patchedAppGetWindows = function (...args) {
            const original = extension._originalAppGetWindows.call(this, ...args);
            return extension._resolver.getWindowsForApp(this, original);
        };
        Shell.App.prototype.get_windows = this._patchedAppGetWindows;

        this._originalAppGetNWindows = Shell.App.prototype.get_n_windows;
        this._patchedAppGetNWindows = function () {
            return this.get_windows().length;
        };
        Shell.App.prototype.get_n_windows = this._patchedAppGetNWindows;

        this._originalGetRunning = Shell.AppSystem.prototype.get_running;
        this._patchedGetRunning = function (...args) {
            const original = extension._originalGetRunning.call(this, ...args);
            return extension._resolver.getRunningApps(original);
        };
        Shell.AppSystem.prototype.get_running = this._patchedGetRunning;

        this._originalActivate = Shell.App.prototype.activate;
        this._patchedActivate = function (...args) {
            if (!extension._resolver.isPwaApp(this))
                return extension._originalActivate.call(this, ...args);

            const windows = this.get_windows();
            if (windows.length === 0)
                return extension._originalActivate.call(this, ...args);

            const window = windows.reduce((a, b) =>
                b.get_user_time() > a.get_user_time() ? b : a);
            Main.activateWindow(window);
            return undefined;
        };
        Shell.App.prototype.activate = this._patchedActivate;

        this._originalStateDescriptor =
            Object.getOwnPropertyDescriptor(Shell.App.prototype, 'state');
        if (this._originalStateDescriptor &&
            typeof this._originalStateDescriptor.get === 'function') {
            const originalStateGetter = this._originalStateDescriptor.get;
            this._patchedStateGetter = function () {
                const original = originalStateGetter.call(this);
                if (original !== Shell.AppState.STOPPED)
                    return original;
                if (extension._resolver.isPwaApp(this) &&
                    this.get_windows().length > 0)
                    return Shell.AppState.RUNNING;
                return original;
            };
            Object.defineProperty(Shell.App.prototype, 'state', {
                configurable: true,
                enumerable: this._originalStateDescriptor.enumerable,
                get: this._patchedStateGetter,
            });
        } else {
            this._originalStateDescriptor = null;
            console.warn(
                '[pwa-separation] Shell.App "state" is not a plain accessor ' +
                'property on this GNOME Shell version; the Dash running dot ' +
                'may not reflect running PWAs.');
        }
    }

    disable() {
        const currentStateDescriptor =
            Object.getOwnPropertyDescriptor(Shell.App.prototype, 'state');
        if (this._originalStateDescriptor &&
            currentStateDescriptor?.get === this._patchedStateGetter)
            Object.defineProperty(Shell.App.prototype, 'state', this._originalStateDescriptor);
        this._originalStateDescriptor = null;
        this._patchedStateGetter = null;

        if (Shell.App.prototype.activate === this._patchedActivate)
            Shell.App.prototype.activate = this._originalActivate;
        this._originalActivate = null;
        this._patchedActivate = null;

        if (Shell.AppSystem.prototype.get_running === this._patchedGetRunning)
            Shell.AppSystem.prototype.get_running = this._originalGetRunning;
        this._originalGetRunning = null;
        this._patchedGetRunning = null;

        if (Shell.App.prototype.get_n_windows === this._patchedAppGetNWindows)
            Shell.App.prototype.get_n_windows = this._originalAppGetNWindows;
        this._originalAppGetNWindows = null;
        this._patchedAppGetNWindows = null;

        if (Shell.App.prototype.get_windows === this._patchedAppGetWindows)
            Shell.App.prototype.get_windows = this._originalAppGetWindows;
        this._originalAppGetWindows = null;
        this._patchedAppGetWindows = null;

        if (Shell.WindowTracker.prototype.get_window_app === this._patchedGetWindowApp)
            Shell.WindowTracker.prototype.get_window_app = this._originalGetWindowApp;
        this._originalGetWindowApp = null;
        this._patchedGetWindowApp = null;

        this._resolver.destroy();
        this._resolver = null;
    }
}
