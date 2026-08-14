// Reine Erkennungs-Logik (kein Telegram, kein Firebase) -> dadurch testbar.
// Tests: npm test  (siehe test/detect.test.mjs)

// ---------- Basis-Helfer ----------

export function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "1.234,56" / "12,50" / "12.50" / "€ 12,50" -> Number
export function parseAmount(s) {
  s = String(s == null ? '' : s).replace(/[€\s]/g, '').trim();
  if (!s) return NaN;
  if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return parseFloat(s);
}

// Betrag in österreichischer Schreibweise: 1.234,56 €
export function euro(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const [ganz, dez] = n.toFixed(2).split('.');
  return `${ganz.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dez} €`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Geldbeträge: immer 2 Nachkommastellen. Die Lookarounds verhindern, dass aus
// "12.345" fälschlich "12.34" oder aus "1.234,56" nur "234,56" gelesen wird.
const MONEY_RE =
  /(?<![\d.,])\d{1,3}(?:[.\s]\d{3})+,\d{2}(?!\d)|(?<![\d.,])\d+,\d{2}(?!\d)|(?<![\d.,])\d+\.\d{2}(?!\d)/g;

// Alles entfernen, was wie Geld aussieht, aber keines ist:
// Datum (01.10.2025 -> sonst "1.10"), Uhrzeit, UID-Nummer, Steuersatz (20,00 %).
function stripNonMoney(line) {
  return String(line || '')
    .replace(/\b\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\bATU\s*\d+/gi, ' ')
    .replace(/\d{1,2}(?:[.,]\d{1,2})?\s*%/g, ' ');
}

// Alle Geldbeträge einer Zeile (ohne Datum/Uhrzeit/Prozent)
export function amountsOn(line) {
  return (stripNonMoney(line).match(MONEY_RE) || [])
    .map(parseAmount)
    .filter((v) => !isNaN(v));
}

// Steuersätze einer Zeile, z.B. "20%" / "10,0 %"
export function ratesOn(line) {
  const out = [];
  const re = /(\d{1,2})(?:[.,](\d{1,2}))?\s*%/g;
  let m;
  while ((m = re.exec(String(line || ''))) !== null) {
    const v = parseFloat(m[2] ? `${m[1]}.${m[2]}` : m[1]);
    if (!isNaN(v) && v > 0 && v <= 30) out.push(v);
  }
  return out;
}

// Zeile besteht im Wesentlichen nur aus einem Geldbetrag ("125.12", "€ 12,50")
export function isMoneyLine(line) {
  return /^\s*€?\s*\d[\d.\s]*[.,]\d{2}\s*€?\s*$/.test(String(line || ''));
}

function toLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ---------- Brutto-/Endbetrag ----------

// Stichwörter für den Endbetrag, nach Priorität
const TOTAL_TIERS = [
  /(zu\s*zahlen|zahlbetrag|zahlungsbetrag|endbetrag)/i,
  /(gesamtbetrag|rechnungsbetrag|gesamtsumme|gesamt|total)/i,
  /(bruttobetrag|brutto|summe|betrag)/i
];

// Zeilen, die NIE der Rechnungsbetrag sind
const TOTAL_SKIP =
  /(zwischensumme|zw\.?\s*summe|gegeben|geg\.|r(ü|ue)ckgeld|wechselgeld|herausgeld|retour|zur(ü|ue)ck|trinkgeld|rabatt|skonto|gutschein|einzahlung|spende|pfand\b)/i;

// Zeilen der Steuer-Aufstellung (Netto/MwSt) sind kein Endbetrag ...
const VAT_LINE = /(netto|mwst|mehrwertsteuer|umsatzsteuer|steuerbetrag|\bu\.?\s?st\.?\b)/i;
// ... außer die Zeile nennt ausdrücklich den Endbetrag ("Gesamtbetrag inkl. MwSt")
const STRONG_TOTAL = /(gesamtbetrag|rechnungsbetrag|gesamtsumme|zu\s*zahlen|zahlbetrag|endbetrag)/i;

// Bargeld: gegebener Betrag und Rückgeld
const CASH_GIVEN = /(gegeben|geg\.|bar\s*erhalten|erhalten|barzahlung|^\s*bar\b|^\s*cash\b|kunde\s*gibt)/i;
const CASH_CHANGE = /(r(ü|ue)ckgeld|wechselgeld|herausgeld|zur(ü|ue)ck|retour|change)/i;

// Wert steht in der nächsten Zeile (Label und Betrag in zwei Spalten/Zeilen)
function amountFromNextLines(lines, i) {
  for (let k = i + 1; k < Math.min(i + 3, lines.length); k++) {
    if (isMoneyLine(lines[k])) {
      const a = amountsOn(lines[k]);
      if (a.length) return a;
    }
  }
  return [];
}

/**
 * Endbetrag (Brutto) aus dem OCR-Text lesen.
 * @returns {{value: number|null, source: string|null}}
 *   source: 'keyword' | 'keyword+cash' | 'cash' | 'fallback' | null
 *   'fallback' = geraten, sollte vom Benutzer geprüft werden.
 */
export function detectTotalInfo(text) {
  const lines = toLines(text);
  if (!lines.length) return { value: null, source: null };

  // 1) Bargeld-Gegenprobe: Gegeben − Rückgeld = Rechnungsbetrag.
  //    Verhindert, dass der an der Kassa gegebene Bar-Betrag als Summe gilt.
  let given = null;
  let change = null;
  for (const line of lines) {
    const a = amountsOn(line);
    if (!a.length) continue;
    if (CASH_CHANGE.test(line)) {
      if (change === null) change = Math.max(...a);
    } else if (CASH_GIVEN.test(line)) {
      if (given === null) given = Math.max(...a);
    }
  }
  const cashDerived = given !== null && change !== null && given > change ? round2(given - change) : null;

  // 2) Stichwort-Zeilen nach Priorität
  for (const tier of TOTAL_TIERS) {
    const cands = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!tier.test(line)) continue;
      if (TOTAL_SKIP.test(line)) continue;
      if (VAT_LINE.test(line) && !STRONG_TOTAL.test(line)) continue;
      let a = amountsOn(line);
      if (!a.length) a = amountFromNextLines(lines, i);
      // In einer Tabellenzeile ("Summe 24,00 20,00 4,00") ist Brutto der größte Wert
      if (a.length) cands.push(Math.max(...a));
    }
    if (cands.length) {
      // Passt die Bargeld-Gegenprobe zu einem Kandidaten -> sicherster Wert
      if (cashDerived !== null && cands.some((c) => Math.abs(c - cashDerived) < 0.005)) {
        return { value: cashDerived, source: 'keyword+cash' };
      }
      return { value: Math.max(...cands), source: 'keyword' };
    }
  }

  // 3) Kein Stichwort, aber Bargeld-Gegenprobe möglich
  if (cashDerived !== null) return { value: cashDerived, source: 'cash' };

  // 4) Notfall: größter Betrag – Bargeld-/Steuerzeilen aber ausgenommen
  let max = null;
  for (const line of lines) {
    if (TOTAL_SKIP.test(line) || VAT_LINE.test(line)) continue;
    // "Bar 50,00" nur dann ignorieren, wenn es wirklich eine Bargeld-Rückgabe gab
    if (change !== null && (CASH_GIVEN.test(line) || CASH_CHANGE.test(line))) continue;
    for (const v of amountsOn(line)) if (max === null || v > max) max = v;
  }
  return max === null ? { value: null, source: null } : { value: max, source: 'fallback' };
}

