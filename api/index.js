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

// Lieferanten Liste
const SUPPLIERS = [
  'Metro 1110',
  'GastroGenius GmbH',
  'Sahan Einzelhandel GmbH',
  'Rubin GmbH',
  'Orient GmbH',
  'Shirinagha Hussaini (Tandori Brot)',
  'Spar',
  'Dr. Falafel',
  'IG Gastro',
  'Kaffee Partner',
  'AKM',
  'Hofer',
  'JET Tankstelle',
  'Interspar',
  'Alizadeh Ashouri',
  'Reza Davoudi',
  'Etsan'
];

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const userSessions = {};

console.log('🤖 Bot initialized');

// Helper: Generate Filename
function generateFileName(data) {
  const date = new Date().toISOString().split('T')[0];
  const supplier = (data.supplier || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
  const payment = (data.paymentMethod || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_');
  const account = (data.account || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
  return `${date}_${supplier}_${payment}_${account}`;
}

// Helper: Create PDF from Image
function createPdfFromImage(imagePath, pdfPath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 10
      });

      const stream = fs.createWriteStream(pdfPath);
      
      doc.pipe(stream);

      // Get image dimensions
      const img = doc.openImage(imagePath);
      const pageWidth = doc.page.width - 20;
      const pageHeight = doc.page.height - 20;
      
      // Scale image to fit page
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

      // Center image on page
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

// Commands
bot.start((ctx) => {
  ctx.reply('👋 Willkommen!\n\n📸 Lade ein Rechnungs-Foto oder PDF hoch!');
});

bot.help((ctx) => {
  ctx.reply('📸 Foto oder PDF hochladen!');
});

// Photo Handler
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    
    userSessions[userId] = {
      fileId,
      chatId: ctx.chat.id,
      timestamp: new Date().toISOString(),
      type: 'photo'
    };

    askForSupplier(ctx, userId);
  } catch (error) {
    console.error('Photo error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
  }
});

// Document Handler
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    const fileId = ctx.message.document.file_id;
    
    userSessions[userId] = {
      fileId,
      chatId: ctx.chat.id,
      fileName: ctx.message.document.file_name,
      timestamp: new Date().toISOString(),
      type: 'document'
    };

    askForSupplier(ctx, userId);
  } catch (error) {
    console.error('Document error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
  }
});

// Ask for Supplier with Buttons
function askForSupplier(ctx, userId) {
  const buttons = [];
  
  // Create buttons for suppliers (2 per row)
  for (let i = 0; i < SUPPLIERS.length; i += 2) {
    const row = [];
    row.push({ text: SUPPLIERS[i], callback_data: `supplier_${i}` });
    if (i + 1 < SUPPLIERS.length) {
      row.push({ text: SUPPLIERS[i + 1], callback_data: `supplier_${i + 1}` });
    }
    buttons.push(row);
  }
  
  // Add "Sonstiges" button
  buttons.push([{ text: 'Sonstiges ➕', callback_data: 'supplier_other' }]);

  ctx.reply(
    '🏪 Welcher Lieferant?',
    {
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
}

// Supplier Selection
bot.action(/supplier_/, async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  const action = ctx.match[0];
  
  if (action === 'supplier_other') {
    ctx.reply('📝 Schreib den Namen des neuen Lieferanten:');
    session.waitingForSupplier = true;
  } else {
    const index = parseInt(action.split('_')[1]);
    session.supplier = SUPPLIERS[index];
    askForPayment(ctx, userId);
  }
});

// Text Handler (für Sonstiges)
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];

  if (!session) {
    ctx.reply('📸 Bitte lade erst ein Foto hoch!');
    return;
  }

  if (session.waitingForSupplier) {
    session.supplier = ctx.message.text;
    session.waitingForSupplier = false;
    askForPayment(ctx, userId);
    return;
  }

  ctx.reply('❌ Bitte nutze die Buttons!');
});

// Ask for Payment
function askForPayment(ctx, userId) {
  ctx.reply(
    '💰 Wie wurde bezahlt?',
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
}

// Payment Selection
bot.action('payment_cash', (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  session.paymentMethod = 'Bar';
  askForAccount(ctx, userId);
});

bot.action('payment_card', (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  ctx.reply(
    '🏦 Welche Karte?',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'BAWAG', callback_data: 'card_bawag' },
            { text: 'N26', callback_data: 'card_n26' }
          ]
        ]
      }
    }
  );
});

// Card Selection
bot.action('card_bawag', (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  session.paymentMethod = 'Karte_BAWAG';
  askForAccount(ctx, userId);
});

bot.action('card_n26', (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  session.paymentMethod = 'Karte_N26';
  askForAccount(ctx, userId);
});

// Ask for Account
function askForAccount(ctx, userId) {
  ctx.reply(
    '🏦 Von welchem Konto?',
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
}

// Account Selection
bot.action('account_business', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  session.account = 'Geschaeftskonto';
  await processInvoice(ctx, userId, session);
});

bot.action('account_private', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  session.account = 'Privat';
  await processInvoice(ctx, userId, session);
});

// Process Invoice
async function processInvoice(ctx, userId, session) {
  try {
    ctx.reply('⏳ Verarbeite Rechnung...');

    const fileName = generateFileName({
      supplier: session.supplier,
      paymentMethod: session.paymentMethod,
      account: session.account
    });

    // Get file from Telegram
    const file = await ctx.telegram.getFile(session.fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    // Download file
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const fileExtension = file.file_path.split('.').pop();
    const originalPath = path.join(tempDir, `${fileName}.${fileExtension}`);
    const pdfPath = path.join(tempDir, `${fileName}.pdf`);
    
    // Save original file
    fs.writeFileSync(originalPath, response.data);
    
    // Create PDF from image if it's a photo
    if (session.type === 'photo') {
      await createPdfFromImage(originalPath, pdfPath);
    }

    // Send original file
    const originalStream = fs.createReadStream(originalPath);
    await ctx.telegram.sendDocument(
      session.chatId,
      {
        source: originalStream,
        filename: `${fileName}.${fileExtension}`
      },
      {
        caption: `✅ Rechnung verarbeitet!\n\n📄 ${fileName}\n🏪 ${session.supplier}\n💰 ${session.paymentMethod}\n🏦 ${session.account}`
      }
    );

    // Send PDF if created
    if (session.type === 'photo' && fs.existsSync(pdfPath)) {
      const pdfStream = fs.createReadStream(pdfPath);
      await ctx.telegram.sendDocument(
        session.chatId,
        {
          source: pdfStream,
          filename: `${fileName}.pdf`
        },
        {
          caption: `📑 PDF-Version`
        }
      );
    }

    // Clean up
    fs.unlinkSync(originalPath);
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }

    ctx.answerCbQuery('✅ Fertig!');
    delete userSessions[userId];
  } catch (error) {
    console.error('Process error:', error);
    ctx.reply('❌ Fehler beim Verarbeiten');
    delete userSessions[userId];
  }
}

// Webhook
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

// Start Server
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);
  
  try {
    const webhookUrl = process.env.WEBHOOK_URL;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Webhook set!`);
  } catch (error) {
    console.log(`⚠️ Webhook: ${error.message}`);
  }
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});