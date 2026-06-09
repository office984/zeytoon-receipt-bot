import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = path.join(__dirname, 'temp');

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Lieferanten + Stichwörter zur automatischen Erkennung aus dem OCR-Text.
// keywords sind kleingeschrieben; Treffer mit Wortgrenzen, längster Treffer gewinnt.
// `let`, weil die Liste zur Laufzeit um neu gelernte Lieferanten wächst (siehe learnSupplier).
let SUPPLIERS = [
  { name: 'Metro 1110', keywords: ['metro'] },
  { name: 'GastroGenius GmbH', keywords: ['gastrogenius', 'gastro genius'] },
  { name: 'Sahan Einzelhandel GmbH', keywords: ['sahan'] },
  { name: 'Rubin GmbH', keywords: ['rubin'] },
  { name: 'Orient GmbH', keywords: ['orient'] },
  { name: 'Shirinagha Hussaini (Tandori Brot)', keywords: ['shirinagha', 'hussaini', 'tandori'] },
  { name: 'Spar', keywords: ['spar'] },
  { name: 'Dr. Falafel', keywords: ['falafel'] },
  { name: 'IG Gastro', keywords: ['ig gastro'] },
  { name: 'Kaffee Partner', keywords: ['kaffee partner'] },
  { name: 'AKM', keywords: ['akm'] },
  { name: 'Hofer', keywords: ['hofer'] },
  { name: 'JET Tankstelle', keywords: ['jet tankstelle', 'jet '] },
  { name: 'Interspar', keywords: ['interspar'] },
  { name: 'Alizadeh Ashouri', keywords: ['alizadeh', 'ashouri'] },
  { name: 'Reza Davoudi', keywords: ['reza davoudi', 'davoudi'] },
  { name: 'Etsan', keywords: ['etsan'] },
  { name: 'T-Mobile', keywords: ['t-mobile', 't mobile', 'tmobile', 'magenta telekom'] },
  { name: 'SWV Wien', keywords: ['swv wien', 'swv'] },
  { name: 'Mega Gastro GmbH', keywords: ['mega gastro', 'megagastro'] }
];

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const userSessions = {};

// Mehrere Fotos auf einmal (Telegram-Album) = EINE Rechnung mit mehreren Seiten.
// Album-Fotos kommen als getrennte Updates mit gleicher media_group_id an.
// Wir sammeln sie kurz und verarbeiten sie dann gemeinsam.
const mediaGroups = {};
const MEDIA_GROUP_DEBOUNCE_MS = 2500;

function bufferMediaGroupItem(ctx, userId, mediaGroupId, item, meta) {
  const key = `${userId}:${mediaGroupId}`;
  let group = mediaGroups[key];
  if (!group) {
    group = { items: [], meta, timer: null };
    mediaGroups[key] = group;
  }
  group.items.push(item);
  if (group.timer) clearTimeout(group.timer);
  group.timer = setTimeout(() => {
    delete mediaGroups[key];
    // In Telegram-Reihenfolge (nach Nachrichten-ID) sortieren = Seitenreihenfolge
    group.items.sort((a, b) => a.messageId - b.messageId);
    handleIncomingFile(ctx, userId, group.items, group.meta).catch((error) => {
      console.error('Media group error:', error);
      ctx.reply('❌ Fehler bei der Verarbeitung');
    });
  }, MEDIA_GROUP_DEBOUNCE_MS);
}

// Firebase Realtime Database (REST). Optionaler Auth-Token via FIREBASE_DB_SECRET.
const FIREBASE_DB = (process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');
const FIREBASE_AUTH = process.env.FIREBASE_DB_SECRET ? `?auth=${process.env.FIREBASE_DB_SECRET}` : '';

const MONTHS_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
];

console.log('🤖 Bot initialized');

// ---------- Helpers ----------

// ctx.reply, das die Message-ID merkt, damit sie am Ende gelöscht werden kann
async function trackReply(ctx, session, text, extra) {
  const msg = await ctx.reply(text, extra);
  if (session) session.botMessages.push(msg.message_id);
  return msg;
}

// Alle Zwischen-Nachrichten + das hochgeladene Original löschen -> nur PDF bleibt
async function cleanupMessages(ctx, session) {
  const ids = [...(session.botMessages || [])];
  if (session.userMessageIds) ids.push(...session.userMessageIds);
  for (const id of ids) {
    await ctx.telegram.deleteMessage(session.chatId, id).catch(() => {});
  }
}

// Text normalisieren: klein, ohne Akzente, einfache Leerzeichen
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lieferant aus OCR-Text erkennen. Gibt den Namen zurück oder null.
function matchSupplier(text) {
  const norm = normalize(text);
  if (!norm) return null;

  let best = null;
  let bestLen = 0;

  for (const supplier of SUPPLIERS) {
    for (const kw of supplier.keywords) {
      const nk = normalize(kw);
      if (!nk) continue;
      const re = new RegExp(`\\b${escapeRegex(nk)}`, 'i');
      if (re.test(norm) && nk.length > bestLen) {
        best = supplier;
        bestLen = nk.length;
      }
    }
  }

  return best ? best.name : null;
}

// --- Freies Auslesen des Lieferanten aus dem Beleg-Kopf (wenn die Liste nicht trifft) ---
// Rechtsformen = starkes Signal für den Firmennamen
const LEGAL_FORM_RE = /\b(gmbh|gesmbh|ges\.?\s?m\.?\s?b\.?\s?h|e\.?\s?u\.?|kg|og|ohg|ag|e\.?\s?gen)\b/i;
// Zeilen, die KEIN Firmenname sind (Belegkopf-Rauschen)
const HEADER_NOISE_RE = /(rechnung|kassabon|kassenbon|beleg|quittung|datum|uhrzeit|uid|atu|steuer|tel\.?|telefon|fax|www\.|http|@|iban|bic|filiale|kunde|seite|betrag|summe|gesamt|mwst|ust)/i;
const ADDRESS_RE = /(stra(ss|ß)e|str\.|gasse|platz|\b\d{4}\b)/i; // Straße / 4-stellige PLZ
const DATE_LINE_RE = /\b\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}\b/;

// Eine Kopf-Zeile in einen sauberen Lieferantennamen verwandeln
function cleanSupplierName(line) {
  return (line || '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\d]+/u, '')      // führende Symbole weg
    .replace(/[^\p{L}\d.)\s&+-]+$/u, '') // Müll am Ende weg
    .trim();
}