export function detectTotal(text) {
  return detectTotalInfo(text).value;
}

// ---------- MwSt ----------

const SUM_VAT_RE =
  /(summe\s*(mwst|ust|steuer)|(mwst|ust|steuer)\s*(summe|gesamt|total)|gesamt\s*(mwst|ust)|enthaltene?\s*(mwst|ust)|davon\s*(mwst|ust)|inkl\.?\s*(mwst|ust|\d{1,2}\s*%\s*(mwst|ust)))/i;
const VAT_KEY_RE = /(mwst|mehrwertsteuer|umsatzsteuer|\bu\.?\s?st\.?\b|steuer)/i;
const VAT_KEY_SKIP = /(steuer\s*nr|st\.?\s?-?\s?nr|uid|atu|finanzamt)/i;

/**
 * Bezahlte MwSt aus dem OCR-Text lesen.
 * @param {string} text
 * @param {number|null} total Brutto (falls bekannt) – dient als Plausibilitätsgrenze
 * @returns {{value: number|null, source: string|null}}
 *   source: 'sum' | 'rates' | 'table' | 'keyword' | 'keyword-sum' | 'computed' | null
 */
export function detectVatInfo(text, total = null) {
  const lines = toLines(text);
  if (!lines.length) return { value: null, source: null };

  // MwSt kann nie größer als ~20% vom Brutto sein (AT: 20% inkl. = 16,67% vom Brutto)
  const plausible = (v) =>
    typeof v === 'number' && !isNaN(v) && v > 0 && (!total || v <= total * 0.21 + 0.02);

  // 1) Ausdrückliche Summenzeile ("Summe MwSt", "davon MwSt", "inkl. 20% MwSt")
  for (const line of lines) {
    if (!SUM_VAT_RE.test(line) || VAT_KEY_SKIP.test(line)) continue;
    const a = amountsOn(line);
    if (!a.length) continue;
    const v = a.length === 1 ? a[0] : Math.min(...a);
    if (plausible(v)) return { value: v, source: 'sum' };
  }

  // 2) Steuersatz-Zeilen rechnerisch auflösen:
  //    Auf "20% 20,00 4,00 24,00" ist genau der Wert die MwSt, für den
  //    netto * satz = wert (oder brutto * satz/(100+satz) = wert) aufgeht.
  const perRate = new Map();
  for (const line of lines) {
    const rates = ratesOn(line);
    if (rates.length !== 1) continue;
    const r = rates[0];
    const a = amountsOn(line);
    if (a.length < 2) continue;
    let found = null;
    for (const base of a) {
      for (const vat of a) {
        if (base === vat) continue;
        if (Math.abs((base * r) / 100 - vat) <= 0.02) { found = vat; break; }
        if (Math.abs((base * r) / (100 + r) - vat) <= 0.02) { found = vat; break; }
      }
      if (found !== null) break;
    }
    if (found !== null && !perRate.has(r)) perRate.set(r, found);
  }
  if (perRate.size) {
    const v = round2([...perRate.values()].reduce((a, b) => a + b, 0));
    if (plausible(v)) return { value: v, source: 'rates' };
  }

  // 3) Tabellen-Format: Kopfzeile "Brutto Netto MwSt", danach Zahlenblock.
  //    MwSt ist dort der kleinste der drei Werte.
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
        const a = amountsOn(l);
        if (a.length) amounts.push(a[0]);
      } else if (amounts.length) {
        break;
      } else if (/%/.test(l) || /^\d+$/.test(l)) {
        continue;
      }
    }
    if (amounts.length) {
      const v = Math.min(...amounts);
      if (plausible(v)) return { value: v, source: 'table' };
    }
  }

  // 4) Zeilen mit MwSt-Stichwort: der kleinste Betrag der Zeile ist die Steuer
  const vals = [];
  for (const line of lines) {
    if (!VAT_KEY_RE.test(line) || VAT_KEY_SKIP.test(line)) continue;
    const a = amountsOn(line);
    if (a.length) vals.push(Math.min(...a));
  }
  if (vals.length === 1 && plausible(vals[0])) return { value: vals[0], source: 'keyword' };
  if (vals.length > 1) {
    const sum = round2(vals.reduce((a, b) => a + b, 0));
    if (plausible(sum)) return { value: sum, source: 'keyword-sum' };
    const mx = Math.max(...vals);
    if (plausible(mx)) return { value: mx, source: 'keyword' };
  }

  // 5) Nur EIN Steuersatz genannt + Brutto bekannt -> MwSt ausrechnen
  const allRates = new Set();
  for (const line of lines) for (const r of ratesOn(line)) allRates.add(r);
  if (total && allRates.size === 1) {
    const r = [...allRates][0];
    const v = round2(total - total / (1 + r / 100));
    if (plausible(v)) return { value: v, source: 'computed' };
  }

  return { value: null, source: null };
}

