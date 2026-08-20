import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CHROMIUM_BINARY_RE = /^(google-chrome|chrome|chromium|chromium-browser|brave|brave-browser|vivaldi|vivaldi-stable|opera|microsoft-edge|msedge)(-(beta|dev|canary|nightly|unstable|snapshot))?$/i;
const APP_ID_RE = /--app-id=([A-Za-z0-9]+)/;
const CRX_WM_CLASS_RE = /^crx_+([A-Za-z0-9]+)$/i;
// Newer Edge builds observed setting wm_class_instance to
// "<binary>-_<app-id>-<profile-directory>" (e.g.
// "msedge-_eoficlgicibekocmfdomjbfnjmehnhcd-Default") instead of the legacy
// "crx_<app-id>" form. Chrome extension/app ids are always a 32-character
// string from the a-p alphabet, so that's matched directly rather than
// relying on a specific binary-name or profile-directory prefix/suffix.
const PROFILE_WM_CLASS_RE = /-_([a-p]{32})-/i;
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

// Safely calls `getter()` and matches its result against `regex`, swallowing
// any exception the getter throws (window properties like WM_CLASS can throw
// on a window that's mid-teardown). Returns the first capture group, or null.
function tryMatchGetter(getter, regex) {
    let value;
    try {
        value = getter();
    } catch (e) {
        return null;
    }
    if (!value)
        return null;

    const match = regex.exec(value);
    return match ? match[1] : null;
}

function extractAppIdFromWindow(window) {
    // WM_CLASS is an instance/class pair. Chromium-family browsers set a
    // per-app value on the *instance* part (get_wm_class_instance()) and
    // leave the *class* part (get_wm_class()) as a generic string shared by
    // every window -- reading get_wm_class() here never matches any window,
    // PWA or not.
    //
    // This is what desktop files record as StartupWMClass, set individually
    // per window at window-creation time. This stays correct even when
    // several PWAs installed under the same --profile-directory get merged by
    // the browser into a single shared process ("Opening in existing browser
    // session") whose /proc/<pid>/cmdline only ever reflects whichever PWA
    // first launched that process -- confirmed live with Edge: opening a
    // second PWA under the same profile does not spawn a new --app-id=...
    // process, so cmdline-based extraction alone misidentifies every PWA
    // window in that process as the first one launched.
    return tryMatchGetter(() => window.get_wm_class_instance(), CRX_WM_CLASS_RE) ??
        tryMatchGetter(() => window.get_wm_class_instance(), PROFILE_WM_CLASS_RE);
}

function extractFirefoxPwaSiteId(window) {
    // Unlike Chromium's WM_CLASS convention (always the instance part),
    // it's unconfirmed which half of the WM_CLASS pair firefoxpwa's --class
    // flag sets, so both are tried.
    const match = tryMatchGetter(() => window.get_wm_class_instance(), FFPWA_WM_CLASS_RE) ??
        tryMatchGetter(() => window.get_wm_class(), FFPWA_WM_CLASS_RE);
    return match ? match.toUpperCase() : null;
}

// Builds a Map from whatever id `extractIdFromAppInfo` derives from each
// installed desktop entry to that entry's own desktop-file id. Shared by the
// Chromium and Firefox paths below, which differ only in what they extract.
function buildIdMap(extractIdFromAppInfo) {
    const map = new Map();
    for (const appInfo of Gio.AppInfo.get_all()) {
        const id = extractIdFromAppInfo(appInfo);
        if (id)
            map.set(id, appInfo.get_id());
    }
    return map;
}

function extractChromiumAppIdFromAppInfo(appInfo) {
    const commandline = appInfo.get_commandline();
    return commandline ? APP_ID_RE.exec(commandline)?.[1] ?? null : null;
}

function extractFirefoxPwaSiteIdFromAppInfo(appInfo) {
    // get_startup_wm_class() is a Gio.DesktopAppInfo method that may not
    // exist on every GNOME Shell version's GJS/GLib bindings; if it's
    // missing, every entry simply yields no id, leaving the map empty and
    // Firefox detection silently disabled (same feature-detection pattern
    // used for Shell.App:state in the extension class below).
    if (typeof appInfo.get_startup_wm_class !== 'function')
        return null;

    const startupWmClass = appInfo.get_startup_wm_class();
    if (!startupWmClass)
        return null;

    const match = FFPWA_WM_CLASS_RE.exec(startupWmClass);
    return match ? match[1].toUpperCase() : null;
}

