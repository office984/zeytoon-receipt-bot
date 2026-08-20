import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import {
  normalize,
  parseAmount,
  euro,
  detectTotalInfo,
  detectVatInfo,
  detectReceiptNumber,
  detectDate,
  guessSupplierFromText,
  matchSupplier,
  supplierKeywords,
  vatLooksOff
} from './detect.js';
import { BASE_SUPPLIERS } from './suppliers.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = path.join(__dirname, 'temp');

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Grundliste liegt in api/suppliers.js (wird auch vom Prüf-Werkzeug genutzt).
// Eigene Kopie, weil die Liste zur Laufzeit um gelernte Lieferanten wächst.
const SUPPLIERS = [...BASE_SUPPLIERS];

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const userSessions = {};

// Session-Schlüssel = Chat + Benutzer. Wichtig, weil derselbe Benutzer den Bot
// gleichzeitig in einer Gruppe UND im Privatchat verwenden kann – sonst
// überschreiben sich die beiden Vorgänge gegenseitig.
function sidOf(ctx) {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id ?? 'nochat';
  return `${chatId}_${ctx.from?.id}`;
}

// Sessions liegen im RAM, werden aber nach jedem Update nach Firebase gespiegelt
// und beim Start wieder eingelesen -> sie überleben Neustarts/Redeploys.
// EIN zentraler Punkt: nach jedem verarbeiteten Update die Session sichern
// (sofern der Handler sie nicht beendet hat).
bot.use(async (ctx, next) => {
  await next();
  if (!ctx.from) return;
  const sid = sidOf(ctx);
  if (userSessions[sid]) persistSession(sid);
});

// Mehrere Fotos auf einmal (Telegram-Album) = EINE Rechnung mit mehreren Seiten.
// Album-Fotos kommen als getrennte Updates mit gleicher media_group_id an.
// Wir sammeln sie kurz und verarbeiten sie dann gemeinsam.
const mediaGroups = {};
const MEDIA_GROUP_DEBOUNCE_MS = 2500;