export function detectVat(text, total = null) {
  return detectVatInfo(text, total).value;
}

// MwSt/Brutto-Verhältnis plausibel? (AT: 10% -> 9,1%, 20% -> 16,7% vom Brutto)
export function vatLooksOff(total, vat) {
  if (typeof total !== 'number' || typeof vat !== 'number') return false;
  if (total <= 0 || vat <= 0) return true;
  const ratio = vat / total;
  return ratio < 0.03 || ratio > 0.19;
}

// ---------- Beleg-/Rechnungsnummer ----------

// Zeilen, auf denen zwar eine Nummer steht, die aber NIE die Belegnummer ist.
// Bewusst großzügig: eine falsche Nummer ist schlimmer als gar keine.
const RN_SKIP = new RegExp(
  [
    // Kontakt
    'tel\\.?\\b', 'telefon', 'mobil', '\\bfax\\b', 'rufnummer', 'hotline',
    // Bank
    'iban', '\\bbic\\b', '\\bblz\\b', 'konto', 'bankleitzahl', 'bankverbindung',
    'mandat', 'gl(ä|ae)ubiger', 'creditor',
    // Steuer / Register
    '\\buid\\b', '\\batu\\b', 'steuer\\s*-?\\s*nr', 'st\\.?\\s?-?\\s?nr', '\\bust\\b',
    'finanzamt', 'firmenbuch', '\\bfn\\b', '\\bdvr\\b', 'gisa', 'handelsregister', 'gewerbe',
    // Personen / Partner
    'kunden', 'debitor', 'kreditor', 'lieferanten', 'gesch(ä|ae)ftspartner',
    'vertrag', 'mitglied', 'mitarbeiter', 'bediener', 'kellner', 'tisch', 'personal',
    // Kasse / Terminal
    'kassen\\s*-?\\s*(id|nr|nummer)', 'kassa\\s*-?\\s*(id|nr|nummer)', 'kassenidentifikation',
    'terminal', '\\btid\\b', '\\bmid\\b', '\\bagn\\b', '\\bvu\\s*-?\\s*nr', 'trace',
    'genehmigung', 'autorisier', 'approval', 'kartennummer', 'kartenfolge', '\\bpan\\b',
    // Ware / Technik
    'artikel', '\\bean\\b', '\\bgln\\b', '\\bisbn\\b', '\\bpzn\\b',
    '\\btse\\b', 'signatur', 'serien', 'zertifikat', 'ger(ä|ae)te', 'z(ä|ae)hler',
    // Sonstiges
    'tracking', 'sendung', 'paket', '\\bplz\\b', 'postfach',
    'seite\\s*\\d', 'blatt', 'version'
  ].join('|'),
  'i'
);

