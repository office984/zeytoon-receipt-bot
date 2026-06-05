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
const SUPPLIERS = [
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
  { name: 'Etsan', keywords: ['etsan'] }
];

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const userSessions = {};

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
  if (session.userMessageId) ids.push(session.userMessageId);
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
  return res?.fullTextAnnotation?.text || res?.textAnnotations?.[0]?.description || '';
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

// PDF aus Bild erstellen
function createPdfFromImage(imagePath, pdfPath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 10 });
      const stream = fs.createWriteStream(pdfPath);
      doc.pipe(stream);

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

function euro(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return n.toFixed(2).replace('.', ',') + ' €';
}

// Beleg-/Rechnungs-/Bonnummer aus OCR-Text lesen. Gibt String oder null.
// Erkennt viele Bezeichnungen und Nummern mit Buchstaben/Bindestrichen/Schrägstrichen.
function detectReceiptNumber(text) {
  if (!text) return null;
  const re = /\b(beleg|bon|rechnung|faktura|quittung|kassenbon|kassabon|rg)s?\s*[-.]?\s*(nr|nummer|no|number|n°)?\.?\s*[:#]?\s*([A-Z]{0,4}\d{3,}(?:[-\/.][A-Z0-9]+)*)/i;
  const m = text.match(re);
  return m ? m[3] : null;
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
  if (!FIREBASE_DB) return;
  try {
    await axios.post(`${FIREBASE_DB}/invoices.json${FIREBASE_AUTH}`, record);
  } catch (error) {
    console.error('Firebase save error:', error.response?.status, error.response?.data || error.message);
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

// ---------- Zusammenfassung ----------
function summarize(invoicesObj, month, chatId) {
  const recs = Object.values(invoicesObj || {}).filter(
    (r) => r && r.month === month && (chatId == null || r.chatId === chatId)
  );
  const count = recs.length;
  const withVat = recs.filter((r) => typeof r.vat === 'number');
  const vatTotal = Math.round(withVat.reduce((s, r) => s + r.vat, 0) * 100) / 100;
  return { count, vatTotal, missing: count - withVat.length };
}

function summaryText(label, s) {
  let txt =
    `📊 *Zusammenfassung ${label}*\n\n` +
    `🧾 Belege: ${s.count}\n` +
    `💶 Bezahlte MwSt gesamt: ${euro(s.vatTotal)}`;
  if (s.missing > 0) {
    txt += `\n\n⚠️ Bei ${s.missing} Beleg(en) konnte die MwSt nicht automatisch gelesen werden.`;
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
    '📸 Foto oder PDF hochladen. Ich erkenne den Lieferanten selbst und frage nur noch nach der Zahlungsart.\n\n' +
    '📊 /zusammenfassung – MwSt-Summe des laufenden Monats'
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
    await handleIncomingFile(ctx, userId, fileId, { type: 'photo', isImage: true });
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
    await handleIncomingFile(ctx, userId, doc.file_id, {
      type: 'document',
      isImage,
      isPdf,
      fileName: doc.file_name
    });
  } catch (error) {
    console.error('Document error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
  }
});

// Gemeinsame Verarbeitung: Download -> OCR -> Lieferant erkennen
async function handleIncomingFile(ctx, userId, fileId, meta) {
  userSessions[userId] = {
    fileId,
    chatId: ctx.chat.id,
    userMessageId: ctx.message.message_id,
    botMessages: [],
    timestamp: new Date().toISOString(),
    ...meta
  };
  const session = userSessions[userId];

  await trackReply(ctx, session, '🔍 Lese Rechnung...');

  const { buffer, ext } = await downloadTelegramFile(ctx, fileId);
  session.buffer = buffer;
  session.ext = ext;

  // OCR ausführen (Fehler -> trotzdem manuell weiter)
  let text = '';
  let ocrError = null;
  try {
    const base64 = buffer.toString('base64');
    if (meta.isImage) {
      text = await ocrImage(base64);
    } else if (meta.isPdf) {
      text = await ocrPdf(base64);
    }
  } catch (error) {
    ocrError = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error('OCR error:', ocrError);
  }

  console.log(`OCR fertig – ${text.length} Zeichen erkannt`);

  // Debug: Rohtext anzeigen, wenn DEBUG_OCR=true (wird NICHT auto-gelöscht)
  if (process.env.DEBUG_OCR === 'true') {
    const info = text && text.trim() ? text.slice(0, 3500) : `(KEIN Text)${ocrError ? '\nFehler: ' + ocrError : ''}`;
    await ctx.reply(`🔧 DEBUG OCR:\n\n${info}`);
  }

  session.extractedText = text;
  session.vat = detectVat(text);
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
  const supplier = matchSupplier(session.extractedText);
  if (supplier) {
    session.supplier = supplier;
    trackReply(ctx, session, `✅ Lieferant erkannt: *${supplier}*`, { parse_mode: 'Markdown' });
    askForPayment(ctx, userId);
  } else {
    trackReply(ctx, session, '🤔 Lieferant konnte nicht automatisch erkannt werden.');
    askForSupplier(ctx, userId);
  }
}

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
  askForPayment(ctx, userId);
});

// Text-Handler (für "Sonstiges")
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];

  // Wartet der Bot auf einen getippten Lieferanten-Namen? -> übernehmen
  if (session && session.waitingForSupplier) {
    session.supplier = ctx.message.text;
    session.waitingForSupplier = false;
    // die getippte Antwort des Users auch wieder aufräumen
    session.botMessages.push(ctx.message.message_id);
    askForPayment(ctx, userId);
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
  await processInvoice(ctx, userId, session);
});

bot.action('payment_transfer', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from.id;
  const session = userSessions[userId];
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }
  session.paymentMethod = 'Ueberwiesen';
  session.account = 'Geschaeftskonto';
  await processInvoice(ctx, userId, session);
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
  await processInvoice(ctx, userId, session);
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
  await processInvoice(ctx, userId, session);
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
      // Bild -> PDF erzeugen
      const originalPath = path.join(tempDir, `${fileName}.${session.ext}`);
      fs.writeFileSync(originalPath, session.buffer);
      await createPdfFromImage(originalPath, pdfPath);
      fs.unlinkSync(originalPath);
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
  if (session.receiptNumber) {
    caption += `\n🧾 Beleg-Nr.: ${session.receiptNumber}`;
  }
  if (typeof session.vat === 'number') {
    caption += `\n💶 MwSt (erkannt): ${euro(session.vat)}`;
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
  res.json({ status: 'ok', firebase: FIREBASE_DB ? 'konfiguriert' : 'fehlt' });
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
