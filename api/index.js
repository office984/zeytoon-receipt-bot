import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, push, set } from 'firebase/database';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Firebase Config
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: "zeytoon-belege",
  databaseURL: "https://zeytoon-belege.firebaseio.com",
  authDomain: "zeytoon-belege.firebaseapp.com",
  storageBucket: "zeytoon-belege.appspot.com",
};

let database;
try {
  const firebaseApp = initializeApp(firebaseConfig);
  database = getDatabase(firebaseApp);
  console.log('✅ Firebase connected');
} catch (error) {
  console.error('Firebase error:', error.message);
}

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
  ctx.reply('👋 Willkommen!\n\n📸 Lade eine Rechnung hoch und ich verarbeite sie!');
});

bot.help((ctx) => {
  ctx.reply('📸 Einfach ein Foto einer Rechnung hochladen!');
});

// Photo Handler
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  
  try {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    
    // Initialize session
    userSessions[userId] = {
      fileId,
      chatId,
      timestamp: new Date().toISOString()
    };

    // Ask for supplier
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

// Text Handler - für Lieferant, Zahlungsart, Konto
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  const session = userSessions[userId];

  if (!session) {
    ctx.reply('📸 Bitte lade erst ein Foto einer Rechnung hoch!');
    return;
  }

  // Step 1: Supplier Name
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

  ctx.reply('❌ Bitte nutze die Buttons für deine Antwort!');
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
  await saveInvoice(ctx, userId, session);
});

bot.action('account_private', async (ctx) => {
  const userId = ctx.from.id;
  const session = userSessions[userId];
  
  if (!session) {
    ctx.reply('❌ Sitzung abgelaufen');
    return;
  }

  session.account = 'Privat';
  await saveInvoice(ctx, userId, session);
});

// Save to Firebase
async function saveInvoice(ctx, userId, session) {
  try {
    const fileName = generateFileName({
      supplier: session.supplier,
      paymentMethod: session.paymentMethod,
      account: session.account
    });

    const invoiceData = {
      fileName,
      supplier: session.supplier,
      paymentMethod: session.paymentMethod,
      account: session.account,
      fileId: session.fileId,
      timestamp: session.timestamp,
      userId,
      createdAt: new Date().toISOString()
    };

    // Save to Firebase
    if (database) {
      const invoicesRef = ref(database, 'invoices');
      const newInvoiceRef = push(invoicesRef);
      await newInvoiceRef.set(invoiceData);
    }

    ctx.reply(
      `✅ Rechnung gespeichert!\n\n` +
      `📄 Datei: ${fileName}\n` +
      `🏪 Lieferant: ${session.supplier}\n` +
      `💰 Zahlungsart: ${session.paymentMethod}\n` +
      `🏦 Konto: ${session.account}`
    );

    delete userSessions[userId];
  } catch (error) {
    console.error('Firebase error:', error);
    ctx.reply('❌ Fehler beim Speichern. Bitte versuchen Sie es später erneut.');
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

// Root
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