// Label-Bausteine: "Nr", "Nummer", "No", "N°", "Number" – längste zuerst,
// damit "Nummer" nicht als "Nr" + Rest gelesen wird.
// Trennzeichen zwischen Label und "Nr" sind beliebig: "Bel.-Nr.", "BelegNr", "Beleg Nr"
const NR_WORD = '(?:[\\s.\\-–/]*(?:nummer|number|num|n°|nr|no)\\b)';

/**
 * Baut die Regex für eine Gruppe von Label-Wörtern.
 * Der Lookahead (?![a-zäöüß]) verhindert Treffer in längeren Wörtern:
 * "Bonus" ist kein "Bon", "Rechnungsdatum" keine "Rechnung(snummer)".
 * @param {string[]} stems Label-Wörter
 * @param {boolean} requireNr true = "Nr"/"Nummer" muss folgen (für kurze Kürzel wie RG, AR)
 */
function labelRegex(stems, requireNr) {
  const alt = [...stems]
    .sort((a, b) => b.length - a.length) // längstes Label zuerst
    .map(escapeRegex)
    .join('|');
  return new RegExp(
    `\\b(?:${alt})s?${NR_WORD}${requireNr ? '' : '?'}(?![a-zäöüß])\\.?\\s*[:#]?\\s*(.*)$`,
    'i'
  );
}

