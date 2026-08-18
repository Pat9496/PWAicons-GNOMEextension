import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const EDGE_BINARY_RE = /^(microsoft-edge|msedge)(-(beta|dev|canary))?$/i;
const APP_ID_RE = /--app-id=([A-Za-z0-9]+)/;
const CRX_WM_CLASS_RE = /^crx__([A-Za-z0-9]+)$/i;

function isEdgeExecutable(pid) {
    let exePath;
    try {
        exePath = GLib.file_read_link(`/proc/${pid}/exe`);
    } catch (e) {
        return false;
    }
    if (!exePath)
        return false;

    const basename = GLib.path_get_basename(exePath);
    return EDGE_BINARY_RE.test(basename);
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
    // Chromium/Edge processes (observed with Flatpak's zypak-helper) rewrite
    // their own cmdline into a single space-joined string for a friendlier
    // process title, collapsing the NUL separators. Matching the flag pattern
    // against the raw decoded string (NUL bytes included) works for both forms.
    const match = APP_ID_RE.exec(cmdline);
    return match ? match[1] : null;
}

function extractAppIdFromWindow(window) {
    let wmClass;
    try {
        wmClass = window.get_wm_class();
    } catch (e) {
        return null;
    }
    if (!wmClass)
        return null;

    // Chromium sets each installed web app's window WM_CLASS/app-id to
    // "crx__<app-id>" (this is what desktop files record as StartupWMClass)
    // individually per window, at window-creation time. This stays correct
    // even when several PWAs installed under the same --profile-directory get
    // merged by Chromium into a single shared browser process ("Opening in
    // existing browser session") whose /proc/<pid>/cmdline only ever reflects
    // whichever PWA first launched that process -- confirmed live: opening a
    // second PWA under the same profile does not spawn a new --app-id=...
    // process, so cmdline-based extraction alone misidentifies every PWA
    // window in that process as the first one launched.
    const match = CRX_WM_CLASS_RE.exec(wmClass);
    return match ? match[1] : null;
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

class EdgePwaResolver {
    constructor() {
        this._appIdToDesktopId = null;
        this._appCache = new WeakMap();
        this._windowSignalIds = new Map();
        this._pwaDesktopIds = new Set();
        this._pwaAppWindowCounts = new Map();

        this._appInfoMonitor = Gio.AppInfoMonitor.get();
        this._appInfoChangedId = this._appInfoMonitor.connect('changed', () => {
            this._appIdToDesktopId = null;
        });
    }

    _ensureAppIdMap() {
        if (!this._appIdToDesktopId)
            this._appIdToDesktopId = buildAppIdMap();
        return this._appIdToDesktopId;
    }

    _lookupDesktopId(appId) {
        const map = this._ensureAppIdMap();
        let desktopId = map.get(appId);
        if (!desktopId) {
            // Cache miss: refresh in case the AppInfoMonitor 'changed' signal was missed.
            this._appIdToDesktopId = buildAppIdMap();
            desktopId = this._appIdToDesktopId.get(appId);
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

        if (!isEdgeExecutable(pid))
            return null;

        // Prefer the window's own WM_CLASS (per-window ground truth); fall
        // back to the process cmdline only if WM_CLASS isn't available yet.
        const appId = extractAppIdFromWindow(window) ?? extractAppIdFromCmdline(pid);
        if (!appId)
            return null;

        const desktopId = this._lookupDesktopId(appId);
        if (!desktopId)
            return null;

        this._pwaDesktopIds.add(desktopId);
        return Shell.AppSystem.get_default().lookup_app(desktopId) ?? null;
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
        if (this._appCache.has(window))
            return this._appCache.get(window);

        const app = this._computeAppForWindow(window);
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
    // Edge app instead. get_windows()/get_running() are patched separately
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
        this._appIdToDesktopId = null;
        this._pwaDesktopIds.clear();
        this._pwaAppWindowCounts.clear();
    }
}

export default class EdgePwaIconExtension extends Extension {
    enable() {
        this._resolver = new EdgePwaResolver();

        const extension = this;
        this._originalGetWindowApp = Shell.WindowTracker.prototype.get_window_app;
        Shell.WindowTracker.prototype.get_window_app = function (...args) {
            const app = extension._resolver.resolveApp(args[0]);
            if (app)
                return app;
            return extension._originalGetWindowApp.call(this, ...args);
        };

        this._originalAppGetWindows = Shell.App.prototype.get_windows;
        Shell.App.prototype.get_windows = function (...args) {
            const original = extension._originalAppGetWindows.call(this, ...args);
            return extension._resolver.getWindowsForApp(this, original);
        };

        this._originalAppGetNWindows = Shell.App.prototype.get_n_windows;
        Shell.App.prototype.get_n_windows = function () {
            return this.get_windows().length;
        };

        this._originalGetRunning = Shell.AppSystem.prototype.get_running;
        Shell.AppSystem.prototype.get_running = function (...args) {
            const original = extension._originalGetRunning.call(this, ...args);
            return extension._resolver.getRunningApps(original);
        };

        // Clicking a Dash/pinned PWA icon should focus its existing window
        // rather than launching a new instance. Shell.App.activate()'s own
        // C implementation decides that based on the same broken internal
        // state Shell.App:state uses (see below), so it never recognizes a
        // PWA as already running. Override activate() for resolved PWA apps
        // only, using our own get_windows() (already patched, above) as the
        // source of truth; every other app keeps the original behavior.
        this._originalActivate = Shell.App.prototype.activate;
        Shell.App.prototype.activate = function (...args) {
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

        // Best-effort fix for the Dash running-indicator dot: Shell.App:state
        // is a GObject property backed by the same internal C-side tracking
        // as get_windows()/get_running(), so it never reports RUNNING for a
        // PWA app even while its windows are open. Only attempt this if this
        // GNOME Shell version actually exposes "state" as a plain accessor
        // property on the prototype (as of writing it does); if not, skip
        // rather than risk breaking property access for every Shell.App.
        this._originalStateDescriptor =
            Object.getOwnPropertyDescriptor(Shell.App.prototype, 'state');
        if (this._originalStateDescriptor &&
            typeof this._originalStateDescriptor.get === 'function') {
            const originalStateGetter = this._originalStateDescriptor.get;
            Object.defineProperty(Shell.App.prototype, 'state', {
                configurable: true,
                enumerable: this._originalStateDescriptor.enumerable,
                get: function () {
                    const original = originalStateGetter.call(this);
                    if (original !== Shell.AppState.STOPPED)
                        return original;
                    if (extension._resolver.isPwaApp(this) &&
                        this.get_windows().length > 0)
                        return Shell.AppState.RUNNING;
                    return original;
                },
            });
        } else {
            this._originalStateDescriptor = null;
            console.warn(
                '[pwa-icons] Shell.App "state" is not a plain accessor ' +
                'property on this GNOME Shell version; the Dash running dot ' +
                'may not reflect running PWAs.');
        }
    }

    disable() {
        if (this._originalStateDescriptor)
            Object.defineProperty(Shell.App.prototype, 'state', this._originalStateDescriptor);
        this._originalStateDescriptor = null;

        Shell.App.prototype.activate = this._originalActivate;
        this._originalActivate = null;

        Shell.AppSystem.prototype.get_running = this._originalGetRunning;
        this._originalGetRunning = null;

        Shell.App.prototype.get_n_windows = this._originalAppGetNWindows;
        this._originalAppGetNWindows = null;

        Shell.App.prototype.get_windows = this._originalAppGetWindows;
        this._originalAppGetWindows = null;

        Shell.WindowTracker.prototype.get_window_app = this._originalGetWindowApp;
        this._originalGetWindowApp = null;

        this._resolver.destroy();
        this._resolver = null;
    }
}