function bufferMediaGroupItem(ctx, sid, mediaGroupId, item, meta) {
  const key = `${sid}:${mediaGroupId}`;
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
    handleIncomingFile(ctx, sid, group.items, group.meta).catch((error) => {
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

// Erkennungs-Logik (normalize, matchSupplier, guessSupplierFromText, Beträge,
// MwSt, Belegnummer, Datum) liegt in ./detect.js – dort auch mit Tests abgedeckt.

// Der eigene Betrieb steht auf Eingangsrechnungen im Kopf (als Empfänger) und
// darf nie als Lieferant vorgeschlagen werden. Über OWN_COMPANY erweiterbar.
const OWN_COMPANY_WORDS = (process.env.OWN_COMPANY || 'zeytoon')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Wie verlässlich ist ein erkannter Wert? Höher = besser.
// Wird gebraucht, um die Ergebnisse der zwei OCR-Verfahren zu vergleichen.
const TOTAL_RANK = { 'keyword+cash': 6, keyword: 5, cash: 4, payment: 3, fallback: 1 };
const VAT_RANK = { sum: 6, rates: 5, table: 4, 'keyword-sum': 3, keyword: 3, computed: 2, 'net-diff': 2 };

function extractFrom(text) {
  // Reihenfolge wichtig: das Brutto dient der MwSt-Erkennung als Plausibilitätsgrenze
  const total = detectTotalInfo(text);
  const vat = detectVatInfo(text, total.value);
  return {
    total: total.value,
    totalSource: total.source,
    vat: vat.value,
    vatSource: vat.source,
    invoiceDate: detectDate(text),
    receiptNumber: detectReceiptNumber(text)
  };
}

/**
 * Beide OCR-Lesarten auswerten und pro Feld das sicherere Ergebnis nehmen.
 * Ein Beleg, dessen Summe die eine Lesart verschluckt, wird von der anderen
 * oft sauber erkannt – vor allem bei mehrspaltigen Rechnungen.
 */
function bestExtraction(texts) {
  const cands = texts.filter((t) => t && t.trim()).map(extractFrom);
  if (!cands.length) return extractFrom('');

  const out = { ...cands[0] };
  for (const c of cands.slice(1)) {
    if ((TOTAL_RANK[c.totalSource] || 0) > (TOTAL_RANK[out.totalSource] || 0)) {
      out.total = c.total;
      out.totalSource = c.totalSource;
      // MwSt hängt am Brutto -> gleich mitnehmen, sonst passen die beiden nicht zusammen
      if ((VAT_RANK[c.vatSource] || 0) >= (VAT_RANK[out.vatSource] || 0)) {
        out.vat = c.vat;
        out.vatSource = c.vatSource;
      }
    } else if ((VAT_RANK[c.vatSource] || 0) > (VAT_RANK[out.vatSource] || 0)) {
      out.vat = c.vat;
      out.vatSource = c.vatSource;
    }
    if (!out.invoiceDate && c.invoiceDate) out.invoiceDate = c.invoiceDate;
    if (!out.receiptNumber && c.receiptNumber) out.receiptNumber = c.receiptNumber;
  }

  // Passt die MwSt rechnerisch nicht zum (evtl. korrigierten) Brutto, lieber
  // nachrechnen als einen falschen Wert stehen lassen.
  if (out.total && out.vat && vatLooksOff(out.total, out.vat)) {
    const alt = cands
      .map((c) => c.vat)
      .find((v) => typeof v === 'number' && !vatLooksOff(out.total, v));
    if (alt !== undefined) out.vat = alt;
  }
  return out;
}

/** Lieferant über beide OCR-Lesarten suchen: erst bekannte Liste, dann frei lesen. */
function findSupplier(texts) {
  const list = texts.filter((t) => t && t.trim());
  for (const t of list) {
    const hit = matchSupplier(t, SUPPLIERS);
    if (hit) return { supplier: hit, guessed: false };
  }
  for (const t of list) {
    const hit = guessSupplierFromText(t, OWN_COMPANY_WORDS);
    if (hit) return { supplier: hit, guessed: true };
  }
  return { supplier: null, guessed: false };
}

// Sprach-Hinweise: ohne sie liest Vision Umlaute und "ß" auf Kassenzetteln
// deutlich schlechter – und damit auch Stichwörter wie "Rückgeld" oder "Straße".
const VISION_CONTEXT = { languageHints: ['de', 'en'] };

// OCR für Bilder über Google Vision REST API (mit API-Key).
// Es werden BEIDE Verfahren angefragt:
//   DOCUMENT_TEXT_DETECTION – besser bei dicht bedruckten Rechnungen (A4)
//   TEXT_DETECTION          – besser bei kurzen, schiefen Kassabons
// Die beiden Ergebnisse zerlegen den Beleg unterschiedlich in Zeilen; wir werten
// später beide aus und nehmen pro Feld das sicherere Ergebnis (siehe bestExtraction).
async function ocrImage(base64) {
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_VISION_API_KEY}`;
  const { data } = await axios.post(url, {
    requests: [
      { image: { content: base64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], imageContext: VISION_CONTEXT },
      { image: { content: base64 }, features: [{ type: 'TEXT_DETECTION' }], imageContext: VISION_CONTEXT }
    ]
  });
  const [docRes, sparseRes] = data.responses || [];
  const docText = docRes?.fullTextAnnotation?.text || '';
  const sparseText = sparseRes?.fullTextAnnotation?.text || sparseRes?.textAnnotations?.[0]?.description || '';

  // Bounding-Box über den GESAMTEN erkannten Text = ungefähr die Rechnung
  let bbox = null;
  const verts =
    sparseRes?.textAnnotations?.[0]?.boundingPoly?.vertices ||
    docRes?.textAnnotations?.[0]?.boundingPoly?.vertices;
  if (verts && verts.length) {
    const xs = verts.map((v) => v.x || 0);
    const ys = verts.map((v) => v.y || 0);
    bbox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }

  const text = docText || sparseText;
  const altText = sparseText && sparseText !== docText ? sparseText : '';
  return { text, altText, bbox };
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
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: VISION_CONTEXT
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

// ---------- Sessions persistent halten (überleben Neustart/Redeploy) ----------
// Bilddaten (Buffer) werden NICHT gespeichert – sie sind groß und lassen sich
// per Telegram-file_id jederzeit neu laden. Gespeichert wird nur der Zustand.
function serializeSession(s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    // extractedTextAlt wird nur direkt nach der OCR gebraucht -> nicht mitspeichern
    if (k === 'buffer' || k === 'extractedTextAlt' || v === undefined) continue;
    if (k === 'images') {
      out.images = (v || []).map((im) => ({ ext: im.ext || null, cropBox: im.cropBox || null }));
      continue;
    }
    out[k] = v;
  }
  return out;
}

function deserializeSession(d) {
  const s = { ...d, buffer: null };
  if (Array.isArray(s.images)) s.images = s.images.map((im) => ({ ...im, buffer: null }));
  return s;
}

async function saveSession(sid) {
  const s = userSessions[sid];
  if (!s || !FIREBASE_DB) return;
  try {
    await axios.put(`${FIREBASE_DB}/sessions/${sid}.json${FIREBASE_AUTH}`, serializeSession(s));
  } catch (error) {
    console.error('Session save error:', error.message);
  }
}
// Feuer-und-vergiss (blockiert den Handler nicht)
function persistSession(sid) {
  saveSession(sid).catch(() => {});
}

async function dropSession(sid) {
  delete userSessions[sid];
  if (!FIREBASE_DB) return;
  try {
    await axios.delete(`${FIREBASE_DB}/sessions/${sid}.json${FIREBASE_AUTH}`);
  } catch (error) {
    console.error('Session drop error:', error.message);
  }
}

// Beim Start: offene Sessions zurückholen (nur die letzten 24h, ältere verwerfen)
async function loadSessionsAtStartup() {
  if (!FIREBASE_DB) return 0;
  try {
    const { data } = await axios.get(`${FIREBASE_DB}/sessions.json${FIREBASE_AUTH}`);
    if (!data) return 0;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let n = 0;
    for (const [uid, d] of Object.entries(data)) {
      const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
      if (ts && ts < cutoff) {
        axios.delete(`${FIREBASE_DB}/sessions/${uid}.json${FIREBASE_AUTH}`).catch(() => {});
        continue;
      }
      userSessions[uid] = deserializeSession(d);
      n++;
    }
    return n;
  } catch (error) {
    console.error('Session load error:', error.message);
    return 0;
  }
}

// Bild-/PDF-Daten sicherstellen – nach einem Neustart fehlen die Buffer und
// werden hier per Telegram-file_id frisch heruntergeladen.
async function ensureBuffers(ctx, session) {
  try {
    if (session.isImage && session.images && session.images.length) {
      for (let i = 0; i < session.images.length; i++) {
        if (!session.images[i].buffer && session.fileIds && session.fileIds[i]) {
          const { buffer, ext } = await downloadTelegramFile(ctx, session.fileIds[i]);
          session.images[i].buffer = buffer;
          session.images[i].ext = session.images[i].ext || ext;
        }
      }
    }
    if (!session.buffer && session.fileId) {
      const { buffer, ext } = await downloadTelegramFile(ctx, session.fileId);
      session.buffer = buffer;
      session.ext = session.ext || ext;
    }
  } catch (error) {
    console.error('Re-Download fehlgeschlagen:', error.message);
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

// ---------- Duplikat-Erkennung ----------
// Zwei Belege gelten als derselbe, wenn Lieferant + Betrag + Datum + Zahlungsart
// übereinstimmen. Die Belegnummer allein reicht nicht: sie wird nicht immer
// korrekt erkannt und ist damit als alleiniges Merkmal unzuverlässig.
function sameAmount(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;
}

function duplicateReason(rec, cand) {
  if (!rec || !cand) return null;

  const sameSupplier = !!rec.supplier && normalize(rec.supplier) === normalize(cand.supplier);

  // 1) Gleiche Belegnummer beim gleichen Lieferanten -> eindeutig derselbe Beleg
  if (sameSupplier && rec.receiptNumber && rec.receiptNumber === cand.receiptNumber) {
    return `gleiche Beleg-Nr. ${rec.receiptNumber} beim selben Lieferanten`;
  }

  // 2) Lieferant + Betrag + Datum + Zahlungsart identisch
  if (
    sameSupplier &&
    sameAmount(rec.total, cand.total) &&
    !!rec.invoiceDate &&
    rec.invoiceDate === cand.invoiceDate &&
    !!rec.paymentMethod &&
    rec.paymentMethod === cand.paymentMethod
  ) {
    return 'Lieferant, Betrag, Datum und Zahlungsart stimmen überein';
  }

  return null;
}

// Sucht einen bereits gespeicherten, gleichen Beleg im selben Chat.
async function findDuplicate(chatId, cand) {
  const inv = await loadInvoices();
  for (const rec of Object.values(inv || {})) {
    if (!rec || rec.chatId !== chatId) continue;
    const reason = duplicateReason(rec, cand);
    if (reason) return { rec, reason };
  }
  return null;
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

// --- Wie oft wurde ein Lieferant schon verwendet? ---
// Damit stehen die häufigen Lieferanten in der Auswahl ganz oben und man muss
// nicht mehr durch die ganze Liste scrollen.
const supplierUsage = new Map(); // normalisierter Name -> Anzahl

// Firebase-Schlüssel dürfen . # $ [ ] / nicht enthalten
function fbKey(name) {
  return normalize(name).replace(/[.#$[\]/]/g, '_') || '_';
}

function usageOf(name) {
  return supplierUsage.get(fbKey(name)) || 0;
}

async function loadSupplierUsage() {
  if (!FIREBASE_DB) return;
  try {
    const { data } = await axios.get(`${FIREBASE_DB}/supplierUsage.json${FIREBASE_AUTH}`);
    if (!data) return;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'number') supplierUsage.set(k, v);
    }
  } catch (error) {
    console.error('Supplier usage load error:', error.message);
  }
}

function bumpSupplierUsage(name) {
  if (!name) return;
  const key = fbKey(name);
  const next = (supplierUsage.get(key) || 0) + 1;
  supplierUsage.set(key, next);
  if (!FIREBASE_DB) return;
  axios
    .put(`${FIREBASE_DB}/supplierUsage/${key}.json${FIREBASE_AUTH}`, next)
    .catch((error) => console.error('Supplier usage save error:', error.message));
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

  // Stichwörter ableiten (voller Name + markantes Einzelwort, ohne
  // Allerweltswörter wie "hotel"/"gastro" – die würden fremde Belege einfangen)
  const keywords = supplierKeywords(name);
  if (!keywords.length) return false;

  const entry = { name, keywords };
  SUPPLIERS.push(entry);          // sofort in dieser Session nutzbar
  persistLearnedSupplier(entry);  // im Hintergrund dauerhaft speichern
  console.log(`📇 Neuer Lieferant gelernt: ${name}`);
  return true;
}

// ---------- Beleg-Art ----------
// Buchhaltungs-Regel im Betrieb:
//   bar bezahlt              -> Kassenrechnung
//   Karte oder Überweisung   -> Eingangsrechnung
// Die Farbpunkte machen den Unterschied beim Durchscrollen sofort sichtbar.
const KIND_CASH = { key: 'Kassenrechnung', label: 'KASSENRECHNUNG', short: 'Kassenrechnung', icon: '🟢' };
const KIND_INCOMING = { key: 'Eingangsrechnung', label: 'EINGANGSRECHNUNG', short: 'Eingangsrechnung', icon: '🔵' };
const KIND_UNKNOWN = { key: 'unbekannt', label: 'BELEG', short: 'Beleg', icon: '⚪' };

function receiptKind(paymentMethod) {
  if (!paymentMethod) return KIND_UNKNOWN;
  return paymentMethod === 'Bar' ? KIND_CASH : KIND_INCOMING;
}

// Symbol passend zur Zahlungsart
function paymentIcon(paymentMethod) {
  if (paymentMethod === 'Bar') return '💵';
  if (String(paymentMethod || '').startsWith('Karte')) return '💳';
  if (String(paymentMethod || '').startsWith('Ueberwiesen')) return '🏦';
  return '💰';
}

// Monat, in dem der Beleg zählt (Rechnungsdatum, sonst aktueller Monat)
function monthOfRecord(r) {
  return r.month || (r.invoiceDate ? r.invoiceDate.slice(0, 7) : monthKeyOf(new Date()));
}

// ---------- Zusammenfassung ----------
function sumOf(recs) {
  const withVat = recs.filter((r) => typeof r.vat === 'number');
  const withTotal = recs.filter((r) => typeof r.total === 'number');
  return {
    count: recs.length,
    vatTotal: Math.round(withVat.reduce((s, r) => s + r.vat, 0) * 100) / 100,
    grandTotal: Math.round(withTotal.reduce((s, r) => s + r.total, 0) * 100) / 100,
    missingVat: recs.length - withVat.length,
    missingTotal: recs.length - withTotal.length
  };
}

function summarize(invoicesObj, month, chatId) {
  const recs = Object.values(invoicesObj || {}).filter(
    (r) => r && r.month === month && (chatId == null || r.chatId === chatId)
  );
  return {
    ...sumOf(recs),
    // getrennt nach Beleg-Art – so wie die Belege am Monatsende abgelegt werden
    cash: sumOf(recs.filter((r) => receiptKind(r.paymentMethod) === KIND_CASH)),
    incoming: sumOf(recs.filter((r) => receiptKind(r.paymentMethod) === KIND_INCOMING))
  };
}

function summaryText(label, s) {
  let txt =
    `📊 *Zusammenfassung ${label}*\n\n` +
    `🧾 Belege gesamt: ${s.count}\n` +
    `💰 Ausgaben (Brutto): ${euro(s.grandTotal)}\n` +
    `💶 davon MwSt: ${euro(s.vatTotal)}\n\n` +
    `${KIND_CASH.icon} *Kassenrechnungen* (bar): ${s.cash.count}\n` +
    `      ${euro(s.cash.grandTotal)}  ·  MwSt ${euro(s.cash.vatTotal)}\n` +
    `${KIND_INCOMING.icon} *Eingangsrechnungen* (Karte/Überweisung): ${s.incoming.count}\n` +
    `      ${euro(s.incoming.grandTotal)}  ·  MwSt ${euro(s.incoming.vatTotal)}`;
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
    '🔍 In der Lieferanten-Auswahl gibt es einen Such-Button – einfach ein paar ' +
    'Buchstaben tippen statt zu scrollen.\n\n' +
    '⚠️ Ist ein Beleg mit gleichem Lieferant, Betrag, Datum und Zahlungsart schon ' +
    'erfasst, warne ich vor dem Speichern.\n\n' +
    'Unter jedem fertigen PDF steht Monat und Beleg-Art:\n' +
    '🟢 Kassenrechnung = bar bezahlt\n' +
    '🔵 Eingangsrechnung = Karte oder Überweisung\n\n' +
    '📊 /zusammenfassung – Ausgaben & MwSt des laufenden Monats,\n' +
    '        getrennt nach Kassen- und Eingangsrechnungen\n' +
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
  const sid = sidOf(ctx);
  try {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const item = { fileId, messageId: ctx.message.message_id };
    const meta = { type: 'photo', isImage: true };

    // Album (mehrere Fotos auf einmal) -> sammeln und als EINE Rechnung verarbeiten
    if (ctx.message.media_group_id) {
      bufferMediaGroupItem(ctx, sid, ctx.message.media_group_id, item, meta);
      return;
    }

    await handleIncomingFile(ctx, sid, [item], meta);
  } catch (error) {
    console.error('Photo error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
  }
});

// ---------- Eingang: Dokument (PDF oder Bild-Datei) ----------
bot.on('document', async (ctx) => {
  const sid = sidOf(ctx);
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
      bufferMediaGroupItem(ctx, sid, ctx.message.media_group_id, item, meta);
      return;
    }

    await handleIncomingFile(ctx, sid, [item], meta);
  } catch (error) {
    console.error('Document error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
  }
});

// Gemeinsame Verarbeitung: Download -> OCR -> Lieferant erkennen
// items: Array von { fileId, messageId } – bei einem Album mehrere Seiten einer Rechnung.
async function handleIncomingFile(ctx, sid, items, meta) {
  userSessions[sid] = {
    fileId: items[0].fileId,
    fileIds: items.map((it) => it.fileId), // alle Seiten -> Neu-Download nach Neustart
    chatId: ctx.chat.id,
    userMessageIds: items.map((it) => it.messageId),
    botMessages: [],
    timestamp: new Date().toISOString(),
    images: [],
    ...meta
  };
  const session = userSessions[sid];

  const pageCount = items.length;
  await trackReply(
    ctx,
    session,
    pageCount > 1 ? `🔍 Lese Rechnung (${pageCount} Seiten)...` : '🔍 Lese Rechnung...'
  );

  // OCR ausführen (Fehler -> trotzdem manuell weiter)
  let text = '';
  let altText = '';
  let ocrError = null;
  try {
    if (meta.isImage) {
      // Jede Seite herunterladen + per OCR lesen; Texte aller Seiten zusammenführen
      const texts = [];
      const altTexts = [];
      for (const it of items) {
        const { buffer, ext } = await downloadTelegramFile(ctx, it.fileId);
        let pageText = '';
        let pageAlt = '';
        let pageBox = null;
        try {
          const r = await ocrImage(buffer.toString('base64'));
          pageText = r.text;
          pageAlt = r.altText;
          pageBox = r.bbox;
        } catch (error) {
          ocrError = error.response?.data ? JSON.stringify(error.response.data) : error.message;
          console.error('OCR error:', ocrError);
        }
        session.images.push({ buffer, ext, cropBox: pageBox });
        if (pageText) texts.push(pageText);
        if (pageAlt) altTexts.push(pageAlt);
      }
      text = texts.join('\n');
      altText = altTexts.join('\n');
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
  session.extractedTextAlt = altText;

  // Beide OCR-Lesarten auswerten, pro Feld das sicherere Ergebnis übernehmen
  const found = bestExtraction([text, altText]);
  session.total = found.total;
  session.totalSource = found.totalSource;
  session.vat = found.vat;
  session.vatSource = found.vatSource;
  session.invoiceDate = found.invoiceDate;
  session.receiptNumber = found.receiptNumber;
  console.log(
    `Erkannt: Brutto=${found.total} (${found.totalSource}) MwSt=${found.vat} (${found.vatSource}) ` +
    `Datum=${found.invoiceDate} Nr=${found.receiptNumber}`
  );
  persistSession(sid); // Session sofort sichern (auch im Media-Group-Timer-Pfad)

  // Duplikat-Prüfung passiert erst beim Speichern – dort sind Lieferant,
  // Betrag und Zahlungsart bekannt und die Prüfung ist damit verlässlich.
  proceedAfterOcr(ctx, sid);
}

// Lieferant erkennen (oder fragen) und weiter zur Zahlungsart
function proceedAfterOcr(ctx, sid) {
  const session = userSessions[sid];
  if (!session) return;

  // 1) Bekannte Stichwort-Liste (sicherste Erkennung), sonst frei aus dem
  //    Beleg-Kopf lesen – jeweils über beide OCR-Lesarten.
  const { supplier, guessed } = findSupplier([session.extractedText, session.extractedTextAlt]);

  if (supplier) {
    session.supplier = supplier;
    session.supplierGuessed = guessed; // frei gelesen -> bei Bestätigung dauerhaft lernen
    // Erkennung kann falsch sein -> bestätigen lassen oder ändern
    const hint = guessed
      ? `🔎 Lieferant vom Beleg gelesen: *${mdEscape(supplier)}*`
      : `✅ Lieferant erkannt: *${mdEscape(supplier)}*`;
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
    askForSupplier(ctx, sid);
  }
}

// Erkannten Lieferanten bestätigen -> weiter zur Zahlungsart
bot.action('supplier_confirm', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  // Frei gelesener Lieferant + vom User bestätigt -> dauerhaft in die Liste lernen
  if (session.supplierGuessed && session.supplier) {
    learnSupplier(session.supplier);
    session.supplierGuessed = false;
  }
  afterSupplierChosen(ctx, sid);
});

// Erkannten Lieferanten korrigieren -> Liste zur Auswahl zeigen
bot.action('supplier_change', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  askForSupplier(ctx, sid);
});

// Duplikat-Entscheidung (Prüfung passiert beim Speichern, siehe confirm_save)
bot.action('dup_continue', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.duplicateAccepted = true; // nicht nochmal fragen
  await processInvoice(ctx, sid, session);
});

bot.action('dup_cancel', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) return;
  await trackReply(ctx, session, '❌ Abgebrochen – Beleg wurde nicht gespeichert.');
  await cleanupMessages(ctx, session);
  await dropSession(sid);
});

// ---------- Lieferant auswählen (Suche + Seiten) ----------
// Die Liste wird mit der Zeit lang. Statt alles auf einmal anzuzeigen:
// häufigste Lieferanten zuerst, 8 pro Seite, plus Volltext-Suche.
const SUPPLIER_PAGE_SIZE = 8;

// SUPPLIERS in Anzeige-Reihenfolge, der ursprüngliche Index bleibt als `idx`
// erhalten (er steckt in den callback_data der Buttons).
function suppliersForDisplay() {
  return SUPPLIERS.map((s, idx) => ({ ...s, idx })).sort(
    (a, b) => usageOf(b.name) - usageOf(a.name) || a.name.localeCompare(b.name, 'de')
  );
}

function supplierButtonRows(list) {
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [{ text: list[i].name, callback_data: `supplier_${list[i].idx}` }];
    if (i + 1 < list.length) {
      row.push({ text: list[i + 1].name, callback_data: `supplier_${list[i + 1].idx}` });
    }
    rows.push(row);
  }
  return rows;
}

function askForSupplier(ctx, sid, page = 0) {
  const session = userSessions[sid];
  if (!session) return;
  const all = suppliersForDisplay();
  const pages = Math.max(1, Math.ceil(all.length / SUPPLIER_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(p * SUPPLIER_PAGE_SIZE, (p + 1) * SUPPLIER_PAGE_SIZE);

  const buttons = [
    [
      { text: '🔍 Suchen', callback_data: 'supplier_find' },
      { text: '➕ Neuer Lieferant', callback_data: 'supplier_other' }
    ],
    ...supplierButtonRows(slice)
  ];

  if (pages > 1) {
    buttons.push([
      { text: '⬅️', callback_data: `supplier_page_${(p - 1 + pages) % pages}` },
      { text: `Seite ${p + 1}/${pages}`, callback_data: 'supplier_noop' },
      { text: '➡️', callback_data: `supplier_page_${(p + 1) % pages}` }
    ]);
  }

  trackReply(ctx, session, '🏪 Welcher Lieferant?', {
    reply_markup: { inline_keyboard: buttons }
  });
}

// Blättern: bestehende Nachricht umbauen, damit der Chat nicht zugemüllt wird
bot.action(/^supplier_page_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  const all = suppliersForDisplay();
  const pages = Math.max(1, Math.ceil(all.length / SUPPLIER_PAGE_SIZE));
  const p = Math.min(Math.max(0, parseInt(ctx.match[1], 10)), pages - 1);
  const slice = all.slice(p * SUPPLIER_PAGE_SIZE, (p + 1) * SUPPLIER_PAGE_SIZE);

  await ctx
    .editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: '🔍 Suchen', callback_data: 'supplier_find' },
          { text: '➕ Neuer Lieferant', callback_data: 'supplier_other' }
        ],
        ...supplierButtonRows(slice),
        [
          { text: '⬅️', callback_data: `supplier_page_${(p - 1 + pages) % pages}` },
          { text: `Seite ${p + 1}/${pages}`, callback_data: 'supplier_noop' },
          { text: '➡️', callback_data: `supplier_page_${(p + 1) % pages}` }
        ]
      ]
    })
    .catch(() => {});
});

bot.action('supplier_noop', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
});

// Aus der Suche zurück zur vollständigen Liste
bot.action('supplier_list', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  if (!userSessions[sid]) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  askForSupplier(ctx, sid, 0);
});

// Suche starten
bot.action('supplier_find', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.waitingForSupplierSearch = true;
  trackReply(ctx, session, '🔍 Tipp ein paar Buchstaben des Lieferanten (z.B. "meg" für Mega Gastro):');
});

// Suchergebnisse anzeigen
function showSupplierSearchResults(ctx, sid, query) {
  const session = userSessions[sid];
  if (!session) return;
  const q = normalize(query);
  const hits = suppliersForDisplay()
    .filter(
      (s) =>
        normalize(s.name).includes(q) ||
        (s.keywords || []).some((k) => normalize(k).includes(q))
    )
    .slice(0, 10);

  session.pendingSupplierName = query;

  if (!hits.length) {
    trackReply(ctx, session, `🔍 Kein Lieferant mit „${query}" gefunden.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: `➕ „${query}" neu anlegen`, callback_data: 'supplier_use_typed' }],
          [{ text: '🔍 Nochmal suchen', callback_data: 'supplier_find' }],
          [{ text: '📋 Ganze Liste', callback_data: 'supplier_list' }]
        ]
      }
    });
    return;
  }

  trackReply(ctx, session, `🔍 Treffer für „${query}":`, {
    reply_markup: {
      inline_keyboard: [
        ...supplierButtonRows(hits),
        [{ text: `➕ „${query}" neu anlegen`, callback_data: 'supplier_use_typed' }],
        [{ text: '🔍 Nochmal suchen', callback_data: 'supplier_find' }]
      ]
    }
  });
}

