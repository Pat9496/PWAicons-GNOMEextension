# PWA-Trennung

![GNOME Shell 45-50](https://img.shields.io/badge/GNOME%20Shell-45--50-blue)
![Version 1.0](https://img.shields.io/badge/version-1.0-blue)

[English](README.md) | **Deutsch**

## Inhaltsverzeichnis

- [Das Problem](#das-problem)
- [Funktionsweise](#funktionsweise)
- [Anforderungen](#anforderungen)
- [Installation](#installation)
- [Debugging](#debugging)
- [Einschränkungen](#einschränkungen)
- [Danksagungen](#danksagungen)

Eine GNOME-Shell-Erweiterung, die Progressive-Web-Apps (PWAs) als eigenständige Apps mit ihren eigenen Symbolen anzeigt, statt sie unter dem generischen Browser-Symbol in Übersicht, Alt-Tab, dem Dash und Taskbar-Erweiterungen Dritter zu gruppieren. Unterstützt PWAs, die von beliebigen Chromium-Familie-Browsern (Chrome, Chromium, Edge, Brave, Vivaldi, Opera) installiert werden, und bietet Best-Effort-Unterstützung für Firefox-PWAs, die über das Drittanbieter-Add-on firefoxpwa installiert sind.

## Das Problem

Das Installieren einer PWA in einem Chromium-Familie-Browser erzeugt bereits eine korrekte Desktop-Datei pro App mit dem richtigen Namen und Symbol. Trotzdem zeigt ein ausgeführtes PWA-Fenster immer noch das generische Browser-Symbol und wird überall, wo GNOME Shell die Fenster-/App-Identität anzeigt, mit regulären Browser-Fenstern gruppiert. Dies ist am deutlichsten sichtbar, wenn ein Browser als Flatpak installiert ist: `Shell.WindowTracker` löst Fenster der Sandbox-App über die Flatpak-Sandbox-App-ID auf (identisch für jedes Fenster, das der Flatpak öffnet), die gleich für PWA-Fenster und reguläre Browser-Fenster ist. Daher wird die korrekte Desktop-Datei pro PWA für das Fenster-zu-App-Matching nie konsultiert, egal wie korrekt sie auf der Festplatte ist.

## Funktionsweise

Die Erweiterung patcht `Shell.WindowTracker.prototype.get_window_app` (die Methode, die die meisten GNOME-Shell-UIs – Fensterliste, Alt-Tab, Übersicht – zur Auflösung des Apps und Symbols eines Fensters verwenden), um PWA-Fenster korrekt zu identifizieren, bevor auf die ursprüngliche Implementierung zurückgegriffen wird für alles andere.

Es werden zwei parallele Erkennungspfade verwendet:

**Für Chromium-Familie-Browser** (Chrome, Chromium, Edge, Brave, Vivaldi, Opera):

1. Die reale ausführbare Datei des eigentümlichen Prozesses über `/proc/<pid>/exe` auflösen und den Basename gegen bekannte Chromium-Familie-Binärnamen über alle Installationsmethoden und Kanäle hinweg abgleichen (Flatpak, natives Paket, Stable/Beta/Dev/Canary/Nightly).
2. Die eigene App-ID des Fensters aus seinem `WM_CLASS` extrahieren (Chromium setzt dies zu `crx_<app-id>` einzeln pro Fenster), nur fallback zu `/proc/<pid>/cmdline`'s `--app-id=`-Flag, wenn `WM_CLASS` nicht verfügbar ist. Pro-Fenster lesen (anstatt pro-Prozess) ist wichtig, weil Chromium-Familie-Browser einen einzigen Browser-Prozess für mehrere PWAs unter dem gleichen Profil wiederverwenden können, in welchem Fall die cmdline des Prozesses nur die PWA widerspiegelt, die ihn zuerst gestartet hat.
3. Diese App-ID zu einem installierten Desktop-Eintrag abbilden, indem `Gio.AppInfo.get_all()` aufgezählt wird und `--app-id=` in der `Exec`-Zeile jedes Eintrags abgeglichen wird, anstatt ein bestimmtes Desktop-Datei-Benennungsschema anzunehmen.
4. Bei Übereinstimmung die entsprechende `Shell.App` zurückgeben; andernfalls zum Firefox-Pfad fortfahren oder auf das ursprüngliche `get_window_app()`-Verhalten fallen.

**Für Firefox-PWAs** (installiert via firefoxpwa-Add-on):

1. Den `WM_CLASS` des Fensters gegen das strikte ULID-Format prüfen, das firefoxpwa verwendet (`FFPWA-<ULID>`).
2. Bei Übereinstimmung diese zu einem installierten Desktop-Eintrag abbilden, indem `Gio.AppInfo.get_all()` aufgezählt wird und `StartupWMClass` in den Entry-Metadaten abgeglichen wird.
3. Bei Übereinstimmung die entsprechende `Shell.App` zurückgeben; andernfalls auf das ursprüngliche Verhalten fallen.

Da `Shell.App.get_windows()`/`get_n_windows()` und `Shell.AppSystem.get_running()` durch separate, interne C-seitige Verfolgung gestützt werden, die die JS-überschriebene `get_window_app()` nicht neu konsultiert, patcht die Erweiterung auch diese drei Methoden, damit eine PWA an den Dash angeheftet korrekt als „ausgeführt" angezeigt wird, wenn eines ihrer Fenster offen ist.

Die Erweiterung enthält außerdem zwei zusätzliche Behebungen, die implementiert, aber noch nicht in einer Live-GNOME-Shell-Sitzung bestätigt sind: Das Klicken auf ein an den Dash angeheftetes PWA-Symbol versucht nun, das vorhandene Fenster zu fokussieren, anstatt sich so zu verhalten, als würde die App nicht ausgeführt (via eine `Shell.App.prototype.activate`-Überschreibung), und der Running-Indicator-Punkt des Dash sollte eine ausgeführte PWA widerspiegeln (via eine Feature-erkannte Überschreibung der `Shell.App:state`-Eigenschaft, die elegant zurückfällt, wenn diese GNOME-Shell-Version sie nicht als patchbare Zugriffsmethode verfügbar macht).

## Anforderungen

- GNOME Shell 45–50.
- Ein oder mehrere Chromium-Familie-Browser (Chrome, Chromium, Edge, Brave, Vivaldi, Opera) mit installierten PWAs, beliebige Installationsmethode (Flatpak, natives Paket) und Kanal (Stable/Beta/Dev/Canary/Nightly).
- Optional: Firefox mit dem firefoxpwa-Add-on für Best-Effort-Unterstützung von Firefox-PWAs.

## Installation

```bash
./install.sh
```

Dies erkennt den Paketmanager, symlinkt das Repository in `~/.local/share/gnome-shell/extensions/pwa-separation@pat9496`, und aktiviert die Erweiterung. GNOME Shell lädt eine brandneue Erweiterungs-UUID nur beim Session-Start, also wenn dies eine Neuinstallation ist, ist eine verschachtelte Session oder Logout und Neuanmeldung erforderlich, bevor es wirksam wird:

```bash
dbus-run-session -- gnome-shell --nested --wayland   # X11-Host erforderlich
```

Manuelles Äquivalent zu dem, was das Skript tut:

```bash
ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/pwa-separation@pat9496
gnome-extensions enable pwa-separation@pat9496
```

## Debugging

Erweiterungen haben keinen Logging-Mechanismus außer dem Systemjournal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Schnelle Syntax-/Linting-Prüfung ohne eine Shell-Sitzung (testet nicht das eigentliche Verhalten):

```bash
node --check extension.js
python3 -c "import json; json.load(open('metadata.json'))"
```

## Einschränkungen

- Keine Einstellungs-UI – es gibt noch nichts zu konfigurieren.
- Wenn die Identität eines Fensters keinem installierten Desktop-Eintrag entspricht (beispielsweise PWA installiert, aber das Launcher-Programm wurde nicht erstellt/synchronisiert), bleibt das Fenster unverändert, statt eine fabrizierte Identität zugewiesen zu bekommen.
- Der Running-Indicator-Punkt des Dash und die Dash-Klick-Aktivierung (Fokussieren eines vorhandenen PWA-Fensters anstatt Starten eines neuen) sind implementiert, aber noch nicht in einer Live-GNOME-Shell-Sitzung bestätigt.
- Chromium-Familie-Browser-Verallgemeinerung (Chrome, Chromium, Brave, Vivaldi, Opera): Entwicklung und Live-Tests konzentrierten sich auf Microsoft Edge, angetrieben durch den Anwendungsfall des Entwicklers mit Teams und Outlook als installierte PWAs. Die Erkennungslogik der Erweiterung wurde generisch konzipiert, um mit jeder installierten PWA über alle Chromium-Familie-Browser hinweg zu funktionieren, bleibt aber unbestätigt für Browser außer Edge.
- Firefox/firefoxpwa-Unterstützung ist WM_CLASS-gestützt ohne cmdline-Fallback. Wenn mehrere firefoxpwa-PWAs ein Firefox-Profil teilen, kann ein bekannter Upstream-Bug (filips123/PWAsForFirefox#80) alle ihre Fenster in einen einzigen WM_CLASS zusammenführen, was per-window-Identifikation besiegt – diese Erweiterung hat keine Umgehung für diesen Fall.
- Das genaue `FFPWA-<ULID>` WM_CLASS-Format, das firefoxpwa setzt, wurde nicht unabhängig in einer Live-Sitzung bestätigt. Wenn firefoxpwa dieses Format ändert, stoppt die Firefox-PWA-Erkennung stillschweigend zu funktionieren und fällt auf das Standard-, von dieser Erweiterung nicht gruppierte Verhalten zurück.

## Danksagungen

Die Monkey-Patch-Herangehensweise und Installationsstruktur dieser Erweiterung wurden von OverviewPrivacy übernommen, einer Schwester-GNOME-Shell-Erweiterung des gleichen Entwicklers.
