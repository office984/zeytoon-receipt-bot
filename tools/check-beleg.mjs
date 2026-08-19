// Prüf-Werkzeug: liest einen Beleg (PDF oder Bild) mit derselben OCR wie der Bot
// und zeigt, was die Erkennung daraus macht. Gedacht für Belege, bei denen der
// Bot im Betrieb daneben lag – der Rohtext zeigt sofort, woran es liegt.
//
//   node tools/check-beleg.mjs "C:\Pfad\zum\Beleg.pdf"
//   node tools/check-beleg.mjs beleg1.pdf beleg2.jpg      (mehrere auf einmal)
//   node tools/check-beleg.mjs --text beleg.pdf           (mit vollem Rohtext)
//
// Braucht GOOGLE_VISION_API_KEY in der .env – also dieselbe Datei wie der Bot.
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import {
  detectTotalInfo, detectVatInfo, detectReceiptNumber, detectDate,
  guessSupplierFromText, matchSupplier, euro
} from '../api/detect.js';
import { BASE_SUPPLIERS } from '../api/suppliers.js';

dotenv.config();

const KEY = process.env.GOOGLE_VISION_API_KEY;
const OWN = (process.env.OWN_COMPANY || 'zeytoon').split(',').map((s) => s.trim()).filter(Boolean);
const CONTEXT = { languageHints: ['de', 'en'] };

const args = process.argv.slice(2);
const zeigeText = args.includes('--text');
const dateien = args.filter((a) => !a.startsWith('--'));

if (!KEY) {
  console.error('❌ GOOGLE_VISION_API_KEY fehlt (in .env eintragen).');
  process.exit(1);
}
if (!dateien.length) {
  console.error('Aufruf: node tools/check-beleg.mjs [--text] <datei> [weitere dateien]');
  process.exit(1);
}

async function ocr(datei) {
  const base64 = fs.readFileSync(datei).toString('base64');
  if (path.extname(datei).toLowerCase() === '.pdf') {
    const { data } = await axios.post(
      `https://vision.googleapis.com/v1/files:annotate?key=${KEY}`,
      { requests: [{
        inputConfig: { content: base64, mimeType: 'application/pdf' },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: CONTEXT
      }] }
    );
    const seiten = data.responses?.[0]?.responses || [];
    return [seiten.map((p) => p.fullTextAnnotation?.text || '').join('\n')];
  }
  // Bild: beide Verfahren, genau wie der Bot
  const { data } = await axios.post(
    `https://vision.googleapis.com/v1/images:annotate?key=${KEY}`,
    { requests: [
      { image: { content: base64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], imageContext: CONTEXT },
      { image: { content: base64 }, features: [{ type: 'TEXT_DETECTION' }], imageContext: CONTEXT }
    ] }
  );
  const [doc, sparse] = data.responses || [];
  return [
    doc?.fullTextAnnotation?.text || '',
    sparse?.fullTextAnnotation?.text || sparse?.textAnnotations?.[0]?.description || ''
  ].filter(Boolean);
}

for (const datei of dateien) {
  console.log('\n' + '='.repeat(70));
  console.log(path.basename(datei));
  console.log('='.repeat(70));

  let texte;
  try {
    texte = await ocr(datei);
  } catch (e) {
    const info = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    console.log('❌ OCR fehlgeschlagen:', info);
    continue;
  }

  const text = texte[0] || '';
  if (!text.trim()) {
    console.log('❌ Kein Text erkannt.');
    continue;
  }
  if (zeigeText) {
    console.log('\n--- Rohtext ---');
    text.split(/\r?\n/).forEach((l, i) => console.log(String(i).padStart(3) + ' | ' + l));
    console.log('--- Ende ---\n');
  }

  const total = detectTotalInfo(text);
  const vat = detectVatInfo(text, total.value);
  const bekannt = matchSupplier(text, BASE_SUPPLIERS);

  console.log(`  Lieferant : ${bekannt || guessSupplierFromText(text, OWN) || '— NICHT ERKANNT —'}` +
    `  ${bekannt ? '(aus Liste)' : '(frei gelesen)'}`);
  console.log(`  Brutto    : ${total.value === null ? '— NICHT ERKANNT —' : euro(total.value)}  [${total.source}]`);
  console.log(`  MwSt      : ${vat.value === null ? '— NICHT ERKANNT —' : euro(vat.value)}  [${vat.source}]`);
  console.log(`  Datum     : ${detectDate(text) || '— NICHT ERKANNT —'}`);
  console.log(`  Beleg-Nr. : ${detectReceiptNumber(text) || '— NICHT ERKANNT —'}`);
  if (!zeigeText) console.log('  (Rohtext mit --text anzeigen)');
}