// Lieferantennamen frei aus den ersten Belegzeilen raten. Gibt Namen oder null zurück.
function guessSupplierFromText(text) {
  if (!text) return null;
  const header = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 12);

  // 1) Zeile mit Rechtsform (GmbH, e.U., KG ...) = sehr wahrscheinlich der Name
  for (const line of header) {
    if (LEGAL_FORM_RE.test(line) && !HEADER_NOISE_RE.test(line)) {
      const name = cleanSupplierName(line);
      if (name.length >= 3 && name.length <= 50) return name;
    }
  }

  // 2) Sonst: erste „firmen-artige" Zeile (genug Buchstaben, keine Adresse/Datum/Rauschen)
  for (const line of header) {
    if (HEADER_NOISE_RE.test(line) || ADDRESS_RE.test(line) || DATE_LINE_RE.test(line)) continue;
    const letters = (line.match(/\p{L}/gu) || []).length;
    const digits = (line.match(/\d/gu) || []).length;
    if (letters < 3 || digits > letters) continue; // zu wenig Text / zu viele Zahlen
    const name = cleanSupplierName(line);
    if (name.length >= 3 && name.length <= 50) return name;
  }

  return null;
}

// OCR für Bilder über Google Vision REST API (mit API-Key)
async function ocrImage(base64) {
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`;
  const { data } = await axios.post(url, {
    requests: [
      {
        image: { content: base64 },
        features: [{ type: 'TEXT_DETECTION' }]
      }
    ]
  });
  const res = data.responses?.[0];
  const text = res?.fullTextAnnotation?.text || res?.textAnnotations?.[0]?.description || '';

  // Bounding-Box über den GESAMTEN erkannten Text = ungefähr die Rechnung
  let bbox = null;
  const verts = res?.textAnnotations?.[0]?.boundingPoly?.vertices;
  if (verts && verts.length) {
    const xs = verts.map((v) => v.x || 0);
    const ys = verts.map((v) => v.y || 0);
    bbox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  return { text, bbox };
}

// Bild auf den Rechnungs-Bereich zuschneiden (Hintergrund weg). Fällt bei Fehler auf Original zurück.
async function cropToReceipt(buffer, bbox) {
  if (!bbox) return buffer;
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (error) {
    console.error('sharp nicht verfügbar – kein Zuschnitt:', error.message);
    return buffer;
  }
  try {
    const img = sharp(buffer);
    const meta = await img.metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) return buffer;

    const boxW = bbox.maxX - bbox.minX;
    const boxH = bbox.maxY - bbox.minY;
    const padX = Math.round(boxW * 0.05);
    // Oben etwas mehr Rand (Logo/Kopf), unten deutlich mehr:
    // QR-Code + Infos sind KEIN Text und liegen daher unterhalb der Text-Box.
    const padTop = Math.round(boxH * 0.08);
    const padBottom = Math.round(boxH * 0.40);
    const left = Math.max(0, bbox.minX - padX);
    const top = Math.max(0, bbox.minY - padTop);
    const right = Math.min(W, bbox.maxX + padX);
    const bottom = Math.min(H, bbox.maxY + padBottom);
    const width = right - left;
    const height = bottom - top;

    // Sicherheits-Check: kein sinnloser Mini-Zuschnitt
    if (width < 40 || height < 40 || width * height < W * H * 0.05) return buffer;

    return await img.extract({ left, top, width, height }).toBuffer();
  } catch (error) {
    console.error('Zuschnitt fehlgeschlagen:', error.message);
    return buffer;
  }
}

// OCR für PDFs (synchron, bis 5 Seiten) über Google Vision files:annotate
async function ocrPdf(base64) {
  const url = `https://vision.googleapis.com/v1/files:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`;
  const { data } = await axios.post(url, {
    requests: [
      {
        inputConfig: { content: base64, mimeType: 'application/pdf' },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
      }
    ]
  });
  const pages = data.responses?.[0]?.responses || [];
  return pages.map((p) => p.fullTextAnnotation?.text || '').join('\n');
}

// Datei von Telegram herunterladen -> Buffer + Metadaten
async function downloadTelegramFile(ctx, fileId) {
  const file = await ctx.telegram.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const ext = (file.file_path.split('.').pop() || 'bin').toLowerCase();
  return { buffer: Buffer.from(response.data), ext };
}

// Dateiname erzeugen
function generateFileName(data) {
  // Rechnungsdatum vom Beleg, sonst heutiges Datum
  const date = data.date || new Date().toISOString().split('T')[0];
  const supplier = (data.supplier || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
  const payment = (data.paymentMethod || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_');
  // Statt Konto kommt die Beleg-Nr. ans Ende (Karte BAWAG/N26 bleibt im payment-Teil)
  const belegNr = (data.receiptNumber || 'ohneNr').replace(/[^a-zA-Z0-9]/g, '');
  return `${date}_${supplier}_${payment}_${belegNr}`;
}

// PDF aus einem oder mehreren Bildern erstellen (ein Bild = eine Seite)
function createPdfFromImages(imagePaths, pdfPath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 10 });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

      imagePaths.forEach((imagePath, idx) => {
        if (idx > 0) doc.addPage();

        const img = doc.openImage(imagePath);
        const pageWidth = doc.page.width - 20;
        const pageHeight = doc.page.height - 20;

        let width = img.width;
        let height = img.height;

        if (width > pageWidth) {
          const ratio = pageWidth / width;
          width = pageWidth;
          height = height * ratio;
        }
        if (height > pageHeight) {
          const ratio = pageHeight / height;
          height = pageHeight;
          width = width * ratio;
        }

        const x = (doc.page.width - width) / 2;
        const y = (doc.page.height - height) / 2;

        doc.image(imagePath, x, y, { width, height });
      });

      doc.end();

      stream.on('finish', resolve);
      stream.on('error', reject);
    } catch (error) {
      reject(error);
    }
  });
}

// ---------- MwSt (VAT) Erkennung ----------

// "1.234,56" / "12,50" / "12.50" -> Number
function parseAmount(s) {
  s = (s || '').trim();
  if (s.includes(',')) {
    return parseFloat(s.replace(/\./g, '').replace(/\s/g, '').replace(',', '.'));
  }
  return parseFloat(s.replace(/\s/g, ''));
}

// Geldbeträge im Text finden (europäisches Format bevorzugt)
const MONEY_REGEX = /\d{1,3}(?:[.\s]\d{3})*,\d{2}|\d+,\d{2}|\d+\.\d{2}/g;

// Zeile besteht im Wesentlichen nur aus einem Geldbetrag (z.B. "125.12", "1.376,35", "€ 12,50")
function isMoneyLine(line) {
  return /^\s*€?\s*\d[\d.\s]*[.,]\d{2}\s*$/.test(line);
}