class PwaResolver {
    constructor(getNativeAppForWindow) {
        // Each entry lazily builds (and, on a cache miss, rebuilds once --
        // in case the AppInfoMonitor 'changed' signal below was missed) a
        // Map from whatever id its `builder` extracts to a desktop-file id.
        this._idMaps = {
            chromium: {map: null, builder: () => buildIdMap(extractChromiumAppIdFromAppInfo)},
            firefoxPwa: {map: null, builder: () => buildIdMap(extractFirefoxPwaSiteIdFromAppInfo)},
        };
        this._getNativeAppForWindow = getNativeAppForWindow;
        this._appCache = new WeakMap();
        // Window -> the app that GNOME Shell's own (unpatched) native
        // get_window_app() would have attributed the window to, recorded
        // only when that differs from our resolved PWA app -- i.e. the
        // parent browser app whose running/state indicator needs to be
        // corrected and re-notified alongside the PWA's own.
        this._shadowedAppCache = new WeakMap();
        this._windowSignalIds = new Map();
        this._pwaDesktopIds = new Set();
        this._appWindowCounts = new Map();

        this._appInfoMonitor = Gio.AppInfoMonitor.get();
        this._appInfoChangedId = this._appInfoMonitor.connect('changed', () => {
            for (const entry of Object.values(this._idMaps))
                entry.map = null;
        });
    }

    _lookupDesktopId(family, id) {
        const entry = this._idMaps[family];
        let rebuilt = false;
        if (!entry.map) {
            entry.map = entry.builder();
            rebuilt = true;
        }
        let desktopId = entry.map.get(id);
        if (!desktopId && !rebuilt) {
            entry.map = entry.builder();
            desktopId = entry.map.get(id);
        }
        return desktopId ?? null;
    }

    _resolveDesktopId(desktopId) {
        if (!desktopId)
            return null;
        this._pwaDesktopIds.add(desktopId);
        return Shell.AppSystem.get_default().lookup_app(desktopId) ?? null;
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
                    console.log(
                        `[pwa-separation] pid=${pid} wm_class_instance=${window.get_wm_class_instance()} ` +
                        `title="${window.get_title()}" -> no app-id from WM_CLASS, ${otherCount} ` +
                        'other window(s) share this pid, refusing cmdline fallback');
                    return null;
                }
                appId = extractAppIdFromCmdline(pid);
                source = 'cmdline';
            }
            if (!appId) {
                console.log(
                    `[pwa-separation] pid=${pid} wm_class_instance=${window.get_wm_class_instance()} ` +
                    `title="${window.get_title()}" -> no app-id resolved`);
                return null;
            }

            const desktopId = this._lookupDesktopId('chromium', appId);
            console.log(
                `[pwa-separation] pid=${pid} wm_class_instance=${window.get_wm_class_instance()} ` +
                `title="${window.get_title()}" appId=${appId} (via ${source}) -> ` +
                `desktopId=${desktopId ?? 'none'}`);
            return this._resolveDesktopId(desktopId);
        }

        const siteId = extractFirefoxPwaSiteId(window);
        if (siteId) {
            const desktopId = this._lookupDesktopId('firefoxPwa', siteId);
            console.log(
                `[pwa-separation] pid=${pid} siteId=${siteId} -> desktopId=${desktopId ?? 'none'}`);
            return this._resolveDesktopId(desktopId);
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
            const shadowed = this._shadowedAppCache.get(window);
            this._appCache.delete(window);
            this._shadowedAppCache.delete(window);
            this._windowSignalIds.delete(window);
            this._maybeNotifyStateChange(app);
            this._maybeNotifyStateChange(shadowed);
        });
        this._windowSignalIds.set(window, id);
    }

    // Records, the first time `window` resolves to `app`, whichever app
    // GNOME Shell's own native get_window_app() would have attributed the
    // window to -- if that's a different app, it's the parent browser app
    // whose window list/state is currently wrong because of this window,
    // and needs the same notify('state') treatment as the PWA app itself.
    _trackShadowedApp(window, app) {
        if (this._shadowedAppCache.has(window))
            return;

        let nativeApp;
        try {
            nativeApp = this._getNativeAppForWindow(window);
        } catch (e) {
            return;
        }
        if (nativeApp && nativeApp.get_id() !== app.get_id())
            this._shadowedAppCache.set(window, nativeApp);
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
        const cached = this._appCache.get(window);
        if (cached)
            return cached;

        const app = this._computeAppForWindow(window);
        this._trackWindow(window);
        if (app) {
            this._appCache.set(window, app);
            this._trackShadowedApp(window, app);
            this._maybeNotifyStateChange(app);
            this._maybeNotifyStateChange(this._shadowedAppCache.get(window));
        }
        return app;
    }

    // Shell.App:state is a GObject property computed from Shell.WindowTracker's
    // internal C-side window<->app bookkeeping, which (like get_windows(), above)
    // never re-consults the JS-overridden get_window_app(). Reading app.state
    // for a PWA app therefore always reports STOPPED even while its windows are
    // open, unless something else notifies listeners (e.g. the Dash running-dot)
    // that it may have changed. The same staleness cuts the other way for the
    // parent browser app: it can keep reporting RUNNING purely because of a
    // window that's actually been reattributed to a PWA. Call this after any
    // window gets added to, or removed from, either app's resolved window set
    // -- both the PWA app and its shadowed native app (see _trackShadowedApp).
    _maybeNotifyStateChange(app) {
        if (!app)
            return;

        const id = app.get_id();
        const count = app.get_windows().length;
        const previousCount = this._appWindowCounts.get(id) ?? 0;
        this._appWindowCounts.set(id, count);

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
        this._shadowedAppCache = new WeakMap();
        for (const entry of Object.values(this._idMaps))
            entry.map = null;
        this._pwaDesktopIds.clear();
        this._appWindowCounts.clear();
    }
}

