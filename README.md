# 🌑 Shadow Bomber

Echtzeit-Multiplayer-Bomberman mit Licht- und Schatten-Mechanik. Bis zu 4
Spieler pro Raum. Die Arena liegt im Dunkeln — du siehst nur, was dein
eigenes Licht, Laternen und Explosionen erhellen.

Vollständiges Spielkonzept: [docs/SHADOW_BOMBER_KONZEPT.md](docs/SHADOW_BOMBER_KONZEPT.md)

## Features

- **Fog of War:** Sicht nur im eigenen Lichtradius; einmal erkundete Karte bleibt sichtbar (Memory Fog)
- **Cheat-sicher:** Der Server filtert pro Spieler, was er sehen darf — unsichtbare Gegner sind auch in den DevTools nicht zu finden
- **Schattenform:** Wer ≥ 3 s im Schatten steht, lädt die Leiste und kann 4 s lang unsichtbar durch zerstörbare Blöcke gleiten (Shift/E)
- **Laternen:** Feste Lichtquellen — zerstörbar, um die Arena strategisch zu verdunkeln
- **Explosionsblitz:** Jede Explosion erhellt kurz die Umgebung — Aufklärung und Waffe zugleich
- **Fair trotz Unsichtbarkeit:** Fußspuren, Bombenglühen in der letzten Sekunde und Geräusch-Richtungspfeile verraten versteckte Gegner
- **Computer-Gegner:** 0–3 Bots pro Raum — sie jagen Spieler, sprengen Blöcke, sammeln Power-ups und fliehen vor Explosionen (serverseitige BFS-Pfadsuche mit Gefahrenkarte)
- **Best-of-3-Rundensystem:** Countdown vor jeder Runde, Punktestand in der Info-Leiste, wer zuerst 2 Runden gewinnt, holt das Match
- **Sudden Death:** Nach 2 Minuten stürzt die Arena spiralförmig von außen ein — passive Runden gibt es nicht
- **Sound & Effekte:** Synthetisierte Sounds (Web Audio, keine Dateien), Screenshake, Partikel bei Explosionen und zerstörten Blöcken — stummschaltbar per 🔊-Button
- Mehrere Räume, zufällige Karten, Kettenreaktionen, Power-ups, Mobile-Touch-Controls

## Setup (lokal)

```bash
npm install
npm start
```

Öffne `http://localhost:3000` im Browser.

## Spielen

1. Namen eingeben
2. Raum-ID wählen (oder leer lassen für "default")
3. Optional Computer-Gegner (1–3 Bots) auswählen — oder im Wartebildschirm
   per Button hinzufügen
4. Raum-ID mit Freunden teilen
5. Spiel startet automatisch, wenn 2+ Spieler (Bots zählen mit) beigetreten sind

## Steuerung

| Taste | Aktion |
|-------|--------|
| WASD / Pfeiltasten | Bewegen |
| Leertaste | Bombe legen |
| Shift / E | Schattenform aktivieren (bei voller Leiste) |

## Power-ups

- 💣 **Bombe** — Mehr Bomben gleichzeitig
- 🔥 **Flamme** — Größere Explosionen
- 👟 **Schuh** — Schneller laufen
- 🔦 **Fackel** — Größerer Lichtradius

## Kostenloses Online-Deployment

Das Spiel ist ein einzelner Node.js-Prozess (Server + Client zusammen),
braucht keine Datenbank und läuft komplett auf kostenlosen Plattformen.

### Render.com (empfohlen, dauerhaft kostenlos)

Der Free-Tier von Render unterstützt WebSockets und reicht für den
Prototyp völlig aus.

1. Repository zu GitHub pushen (kostenlos)
2. Auf [render.com](https://render.com) kostenloses Konto anlegen
3. **New → Web Service** → GitHub-Repo verbinden
4. Render erkennt die `render.yaml` automatisch (Plan: **Free**) — sonst
   manuell: Runtime *Node*, Build `npm install`, Start `npm start`
5. Nach dem Deploy bekommst du eine URL wie
   `https://shadow-bomber.onrender.com` — Link an Freunde schicken, fertig

> ⚠️ Free-Tier-Hinweis: Der Dienst schläft nach ~15 Minuten Inaktivität
> ein. Der erste Aufruf danach dauert dann ~30–60 Sekunden — für einen
> Prototyp unkritisch.

### Alternative: Koyeb (ebenfalls kostenlos)

[Koyeb](https://www.koyeb.com) bietet eine dauerhaft kostenlose Instanz
mit WebSocket-Unterstützung: **Create Service → GitHub-Repo → Free
Instance** wählen, Build/Start wie oben.

### Alternative: Nur lokal + Tunnel

Zum schnellen Testen mit Freunden ohne Deployment:

```bash
npm start
# in zweitem Terminal (kostenlos, ohne Konto):
npx localtunnel --port 3000
```

Die ausgegebene URL an Freunde schicken (WebSockets funktionieren durch
den Tunnel).