// Best-effort: bezahlte MwSt aus OCR-Text lesen. Gibt Number oder null.
function detectVat(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // 1) Tabellen-Format (AT-Kassenbons): Kopfzeile "Brutto Netto MwSt",
  //    danach Summen-Zeile mit drei Werten -> MwSt ist der kleinste.
  const headerIdx = lines.findIndex(
    (l) => /brutto/i.test(l) && /netto/i.test(l) && /mwst/i.test(l)
  );
  if (headerIdx >= 0) {
    let sumIdx = -1;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (/\bsumme\b/i.test(lines[i])) { sumIdx = i; break; }
    }
    const start = sumIdx >= 0 ? sumIdx + 1 : headerIdx + 1;
    const amounts = [];
    for (let i = start; i < lines.length; i++) {
      const l = lines[i];
      if (isMoneyLine(l)) {
        const v = parseAmount(l.replace(/[€\s]/g, ''));
        if (!isNaN(v)) amounts.push(v);
      } else if (amounts.length) {
        break; // Zahlenblock zu Ende
      } else if (/%/.test(l) || l === '' || /^\d+$/.test(l)) {
        continue; // Rate / Leerzeile / einzelne Ziffer überspringen
      }
    }
    if (amounts.length) return Math.min(...amounts);
  }

  // 2) Fallback: Zeile mit MwSt-Stichwort + Betrag auf derselben Zeile
  const vatKey = /(mwst|mw\.?\s?st|u\.?\s?st\b|ust|mehrwertsteuer|m\.?w\.?s\.?t)/i;
  const totalKey = /(gesamt|summe|total)/i;
  const totals = [];
  const rates = [];
  for (const raw of lines) {
    const line = raw.toLowerCase();
    if (!vatKey.test(line)) continue;
    const amounts = raw.match(MONEY_REGEX);
    if (!amounts) continue;
    const val = parseAmount(amounts[amounts.length - 1]);
    if (isNaN(val)) continue;
    if (totalKey.test(line)) totals.push(val);
    else rates.push(val);
  }
  if (totals.length) return Math.max(...totals);
  if (rates.length) return Math.round(rates.reduce((a, b) => a + b, 0) * 100) / 100;
  return null;
}

// Brutto-/Gesamtbetrag aus OCR-Text lesen. Gibt Number oder null.
// Sucht nach Endbetrags-Stichwörtern (nach Priorität), sonst den größten Betrag.
function detectTotal(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // Auf einer Treffer-Zeile ist der Brutto-/Endbetrag der GRÖSSTE Betrag
  // (z.B. Tabellenzeile "Summe 24,00 20,00 4,00" -> 24,00, nicht die MwSt 4,00).
  const amountOf = (line) => {
    const a = (line.match(MONEY_REGEX) || []).map(parseAmount).filter((v) => !isNaN(v));
    return a.length ? Math.max(...a) : NaN;
  };

  const keyTiers = [
    /(zu\s*zahlen|zahlbetrag|zahlungsbetrag)/i,
    /(gesamtbetrag|rechnungsbetrag|gesamt|total)/i,
    /(brutto|summe|betrag)/i
  ];
  for (const key of keyTiers) {
    let best = null;
    for (const line of lines) {
      if (!key.test(line)) continue;
      const v = amountOf(line);
      if (!isNaN(v)) best = best === null ? v : Math.max(best, v);
    }
    if (best !== null) return best;
  }

  // Fallback: größter Geldbetrag im ganzen Text (meist der Brutto-Gesamtbetrag)
  let max = null;
  for (const line of lines) {
    for (const t of line.match(MONEY_REGEX) || []) {
      const v = parseAmount(t);
      if (!isNaN(v) && (max === null || v > max)) max = v;
    }
  }
  return max;
}

function euro(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toFixed(2).replace('.', ',') + ' €';
}