export default class PwaSeparationExtension extends Extension {
    enable() {
        const extension = this;
        this._originalGetWindowApp = Shell.WindowTracker.prototype.get_window_app;
        this._resolver = new PwaResolver(
            window => extension._originalGetWindowApp.call(Shell.WindowTracker.get_default(), window));

        this._patchedGetWindowApp = function (window) {
            const app = extension._resolver.resolveApp(window);
            if (app)
                return app;
            return extension._originalGetWindowApp.call(this, window);
        };
        Shell.WindowTracker.prototype.get_window_app = this._patchedGetWindowApp;

        this._originalAppGetWindows = Shell.App.prototype.get_windows;
        this._patchedAppGetWindows = function () {
            const original = extension._originalAppGetWindows.call(this);
            return extension._resolver.getWindowsForApp(this, original);
        };
        Shell.App.prototype.get_windows = this._patchedAppGetWindows;

        this._originalAppGetNWindows = Shell.App.prototype.get_n_windows;
        this._patchedAppGetNWindows = function () {
            return this.get_windows().length;
        };
        Shell.App.prototype.get_n_windows = this._patchedAppGetNWindows;

        this._originalGetRunning = Shell.AppSystem.prototype.get_running;
        this._patchedGetRunning = function () {
            const original = extension._originalGetRunning.call(this);
            return extension._resolver.getRunningApps(original);
        };
        Shell.AppSystem.prototype.get_running = this._patchedGetRunning;

        // Not gated to isPwaApp(): the native implementation picks its
        // most-recently-used window from Shell.App's own internal C-side
        // window list, which (like get_windows()/get_n_windows()/
        // get_running(), above) is built from the original unpatched
        // get_window_app() -- so the *parent browser's* app also
        // misattributes every PWA window as its own there. Left ungated,
        // clicking the parent browser's Dash icon could activate a more
        // recently used PWA window instead of a genuine browser window.
        // Using this.get_windows() (already corrected per-app above) fixes
        // both directions with the same logic.
        this._originalActivate = Shell.App.prototype.activate;
        this._patchedActivate = function (...args) {
            const windows = this.get_windows();
            if (windows.length === 0)
                return extension._originalActivate.call(this, ...args);

            const window = windows.reduce((a, b) =>
                b.get_user_time() > a.get_user_time() ? b : a);
            Main.activateWindow(window);
            return undefined;
        };
        Shell.App.prototype.activate = this._patchedActivate;

        // Shell.App.activate_window(window, timestamp) is what the default
        // (app-grouped) Alt-Tab switcher calls on release, passing the exact
        // Meta.Window to focus -- it does not go through activate() above.
        // Its native implementation only proceeds if `window` is found in
        // this app's own internal C-side window list, which (like
        // get_windows()/get_n_windows()/get_running(), above) is built from
        // the original unpatched get_window_app() and so never contains a
        // resolved PWA's windows -- it silently does nothing instead of
        // focusing the window. Bypassed entirely for a resolved PWA app,
        // since the caller already obtained `window` from our patched
        // get_windows() and it is known to genuinely belong to this app.
        this._originalActivateWindow = Shell.App.prototype.activate_window;
        this._patchedActivateWindow = function (window, timestamp) {
            if (!extension._resolver.isPwaApp(this) || !window)
                return extension._originalActivateWindow.call(this, window, timestamp);
            Main.activateWindow(window, timestamp);
            return undefined;
        };
        Shell.App.prototype.activate_window = this._patchedActivateWindow;

        this._originalStateDescriptor =
            Object.getOwnPropertyDescriptor(Shell.App.prototype, 'state');
        if (this._originalStateDescriptor &&
            typeof this._originalStateDescriptor.get === 'function') {
            const originalStateGetter = this._originalStateDescriptor.get;
            this._patchedStateGetter = function () {
                const original = originalStateGetter.call(this);

                if (extension._resolver.isPwaApp(this)) {
                    if (original === Shell.AppState.STOPPED &&
                        this.get_windows().length > 0)
                        return Shell.AppState.RUNNING;
                    return original;
                }

                // The reverse staleness: this app (e.g. a parent browser)
                // can still report RUNNING purely because native's own
                // window-tracking counts a window that our resolver has
                // reattributed to a PWA. Only demote when *every* window
                // native attributes to this app turned out to belong
                // elsewhere -- if any of them are still genuinely this
                // app's own, get_windows() below is non-empty and nothing
                // changes.
                if (original === Shell.AppState.RUNNING) {
                    const nativeWindows = extension._originalAppGetWindows.call(this);
                    if (nativeWindows.length > 0 && this.get_windows().length === 0)
                        return Shell.AppState.STOPPED;
                }
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

        // Shell.WindowTracker:focus-app is, like Shell.App:state above,
        // computed from Shell.WindowTracker's internal C-side bookkeeping
        // rather than derived by calling the JS-overridden get_window_app()
        // -- so it always reports the generic browser app as focused while a
        // PWA window actually has focus. This is what Dash-to-Dock/Ubuntu
        // Dock (and any other dock extension that highlights the focused
        // app) consult to decide which icon to highlight.
        this._originalFocusAppDescriptor =
            Object.getOwnPropertyDescriptor(Shell.WindowTracker.prototype, 'focus_app');
        if (this._originalFocusAppDescriptor &&
            typeof this._originalFocusAppDescriptor.get === 'function') {
            const originalFocusAppGetter = this._originalFocusAppDescriptor.get;
            this._patchedFocusAppGetter = function () {
                const focusWindow = global.display.focus_window;
                if (focusWindow) {
                    const resolved = extension._resolver.resolveApp(focusWindow);
                    if (resolved)
                        return resolved;
                }
                return originalFocusAppGetter.call(this);
            };
            Object.defineProperty(Shell.WindowTracker.prototype, 'focus_app', {
                configurable: true,
                enumerable: this._originalFocusAppDescriptor.enumerable,
                get: this._patchedFocusAppGetter,
            });

            // The C side only emits notify::focus-app when its own
            // (unpatched) idea of the focused app changes -- which never
            // happens when focus moves between a PWA window and its parent
            // browser, since both resolve to the same app internally. Forward
            // every focus-window change as a focus-app notification so
            // listeners (e.g. a dock's focused-icon highlight) re-read the
            // now-corrected property.
            this._focusWindowChangedId = global.display.connect('notify::focus-window', () => {
                Shell.WindowTracker.get_default().notify('focus-app');
            });
        } else {
            this._originalFocusAppDescriptor = null;
            console.warn(
                '[pwa-separation] Shell.WindowTracker "focus-app" is not a ' +
                'plain accessor property on this GNOME Shell version; dock ' +
                'extensions may still highlight the parent browser as ' +
                'focused instead of a running PWA.');
        }
    }

    disable() {
        if (this._focusWindowChangedId) {
            global.display.disconnect(this._focusWindowChangedId);
            this._focusWindowChangedId = null;
        }

        const currentFocusAppDescriptor =
            Object.getOwnPropertyDescriptor(Shell.WindowTracker.prototype, 'focus_app');
        if (this._originalFocusAppDescriptor &&
            currentFocusAppDescriptor?.get === this._patchedFocusAppGetter)
            Object.defineProperty(Shell.WindowTracker.prototype, 'focus_app', this._originalFocusAppDescriptor);
        this._originalFocusAppDescriptor = null;
        this._patchedFocusAppGetter = null;

        const currentStateDescriptor =
            Object.getOwnPropertyDescriptor(Shell.App.prototype, 'state');
        if (this._originalStateDescriptor &&
            currentStateDescriptor?.get === this._patchedStateGetter)
            Object.defineProperty(Shell.App.prototype, 'state', this._originalStateDescriptor);
        this._originalStateDescriptor = null;
        this._patchedStateGetter = null;

        if (Shell.App.prototype.activate_window === this._patchedActivateWindow)
            Shell.App.prototype.activate_window = this._originalActivateWindow;
        this._originalActivateWindow = null;
        this._patchedActivateWindow = null;

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
