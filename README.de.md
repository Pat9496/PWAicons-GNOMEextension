# Edge-PWA-Symbol

![GNOME Shell 45-50](https://img.shields.io/badge/GNOME%20Shell-45--50-blue)
![Version 0.4](https://img.shields.io/badge/version-0.4-blue)

[English](README.md) | **Deutsch**

## Inhaltsverzeichnis

- [Das Problem](#das-problem)
- [Funktionsweise](#funktionsweise)
- [Anforderungen](#anforderungen)
- [Installation](#installation)
- [Debugging](#debugging)
- [Einschränkungen](#einschränkungen)
- [Danksagungen](#danksagungen)

Eine GNOME-Shell-Erweiterung, die Microsoft-Edge-Progressive-Web-Apps (installiert über Edge's „Install site as app" – beispielsweise Outlook, Teams) als eigenständige Apps mit ihren eigenen Symbolen anzeigt, statt sie unter dem generischen Microsoft-Edge-Symbol in Übersicht, Alt-Tab, dem Dash und Taskbar-Erweiterungen Dritter zu gruppieren.

## Das Problem

Das Installieren einer PWA in Edge erzeugt bereits eine korrekte Desktop-Datei pro App mit dem richtigen Namen und Symbol. Trotzdem zeigt ein ausgeführtes PWA-Fenster immer noch Edges generisches Symbol und wird überall, wo GNOME Shell die Fenster-/App-Identität anzeigt, mit regulären Edge-Browser-Fenstern gruppiert. Dies ist am deutlichsten sichtbar, wenn Edge als Flatpak installiert ist: `Shell.WindowTracker` löst Fenster der Sandbox-App über die Flatpak-Sandbox-App-ID auf (`com.microsoft.Edge`), die für jedes Fenster, das der Edge-Flatpak öffnet, identisch ist – PWA oder nicht – sodass die korrekte Desktop-Datei pro PWA für das Fenster-zu-App-Matching nie konsultiert wird, egal wie korrekt sie auf der Festplatte ist.

## Funktionsweise

Die Erweiterung überschreibt `Shell.WindowTracker.prototype.get_window_app` (die Methode, die die meisten GNOME-Shell-UIs – Fensterliste, Alt-Tab, Übersicht – zur Auflösung des Apps und Symbols eines Fensters verwenden) um Edge-PWA-Fenster korrekt zu identifizieren, bevor auf die ursprüngliche Implementierung zurückgefielen wird für alles andere:

1. Für jedes Fenster die reale ausführbare Datei des eigentümlichen Prozesses über `/proc/<pid>/exe` auflösen und seinen Basename gegen bekannte Edge-Binärnamen über Installationsmethoden und Kanäle hinweg abgleichen (Flatpak, natives Paket, Stable/Beta/Dev/Canary).
2. Die eigene App-ID des Fensters aus seinem `WM_CLASS` extrahieren (Chromium setzt dies zu `crx__<app-id>` einzeln pro Fenster), nur fallback zu `/proc/<pid>/cmdline`'s `--app-id=`-Flag, wenn `WM_CLASS` nicht verfügbar ist. Pro-Fenster lesen (anstatt pro-Prozess) ist wichtig, weil Edge einen einzigen Browser-Prozess für mehrere PWAs unter dem gleichen Profil wiederverwenden kann, in welchem Fall die cmdline des Prozesses nur die `--app-id=` der PWA widerspiegelt, die ihn zuerst gestartet hat.
3. Diese App-ID zu einem installierten Desktop-Eintrag abbilden, indem `Gio.AppInfo.get_all()` aufgezählt wird und `--app-id=` in der `Exec`-Zeile jedes Eintrags abgeglichen wird, anstatt ein bestimmtes Desktop-Datei-Benennungsschema anzunehmen – dies funktioniert unabhängig davon, wie die PWA-Desktop-Datei erstellt wurde (Flatpak-Portal, natives Paket Post-Install-Skript, oder manuelle Installation).
4. Wenn eine Übereinstimmung gefunden wird, die entsprechende `Shell.App` zurückgeben; andernfalls zum ursprünglichen `get_window_app()`-Verhalten fallen.

Da `Shell.App.get_windows()`/`get_n_windows()` und `Shell.AppSystem.get_running()` durch separate, interne C-seitige Nachverfolgung gestützt werden, die die JS-überschriebene `get_window_app()` nicht neu konsultiert, überschreibt die Erweiterung auch diese drei Methoden, damit eine PWA an den Dash angeheftet korrekt als „ausgeführt" angezeigt wird, wenn eines ihrer Fenster offen ist.

Die Erweiterung enthält außerdem zwei zusätzliche Behebungen, die implementiert, aber noch nicht in einer Live-GNOME-Shell-Sitzung bestätigt sind: Das Klicken auf ein an den Dash angeheftetes PWA-Symbol versucht nun, das vorhandene Fenster zu fokussieren, anstatt sich so zu verhalten, als würde die App nicht ausgeführt (via eine `Shell.App.prototype.activate`-Überschreibung), und der Running-Indicator-Punkt des Dash sollte eine ausgeführte PWA widerspiegeln (via eine Feature-erkannte Überschreibung der `Shell.App:state`-Eigenschaft, die elegant zurückfällt, wenn diese GNOME-Shell-Version sie nicht als patchbare Zugriffsmethode verfügbar macht).

## Anforderungen

- GNOME Shell 45–50.
- Microsoft Edge, beliebige Installationsmethode (Flatpak, natives `.deb`/`.rpm`, Distro-Repackaging) und Kanal (Stable/Beta/Dev/Canary), mit einer oder mehreren Websites, die als PWAs über Edge's „Install site as app" installiert sind.

## Installation

```bash
./install.sh
```

Dies erkennt den Paketmanager, symlinkt das Repository in `~/.local/share/gnome-shell/extensions/pwa-icons@pat9496`, und aktiviert die Erweiterung. GNOME Shell lädt eine brandneue Erweiterungs-UUID nur beim Session-Start, also wenn dies eine Neuinstallation ist, ist eine verschachtelte Session oder Logout und Neuanmeldung erforderlich, bevor es wirksam wird:

```bash
dbus-run-session -- gnome-shell --nested --wayland   # X11-Host erforderlich
```

Manuelles Äquivalent zu dem, was das Skript tut:

```bash
ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/pwa-icons@pat9496
gnome-extensions enable pwa-icons@pat9496
```

## Debugging

Erweiterungen haben keinen Logging-Mechanismus außer dem Systemjournal:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

Schnelle Syntax-/Linting-Prüfung ohne eine Shell-Session (testet nicht das eigentliche Verhalten):

```bash
node --check extension.js
python3 -c "import json; json.load(open('metadata.json'))"
```

## Einschränkungen

- Keine Einstellungs-UI – es gibt noch nichts zu konfigurieren.
- Wenn die App-ID eines Fensters keinem installierten Desktop-Eintrag entspricht (beispielsweise PWA installiert, aber das Launcher-Programm wurde nicht erstellt/synchronisiert), bleibt das Fenster unverändert, statt eine fabrizierte Identität zugewiesen zu bekommen.
- Der Running-Indicator-Punkt des Dash aktualisiert sich möglicherweise nicht korrekt für PWAs. Die Erweiterung enthält Patches für `Shell.App.get_windows()` (um eine PWA als ausgeführt zu erkennen) und `Shell.App:state` (die Eigenschaft, die den visuellen Indikator antreibt), aber ob sich der Punkt tatsächlich live aktualisiert, hängt von der GNOME-Shell-Version und der internen Implementierung ab – keiner dieser Patches wurde in einer Live-Sitzung bestätigt.
- Die Dash-Klick-Aktivierungsbehebung (das Fokussieren eines vorhandenen PWA-Fensters anstatt das Starten eines neuen) ist implementiert, aber noch nicht in einer Live-Sitzung bestätigt.

## Danksagungen

Die Monkey-Patch-Herangehensweise und Installationsstruktur dieser Erweiterung wurden von OverviewPrivacy übernommen, einer Schwester-GNOME-Shell-Erweiterung des gleichen Entwicklers.