// Reihenfolge = Priorität. Pro Stufe: ausgeschriebene Labels + kurze Kürzel,
// bei denen zwingend "Nr"/"Nummer" dahinter stehen muss.
// strong = eindeutiges Label; dort wird nur der Wert-Teil auf Störwörter geprüft,
// damit "Kasse 2  Bon-Nr 4711" nicht an "Kasse" scheitert.
const RN_TIERS = [
  // 1) Beleg / Bon / Kassa
  {
    strong: true,
    words: [
      'beleg', 'belegid', 'bon', 'kassabon', 'kassenbon', 'kassabeleg', 'kassenbeleg',
      'kassenzettel', 'kaufbeleg', 'zahlungsbeleg', 'barbeleg', 'barverkaufsbeleg',
      'bewirtungsbeleg', 'barumsatz', 'eingangsbeleg', 'ausgangsbeleg'
    ],
    short: ['bel', 'bon', 'blg']
  },
  // 2) Rechnung / Faktura
  {
    strong: true,
    words: [
      'rechnung', 'ausgangsrechnung', 'eingangsrechnung', 'barverkaufsrechnung',
      'schlussrechnung', 'teilrechnung', 'faktura', 'invoice', 'abrechnung', 'nota',
      'gutschrift'
    ],
    short: ['rg', 're', 'ar', 'er', 'inv', 'rechn', 'fakt', 'gs']
  },
  // 3) Vorgang / Auftrag / Transaktion / Lieferschein (schwächer -> ganze Zeile prüfen)
  {
    strong: false,
    words: [
      'quittung', 'auftrag', 'vorgang', 'geschäftsfall', 'geschaeftsfall',
      'transaktion', 'receipt', 'ticket', 'dokument', 'journal', 'buchung',
      'lieferschein', 'bestellung', 'bestell', 'referenz', 'vorgangs'
    ],
    short: ['ta', 'trx', 'trans', 'vorg', 'auftr', 'dok', 'ls', 'bv', 'ref']
  }
];

// Regexe einmal beim Laden bauen (nicht bei jedem Beleg neu)
const RN_TIERS_COMPILED = RN_TIERS.map((tier) => ({
  strong: tier.strong,
  regexes: [labelRegex(tier.words, false), labelRegex(tier.short, true)]
}));

// Datum / Uhrzeit / UID / Beträge aus einem Zeilenrest entfernen
function stripRnNoise(s) {
  return String(s || '')
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ')      // 03.10.2025
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ')          // 2025-10-03
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')             // 19:42
    .replace(/\bATU\s*\d+/gi, ' ')
    .replace(/\b\d{1,3}(?:\.\d{3})+,\d{2}\b/g, ' ')            // 1.234,00
    .replace(/\b\d+[.,]\d{2}\b/g, ' ')                         // 12,40
    .replace(/\d{1,2}\s*%/g, ' ');
}

// Sieht der Wert nach einer echten Belegnummer aus?
function isUsableNumber(v) {
  if (!v) return false;
  if (v.length < 2 || v.length > 20) return false;
  if (!/\d/.test(v)) return false;
  // reine Jahreszahl (2019-2035) ist keine Belegnummer
  if (/^\d{4}$/.test(v)) {
    const y = parseInt(v, 10);
    if (y >= 2019 && y <= 2035) return false;
  }
  if (/^0+$/.test(v)) return false;
  return true;
}

const RN_NUMBER_RE = /([A-Z]{0,5}[-/.]?\d{1,}(?:[-/.][A-Z0-9]+)*)/gi;

/**
 * Erste brauchbare Nummer aus einem Zeilenrest.
 * Steht zwischen Label und Wert ein Störwort ("Rechnung für Kunden-Nr 4455"),
 * gehört die Nummer zu etwas anderem und wird verworfen.
 */
function grabNumber(s) {
  const clean = stripRnNoise(s);
  RN_NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = RN_NUMBER_RE.exec(clean)) !== null) {
    const v = m[1].replace(/^[-/.]+|[-/.]+$/g, '');
    if (!isUsableNumber(v)) continue;
    if (RN_SKIP.test(clean.slice(0, m.index))) return null;
    return v;
  }
  return null;
}

// Belege ganz ohne Label: nur sehr eindeutige Muster übernehmen.
// "#4711" oder ein Kürzel mit Trennzeichen ("RE-2025-0012", "AR/12345").
// Reine Ziffernfolgen ohne Label werden NICHT genommen (zu viele Fehltreffer).
const RN_HASH_RE = /#\s*([A-Za-z0-9][A-Za-z0-9./-]{1,19})/;
const RN_DOCNUM_RE = /\b([A-Z]{1,4}[-/][A-Z0-9]*\d{2,}[A-Z0-9./-]*)\b/;