// Beleg-/Rechnungs-/Bonnummer aus OCR-Text lesen. Gibt String oder null.
// Mehrstufig: zuerst spezifische Labels (Beleg/Bon/Rechnung/...), dann ein
// eigenständiges "Nr./No.". Der Wert darf auf derselben ODER der nächsten Zeile
// stehen. Datum/Uhrzeit/UID/Geldbeträge werden vorher entfernt, damit z.B. nicht
// die Jahreszahl eines Datums fälschlich als Nummer übernommen wird.
function detectReceiptNumber(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // Datum / Uhrzeit / UID / Beträge aus einem Zeilenrest entfernen
  const stripNoise = (s) =>
    (s || '')
      .replace(/\b\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}\b/g, ' ') // Datum
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')          // Uhrzeit
      .replace(/\batu\s?\d+/gi, ' ')                          // UID
      .replace(/\b\d{1,3}(?:\.\d{3})+,\d{2}\b/g, ' ')         // 1.234,00
      .replace(/\b\d+,\d{2}\b/g, ' ');                        // 12,40

  // Eine Nummer (opt. Buchstaben-Präfix, >=3 Ziffern, mit Trennern) herausziehen
  const grab = (s) => {
    const clean = stripNoise(s);
    const re = /([A-Z]{0,5}[-\/.]?\d{3,}(?:[-\/.][A-Z0-9]+)*)/gi;
    let m;
    while ((m = re.exec(clean)) !== null) {
      const v = m[1].replace(/^[-\/.]+|[-\/.]+$/g, '');
      if (v && /\d/.test(v)) return v;
    }
    return null;
  };

  // Wert nach dem Label – sonst in den nächsten 1-2 Zeilen (Label/Wert in 2 Spalten)
  const valueFrom = (rest, i) => {
    let v = grab(rest);
    if (v) return v;
    for (let k = i + 1; k < Math.min(i + 3, lines.length); k++) {
      if (lines[k]) { v = grab(lines[k]); if (v) return v; }
    }
    return null;
  };

  // Spezifische Labels nach Priorität (Position im Text egal, erster Treffer gewinnt).
  // Der Lookahead verhindert Teilwort-Treffer (z.B. "Bonus", "Restaurant").
  const tiers = [
    /\b(?:beleg|bon|kassenbon|kassabon|belegid)s?(?=[\s:#.\-]|nr|nummer|no\b|$)\s*[-.:#]?\s*(?:nr|nummer|no|number|n°)?\.?\s*[:#]?\s*(.*)/i,
    /\b(?:rechnung|faktura|invoice|rg|re)s?(?=[\s:#.\-]|nr|nummer|no\b|$)\s*[-.:#]?\s*(?:nr|nummer|no|number|n°)?\.?\s*[:#]?\s*(.*)/i,
    /\b(?:quittung|auftrag|transaktion|vorgang|receipt|ta)s?(?=[\s:#.\-]|nr|nummer|no\b|$)\s*[-.:#]?\s*(?:nr|nummer|no|number|n°)?\.?\s*[:#]?\s*(.*)/i
  ];
  for (const re of tiers) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      const v = valueFrom(m[1], i);
      if (v) return v;
    }
  }

  // Eigenständiges "Nr./No." – aber NICHT auf Telefon-/UID-/Steuer-/Kunden-Zeilen
  const genericSkip = /(tel|telefon|fax|iban|bic|uid|atu|steuer|st\.?\s?nr|ust|kunden|kassen[\s-]*id|terminal|\btid\b|\bmid\b)/i;
  const genericNr = /\b(?:nr|no|n°|nummer|number)\b\.?\s*[:#]?\s*(.*)/i;
  for (let i = 0; i < lines.length; i++) {
    if (genericSkip.test(lines[i])) continue;
    const m = lines[i].match(genericNr);
    if (!m) continue;
    const v = valueFrom(m[1], i);
    if (v) return v;
  }
  return null;
}

// Rechnungsdatum aus OCR-Text lesen (TT.MM.JJJJ / TT/MM/JJJJ / TT.MM.JJ). Gibt 'YYYY-MM-DD' oder null.
function detectDate(text) {
  if (!text) return null;
  const re = /\b(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{2,4})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let d = parseInt(m[1], 10);
    let mo = parseInt(m[2], 10);
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    if (y < 2020 || y > 2035) continue;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

// ---------- Zeit-Helfer ----------
function monthKeyOf(date) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}
function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTHS_DE[parseInt(m, 10) - 1]} ${y}`;
}
function prevMonthKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

// ---------- Firebase (REST) ----------
async function saveInvoice(record) {
  if (!FIREBASE_DB) return null;
  try {
    const { data } = await axios.post(`${FIREBASE_DB}/invoices.json${FIREBASE_AUTH}`, record);
    return data?.name || null; // von Firebase vergebener Push-Key
  } catch (error) {
    console.error('Firebase save error:', error.response?.status, error.response?.data || error.message);
    return null;
  }
}

// Einzelnen Beleg aktualisieren (Korrektur) bzw. löschen
async function updateInvoice(key, patch) {
  if (!FIREBASE_DB || !key) return;
  try {
    await axios.patch(`${FIREBASE_DB}/invoices/${key}.json${FIREBASE_AUTH}`, patch);
  } catch (error) {
    console.error('Firebase update error:', error.message);
  }
}

async function deleteInvoiceByKey(key) {
  if (!FIREBASE_DB || !key) return;
  try {
    await axios.delete(`${FIREBASE_DB}/invoices/${key}.json${FIREBASE_AUTH}`);
  } catch (error) {
    console.error('Firebase delete error:', error.message);
  }
}

async function loadInvoices() {
  if (!FIREBASE_DB) return {};
  try {
    const { data } = await axios.get(`${FIREBASE_DB}/invoices.json${FIREBASE_AUTH}`);
    return data || {};
  } catch (error) {
    console.error('Firebase load error:', error.response?.status || error.message);
    return {};
  }
}

// Sucht einen bereits gespeicherten Beleg mit gleicher Beleg-Nr. im selben Chat.
async function findDuplicate(chatId, receiptNumber) {
  if (!receiptNumber) return null;
  const inv = await loadInvoices();
  return (
    Object.values(inv || {}).find(
      (r) => r && r.chatId === chatId && r.receiptNumber === receiptNumber
    ) || null
  );
}

async function wasSummaryPosted(chatId, month) {
  if (!FIREBASE_DB) return false;
  try {
    const { data } = await axios.get(`${FIREBASE_DB}/summariesPosted/${chatId}/${month}.json${FIREBASE_AUTH}`);
    return data === true;
  } catch {
    return false;
  }
}

async function markSummaryPosted(chatId, month) {
  if (!FIREBASE_DB) return;
  try {
    await axios.put(`${FIREBASE_DB}/summariesPosted/${chatId}/${month}.json${FIREBASE_AUTH}`, true);
  } catch (error) {
    console.error('Firebase mark error:', error.message);
  }
}

// ---------- Gelernte Lieferanten (wachsende Liste in Firebase) ----------
async function loadLearnedSuppliers() {
  if (!FIREBASE_DB) return [];
  try {
    const { data } = await axios.get(`${FIREBASE_DB}/suppliers.json${FIREBASE_AUTH}`);
    // Firebase liefert {pushId: {...}} -> in Array wandeln
    return data ? Object.values(data).filter((s) => s && s.name) : [];
  } catch (error) {
    console.error('Firebase suppliers load error:', error.response?.status || error.message);
    return [];
  }
}

async function persistLearnedSupplier(entry) {
  if (!FIREBASE_DB) return;
  try {
    await axios.post(`${FIREBASE_DB}/suppliers.json${FIREBASE_AUTH}`, entry);
  } catch (error) {
    console.error('Firebase supplier save error:', error.message);
  }
}

// Neuen Lieferanten in die laufende Liste übernehmen + dauerhaft speichern.
// Dedupliziert über den normalisierten Namen / vorhandene Stichwörter.
// Gibt true zurück, wenn wirklich neu gelernt wurde.
function learnSupplier(rawName) {
  const name = (rawName || '').trim();
  const norm = normalize(name);
  if (!norm) return false;
  const exists = SUPPLIERS.some(
    (s) => normalize(s.name) === norm || s.keywords.some((k) => normalize(k) === norm)
  );
  if (exists) return false;

  // Stichwörter ableiten: voller Name + (falls markant) erstes Wort
  const keywords = [norm];
  const firstWord = norm.split(' ').find((w) => w.length >= 5 && !/^\d+$/.test(w));
  if (firstWord && firstWord !== norm) keywords.push(firstWord);

  const entry = { name, keywords };
  SUPPLIERS.push(entry);          // sofort in dieser Session nutzbar
  persistLearnedSupplier(entry);  // im Hintergrund dauerhaft speichern
  console.log(`📇 Neuer Lieferant gelernt: ${name}`);
  return true;
}

// ---------- Zusammenfassung ----------
function summarize(invoicesObj, month, chatId) {
  const recs = Object.values(invoicesObj || {}).filter(
    (r) => r && r.month === month && (chatId == null || r.chatId === chatId)
  );
  const count = recs.length;
  const withVat = recs.filter((r) => typeof r.vat === 'number');
  const withTotal = recs.filter((r) => typeof r.total === 'number');
  const vatTotal = Math.round(withVat.reduce((s, r) => s + r.vat, 0) * 100) / 100;
  const grandTotal = Math.round(withTotal.reduce((s, r) => s + r.total, 0) * 100) / 100;
  return {
    count,
    vatTotal,
    grandTotal,
    missingVat: count - withVat.length,
    missingTotal: count - withTotal.length
  };
}

function summaryText(label, s) {
  let txt =
    `📊 *Zusammenfassung ${label}*\n\n` +
    `🧾 Belege: ${s.count}\n` +
    `💰 Ausgaben gesamt (Brutto): ${euro(s.grandTotal)}\n` +
    `💶 davon MwSt: ${euro(s.vatTotal)}`;
  const notes = [];
  if (s.missingTotal > 0) notes.push(`${s.missingTotal}× ohne Betrag`);
  if (s.missingVat > 0) notes.push(`${s.missingVat}× ohne MwSt`);
  if (notes.length) {
    txt += `\n\n⚠️ Nicht automatisch gelesen: ${notes.join(', ')}.`;
  }
  return txt;
}

async function postMonthlySummaries() {
  const month = prevMonthKey(new Date());
  const inv = await loadInvoices();
  const recs = Object.values(inv || {}).filter((r) => r && r.month === month);
  const chatIds = [...new Set(recs.map((r) => r.chatId))];

  for (const chatId of chatIds) {
    if (await wasSummaryPosted(chatId, month)) continue;
    const s = summarize(inv, month, chatId);
    try {
      await bot.telegram.sendMessage(chatId, summaryText(monthLabel(month), s), { parse_mode: 'Markdown' });
      await markSummaryPosted(chatId, month);
      console.log(`📊 Monatsbericht ${month} an Chat ${chatId} gesendet`);
    } catch (error) {
      console.error('Monthly post error:', error.message);
    }
  }
}

// ---------- Commands ----------

bot.start((ctx) => {
  ctx.reply('👋 Willkommen!\n\n📸 Lade ein Rechnungs-Foto oder PDF hoch – ich lese den Lieferanten automatisch aus.');
});

bot.help((ctx) => {
  ctx.reply(
    '📸 Foto oder PDF hochladen. Ich lese Lieferant, Betrag, MwSt, Datum und Beleg-Nr. aus – ' +
    'du prüfst die Werte und kannst alles korrigieren, bevor gespeichert wird.\n\n' +
    '📊 /zusammenfassung – Ausgaben & MwSt des laufenden Monats\n' +
    '🗂️ /letzter – letzten Beleg ansehen, korrigieren oder löschen'
  );
});

// Zusammenfassung des laufenden Monats für diesen Chat
async function sendCurrentSummary(ctx) {
  const month = monthKeyOf(new Date());
  const inv = await loadInvoices();
  const s = summarize(inv, month, ctx.chat.id);
  await ctx.reply(summaryText(`${monthLabel(month)} (laufend)`, s), { parse_mode: 'Markdown' });
}

bot.command('zusammenfassung', sendCurrentSummary);
bot.command('summary', sendCurrentSummary);

// ---------- Eingang: Foto ----------
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  try {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const item = { fileId, messageId: ctx.message.message_id };
    const meta = { type: 'photo', isImage: true };

    // Album (mehrere Fotos auf einmal) -> sammeln und als EINE Rechnung verarbeiten
    if (ctx.message.media_group_id) {
      bufferMediaGroupItem(ctx, userId, ctx.message.media_group_id, item, meta);
      return;
    }

    await handleIncomingFile(ctx, userId, [item], meta);
  } catch (error) {
    console.error('Photo error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
  }
});

// ---------- Eingang: Dokument (PDF oder Bild-Datei) ----------
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  try {
    const doc = ctx.message.document;
    const mime = doc.mime_type || '';
    const isImage = mime.startsWith('image/');
    const isPdf = mime === 'application/pdf' || (doc.file_name || '').toLowerCase().endsWith('.pdf');
    const item = { fileId: doc.file_id, messageId: ctx.message.message_id };
    const meta = { type: 'document', isImage, isPdf, fileName: doc.file_name };

    // Album aus Bild-Dateien (mehrere auf einmal) -> als EINE Rechnung verarbeiten.
    // PDFs werden nicht zusammengefasst (jedes PDF ist für sich ein Beleg).
    if (ctx.message.media_group_id && isImage && !isPdf) {
      bufferMediaGroupItem(ctx, userId, ctx.message.media_group_id, item, meta);
      return;
    }

    await handleIncomingFile(ctx, userId, [item], meta);
  } catch (error) {
    console.error('Document error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
  }
});

// Gemeinsame Verarbeitung: Download -> OCR -> Lieferant erkennen
// items: Array von { fileId, messageId } – bei einem Album mehrere Seiten einer Rechnung.
async function handleIncomingFile(ctx, userId, items, meta) {
  userSessions[userId] = {
    fileId: items[0].fileId,
    chatId: ctx.chat.id,
    userMessageIds: items.map((it) => it.messageId),
    botMessages: [],
    timestamp: new Date().toISOString(),
    images: [],
    ...meta
  };
  const session = userSessions[userId];

  const pageCount = items.length;
  await trackReply(
    ctx,
    session,
    pageCount > 1 ? `🔍 Lese Rechnung (${pageCount} Seiten)...` : '🔍 Lese Rechnung...'
  );

  // OCR ausführen (Fehler -> trotzdem manuell weiter)
  let text = '';
  let ocrError = null;
  try {
    if (meta.isImage) {
      // Jede Seite herunterladen + per OCR lesen; Texte aller Seiten zusammenführen
      const texts = [];
      for (const it of items) {
        const { buffer, ext } = await downloadTelegramFile(ctx, it.fileId);
        let pageText = '';
        let pageBox = null;
        try {
          const r = await ocrImage(buffer.toString('base64'));
          pageText = r.text;
          pageBox = r.bbox;
        } catch (error) {
          ocrError = error.response?.data ? JSON.stringify(error.response.data) : error.message;
          console.error('OCR error:', ocrError);
        }
        session.images.push({ buffer, ext, cropBox: pageBox });
        if (pageText) texts.push(pageText);
      }
      text = texts.join('\n');
      // Rückwärtskompatibel: erste Seite auch als buffer/ext/cropBox bereitstellen
      if (session.images[0]) {
        session.buffer = session.images[0].buffer;
        session.ext = session.images[0].ext;
        session.cropBox = session.images[0].cropBox;
      }
    } else {
      // PDF / sonstige Datei: nur die erste (einzige) Datei
      const { buffer, ext } = await downloadTelegramFile(ctx, items[0].fileId);
      session.buffer = buffer;
      session.ext = ext;
      if (meta.isPdf) {
        text = await ocrPdf(buffer.toString('base64'));
      }
    }
  } catch (error) {
    ocrError = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error('OCR error:', ocrError);
  }

  console.log(`OCR fertig – ${text.length} Zeichen erkannt (${pageCount} Seite(n))`);

  // Debug: Rohtext anzeigen, wenn DEBUG_OCR=true (wird NICHT auto-gelöscht)
  if (process.env.DEBUG_OCR === 'true') {
    const info = text && text.trim() ? text.slice(0, 3500) : `(KEIN Text)${ocrError ? '\nFehler: ' + ocrError : ''}`;
    await ctx.reply(`🔧 DEBUG OCR:\n\n${info}`);
  }

  session.extractedText = text;
  session.vat = detectVat(text);
  session.total = detectTotal(text);
  session.invoiceDate = detectDate(text);
  session.receiptNumber = detectReceiptNumber(text);

  // Doppelten Beleg erkennen (anhand Beleg-Nr. im selben Chat)
  const dup = await findDuplicate(session.chatId, session.receiptNumber);
  if (dup) {
    await trackReply(
      ctx,
      session,
      `⚠️ *Achtung – Beleg evtl. doppelt!*\n` +
        `Beleg-Nr. ${session.receiptNumber} wurde bereits erfasst` +
        `${dup.invoiceDate ? ` (Datum ${dup.invoiceDate})` : ''}.\n\nTrotzdem verarbeiten?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Ja, trotzdem ✅', callback_data: 'dup_continue' },
              { text: 'Abbrechen ❌', callback_data: 'dup_cancel' }
            ]
          ]
        }
      }
    );
    return; // auf Entscheidung des Users warten
  }

  proceedAfterOcr(ctx, userId);
}

