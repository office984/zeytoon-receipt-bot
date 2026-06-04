import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import vision from '@google-cloud/vision';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, push, get, query, orderByChild, limitToLast } from 'firebase/database';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express Setup
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb' }));

// Firebase Config
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: "zeytoon-belege",
  databaseURL: "https://zeytoon-belege.firebaseio.com",
  authDomain: "zeytoon-belege.firebaseapp.com",
  storageBucket: "zeytoon-belege.appspot.com",
};

let firebaseApp;
let database;

try {
  firebaseApp = initializeApp(firebaseConfig);
  database = getDatabase(firebaseApp);
  console.log('✅ Firebase initialized');
} catch (error) {
  console.error('❌ Firebase error:', error.message);
}

// Google Vision Client
const visionClient = new vision.ImageAnnotatorClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

// Alternative: Nutze API-Key wenn env var nicht vorhanden
let visionApiKey = process.env.GOOGLE_VISION_API_KEY;

// Telegram Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// State für User-Sessions
const userSessions = {};

// ============================================================================
// Helper Functions
// ============================================================================

async function extractTextFromImage(imageBuffer) {
  try {
    if (!visionApiKey) {
      console.error('❌ Google Vision API Key missing');
      return null;
    }

    const base64Image = imageBuffer.toString('base64');
    const response = await axios.post(
      `https://vision.googleapis.com/v1/images:annotateRequest?key=${visionApiKey}`,
      {
        requests: [
          {
            image: { content: base64Image },
            features: [
              { type: 'TEXT_DETECTION' },
              { type: 'DOCUMENT_TEXT_DETECTION' }
            ]
          }
        ]
      }
    );

    const textAnnotations = response.data.responses[0].textAnnotations;
    if (textAnnotations && textAnnotations.length > 0) {
      return textAnnotations[0].description;
    }
    return null;
  } catch (error) {
    console.error('Vision API Error:', error.message);
    return null;
  }
}

// Extrahiere Lieferant aus Text
function extractSupplier(text) {
  const lines = text.split('\n').slice(0, 5);
  return lines.find(l => l.length > 3) || 'Unknown';
}

// Extrahiere MwSt-Satz aus Text
function extractVatRate(text) {
  const vatPatterns = [
    /(\d{1,2})\s*%\s*(MwSt|VAT|Mehrwertsteuer|Umsatzsteuer)/gi,
    /MwSt[:\s]+(\d{1,2})\s*%/gi,
    /(\d{1,2})\s*%/gi
  ];

  for (const pattern of vatPatterns) {
    const match = text.match(pattern);
    if (match) {
      const numbers = match[0].match(/\d+/);
      if (numbers) {
        const rate = parseInt(numbers[0]);
        if (rate >= 5 && rate <= 25) {
          return rate + '%';
        }
      }
    }
  }
  return '20%'; // Default
}

