# Shadow Bomber — Spielkonzept

> Online-Multiplayer-Bomberman mit Licht- und Schatten-Mechanik.
> Weiterentwicklung des bestehenden Bomberman-Prototyps in diesem Repository.

## 1. Vision

**Shadow Bomber** ist ein taktisches Arena-Spiel für 2–8 Spieler. Es kombiniert
das klassische Bomberman-Gameplay (Bomben legen, Blöcke zerstören, Gegner
ausschalten) mit einer zentralen neuen Idee: **Sichtbarkeit ist eine Ressource.**

Die Arena liegt im Halbdunkel. Jeder Spieler trägt eine Lichtquelle und sieht
nur einen begrenzten Bereich um sich herum. Wer im Schatten steht, ist für
andere unsichtbar — kann aber auch selbst weniger sehen. Explosionen erhellen
kurzzeitig die gesamte Umgebung und verraten Positionen.

**Kernaussage in einem Satz:** *Bomberman trifft Fog of War — Verstecken,
Anschleichen und der perfekte Moment zum Zünden entscheiden.*

## 2. Kern-Gameplay

### 2.1 Klassische Basis (bereits im Prototyp vorhanden)

- Gitterbasierte Arena mit festen Wänden, zerstörbaren Blöcken und freien Feldern
- Bomben mit Timer (~3 s), kreuzförmige Explosion, Kettenreaktionen
- Power-ups aus zerstörten Blöcken (mehr Bomben, größere Flamme, Tempo)
- Last-man-standing: Der letzte Überlebende gewinnt die Runde

### 2.2 Neu: Das Licht-/Schatten-System