// Lieferant erkennen (oder fragen) und weiter zur Zahlungsart
function proceedAfterOcr(ctx, userId) {
  const session = userSessions[userId];
  if (!session) return;

  // 1) Bekannte Stichwort-Liste (sicherste Erkennung)
  let supplier = matchSupplier(session.extractedText);
  let guessed = false;
  // 2) Sonst: Lieferant frei aus dem Beleg-Kopf lesen
  if (!supplier) {
    supplier = guessSupplierFromText(session.extractedText);
    guessed = !!supplier;
  }

  if (supplier) {
    session.supplier = supplier;
    session.supplierGuessed = guessed; // frei gelesen -> bei Bestätigung dauerhaft lernen
    // Erkennung kann falsch sein -> bestätigen lassen oder ändern
    const hint = guessed
      ? `🔎 Lieferant vom Beleg gelesen: *${supplier}*`
      : `✅ Lieferant erkannt: *${supplier}*`;
    trackReply(ctx, session, `${hint}\n\nStimmt das?`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Passt ✅', callback_data: 'supplier_confirm' },
            { text: 'Ändern ✏️', callback_data: 'supplier_change' }
          ]
        ]
      }
    });
  } else {
    trackReply(ctx, session, '🤔 Lieferant konnte nicht automatisch erkannt werden.');
    askForSupplier(ctx, userId);
  }
}