/**
 * Beleg-/Rechnungsnummer lesen.
 * Grundsatz: lieber null als eine falsche Nummer – es wird nur ein Wert
 * übernommen, der zu einem eindeutigen Label oder einem klaren Muster gehört.
 */
export function detectReceiptNumber(text) {
  const lines = toLines(text);
  if (!lines.length) return null;

  // Label und Wert stehen in zwei Spalten -> Wert in einer der nächsten Zeilen
  const valueFromNextLines = (i) => {
    for (let k = i + 1; k < Math.min(i + 3, lines.length); k++) {
      if (!lines[k] || RN_SKIP.test(lines[k])) continue;
      const v = grabNumber(lines[k]);
      if (v) return v;
    }
    return null;
  };

  const valueFrom = (rest, i) => grabNumber(rest) || valueFromNextLines(i);

  // Stufe 1-3: Labels nach Priorität
  for (const tier of RN_TIERS_COMPILED) {
    for (const re of tier.regexes) {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (!m) continue;
        // Schwaches Label (Vorgang/Referenz/...): die ganze Zeile muss sauber sein.
        // Starkes Label (Beleg/Rechnung): der Wert direkt dahinter zählt, auch
        // wenn vorne auf der Zeile z.B. "Kasse 2" steht.
        if (!tier.strong && RN_SKIP.test(lines[i])) continue;
        const direct = grabNumber(m[1]);
        if (direct) return direct;
        // Wert erst in der Folgezeile -> dann muss auch die Label-Zeile sauber sein
        if (RN_SKIP.test(lines[i])) continue;
        const next = valueFromNextLines(i);
        if (next) return next;
      }
    }
  }

  // Stufe 4: eigenständiges "Nr." – nur wenn es die Zeile anführt oder : / # folgt
  const genericNr = /(?:^|\s)(?:nummer|number|n°|nr|no)\b\.?\s*[:#]?\s*(.*)$/i;
  for (let i = 0; i < lines.length; i++) {
    if (RN_SKIP.test(lines[i])) continue;
    if (
      !/^\s*(?:nummer|number|n°|nr|no)\b/i.test(lines[i]) &&
      !/\b(?:nummer|number|nr|no)\b\.?\s*[:#]/i.test(lines[i])
    ) {
      continue;
    }
    const m = lines[i].match(genericNr);
    if (!m) continue;
    const v = valueFrom(m[1], i);
    if (v) return v;
  }

  // Stufe 5: gar kein Label -> nur "#1234" oder Kürzel-Muster wie "RE-2025-0012"
  for (const line of lines) {
    if (RN_SKIP.test(line) || line.length > 60) continue;
    const clean = stripRnNoise(line);
    for (const re of [RN_HASH_RE, RN_DOCNUM_RE]) {
      const m = clean.match(re);
      if (!m) continue;
      const v = m[1].replace(/^[-/.]+|[-/.]+$/g, '');
      if (isUsableNumber(v)) return v;
    }
  }

  return null;
}

// ---------- Datum ----------

// Datums-Labels nach Priorität: das Rechnungs-/Belegdatum zählt für die
// Buchhaltung, nicht das Liefer- oder Leistungsdatum.
const DATE_LABEL_TIERS = [
  /(rechnungsdatum|belegdatum|bondatum|kaufdatum|rechnung\s*vom|beleg\s*vom|invoice\s*date)/i,
  /(\bdatum\b|\bvom\b|\bam\b|\bdate\b)/i,
  /(lieferdatum|leistungsdatum|lieferung|leistungszeitraum)/i
];

// Zeilen mit Datumsangaben, die NIE das Rechnungsdatum sind
const DATE_SKIP =
  /(zahlbar|f(ä|ae)llig|zahlungsziel|valuta|g(ü|ue)ltig|haltbar|\bmhd\b|verfall|geboren|\bgeb\.|skonto|ausgedruckt|gedruckt\s*am)/i;

// Monatsnamen deutsch (inkl. österreichisch "Jänner") + englisch, auch abgekürzt.
// WICHTIG: Schlüssel in normalisierter Form (ohne Umlaute), denn der Vergleich
// läuft über normalize(): "Jänner" -> "janner", "März" -> "marz".
const MONTH_NAMES = {
  jan: 1, januar: 1, january: 1, janner: 1, jaenner: 1,
  feb: 2, februar: 2, february: 2,
  mar: 3, marz: 3, maerz: 3, march: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dez: 12, dec: 12, dezember: 12, december: 12
};

function monthFromName(word) {
  const key = normalize(word).replace(/\.$/, '');
  return MONTH_NAMES[key] || null;
}

// Tag/Monat/Jahr prüfen und als 'YYYY-MM-DD' zurückgeben (oder null)
function buildDate(d, mo, y, today, maxAgeDays) {
  if (y < 100) y += 2000;
  if (!mo || mo < 1 || mo > 12 || !d || d < 1 || d > 31) return null;
  if (y < 2000 || y > 2100) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = Date.parse(`${iso}T12:00:00Z`);
  if (isNaN(t)) return null;
  // Tag muss es wirklich geben (31.02. gibt es nicht)
  if (new Date(t).getUTCDate() !== d) return null;
  // nie in der Zukunft (1 Tag Toleranz für Zeitzonen) und nicht beliebig alt
  if (t > today.getTime() + 36 * 60 * 60 * 1000) return null;
  if (t < today.getTime() - maxAgeDays * 24 * 60 * 60 * 1000) return null;
  return iso;
}

// Alle unterstützten Schreibweisen. Reihenfolge = Priorität innerhalb einer Zeile.
const DATE_PATTERNS = [
  // 2025-10-03 (ISO)
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, take: (m) => [+m[3], +m[2], +m[1]] },
  // 03.10.2025 / 3/10/25 / 03-10-2025, auch mit Leerzeichen: 03. 10. 2025
  { re: /\b(\d{1,2})\s?[./-]\s?(\d{1,2})\s?[./-]\s?(\d{2,4})\b/g, take: (m) => [+m[1], +m[2], +m[3]] },
  // 3. Oktober 2025 / 3 Okt 2025 / 03.Okt.25
  {
    re: /\b(\d{1,2})\.?\s*([A-Za-zÄÖÜäöü]{3,9})\.?,?\s*(\d{2,4})\b/g,
    take: (m) => {
      const mo = monthFromName(m[2]);
      return mo ? [+m[1], mo, +m[3]] : null;
    }
  },
  // October 3, 2025 / Okt 3 2025
  {
    re: /\b([A-Za-zÄÖÜäöü]{3,9})\.?\s+(\d{1,2})\.?,?\s+(\d{4})\b/g,
    take: (m) => {
      const mo = monthFromName(m[1]);
      return mo ? [+m[2], mo, +m[3]] : null;
    }
  }
];

