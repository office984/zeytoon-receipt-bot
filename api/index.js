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
  const date = new Date().toISOString().split('T')[0];
  const supplier = (data.supplier || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
  const payment = (data.paymentMethod || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_');
  const account = (data.account || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
  return `${date}_${supplier}_${payment}_${account}`;
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

// ---------- Commands ----------

bot.start((ctx) => {
  ctx.reply('👋 Willkommen!\n\n📸 Lade ein Rechnungs-Foto oder PDF hoch – ich lese den Lieferanten automatisch aus.');
});

bot.help((ctx) => {
  ctx.reply('📸 Foto oder PDF hochladen. Ich erkenne den Lieferanten selbst und frage nur noch nach der Zahlungsart.');
});

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
  try {
    const base64 = buffer.toString('base64');
    if (meta.isImage) {
      text = await ocrImage(base64);
    } else if (meta.isPdf) {
      text = await ocrPdf(base64);
    }
  } catch (error) {
    console.error('OCR error:', error.response?.data || error.message);
  }

  session.extractedText = text;
  const supplier = matchSupplier(text);

  if (supplier) {
    session.supplier = supplier;
    await trackReply(ctx, session, `✅ Lieferant erkannt: *${supplier}*`, { parse_mode: 'Markdown' });
    askForPayment(ctx, userId);
  } else {
    await trackReply(ctx, session, '🤔 Lieferant konnte nicht automatisch erkannt werden.');
    askForSupplier(ctx, userId);
  }
}

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

  if (!session) {
    ctx.reply('📸 Bitte lade erst ein Foto oder PDF hoch!');
    return;
  }

  if (session.waitingForSupplier) {
    session.supplier = ctx.message.text;
    session.waitingForSupplier = false;
    // die getippte Antwort des Users auch wieder aufräumen
    session.botMessages.push(ctx.message.message_id);
    askForPayment(ctx, userId);
    return;
  }

  ctx.reply('❌ Bitte nutze die Buttons!');
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
      account: session.account
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
  return (
    `✅ Rechnung verarbeitet!\n\n` +
    `📄 ${fileName}\n` +
    `🏪 ${session.supplier}\n` +
    `💰 ${session.paymentMethod}`
  );
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
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({ message: 'Zeytoon Receipt Bot is running' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  try {
    const webhookUrl = process.env.WEBHOOK_URL;
    await bot.telegram.setWebhook(webhookUrl);
    console.log('✅ Webhook set!');
  } catch (error) {
    console.log(`⚠️ Webhook: ${error.message}`);
  }
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});