// Erkannten Lieferanten bestätigen -> weiter zur Zahlungsart
bot.action('supplier_confirm', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  // Frei gelesener Lieferant + vom User bestätigt -> dauerhaft in die Liste lernen
  if (session.supplierGuessed && session.supplier) {
    learnSupplier(session.supplier);
    session.supplierGuessed = false;
  }
  afterSupplierChosen(ctx, userId);
});

// Erkannten Lieferanten korrigieren -> Liste zur Auswahl zeigen
bot.action('supplier_change', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  askForSupplier(ctx, userId);
});

// Duplikat-Entscheidung
bot.action('dup_continue', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  proceedAfterOcr(ctx, userId);
});

bot.action('dup_cancel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) return;
  await trackReply(ctx, session, '❌ Abgebrochen – Beleg wurde nicht erneut verarbeitet.');
  await cleanupMessages(ctx, session);
  delete userSessions[userId];
});

// ---------- Lieferant manuell (Fallback) ----------
function askForSupplier(ctx, userId) {
  const session = userSessions[userId];
  const buttons = [];
  for (let i = 0; i < SUPPLIERS.length; i += 2) {
    const row = [{ text: SUPPLIERS[i].name, callback_data: `supplier_${i}` }];
    if (i + 1 < SUPPLIERS.length) {
      row.push({ text: SUPPLIERS[i + 1].name, callback_data: `supplier_${i + 1}` });
    }
    buttons.push(row);
  }
  buttons.push([{ text: 'Sonstiges ➕', callback_data: 'supplier_other' }]);

  trackReply(ctx, session, '🏪 Welcher Lieferant?', {
    reply_markup: { inline_keyboard: buttons }
  });
}

bot.action('supplier_other', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  trackReply(ctx, session, '📝 Schreib den Namen des neuen Lieferanten:');
  session.waitingForSupplier = true;
});

bot.action(/^supplier_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  const index = parseInt(ctx.match[1], 10);
  const supplier = SUPPLIERS[index];
  if (!supplier) {
    ctx.reply('❌ Unbekannter Lieferant, bitte erneut wählen.');
    askForSupplier(ctx, userId);
    return;
  }

  session.supplier = supplier.name;
  afterSupplierChosen(ctx, userId);
});

// Text-Handler (für "Sonstiges")
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];

  // Wartet der Bot auf einen Wert (Betrag/Datum/Nr.) aus der Prüfen-Übersicht?
  if (session && session.waitingForField) {
    const field = session.waitingForField;
    const raw = (ctx.message.text || '').trim();
    session.waitingForField = null;
    session.userMessageIds = session.userMessageIds || [];
    session.userMessageIds.push(ctx.message.message_id);

    if (field === 'total' || field === 'vat') {
      const v = parseAmount(raw.replace(/[€\s]/g, ''));
      if (!isNaN(v)) session[field] = v;
    } else if (field === 'date') {
      const iso = detectDate(raw); // versteht TT.MM.JJJJ / TT.MM.JJ
      if (iso) session.invoiceDate = iso;
    } else if (field === 'receiptNumber') {
      session.receiptNumber = raw || null;
    }

    showReview(ctx, userId);
    return;
  }

  // Wartet der Bot auf einen getippten Lieferanten-Namen? -> übernehmen
  if (session && session.waitingForSupplier) {
    const typed = (ctx.message.text || '').trim();
    session.supplier = typed;
    session.supplierGuessed = false;
    session.waitingForSupplier = false;
    // Getippter (neuer) Lieferant -> dauerhaft in die Liste lernen
    learnSupplier(typed);
    // die getippte Antwort des Users auch wieder aufräumen
    session.botMessages.push(ctx.message.message_id);
    afterSupplierChosen(ctx, userId);
    return;
  }

  // In Gruppen NICHT auf beliebigen Text reagieren (z.B. ✅✅✅ als "erledigt"-Markierung).
  // Nur im privaten Chat einen Hinweis geben.
  if (ctx.chat.type !== 'private') return;

  if (!session) {
    ctx.reply('📸 Bitte lade erst ein Foto oder PDF hoch!');
  } else {
    ctx.reply('❌ Bitte nutze die Buttons!');
  }
});

// ---------- Zahlungsart ----------
function askForPayment(ctx, userId) {
  const session = userSessions[userId];
  trackReply(ctx, session, '💰 Wie wurde bezahlt?', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Bar 💵', callback_data: 'payment_cash' },
          { text: 'Karte 💳', callback_data: 'payment_card' }
        ],
        [
          { text: 'Überwiesen 🏦', callback_data: 'payment_transfer' }
        ]
      ]
    }
  });
}

bot.action('payment_cash', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Bar';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, userId);
});

bot.action('payment_transfer', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  trackReply(ctx, session, '🏦 Von welchem Konto überwiesen?', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'BAWAG', callback_data: 'transfer_bawag' },
          { text: 'N26', callback_data: 'transfer_n26' }
        ],
        [
          { text: 'Viva', callback_data: 'transfer_viva' }
        ]
      ]
    }
  });
});

bot.action('transfer_bawag', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Ueberwiesen_BAWAG';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, userId);
});

bot.action('transfer_n26', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Ueberwiesen_N26';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, userId);
});

bot.action('transfer_viva', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Ueberwiesen_Viva';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, userId);
});

bot.action('payment_card', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  trackReply(ctx, session, '🏦 Welche Karte?', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'BAWAG', callback_data: 'card_bawag' },
          { text: 'N26', callback_data: 'card_n26' }
        ],
        [
          { text: 'Viva', callback_data: 'card_viva' }
        ]
      ]
    }
  });
});

bot.action('card_bawag', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Karte_BAWAG';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, userId);
});

bot.action('card_n26', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Karte_N26';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, userId);
});

bot.action('card_viva', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Karte_Viva';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, userId);
});