| Element | Verhalten |
|---|---|
| **Lichtradius** | Jeder Spieler leuchtet einen Radius von ~3 Feldern aus. Nur dort sieht er Gegner, Bomben und Power-ups. Die Karte selbst (Wände/Blöcke) bleibt sichtbar, sobald sie einmal erkundet wurde („Memory Fog"). |
| **Schatten** | Außerhalb aller Lichtradien sind Spieler und Bomben unsichtbar. Bewegung im Schatten erzeugt aber subtile Hinweise (siehe 2.3). |
| **Explosionsblitz** | Jede Explosion erhellt für ~1,5 s einen großen Bereich (z. B. 6 Felder Radius) — Bomben sind also gleichzeitig Waffe und Aufklärung. |
| **Laternen** | Feste Lichtquellen auf der Karte, die zerstört werden können. Wer Laternen sprengt, verdunkelt die Arena strategisch. |
| **Shadow Meter** | Wer sich ≥ 3 s im Schatten aufhält, lädt eine Leiste auf und kann kurz in die **Schattenform** wechseln (siehe 2.4). |

### 2.3 Gegenspiel zur Unsichtbarkeit (Fairness)

Unsichtbarkeit darf nicht frustrieren. Deshalb hinterlässt jeder Spieler Spuren:

- **Fußspuren:** Kurz sichtbare Schrittabdrücke, die nach ~2 s verblassen
- **Bombenglühen:** Bomben glimmen schwach — je kürzer der Timer, desto heller
- **Geräusch-Indikator:** Richtungsanzeige am Bildschirmrand, wenn ein Gegner in der Nähe läuft oder eine Bombe legt
- **Power-up-Schimmer:** Eingesammelte Power-ups erzeugen einen kurzen Lichtimpuls

### 2.4 Schattenform (Signature-Mechanik)

Mit voller Shadow-Meter-Leiste kann der Spieler für **4 Sekunden** in die
Schattenform wechseln:

- Komplett unsichtbar, auch im Licht
- +30 % Bewegungstempo
- Kann **durch zerstörbare Blöcke hindurchgleiten** (nicht durch feste Wände)
- **Kann keine Bomben legen** und stirbt weiterhin durch Explosionen
- Danach 10 s Abklingzeit, Leiste leert sich vollständig

Das erzeugt die zentrale Entscheidung des Spiels: *Jetzt fliehen, flankieren
oder die Leiste für später aufsparen?*

## 3. Power-ups

### Bestehend (bleiben erhalten)

- 💣 **Bombe** — mehr gleichzeitige Bomben (max. 8)
- 🔥 **Flamme** — größere Explosionen (max. 8)
- 👟 **Schuh** — höheres Tempo

### Neu (Schatten-Thema)

| Power-up | Effekt |
|---|---|
| 🔦 **Fackel** | Lichtradius +1 Feld (max. +3) |
| 🌑 **Dunkelbombe** | Nächste Bombe explodiert ohne Lichtblitz und ist lautlos |
| 👁️ **Drittes Auge** | 5 s lang alle Gegner durch Wände sehen (auch in Schattenform) |
| 💨 **Rauchwand** | Legt eine 3 Felder lange Rauchwand, die Licht blockiert |
| ⚡ **Blitzlicht** | Einmalig: erhellt sofort die ganze Karte für 2 s (offensiv als Aufklärung nutzbar) |
| 💀 **Fluch** (negativ, 10 % Chance) | Lichtradius −1, oder invertierte Steuerung für 5 s |

## 4. Spielmodi

1. **Klassisch (MVP):** Last man standing, 2–4 Spieler, Best-of-3-Runden
2. **Shadow Hunt (2v2):** Team-Modus; Punkte für Kills, Respawn nach 5 s, 3 Minuten Zeitlimit
3. **Lantern Rush:** Ein Team verteidigt Laternen, das andere sprengt sie — dann Seitenwechsel
4. **Battle Royale (später):** Bis zu 8 Spieler auf großer Karte, die von außen kontinuierlich dunkler wird („Shadow Shrink" statt Zone)

**Sudden Death:** Nach 2 Minuten fallen vom Rand her Blöcke in die Arena und verkleinern sie — verhindert passive Runden.

## 5. Karten & Arena

- Basisgröße 15×13 (wie Prototyp), große Karten 21×17 für 6–8 Spieler
- Prozedural generiert mit garantiert fairen Startbereichen (symmetrische Spiegelung)
- **Neue Kachel-Typen:**
  - **Laterne** — Lichtquelle, zerstörbar
  - **Spiegel-Block** — reflektiert Explosionen um 90° (selten, taktisches Element)
  - **Schattenteich** — Feld, auf dem der Shadow Meter doppelt so schnell lädt
- Themes (nur visuell): *Verlassene Fabrik*, *Nachtfriedhof*, *Neon-Stadt*

## 6. Technisches Konzept

### 6.1 Architektur (Weiterentwicklung des Bestands)

Der bestehende Stack (Node.js, Express, `ws`, Canvas-Client in `public/`) wird
beibehalten und schrittweise ausgebaut:

```
┌────────────┐   WebSocket (JSON, später binär)   ┌──────────────────────┐
│  Browser    │ ─────────────────────────────────▶ │  Node.js Game Server  │
│  Canvas 2D  │ ◀───────────────────────────────── │  autoritative Logik   │
│  Prediction │        Snapshots @ 20 Hz           │  Tick-Loop @ 30 Hz    │
└────────────┘                                     └──────────────────────┘
```

**Wichtigste Änderung gegenüber dem Prototyp:** Der Server wird **autoritativ**.
Aktuell schickt der Client fertige Positionen (`move { x, y }`) — das ist
cheatanfällig und für das Schatten-System unbrauchbar. Stattdessen:

1. Client sendet nur **Inputs** (Richtung gedrückt, Bombe, Schattenform)
2. Server simuliert in einer festen **Tick-Loop (30 Hz)** Bewegung, Kollision, Bomben, Licht
3. Server sendet **Snapshots (20 Hz)** — aber pro Spieler gefiltert!

### 6.2 Interest Management (das Herz des Schatten-Systems)

Unsichtbarkeit muss **serverseitig** durchgesetzt werden, sonst genügt ein
Blick in die DevTools, um alle Gegner zu sehen:

- Der Server berechnet pro Tick die Sichtbarkeitsmenge jedes Spielers (Lichtradien + Explosionsblitze + aktive Effekte)
- Jeder Spieler erhält **nur die Entitäten in seinem Snapshot, die er sehen darf**
- Geräusch-/Richtungshinweise werden als abstrakte Events gesendet (`{ type: 'noise', direction: 'NE' }`), nie mit exakten Koordinaten

### 6.3 Netcode

- **Client-Side Prediction** für die eigene Figur + Server-Reconciliation (Inputs mit Sequenznummern)
- **Entity Interpolation** (~100 ms Puffer) für Gegner — kaschiert auch das Ein-/Ausblenden an Lichtgrenzen
- Nachrichten zunächst JSON; bei Bedarf Wechsel auf kompaktes Binärformat (`ArrayBuffer`)
- Heartbeat/Ping-Messung; Disconnect-Toleranz 5 s (Spieler wird „eingefroren", dann entfernt)

### 6.4 Rendering (Client)

- Canvas 2D bleibt; Licht als zweiter Offscreen-Canvas („Darkness Layer"): schwarze Fläche, aus der radiale Gradienten pro Lichtquelle mit `globalCompositeOperation: 'destination-out'` ausgestanzt werden
- Memory Fog: einmal gesehene Kartenkacheln werden abgedunkelt weitergezeichnet
- Später optional Upgrade auf WebGL/PixiJS, falls Performance auf Mobile nicht reicht

### 6.5 Persistenz & Meta (Phase 3+)

- Lobby-/Matchmaking-Service, öffentliche Raumliste mit Raum-Codes (wie bisher)
- Optional Konten & Statistiken (Wins, K/D, Lieblings-Power-up) — z. B. via Supabase (Auth + Postgres)
- Kosmetik-Unlocks (Skins, Bombendesigns, Lichtfarben) — rein kosmetisch, kein Pay-to-win

## 7. Roadmap

### Phase 1 — Fundament (autoritativer Server)
- [ ] Tick-Loop + Input-basiertes Protokoll (ersetzt `move { x, y }`)
- [ ] Client-Side Prediction + Interpolation
- [ ] Rundensystem (Best-of-3) statt einfachem Restart

### Phase 2 — Schatten-MVP
- [ ] Darkness Layer + Lichtradius im Client
- [ ] Serverseitiges Interest Management (gefilterte Snapshots)
- [ ] Explosionsblitz, Fußspuren, Geräusch-Indikator
- [ ] Laternen als zerstörbare Lichtquellen

### Phase 3 — Tiefe
- [ ] Shadow Meter + Schattenform
- [ ] Neue Power-ups (Fackel, Dunkelbombe, Drittes Auge, …)
- [ ] Sudden Death, Team-Modus Shadow Hunt
- [ ] Neue Kacheln (Spiegel-Block, Schattenteich), Karten-Themes

### Phase 4 — Online-Poliertheit
- [ ] Lobby mit öffentlicher Raumliste, Zuschauermodus
- [ ] Konten & Statistiken, Kosmetik
- [ ] Battle-Royale-Modus (8 Spieler, Shadow Shrink)
- [ ] Mobile-Touch-Feinschliff, Sound-Design

## 8. Offene Design-Fragen

1. **Sichtbarkeit der eigenen Bomben für Gegner:** Glühen sichtbar ab Timer < 1 s oder immer schwach? (Playtest nötig)
2. **Shadow-Meter-Ladezeit:** 3 s fühlen sich richtig an, könnten aber Camping fördern → evtl. nur Laden bei Bewegung
3. **Teamsicht in 2v2:** Teilen Teammitglieder ihre Lichtradien? (Vorschlag: ja — stärkt Koordination)
4. **Explosionsblitz-Radius:** global vs. lokal — global ist einfacher, lokal taktischer
