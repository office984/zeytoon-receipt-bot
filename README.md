# 🧾 Zeytoon Receipt Processing Bot

Ein vollautomatischer Telegram-Bot zur Verarbeitung und Verwaltung von Rechnungen mit Google Cloud Vision API und Firebase.

## ✨ Features

- 📸 **Automatische Bilderkennung** – Fotos von Rechnungen hochladen
- 🤖 **OCR (Optische Zeichenerkennung)** – Text automatisch erkennen
- 📋 **Automatisches Parsing**:
  - Lieferant erkennen
  - MwSt-Satz herauslesen
  - Betrag & Artikel extrahieren
- ❓ **Smart Questions** – Bot fragt nur noch:
  - Bar oder Karte?
  - Von welchem Konto?
- 📄 **PDF-Generierung** – Alle Daten als PDF speichern
- 📊 **Web Dashboard** – Übersichtsseite mit Filtern
- ☁️ **Firebase Sync** – Echtzeitdaten
- 🔐 **Sicher & Privat** – Alle Daten in deiner Kontrolle

## 🏗️ Architektur

```
zeytoon-receipt-bot/
├── api/
│   ├── index.js          # Express Server + Telegram Bot (Ablauf, Telegram, Firebase)
│   └── detect.js         # Erkennung aus dem OCR-Text (Betrag, MwSt, Beleg-Nr., Datum, Lieferant)
├── test/
│   └── detect.test.mjs   # Tests der Erkennung: npm test
├── src/
│   ├── Dashboard.jsx     # React Dashboard
│   └── Dashboard.css     # Styling
├── package.json
├── .env.example
└── README.md
```

### Wie die Werte vom Beleg gelesen werden (`api/detect.js`)

Die Erkennung steckt bewusst in einem eigenen Modul ohne Telegram/Firebase –
so ist sie mit `npm test` überprüfbar. Die wichtigsten Regeln:

- **Brutto**: Endbetrags-Stichwörter nach Priorität (`Zu zahlen` > `Gesamtbetrag`
  > `Summe`). `Zwischensumme`, `Trinkgeld` und `Rabatt` werden ausgeschlossen.
  Gibt es `Gegeben`/`Bar` und `Rückgeld`, wird über die Differenz gegengeprüft –
  damit wird nie das an der Kassa gegebene Bargeld als Rechnungsbetrag genommen.
- **MwSt**: zuerst eine ausdrückliche Zeile (`davon MwSt`), sonst wird die
  Steuerzeile *gerechnet* aufgelöst (welcher Wert passt zu `Netto × Satz`),
  sonst aus einem einzelnen Steuersatz und dem Brutto ermittelt. Werte über 21 %
  vom Brutto gelten als unplausibel und werden verworfen.
- **Beleg-Nr.**: in 5 Stufen, nach Priorität:
  1. Beleg/Bon/Kassa (`Belegnummer`, `Beleg-Nr.`, `BelegNr`, `Bel.-Nr.`, `Bon-Nr`,
     `Bonnummer`, `Kassabon`, `Kassenbon`, `Kassenbeleg`, `Kassenzettel`,
     `Kaufbeleg`, `Zahlungsbeleg`, `Barbeleg`, `Barumsatz Nr.` …)
  2. Rechnung/Faktura (`Rechnungsnummer`, `Rechnungs-Nr.`, `RG-Nr.`, `Rg.Nr`,
     `Re.-Nr.`, `AR-Nr.`, `ER-Nr.`, `Faktura-Nr.`, `Invoice No.`,
     `Abrechnungsnummer`, `Gutschrift Nr.` …)
  3. Vorgang/Auftrag (`Auftragsnummer`, `Vorgangsnummer`, `Geschäftsfall`,
     `Transaktionsnummer`, `Trans-Nr.`, `TA-Nr.`, `Quittung`, `Ticket`,
     `Journal-Nr`, `Buchungsnummer`, `Lieferschein-Nr.`, `Bestellnummer`,
     `Referenz-Nr.`, `Dokument-Nr.` …)
  4. ein eigenständiges `Nr.` / `Nummer` / `No.` am Zeilenanfang
  5. ganz ohne Label nur eindeutige Muster: `#4711` oder `RE-2025-0012`
  
  Kurzformen wie `RG`, `RE`, `AR`, `TA`, `LS` gelten nur, wenn `Nr`/`Nummer`
  dahinter steht. Ignoriert werden Telefon-, UID-/ATU-, Firmenbuch- (`FN`),
  GISA-, DVR-, Kunden-, Lieferanten-, Vertrags-, Konto-/IBAN-, Kassen-,
  Terminal-/Trace-, Artikel-/EAN-, TSE-/Signatur-, Serien-, Geräte- und
  Zählernummern sowie reine Jahreszahlen. Steht zwischen Label und Zahl ein
  solches Störwort (`Rechnung für Kunden-Nr 4455`), wird nichts übernommen.
  Ähnliche Wörter lösen keinen Treffer aus: `Bonus` ist kein `Bon`,
  `Rechnungsdatum` keine `Rechnungsnummer`. Grundsatz bleibt:
  **lieber keine Nummer als eine falsche.**