// ---------- Werte prüfen / korrigieren ----------
function fmtAmount(n) {
  return typeof n === 'number' ? euro(n) : '—';
}
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// Nach der Lieferanten-Auswahl: in der Erst-Erfassung -> Zahlungsart,
// beim Korrigieren (Zahlungsart steht schon) -> zurück zur Übersicht.
function afterSupplierChosen(ctx, userId) {
  const session = userSessions[userId];
  if (!session) return;
  if (session.paymentMethod) showReview(ctx, userId);
  else askForPayment(ctx, userId);
}

// Übersicht aller erkannten Werte mit Korrektur-Buttons
function showReview(ctx, userId) {
  const s = userSessions[userId];
  if (!s) return;
  const txt =
    `📋 *Bitte prüfen:*\n\n` +
    `🏪 Lieferant: ${s.supplier || '—'}\n` +
    `💶 Brutto: ${fmtAmount(s.total)}\n` +
    `🧾 MwSt: ${fmtAmount(s.vat)}\n` +
    `📅 Datum: ${fmtDate(s.invoiceDate)}\n` +
    `🔖 Beleg-Nr.: ${s.receiptNumber || '—'}\n` +
    `💳 Zahlung: ${s.paymentMethod || '—'}\n\n` +
    `Stimmt alles? Sonst einzeln korrigieren:`;
  trackReply(ctx, s, txt, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Lieferant ✏️', callback_data: 'edit_supplier' },
          { text: 'Brutto ✏️', callback_data: 'edit_total' }
        ],
        [
          { text: 'MwSt ✏️', callback_data: 'edit_vat' },
          { text: 'Datum ✏️', callback_data: 'edit_date' }
        ],
        [
          { text: 'Beleg-Nr. ✏️', callback_data: 'edit_receipt' }
        ],
        [
          { text: 'Speichern ✅', callback_data: 'confirm_save' }
        ]
      ]
    }
  });
}

// Lieferant ändern -> bekannte Liste / freie Eingabe (kehrt danach zur Übersicht zurück)
bot.action('edit_supplier', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  if (!userSessions[userId]) return ctx.reply('❌ Sitzung abgelaufen');
  askForSupplier(ctx, userId);
});

// Betrags-/Datums-/Nummern-Felder: nach Eingabe fragen
const FIELD_PROMPTS = {
  total: '💶 Brutto-Betrag eingeben (z.B. 24,90):',
  vat: '🧾 MwSt-Betrag eingeben (z.B. 2,26):',
  date: '📅 Datum eingeben (TT.MM.JJJJ):',
  receiptNumber: '🔖 Beleg-Nr. eingeben:'
};
function askForField(ctx, userId, field) {
  const session = userSessions[userId];
  if (!session) return;
  session.waitingForField = field;
  trackReply(ctx, session, FIELD_PROMPTS[field]);
}
bot.action('edit_total', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); askForField(ctx, ctx.from.id, 'total'); });
bot.action('edit_vat', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); askForField(ctx, ctx.from.id, 'vat'); });
bot.action('edit_date', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); askForField(ctx, ctx.from.id, 'date'); });
bot.action('edit_receipt', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); askForField(ctx, ctx.from.id, 'receiptNumber'); });

// Speichern bestätigen -> neuer Beleg ODER Korrektur eines gespeicherten
bot.action('confirm_save', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) return ctx.reply('❌ Sitzung abgelaufen');

  if (session.correctingKey) {
    const patch = {
      supplier: session.supplier,
      paymentMethod: session.paymentMethod,
      total: typeof session.total === 'number' ? session.total : null,
      vat: typeof session.vat === 'number' ? session.vat : null,
      invoiceDate: session.invoiceDate || null,
      receiptNumber: session.receiptNumber || null
    };
    if (session.invoiceDate) patch.month = session.invoiceDate.slice(0, 7);
    await updateInvoice(session.correctingKey, patch);
    await trackReply(ctx, session, '✅ Beleg aktualisiert.');
    await cleanupMessages(ctx, session);
    delete userSessions[userId];
    return;
  }

  await processInvoice(ctx, userId, session);
});

// ---------- Letzten Beleg ansehen / korrigieren / löschen ----------
function lastInvoiceText(r) {
  return (
    `🗂️ *Letzter Beleg*\n\n` +
    `🏪 ${r.supplier || '—'}\n` +
    `💶 Brutto: ${fmtAmount(r.total)}\n` +
    `🧾 MwSt: ${fmtAmount(r.vat)}\n` +
    `📅 ${fmtDate(r.invoiceDate)}\n` +
    `🔖 ${r.receiptNumber || '—'}\n` +
    `💳 ${r.paymentMethod || '—'}`
  );
}

async function findLastInvoice(chatId) {
  const inv = await loadInvoices();
  const entries = Object.entries(inv || {}).filter(([, r]) => r && r.chatId === chatId);
  if (!entries.length) return null;
  entries.sort((a, b) => new Date(b[1].createdAt || 0) - new Date(a[1].createdAt || 0));
  return { key: entries[0][0], rec: entries[0][1] };
}

bot.command('letzter', async (ctx) => {
  const last = await findLastInvoice(ctx.chat.id);
  if (!last) return ctx.reply('Noch kein Beleg gespeichert.');
  await ctx.reply(lastInvoiceText(last.rec), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: 'Korrigieren ✏️', callback_data: `fix_${last.key}` },
        { text: 'Löschen 🗑️', callback_data: `del_${last.key}` }
      ]]
    }
  });
});

bot.action(/^del_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await deleteInvoiceByKey(ctx.match[1]);
  await ctx.editMessageText('🗑️ Beleg gelöscht.').catch(() => ctx.reply('🗑️ Beleg gelöscht.'));
});

// Gespeicherten Beleg zur Korrektur in eine Session laden -> Übersicht (ohne neues PDF)
bot.action(/^fix_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const key = ctx.match[1];
  const inv = await loadInvoices();
  const r = inv && inv[key];
  if (!r) return ctx.reply('❌ Beleg nicht mehr gefunden.');
  userSessions[userId] = {
    chatId: ctx.chat.id,
    botMessages: [],
    userMessageIds: [],
    supplier: r.supplier,
    total: typeof r.total === 'number' ? r.total : null,
    vat: typeof r.vat === 'number' ? r.vat : null,
    invoiceDate: r.invoiceDate || null,
    receiptNumber: r.receiptNumber || null,
    paymentMethod: r.paymentMethod || null,
    correctingKey: key
  };
  showReview(ctx, userId);
});