/**
 * Rechnungsdatum als 'YYYY-MM-DD' oder null.
 * Zeilen mit "Datum"/"Rechnungsdatum"/"vom" haben Vorrang, damit z.B. ein
 * Lieferdatum oder ein Zahlungsziel nicht das Rechnungsdatum überstimmt.
 * @param {number} maxAgeDays wie weit darf das Datum zurückliegen (Standard 3 Jahre)
 */
export function detectDate(text, today = new Date(), maxAgeDays = 3 * 365) {
  const lines = toLines(text);
  if (!lines.length) return null;

  const dateOn = (line) => {
    for (const { re, take } of DATE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const parts = take(m);
        if (!parts) continue;
        const iso = buildDate(parts[0], parts[1], parts[2], today, maxAgeDays);
        if (iso) return iso;
      }
    }
    return null;
  };

  // Durchgang 1-3: Zeilen mit Datums-Label, nach Priorität.
  // Durchgang 4: alle übrigen Zeilen (null = kein Label nötig).
  for (const label of [...DATE_LABEL_TIERS, null]) {
    for (const line of lines) {
      if (DATE_SKIP.test(line)) continue;
      if (label && !label.test(line)) continue;
      const iso = dateOn(line);
      if (iso) return iso;
    }
  }
  return null;
}

// ---------- Lieferant ----------

