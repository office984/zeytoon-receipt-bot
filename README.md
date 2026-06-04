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
│   └── index.js          # Express Server + Telegram Bot
├── src/
│   ├── Dashboard.jsx     # React Dashboard
│   └── Dashboard.css     # Styling
├── package.json
├── .env.example
└── README.md
```

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

### 4. **Lokal starten (Testing)**

```bash
npm run dev
```

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
1. 📸 Benutzer lädt Foto in Telegram
   ↓
2. 🤖 Bot verarbeitet mit Vision API
   ↓
3. 📋 Bot erkennt automatisch:
   - Lieferant
   - MwSt-Satz
   - Text
   ↓
4. ❓ Bot fragt:
   - Bar oder Karte?
   - Konto?
   ↓
5. 📄 PDF erstellt & in Firebase gespeichert
   ↓
6. ✅ Bestätigung in Telegram
   ↓
7. 📊 Erscheint im Dashboard
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
