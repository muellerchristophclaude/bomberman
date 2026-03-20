# Bomberman Multiplayer

Echtzeit-Multiplayer Bomberman mit WebSockets. Bis zu 4 Spieler pro Raum.

## Setup

```bash
npm install
npm start
```

Öffne `http://localhost:3000` im Browser.

## Spielen

1. Namen eingeben
2. Raum-ID wählen (oder leer lassen für "default")
3. Raum-ID mit Freunden teilen
4. Spiel startet automatisch wenn 2+ Spieler beigetreten sind

## Steuerung

| Taste | Aktion |
|-------|--------|
| WASD / Pfeiltasten | Bewegen |
| Leertaste | Bombe legen |

## Power-ups

- 💣 **Bombe** — Mehr Bomben gleichzeitig
- 🔥 **Flamme** — Größere Explosionen
- 👟 **Schuh** — Schneller laufen

## Features

- Bis zu 4 Spieler
- Mehrere Räume gleichzeitig
- Zufällig generierte Karten
- Kettenreaktionen bei Bomben
- Power-ups in zerstörten Blöcken
- Automatischer Neustart
- Mobile-freundliche Touch-Controls