const LEGAL_FORM_RE = /\b(gmbh|gesmbh|ges\.?\s?m\.?\s?b\.?\s?h|e\.?\s?u\.?|kg|og|ohg|ag|e\.?\s?gen)\b/i;
const ONLY_LEGAL_FORM_RE = /^(&\s*co\.?\s*)?(gmbh|gesmbh|ges\.?\s?m\.?\s?b\.?\s?h\.?|e\.?\s?u\.?|kg|og|ohg|ag)\.?$/i;
const HEADER_NOISE_RE =
  /(rechnung|kassabon|kassenbon|beleg|quittung|datum|uhrzeit|uid|atu|steuer|tel\.?|telefon|fax|www\.|http|@|iban|bic|filiale|kunde|seite|betrag|summe|gesamt|mwst|ust|danke|willkommen)/i;
const ADDRESS_RE = /(stra(ss|ß)e|str\.|gasse|platz|weg\b|\b\d{4}\b)/i;
const DATE_LINE_RE = /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/;

function cleanSupplierName(line) {
  return (line || '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(fa\.?|firma)\s+/i, '')
    .replace(/^[^\p{L}\d]+/u, '')
    .replace(/[^\p{L}\d.)\s&+-]+$/u, '')
    .trim();
}

/** Lieferantennamen frei aus dem Belegkopf lesen (volle Firmenbezeichnung inkl. Rechtsform). */
export function guessSupplierFromText(text) {
  const raw = toLines(text).slice(0, 15);
  if (!raw.length) return null;

  // "Mega Gastro" + "GmbH" aus zwei Zeilen zu einem Namen zusammenziehen
  const header = [];
  for (let i = 0; i < raw.length; i++) {
    const cur = raw[i];
    const next = raw[i + 1];
    if (next && ONLY_LEGAL_FORM_RE.test(next) && !LEGAL_FORM_RE.test(cur) && !HEADER_NOISE_RE.test(cur)) {
      header.push(`${cur} ${next}`);
      i++;
    } else {
      header.push(cur);
    }
  }

  // 1) Zeile mit Rechtsform = mit hoher Sicherheit der Firmenname
  for (const line of header) {
    if (LEGAL_FORM_RE.test(line) && !HEADER_NOISE_RE.test(line) && !ADDRESS_RE.test(line)) {
      const name = cleanSupplierName(line);
      if (name.length >= 3 && name.length <= 60) return name;
    }
  }

  // 2) Sonst: erste „firmen-artige" Zeile
  for (const line of header) {
    if (HEADER_NOISE_RE.test(line) || ADDRESS_RE.test(line) || DATE_LINE_RE.test(line)) continue;
    const letters = (line.match(/\p{L}/gu) || []).length;
    const digits = (line.match(/\d/gu) || []).length;
    if (letters < 3 || digits > letters) continue;
    const name = cleanSupplierName(line);
    if (name.length >= 3 && name.length <= 60) return name;
  }

  return null;
}

// Stichwort als ganzes Wort suchen ("spar" trifft nicht "Sparkasse"/"Interspar").
// Gibt die Fundstelle zurück oder -1.
function keywordIndex(haystack, keyword) {
  const tail = /\w$/.test(keyword) ? '\\b' : '';
  const re = new RegExp(`\\b${escapeRegex(keyword)}${tail}`, 'i');
  const m = re.exec(haystack);
  return m ? m.index : -1;
}

/**
 * Bekannten Lieferanten über Stichwörter erkennen.
 * Es gewinnt der Treffer, der am WEITESTEN OBEN steht – der Lieferant steht im
 * Belegkopf, ein Firmenname in einer Artikelzeile darf ihn nicht überstimmen.
 * Bei gleicher Position gewinnt das längere (genauere) Stichwort.
 */
export function matchSupplier(text, suppliers) {
  if (!text || !Array.isArray(suppliers)) return null;
  const norm = normalize(text);
  if (!norm) return null;

  let best = null;
  let bestPos = Infinity;
  let bestLen = 0;

  for (const supplier of suppliers) {
    for (const kw of supplier.keywords || []) {
      const nk = normalize(kw);
      if (!nk) continue;
      const pos = keywordIndex(norm, nk);
      if (pos < 0) continue;
      if (pos < bestPos || (pos === bestPos && nk.length > bestLen)) {
        best = supplier;
        bestPos = pos;
        bestLen = nk.length;
      }
    }
  }

  return best ? best.name : null;
}