// Getippten Suchbegriff als neuen Lieferanten übernehmen
bot.action('supplier_use_typed', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session || !session.pendingSupplierName) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.supplier = session.pendingSupplierName;
  session.supplierGuessed = false;
  learnSupplier(session.supplier);
  afterSupplierChosen(ctx, sid);
});

bot.action('supplier_other', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  trackReply(ctx, session, '📝 Schreib die genaue Firmenbezeichnung des Lieferanten (z.B. „Mega Gastro GmbH"):');
  session.waitingForSupplier = true;
});

bot.action(/^supplier_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  const index = parseInt(ctx.match[1], 10);
  const supplier = SUPPLIERS[index];
  if (!supplier) {
    ctx.reply('❌ Unbekannter Lieferant, bitte erneut wählen.');
    askForSupplier(ctx, sid);
    return;
  }

  session.supplier = supplier.name;
  session.supplierGuessed = false;
  afterSupplierChosen(ctx, sid);
});

// Text-Handler (für "Sonstiges")
bot.on('text', async (ctx) => {
  const sid = sidOf(ctx);
  const session = userSessions[sid];

  // Wartet der Bot auf einen Wert (Betrag/Datum/Nr.) aus der Prüfen-Übersicht?
  if (session && session.waitingForField) {
    const field = session.waitingForField;
    const raw = (ctx.message.text || '').trim();
    session.userMessageIds = session.userMessageIds || [];
    session.userMessageIds.push(ctx.message.message_id);

    let ok = true;
    if (field === 'total' || field === 'vat') {
      const v = parseAmount(raw);
      if (!isNaN(v) && v >= 0) {
        session[field] = v;
        if (field === 'total') session.totalSource = 'manuell';
        else session.vatSource = 'manuell';
      } else {
        ok = false;
      }
    } else if (field === 'date') {
      // versteht TT.MM.JJJJ / TT.MM.JJ; bei Handeingabe auch ältere Belege (10 Jahre)
      const iso = detectDate(raw, new Date(), 10 * 365);
      if (iso) session.invoiceDate = iso;
      else ok = false;
    } else if (field === 'receiptNumber') {
      if (raw) session.receiptNumber = raw;
      else ok = false;
    }

    // Fehleingabe nicht stillschweigend verschlucken, sondern nochmal fragen
    if (!ok) {
      await trackReply(ctx, session, `⚠️ „${raw}" konnte ich nicht lesen.\n${FIELD_PROMPTS[field]}`);
      return; // waitingForField bleibt gesetzt
    }

    session.waitingForField = null;
    showReview(ctx, sid);
    return;
  }

  // Wartet der Bot auf einen Suchbegriff für die Lieferanten-Liste?
  if (session && session.waitingForSupplierSearch) {
    const typed = (ctx.message.text || '').trim();
    session.waitingForSupplierSearch = false;
    session.userMessageIds = session.userMessageIds || [];
    session.userMessageIds.push(ctx.message.message_id);
    showSupplierSearchResults(ctx, sid, typed);
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
    session.userMessageIds = session.userMessageIds || [];
    session.userMessageIds.push(ctx.message.message_id);
    afterSupplierChosen(ctx, sid);
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
function askForPayment(ctx, sid) {
  const session = userSessions[sid];
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
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Bar';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, sid);
});

bot.action('payment_transfer', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
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
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Ueberwiesen_BAWAG';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, sid);
});

bot.action('transfer_n26', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Ueberwiesen_N26';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, sid);
});