// Generiere Dateiname
function generateFileName(data) {
  const date = new Date(data.timestamp);
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const supplier = data.supplier.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
  const payment = data.paymentMethod.replace(/\s+/g, '');
  const account = (data.account || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
  
  return `${dateStr}_${supplier}_${payment}_${account}`;
}

// Erstelle PDF aus Bild + Metadaten
async function createReceiptPDF(imagePath, metadata) {
  return new Promise((resolve, reject) => {
    try {
      const pdfPath = path.join(__dirname, `receipts/${metadata.fileName}.pdf`);
      
      // Erstelle receipts Folder falls nicht vorhanden
      if (!fs.existsSync(path.join(__dirname, 'receipts'))) {
        fs.mkdirSync(path.join(__dirname, 'receipts'), { recursive: true });
      }

      const doc = new PDFDocument({ bufferPages: true });
      const stream = fs.createWriteStream(pdfPath);

      doc.pipe(stream);

      // Title
      doc.fontSize(16).font('Helvetica-Bold').text('Zeytoon - Rechnungsbeleg', 50, 50);

      // Metadata
      doc.fontSize(11).font('Helvetica').text(`Datum: ${new Date(metadata.timestamp).toLocaleDateString('de-AT')}`, 50, 100);
      doc.text(`Lieferant: ${metadata.supplier}`, 50, 120);
      doc.text(`Zahlungsart: ${metadata.paymentMethod}`, 50, 140);
      doc.text(`Konto: ${metadata.account || 'N/A'}`, 50, 160);
      doc.text(`MwSt-Satz: ${metadata.vatRate}`, 50, 180);

      if (metadata.frameDetected) {
        doc.fontSize(9).font('Helvetica').fillColor('green');
        doc.text('✓ Rahmen automatisch erkannt und gecroppt', 50, 210);
      } else {
        doc.fontSize(9).font('Helvetica').fillColor('blue');
        doc.text('ℹ Kein Rahmen erkannt (manuell freigestellt)', 50, 210);
      }

      doc.fillColor('black');

      // Extrahierter Text
      doc.fontSize(10).font('Helvetica').text('\n--- Extrahierter Text ---\n', 50, 240);
      doc.fontSize(9).text(metadata.extractedText || 'Kein Text erkannt', 50, 270, {
        width: 500,
        height: 200,
        overflow: 'ellipsis'
      });

      // Original Bild
      if (fs.existsSync(imagePath)) {
        doc.addPage().image(imagePath, 50, 50, { width: 500 });
      }

      doc.end();

      stream.on('finish', () => {
        resolve({ success: true, path: pdfPath });
      });

      stream.on('error', (error) => {
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Speichere in Firebase
async function saveToFirebase(metadata, pdfPath) {
  try {
    const invoicesRef = ref(database, 'invoices');
    const newInvoiceRef = push(invoicesRef);
    
    const invoiceData = {
      fileName: metadata.fileName,
      supplier: metadata.supplier,
      paymentMethod: metadata.paymentMethod,
      account: metadata.account,
      vatRate: metadata.vatRate,
      extractedText: metadata.extractedText,
      frameDetected: metadata.frameDetected,
      timestamp: metadata.timestamp,
      userId: metadata.userId,
      createdAt: new Date().toISOString()
    };

    await newInvoiceRef.set(invoiceData);
    console.log('✅ Saved to Firebase:', metadata.fileName);
    return { success: true, id: newInvoiceRef.key };
  } catch (error) {
    console.error('❌ Firebase save error:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Telegram Bot Commands
// ============================================================================

bot.start((ctx) => {
  ctx.reply(
    '👋 Willkommen zum Zeytoon Rechnungs-Bot!\n\n' +
    '📸 Sende ein Foto oder PDF einer Rechnung und ich verarbeite es automatisch.\n\n' +
    '/help - Hilfe\n' +
    '/dashboard - Dashboard öffnen'
  );
});

bot.help((ctx) => {
  ctx.reply(
    '📋 So funktioniert der Bot:\n\n' +
    '1. 📸 Lade ein Foto oder PDF einer Rechnung hoch\n' +
    '2. 🤖 Ich erkenne automatisch:\n' +
    '   • Lieferant\n' +
    '   • MwSt-Satz\n' +
    '   • Text der Rechnung\n' +
    '3. ❓ Ich frage dich nach:\n' +
    '   • Bar oder Karte?\n' +
    '   • Von welchem Konto?\n' +
    '4. 📄 Ich speichere alles als PDF\n\n' +
    '/start - Zurück zum Start\n' +
    '/dashboard - Zur Web-Oberfläche'
  );
});

bot.command('dashboard', (ctx) => {
  ctx.reply('📊 Dashboard: ' + process.env.DASHBOARD_URL || 'https://your-app.vercel.app');
});

// Handle Photos
bot.on('photo', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  try {
    // Download Photo
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    ctx.reply('⏳ Verarbeite Rechnung...');

    // Download and process
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data);

    // Extract Text with Vision API
    const extractedText = await extractTextFromImage(imageBuffer);
    const supplier = extractSupplier(extractedText || 'Unknown');
    const vatRate = extractVatRate(extractedText || '');

    // Initialize session
    userSessions[userId] = {
      extractedText,
      supplier,
      vatRate,
      imageBuffer,
      timestamp: new Date().toISOString(),
      chatId
    };

    // Ask for payment method
    ctx.reply(
      `✅ Rechnung erkannt!\n\n` +
      `📦 Lieferant: ${supplier}\n` +
      `📊 MwSt: ${vatRate}\n\n` +
      `Wie wurde bezahlt?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Bar 💵', callback_data: 'payment_cash' },
              { text: 'Karte 💳', callback_data: 'payment_card' }
            ]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Photo handling error:', error);
    ctx.reply('❌ Fehler beim Verarbeiten der Rechnung');
  }
});

// Handle Callback Queries (Buttons)
bot.action('payment_cash', (ctx) => {
  const userId = ctx.from.id;
  if (!userSessions[userId]) {
    ctx.reply('❌ Sitzung abgelaufen. Bitte neue Rechnung hochladen.');
    return;
  }

  userSessions[userId].paymentMethod = 'Bar';
  ctx.reply(
    '💳 Von welchem Konto wurde die Rechnung bezahlt?',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Geschäftskonto', callback_data: 'account_business' },
            { text: 'Privat', callback_data: 'account_private' }
          ]
        ]
      }
    }
  );
});

bot.action('payment_card', (ctx) => {
  const userId = ctx.from.id;
  if (!userSessions[userId]) {
    ctx.reply('❌ Sitzung abgelaufen. Bitte neue Rechnung hochladen.');
    return;
  }

  userSessions[userId].paymentMethod = 'Karte';
  ctx.reply(
    '💳 Von welchem Konto wurde die Rechnung bezahlt?',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Geschäftskonto', callback_data: 'account_business' },
            { text: 'Privat', callback_data: 'account_private' }
          ]
        ]
      }
    }
  );
});

bot.action('account_business', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];

  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen.');
    return;
  }

  session.account = 'Geschäftskonto';
  await finalizeReceipt(ctx, userId, session);
});

bot.action('account_private', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];

  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen.');
    return;
  }

  session.account = 'Privat';
  await finalizeReceipt(ctx, userId, session);
});

async function finalizeReceipt(ctx, userId, session) {
  try {
    // Generate filename
    const fileName = generateFileName({
      supplier: session.supplier,
      paymentMethod: session.paymentMethod,
      account: session.account,
      timestamp: session.timestamp
    });

    // Save image temporarily
    const tempImagePath = path.join(__dirname, `temp/${fileName}.jpg`);
    if (!fs.existsSync(path.join(__dirname, 'temp'))) {
      fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
    }
    fs.writeFileSync(tempImagePath, session.imageBuffer);

    // Create PDF
    const pdfResult = await createReceiptPDF(tempImagePath, {
      fileName,
      supplier: session.supplier,
      paymentMethod: session.paymentMethod,
      account: session.account,
      vatRate: session.vatRate,
      extractedText: session.extractedText,
      frameDetected: false,
      timestamp: session.timestamp,
      userId
    });

    // Save to Firebase
    const firebaseResult = await saveToFirebase({
      fileName,
      supplier: session.supplier,
      paymentMethod: session.paymentMethod,
      account: session.account,
      vatRate: session.vatRate,
      extractedText: session.extractedText,
      frameDetected: false,
      timestamp: session.timestamp,
      userId
    }, pdfResult.path);

    if (firebaseResult.success) {
      ctx.reply(
        `✅ Rechnung gespeichert!\n\n` +
        `📄 Datei: ${fileName}.pdf\n` +
        `💰 Zahlungsart: ${session.paymentMethod}\n` +
        `🏦 Konto: ${session.account}\n` +
        `📊 MwSt: ${session.vatRate}`
      );
    } else {
      ctx.reply('❌ Fehler beim Speichern in Firebase');
    }

    // Cleanup temp file
    fs.unlinkSync(tempImagePath);
    delete userSessions[userId];

  } catch (error) {
    console.error('Finalize error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
    delete userSessions[userId];
  }
}

// ============================================================================
// Express Routes
// ============================================================================

// Webhook für Telegram
app.post('/api/webhook', express.json(), async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// Get all invoices
app.get('/api/invoices', async (req, res) => {
  try {
    const invoicesRef = ref(database, 'invoices');
    const snapshot = await get(invoicesRef);
    const data = snapshot.val() || {};
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// Server Start
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  
  // Set webhook
  try {
    const webhookUrl = process.env.WEBHOOK_URL || `https://your-app.vercel.app/api/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Telegram webhook set to: ${webhookUrl}`);
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
  }

  // Start polling for testing
  if (process.env.USE_POLLING === 'true') {
    await bot.launch();
    console.log('✅ Bot started with polling');
  }
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