// ---------- Rechnung fertigstellen ----------
async function processInvoice(ctx, userId, session) {
  try {
    const processingMsg = await ctx.reply('⏳ Verarbeite Rechnung...');
    session.botMessages.push(processingMsg.message_id);

    const fileName = generateFileName({
      supplier: session.supplier,
      paymentMethod: session.paymentMethod,
      date: session.invoiceDate,
      receiptNumber: session.receiptNumber
    });

    const pdfPath = path.join(tempDir, `${fileName}.pdf`);

    if (session.isImage) {
      // Jede Seite auf den Rechnungs-Bereich zuschneiden, dann -> mehrseitiges PDF
      const images = session.images && session.images.length
        ? session.images
        : [{ buffer: session.buffer, ext: session.ext, cropBox: session.cropBox }];
      const pagePaths = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const cropped = await cropToReceipt(img.buffer, img.cropBox);
        const pagePath = path.join(tempDir, `${fileName}_p${i + 1}.${img.ext}`);
        fs.writeFileSync(pagePath, cropped);
        pagePaths.push(pagePath);
      }
      await createPdfFromImages(pagePaths, pdfPath);
      pagePaths.forEach((p) => fs.unlinkSync(p));
    } else if (session.isPdf) {
      // schon ein PDF -> nur umbenannt speichern
      fs.writeFileSync(pdfPath, session.buffer);
    } else {
      // unbekannter Typ -> Original mit eigener Endung senden
      const otherPath = path.join(tempDir, `${fileName}.${session.ext}`);
      fs.writeFileSync(otherPath, session.buffer);
      await ctx.telegram.sendDocument(
        session.chatId,
        { source: fs.createReadStream(otherPath), filename: `${fileName}.${session.ext}` },
        { caption: buildCaption(fileName, session) }
      );
      fs.unlinkSync(otherPath);
      await persistInvoice(session);
      await cleanupMessages(ctx, session);
      delete userSessions[userId];
      return;
    }

    // Nur die fertige PDF senden
    await ctx.telegram.sendDocument(
      session.chatId,
      { source: fs.createReadStream(pdfPath), filename: `${fileName}.pdf` },
      { caption: buildCaption(fileName, session) }
    );

    fs.unlinkSync(pdfPath);

    // In Datenbank speichern (für Monats-Zusammenfassung)
    await persistInvoice(session);

    // Alle Zwischen-Nachrichten + Original-Upload löschen -> nur PDF bleibt
    await cleanupMessages(ctx, session);

    delete userSessions[userId];
  } catch (error) {
    console.error('Process error:', error);
    ctx.reply('❌ Fehler beim Verarbeiten');
    delete userSessions[userId];
  }
}

function buildCaption(fileName, session) {
  let caption =
    `✅ Rechnung verarbeitet!\n\n` +
    `📄 ${fileName}\n` +
    `🏪 ${session.supplier}\n` +
    `💰 ${session.paymentMethod}`;
  const pages = session.images ? session.images.length : 0;
  if (pages > 1) {
    caption += `\n📑 Seiten: ${pages}`;
  }
  if (session.receiptNumber) {
    caption += `\n🧾 Beleg-Nr.: ${session.receiptNumber}`;
  }
  if (typeof session.total === 'number') {
    caption += `\n💶 Brutto: ${euro(session.total)}`;
  }
  if (typeof session.vat === 'number') {
    caption += `\n   davon MwSt: ${euro(session.vat)}`;
  }
  return caption;
}

async function persistInvoice(session) {
  // Monat nach Rechnungsdatum (für korrekte Monats-Zusammenfassung), sonst heute
  const month = session.invoiceDate ? session.invoiceDate.slice(0, 7) : monthKeyOf(new Date());
  await saveInvoice({
    chatId: session.chatId,
    supplier: session.supplier,
    paymentMethod: session.paymentMethod,
    total: typeof session.total === 'number' ? session.total : null,
    vat: typeof session.vat === 'number' ? session.vat : null,
    invoiceDate: session.invoiceDate || null,
    receiptNumber: session.receiptNumber || null,
    month,
    createdAt: new Date().toISOString()
  });
}

// ---------- Server / Webhook ----------
app.post('/api/webhook', express.json(), async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(200);
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2026-06-09-multipage-viva',
    features: ['ocr', 'crop', 'receiptNr', 'ueberwiesen', 'multipage', 'viva'],
    firebase: FIREBASE_DB ? 'konfiguriert' : 'fehlt'
  });
});

// Diagnose: prüft pro Service Vision-Key + Konfiguration (zeigt KEINE Geheimwerte)
app.get('/api/diag', async (req, res) => {
  const out = {
    visionKeyLen: (process.env.GOOGLE_VISION_API_KEY || '').length,
    dbSecretLen: (process.env.FIREBASE_DB_SECRET || '').length,
    dbUrl: process.env.FIREBASE_DATABASE_URL || '(leer)',
    webhookEnv: process.env.WEBHOOK_URL || '(leer)'
  };
  try {
    const r = await axios.post(
      `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`,
      { requests: [{ image: { content: 'dGVzdA==' }, features: [{ type: 'TEXT_DETECTION' }] }] },
      { validateStatus: () => true }
    );
    out.visionStatus = r.status;
    out.visionInfo = r.data?.error?.message?.slice(0, 140) || (r.data?.responses ? 'Key OK (Bad-Image erwartet)' : 'unbekannt');
  } catch (e) {
    out.visionStatus = 'EXC';
    out.visionInfo = e.message;
  }
  res.json(out);
});

// Manueller/externer Trigger für den Monatsbericht (z.B. Railway Cron am 1.)
app.get('/api/cron/monthly', async (req, res) => {
  if (process.env.CRON_KEY && req.query.key !== process.env.CRON_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    await postMonthlySummaries();
    res.json({ ok: true });
  } catch (error) {
    console.error('Cron error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'Zeytoon Receipt Bot is running' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);

  // Früher gelernte Lieferanten aus Firebase an die Liste anhängen
  try {
    const learned = await loadLearnedSuppliers();
    let added = 0;
    for (const s of learned) {
      const norm = normalize(s.name);
      if (!norm || SUPPLIERS.some((x) => normalize(x.name) === norm)) continue;
      SUPPLIERS.push({
        name: s.name,
        keywords: Array.isArray(s.keywords) && s.keywords.length ? s.keywords : [norm]
      });
      added++;
    }
    console.log(`📇 Lieferanten aktiv: ${SUPPLIERS.length} (davon ${added} gelernt)`);
  } catch (error) {
    console.error('Lieferanten-Load:', error.message);
  }

  try {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (webhookUrl && /^https:\/\/.+/.test(webhookUrl)) {
      await bot.telegram.setWebhook(webhookUrl);
      console.log('✅ Webhook set!');
    } else {
      // Leere/ungültige URL würde den bestehenden Webhook löschen -> nicht anfassen
      console.log('⚠️ WEBHOOK_URL fehlt/ungültig – bestehender Webhook bleibt unverändert.');
    }
  } catch (error) {
    console.log(`⚠️ Webhook: ${error.message}`);
  }

  // Monatsbericht: täglich prüfen, am 1. den Vormonat automatisch posten
  const checkMonthly = async () => {
    try {
      if (new Date().getUTCDate() === 1) await postMonthlySummaries();
    } catch (error) {
      console.error('Scheduler error:', error.message);
    }
  };
  checkMonthly();
  setInterval(checkMonthly, 6 * 60 * 60 * 1000);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});