bot.action('transfer_viva', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Ueberwiesen_Viva';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, sid);
});

bot.action('payment_card', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
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
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Karte_BAWAG';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, sid);
});

bot.action('card_n26', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Karte_N26';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, sid);
});

bot.action('card_viva', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Karte_Viva';
  session.account = 'Geschaeftskonto';
  await showReview(ctx, sid);
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

// Sonderzeichen für Telegram-Markdown entschärfen (ein einzelnes _ oder *
// in z.B. einem Lieferantennamen würde die Nachricht sonst unsendbar machen).
function mdEscape(v) {
  return String(v == null ? '' : v).replace(/([_*`\[])/g, '\\$1');
}

// Zahlungsart hübsch + ohne Unterstrich anzeigen
function prettyPayment(p) {
  const map = {
    Bar: 'Bar',
    Ueberwiesen_BAWAG: 'Überwiesen (BAWAG)',
    Ueberwiesen_N26: 'Überwiesen (N26)',
    Ueberwiesen_Viva: 'Überwiesen (Viva)',
    Karte_BAWAG: 'Karte (BAWAG)',
    Karte_N26: 'Karte (N26)',
    Karte_Viva: 'Karte (Viva)'
  };
  return p ? map[p] || p.replace(/_/g, ' ') : '—';
}

// Nach der Lieferanten-Auswahl: in der Erst-Erfassung -> Zahlungsart,
// beim Korrigieren (Zahlungsart steht schon) -> zurück zur Übersicht.
function afterSupplierChosen(ctx, sid) {
  const session = userSessions[sid];
  if (!session) return;
  if (session.paymentMethod) showReview(ctx, sid);
  else askForPayment(ctx, sid);
}

// Übersicht aller erkannten Werte mit Korrektur-Buttons.
// Unsichere Werte werden mit ⚠️ markiert, damit man gezielt hinschaut.
function showReview(ctx, sid) {
  const s = userSessions[sid];
  if (!s) return;

  // 'fallback' = kein Stichwort gefunden, nur der größte Betrag -> unsicher
  const totalFlag =
    s.total === null || s.total === undefined
      ? ' ⚠️'
      : s.totalSource === 'fallback'
        ? ' ⚠️ (unsicher)'
        : '';
  // 'computed'/'net-diff' = nicht abgelesen, sondern errechnet
  const vatFlag =
    s.vat === null || s.vat === undefined
      ? ' ⚠️'
      : vatLooksOff(s.total, s.vat)
        ? ' ⚠️ (unsicher)'
        : s.vatSource === 'computed' || s.vatSource === 'net-diff'
          ? ' (gerechnet)'
          : '';

  const hints = [];
  if (s.totalSource === 'fallback') hints.push('Betrag wurde nur geschätzt – bitte vergleichen.');
  if (s.total === null || s.total === undefined) hints.push('Kein Betrag gefunden – bitte eintragen.');
  if (vatLooksOff(s.total, s.vat)) hints.push('MwSt passt rechnerisch nicht zum Brutto.');
  if (!s.invoiceDate) hints.push('Kein Datum erkannt – ohne Datum zählt der Beleg im aktuellen Monat.');
  if (!s.receiptNumber) hints.push('Keine Beleg-Nr. gefunden – der Dateiname endet dann auf „ohneNr".');

  const kind = receiptKind(s.paymentMethod);
  const monthKey = s.invoiceDate ? s.invoiceDate.slice(0, 7) : monthKeyOf(new Date());

  const txt =
    `📋 *Bitte prüfen:*\n\n` +
    `🏪 Lieferant: ${mdEscape(s.supplier || '—')}\n` +
    `💶 Brutto: ${fmtAmount(s.total)}${totalFlag}\n` +
    `🧾 MwSt: ${fmtAmount(s.vat)}${vatFlag}\n` +
    `📅 Datum: ${fmtDate(s.invoiceDate)}\n` +
    `🔖 Beleg-Nr.: ${mdEscape(s.receiptNumber || '—')}\n` +
    `${paymentIcon(s.paymentMethod)} Zahlung: ${mdEscape(prettyPayment(s.paymentMethod))}\n` +
    `${kind.icon} Art: ${kind.short} · ${monthLabel(monthKey)}\n` +
    (hints.length ? `\n⚠️ ${hints.join('\n⚠️ ')}\n` : '') +
    `\nStimmt alles? Sonst einzeln korrigieren:`;
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
  const sid = sidOf(ctx);
  if (!userSessions[sid]) return ctx.reply('❌ Sitzung abgelaufen');
  askForSupplier(ctx, sid);
});

// Betrags-/Datums-/Nummern-Felder: nach Eingabe fragen
const FIELD_PROMPTS = {
  total: '💶 Brutto-Betrag eingeben (z.B. 24,90):',
  vat: '🧾 MwSt-Betrag eingeben (z.B. 2,26):',
  date: '📅 Datum eingeben (TT.MM.JJJJ):',
  receiptNumber: '🔖 Beleg-Nr. eingeben:'
};
function askForField(ctx, sid, field) {
  const session = userSessions[sid];
  if (!session) return;
  session.waitingForField = field;
  trackReply(ctx, session, FIELD_PROMPTS[field]);
}
bot.action('edit_total', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); askForField(ctx, sidOf(ctx), 'total'); });
bot.action('edit_vat', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); askForField(ctx, sidOf(ctx), 'vat'); });
bot.action('edit_date', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); askForField(ctx, sidOf(ctx), 'date'); });
bot.action('edit_receipt', async (ctx) => { await ctx.answerCbQuery().catch(() => {}); askForField(ctx, sidOf(ctx), 'receiptNumber'); });

// Speichern bestätigen -> neuer Beleg ODER Korrektur eines gespeicherten
bot.action('confirm_save', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const sid = sidOf(ctx);
  const session = userSessions[sid];
  if (!session) return ctx.reply('❌ Sitzung abgelaufen');

  if (session.correctingKey) {
    const patch = {
      supplier: session.supplier,
      paymentMethod: session.paymentMethod,
      kind: receiptKind(session.paymentMethod).key,
      total: typeof session.total === 'number' ? session.total : null,
      vat: typeof session.vat === 'number' ? session.vat : null,
      invoiceDate: session.invoiceDate || null,
      receiptNumber: session.receiptNumber || null
    };
    if (session.invoiceDate) patch.month = session.invoiceDate.slice(0, 7);
    await updateInvoice(session.correctingKey, patch);
    await trackReply(ctx, session, '✅ Beleg aktualisiert.');
    await cleanupMessages(ctx, session);
    await dropSession(sid);
    return;
  }

  // Duplikat-Prüfung: jetzt sind Lieferant, Betrag, Datum und Zahlungsart bekannt
  if (!session.duplicateAccepted) {
    const dup = await findDuplicate(session.chatId, session);
    if (dup) {
      await trackReply(
        ctx,
        session,
        `⚠️ *Dieser Beleg ist vermutlich schon erfasst!*\n\n` +
          `Gefundener Beleg:\n` +
          `🏪 ${mdEscape(dup.rec.supplier || '—')}\n` +
          `💶 ${fmtAmount(dup.rec.total)}\n` +
          `📅 ${fmtDate(dup.rec.invoiceDate)}\n` +
          `💳 ${mdEscape(prettyPayment(dup.rec.paymentMethod))}\n\n` +
          `Grund: ${mdEscape(dup.reason)}.\n\nTrotzdem speichern?`,
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
  }

  await processInvoice(ctx, sid, session);
});

// ---------- Letzten Beleg ansehen / korrigieren / löschen ----------
function lastInvoiceText(r) {
  const kind = receiptKind(r.paymentMethod);
  return (
    `🗂️ *Letzter Beleg*\n\n` +
    `${kind.icon} ${kind.short} · ${monthLabel(monthOfRecord(r))}\n` +
    `🏪 ${mdEscape(r.supplier || '—')}\n` +
    `💶 Brutto: ${fmtAmount(r.total)}\n` +
    `🧾 MwSt: ${fmtAmount(r.vat)}\n` +
    `📅 ${fmtDate(r.invoiceDate)}\n` +
    `🔖 ${mdEscape(r.receiptNumber || '—')}\n` +
    `${paymentIcon(r.paymentMethod)} ${mdEscape(prettyPayment(r.paymentMethod))}`
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
  const sid = sidOf(ctx);
  const key = ctx.match[1];
  const inv = await loadInvoices();
  const r = inv && inv[key];
  if (!r) return ctx.reply('❌ Beleg nicht mehr gefunden.');
  userSessions[sid] = {
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
  showReview(ctx, sid);
});

// ---------- Rechnung fertigstellen ----------
async function processInvoice(ctx, sid, session) {
  try {
    const processingMsg = await ctx.reply('⏳ Verarbeite Rechnung...');
    session.botMessages.push(processingMsg.message_id);

    // Nach einem Neustart fehlen die Bild-/PDF-Daten -> per file_id neu laden
    await ensureBuffers(ctx, session);

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
        { caption: buildCaption(session) }
      );
      fs.unlinkSync(otherPath);
      await persistInvoice(session);
      await cleanupMessages(ctx, session);
      await dropSession(sid);
      return;
    }

    // Nur die fertige PDF senden
    await ctx.telegram.sendDocument(
      session.chatId,
      { source: fs.createReadStream(pdfPath), filename: `${fileName}.pdf` },
      { caption: buildCaption(session) }
    );

    fs.unlinkSync(pdfPath);

    // In Datenbank speichern (für Monats-Zusammenfassung)
    await persistInvoice(session);

    // Alle Zwischen-Nachrichten + Original-Upload löschen -> nur PDF bleibt
    await cleanupMessages(ctx, session);

    await dropSession(sid);
  } catch (error) {
    console.error('Process error:', error);
    ctx.reply('❌ Fehler beim Verarbeiten');
    await dropSession(sid);
  }
}

// Beschriftung unter dem fertigen PDF in der Gruppe.
// Kopfzeile = Beleg-Art + Monat, damit man beim Ablegen am Monatsende
// auf einen Blick sieht, wohin der Beleg gehört. Bewusst ohne Markdown:
// ein Sonderzeichen im Lieferantennamen würde sonst den Versand verhindern.
function buildCaption(session) {
  const kind = receiptKind(session.paymentMethod);
  const monthKey = session.invoiceDate ? session.invoiceDate.slice(0, 7) : monthKeyOf(new Date());

  const lines = [
    `${kind.icon} ${kind.label}  ·  ${monthLabel(monthKey)}`,
    '─────────────────────',
    `🏪 ${session.supplier || '—'}`,
    `${paymentIcon(session.paymentMethod)} ${prettyPayment(session.paymentMethod)}`
  ];

  lines.push(
    session.invoiceDate
      ? `📅 ${fmtDate(session.invoiceDate)}`
      : `📅 kein Datum erkannt – zählt zu ${monthLabel(monthKey)}`
  );

  if (session.receiptNumber) lines.push(`🔖 Beleg-Nr. ${session.receiptNumber}`);
  if (typeof session.total === 'number') lines.push(`💶 Brutto ${euro(session.total)}`);
  if (typeof session.vat === 'number') lines.push(`🧾 davon MwSt ${euro(session.vat)}`);

  const pages = session.images ? session.images.length : 0;
  if (pages > 1) lines.push(`📑 ${pages} Seiten`);

  return lines.join('\n');
}

async function persistInvoice(session) {
  // Monat nach Rechnungsdatum (für korrekte Monats-Zusammenfassung), sonst heute
  const month = session.invoiceDate ? session.invoiceDate.slice(0, 7) : monthKeyOf(new Date());
  // Häufigkeit mitzählen -> der Lieferant rutscht in der Auswahl nach oben
  bumpSupplierUsage(session.supplier);
  await saveInvoice({
    chatId: session.chatId,
    supplier: session.supplier,
    paymentMethod: session.paymentMethod,
    kind: receiptKind(session.paymentMethod).key, // Kassenrechnung / Eingangsrechnung
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

// Polling nur im lokalen Betrieb (siehe Sicherheitsregel beim Start unten)
const usePolling =
  process.env.USE_POLLING === 'true' && !/^https:\/\/.+/.test(process.env.WEBHOOK_URL || '');

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2026-08-20-detection-v6',
    features: [
      'ocr-dual', 'ocr-lang-de', 'crop', 'multipage', 'viva',
      'receiptNr-v3', 'vat-v5', 'vat-multiline-rates', 'vat-repeated-rates',
      'vat-active-rates', 'vat-tax-free',
      'total-columns', 'total-payment-line', 'total-label-order', 'date-v2',
      'supplier-v4', 'supplier-search', 'dup-check', 'kassen-eingangsrechnung'
    ],
    firebase: FIREBASE_DB ? 'konfiguriert' : 'fehlt',
    suppliers: SUPPLIERS.length,
    mode: usePolling ? 'polling' : 'webhook'
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

  // Wie oft welcher Lieferant verwendet wurde (Sortierung der Auswahl)
  await loadSupplierUsage();

  // Offene Sessions nach einem Neustart zurückholen
  try {
    const restored = await loadSessionsAtStartup();
    if (restored) console.log(`♻️ ${restored} offene Session(s) wiederhergestellt`);
  } catch (error) {
    console.error('Session-Load:', error.message);
  }

  try {
    const webhookUrl = process.env.WEBHOOK_URL;
    const webhookOk = !!webhookUrl && /^https:\/\/.+/.test(webhookUrl);

    // SICHERHEITSREGEL: Polling nur, wenn KEINE gültige WEBHOOK_URL gesetzt ist.
    // Auf dem Server ist die URL immer gesetzt -> dort bleibt es beim Webhook,
    // selbst wenn USE_POLLING dort versehentlich auf true steht. Ein Polling-Start
    // würde den Webhook löschen und den Bot in der Gruppe stumm schalten.
    if (usePolling && !webhookOk) {
      await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
      // NICHT awaiten: bot.launch() läuft, bis der Bot gestoppt wird
      bot.launch().catch((error) => console.error('Polling error:', error.message));
      console.log('✅ Polling aktiv (USE_POLLING=true, keine WEBHOOK_URL)');
    } else if (webhookOk) {
      await bot.telegram.setWebhook(webhookUrl);
      console.log('✅ Webhook set!');
      if (usePolling) {
        console.log('ℹ️ USE_POLLING=true wird ignoriert, weil WEBHOOK_URL gesetzt ist.');
      }
    } else {
      // Leere/ungültige URL würde den bestehenden Webhook löschen -> nicht anfassen
      console.log('⚠️ WEBHOOK_URL fehlt/ungültig – bestehender Webhook bleibt unverändert.');
    }
  } catch (error) {
    console.log(`⚠️ Start-Modus: ${error.message}`);
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

// Den Prozess NICHT an einem einzelnen Fehler sterben lassen (sonst gehen
// laufende Sitzungen im RAM verloren). Nur protokollieren.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});
