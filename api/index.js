import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Telegram Bot
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

console.log('🤖 Bot initialized');

// Basic Commands
bot.start((ctx) => {
  ctx.reply('👋 Bot läuft! /help für mehr Info');
});

bot.help((ctx) => {
  ctx.reply('📸 Schreib /test um zu testen!');
});

bot.command('test', (ctx) => {
  ctx.reply('✅ Bot funktioniert!');
});

// Echo alle Messages
bot.on('text', (ctx) => {
  ctx.reply(`Du hast geschrieben: ${ctx.message.text}`);
});

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