- **Datum**: erkannt werden `03.10.2025`, `03/10/2025`, `03-10-2025`, `3.10.25`,
  `2025-10-03` (ISO), `03. 10. 2025`, `3. Oktober 2025`, `3. Okt 2025`,
  `1. Jänner 2025` und englisch `October 3, 2025`.
  Label-Priorität: `Rechnungsdatum`/`Belegdatum` > `Datum`/`vom`/`am` >
  `Lieferdatum`. Nie genommen werden Zeilen mit `Zahlbar bis`, `Fällig`,
  `Zahlungsziel`, `Skonto`, `Gültig bis`, `MHD`. Verworfen werden außerdem
  unmögliche Tage (31.02.), Datumsangaben in der Zukunft und ältere als 3 Jahre.
- **Lieferant**: bekanntes Stichwort gewinnt, und zwar der Treffer, der am
  weitesten oben steht. Findet die Liste nichts, wird die volle Firmenbezeichnung
  aus dem Belegkopf gelesen (inkl. Rechtsform, auch über zwei Zeilen).

### Beleg-Art: Kassenrechnung vs. Eingangsrechnung

Buchhaltungs-Regel im Betrieb:

| Zahlungsart | Beleg-Art | Kennzeichen |
| --- | --- | --- |
| Bar | Kassenrechnung | 🟢 |
| Karte / Überweisung | Eingangsrechnung | 🔵 |

Die Beschriftung unter jedem fertigen PDF beginnt mit **Beleg-Art + Monat**, z.B.
`🟢 KASSENRECHNUNG · August 2026`. Damit sieht man beim Durchscrollen in der
Gruppe sofort, in welchen Monatsordner der Beleg gehört und ob er zur Kassa
oder zu den Eingangsrechnungen zählt. Die Art wird auch in der Prüf-Übersicht,
bei `/letzter` und als Feld `kind` in Firebase geführt; `/zusammenfassung`
weist beide Gruppen getrennt aus.

### Doppelte Belege

Vor dem Speichern wird gewarnt, wenn im selben Chat bereits ein Beleg mit
**gleichem Lieferant + Betrag + Datum + Zahlungsart** liegt – oder mit gleicher
Beleg-Nr. beim selben Lieferanten.

## 🚀 Schnellstart

### 1. **Repository clonen**

```bash
git clone https://github.com/office984/zeytoon-receipt-bot.git
cd zeytoon-receipt-bot
```

### 2. **Dependencies installieren**

```bash
npm install
```

### 3. **Environment Setup**

Kopiere `.env.example` zu `.env`:

```bash
cp .env.example .env
```

Dann fülle folgende Werte aus:

```env
TELEGRAM_BOT_TOKEN=<dein-bot-token>
GOOGLE_VISION_API_KEY=<dein-vision-api-key>
FIREBASE_API_KEY=<dein-firebase-key>
WEBHOOK_URL=https://your-app.railway.app/api/webhook
```

### 4. **Lokal starten**

Lokal gibt es keine öffentliche URL für den Webhook – dafür in der `.env`
`USE_POLLING=true` setzen, dann holt der Bot die Nachrichten selbst ab:

```bash
npm run dev
```

> Auf dem Server muss `USE_POLLING=false` bleiben, sonst wird der Webhook gelöscht.

### 5. **Tests der Beleg-Erkennung**

```bash
npm test
```

Prüft anhand echter Beleg-Beispiele, ob Betrag, MwSt, Beleg-Nr., Datum und
Lieferant richtig gelesen werden. Wenn ein Beleg falsch erkannt wird: den
OCR-Text (`DEBUG_OCR=true`) als neuen Testfall in `test/detect.test.mjs`
aufnehmen, dann die Regel in `api/detect.js` anpassen.

## 📋 Setup-Anleitung

### Telegram Bot erstellen

1. Öffne Telegram und suche **@BotFather**
2. Schreib: `/newbot`
3. Folge den Anweisungen
4. Du erhältst einen **Bot Token** – speichern!
5. Bot zur Gruppe hinzufügen

### Google Cloud Vision API

