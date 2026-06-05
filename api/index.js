import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = path.join(__dirname, 'temp');

// Create temp directory if it doesn't exist
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Telegram Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const userSessions = {};

console.log('🤖 Bot initialized');

// Helper: Generate Filename
function generateFileName(data) {
  const date = new Date().toISOString().split('T')[0];
  const supplier = (data.supplier || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
  const payment = (data.paymentMethod || 'unknown').replace(/\s+/g, '');
  const account = (data.account || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
  return `${date}_${supplier}_${payment}_${account}`;
}

// Commands
bot.start((ctx) => {
  ctx.reply('👋 Willkommen!\n\n📸 Lade ein Rechnungs-Foto oder PDF hoch und ich benenne es für dich!');
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
      messageId: ctx.message.message_id,
      timestamp: new Date().toISOString(),
      type: 'photo'
    };

    ctx.reply(
      '🏪 Von welchem Lieferant stammt die Rechnung?\n\nSchreib den Namen:',
      {
        reply_markup: {
          force_reply: true
        }
      }
    );
  } catch (error) {
    console.error('Photo error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
  }
});

// Document Handler (für PDFs)
bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  
  try {
    const fileId = ctx.message.document.file_id;
    
    userSessions[userId] = {
      fileId,
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      fileName: ctx.message.document.file_name,
      timestamp: new Date().toISOString(),
      type: 'document'
    };

    ctx.reply(
      '🏪 Von welchem Lieferant stammt die Rechnung?\n\nSchreib den Namen:',
      {
        reply_markup: {
          force_reply: true
        }
      }
    );
  } catch (error) {
    console.error('Document error:', error);
    ctx.reply('❌ Fehler bei der Verarbeitung');
  }
});

// Text Handler
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const session = userSessions[userId];

  if (!session) {
    ctx.reply('📸 Bitte lade erst ein Foto oder PDF hoch!');
    return;
  }

  if (!session.supplier) {
    session.supplier = text;
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
    return;
  }

  ctx.reply('❌ Bitte nutze die Buttons!');
});

// Payment callbacks
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

  session.paymentMethod = 'Karte';
  askForAccount(ctx, userId);
});

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

// Account callbacks
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

// Process and rename photo/document
async function processInvoice(ctx, userId, session) {
  try {
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
    const localPath = path.join(tempDir, `${fileName}.${fileExtension}`);
    
    // Save file locally
    fs.writeFileSync(localPath, response.data);
    
    // Send file back to group with new name
    const fileStream = fs.createReadStream(localPath);
    await ctx.telegram.sendDocument(
      session.chatId,
      {
        source: fileStream,
        filename: `${fileName}.${fileExtension}`
      },
      {
        caption: `✅ Rechnung verarbeitet!\n\n📄 ${fileName}\n🏪 ${session.supplier}\n💰 ${session.paymentMethod}\n🏦 ${session.account}`
      }
    );

    // Clean up temp file
    fs.unlinkSync(localPath);

    ctx.answerCbQuery('✅ Fertig!');
    delete userSessions[userId];
  } catch (error) {
    console.error('Process error:', error);
    ctx.reply('❌ Fehler beim Verarbeiten');
    delete userSessions[userId];
  }
}

// Webhook Handler
app.post('/api/webhook', express.json(), async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(200);
  }
});

// Health Check
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
    const webhookUrl = process.env.WEBHOOK_URL || `https://your-railway-url.up.railway.app/api/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Webhook set!`);
  } catch (error) {
    console.log(`⚠️ Webhook setup: ${error.message}`);
  }
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});