1. Gehe zu [Google Cloud Console](https://console.cloud.google.com)
2. Projekt: **Zeytoon Belege** öffnen
3. APIs → **Cloud Vision API** aktivieren
4. Anmeldedaten → **API-Schlüssel erstellen**
5. Schlüssel kopieren und in `.env` einfügen

### Firebase

Deine bestehende Firebase DB nutzen:
- Project ID: `zeytoon-belege`
- Database: `https://zeytoon-belege.firebaseio.com`

### Railway Deployment

1. Gehe zu [Railway.app](https://railway.app)
2. Neues Projekt
3. GitHub repo verbinden (`office984/zeytoon-receipt-bot`)
4. Environment Variables setzen (aus `.env`)
5. Deploy!

**Webhook URL:** `https://your-app.railway.app/api/webhook`

## 🤖 Bot Commands

| Command | Beschreibung |
|---------|-------------|
| `/start` | Bot starten |
| `/help` | Hilfe anzeigen |
| `/dashboard` | Dashboard öffnen |

## 📸 So funktioniert der Workflow

```
1. 📸 Benutzer lädt Foto(s) oder PDF in Telegram
   (mehrere Fotos auf einmal = eine Rechnung mit mehreren Seiten)
   ↓
2. 🤖 Bot liest den Text mit der Vision API
   ↓
3. 📋 Bot erkennt automatisch:
   - Lieferant (bekannte Liste oder Firmenname aus dem Belegkopf)
   - Brutto-Betrag und MwSt
   - Rechnungsdatum und Beleg-Nr.
   ↓
4. ❓ Bot fragt:
   - Lieferant bestätigen oder ändern (mit Such-Funktion)
   - Bar, Karte oder Überweisung? Welches Konto?
   ↓
5. 🔍 Prüf-Übersicht: alle Werte einzeln korrigierbar
   (unsichere Werte sind mit ⚠️ markiert)
   ↓
6. ⚠️ Warnung, falls der Beleg schon erfasst wurde
   ↓
7. 📄 PDF erstellt & in Firebase gespeichert
   ↓
8. ✅ Nur die fertige PDF bleibt im Chat
   ↓
9. 📊 Erscheint im Dashboard
```

## 💾 Datenspeicherung

Alle Rechnungen werden in Firebase Realtime Database gespeichert:

```
/invoices/{id}/
├── fileName: "2026-06-04_Metro_Bar_Geschaeftskonto"
├── supplier: "Metro"
├── paymentMethod: "Bar"
├── account: "Geschäftskonto"
├── vatRate: "20%"
├── extractedText: "..."
├── timestamp: "2026-06-04T10:30:00Z"
└── createdAt: "2026-06-04T10:30:15Z"
```

## 🌐 API Endpoints

| Endpoint | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/webhook` | POST | Telegram Webhook |
| `/api/invoices` | GET | Alle Rechnungen |
| `/api/health` | GET | Health Check |

## 📊 Dashboard Features

- ✅ Übersicht aller Rechnungen
- 🔍 Filter nach:
  - Lieferant
  - Zahlungsart (Bar/Karte)
  - Konto
- 📈 Statistiken:
  - Gesamtanzahl
  - Bar vs. Karte
  - MwSt-Verteilung
- 🔄 Live-Updates alle 10 Sekunden

## 🔐 Sicherheit

- ✅ `.env` ist in `.gitignore` (Secrets werden NICHT gepusht)
- ✅ API Keys nur auf dem Server, nicht im Browser
- ✅ Firebase Rules sind aktiviert
- ✅ HTTPS für alle Webhooks

## 🆘 Troubleshooting

### Bot antwortet nicht

1. Prüfe Telegram Bot Token
2. Prüfe Webhook in Telegram: `curl https://api.telegram.org/botTOKEN/getWebhookInfo`
3. Schau Railway Logs

### Firebase Fehler

1. Prüfe API Key
2. Prüfe Database URL
3. Prüfe Firebase Rules (sollten `public` sein für Testing)

### Vision API Error

1. Prüfe API Key
2. Prüfe ob API aktiviert ist
3. Prüfe API Quota

## 📚 Abhängigkeiten

```json
{
  "express": "REST API Server",
  "telegraf": "Telegram Bot Framework",
  "@google-cloud/vision": "OCR & Bilderkennung",
  "firebase": "Realtime Database",
  "pdfkit": "PDF Generierung",
  "sharp": "Bildverarbeitung"
}
```

## 📝 Lizenz

MIT – Kostenfrei nutzbar

## 👨‍💼 Entwickler

**Zeytoon GmbH** – Wien, Österreich

---

**Version:** 1.0.0  
**Erstellt:** Juni 2026  
**Status:** ✅ Production Ready
