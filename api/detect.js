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

// "1.234,56" / "12,50" / "12.50" / "€ 12,50" / "24,-" -> Number
export function parseAmount(s) {
  s = String(s == null ? '' : s)
    .replace(/(?:€|eur|euro)/gi, '')
    .replace(/\s/g, '')
    .replace(/[-–—]+$/, '') // "24,-" / "24,--" = 24,00
    .trim();
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
// Das optionale Leerzeichen nach dem Komma fängt OCR-Artefakte wie "24, 90" ab.
const MONEY_RE = new RegExp(
  [
    '(?<![\\d.,])\\d{1,3}(?:[.\\s]\\d{3})+,\\s?\\d{2}(?!\\d)', // 1.234,56 / 1 234,56
    '(?<![\\d.,])\\d+,\\s?\\d{2}(?!\\d)',                      // 24,90 / 24, 90
    '(?<![\\d.,])\\d+\\.\\d{2}(?!\\d)',                        // 24.90
    '(?<![\\d.,])\\d+,[-–—]{1,2}(?![\\d,.])'                   // 24,- / 24,--  (= 24,00)
  ].join('|'),
  'g'
);

// Alles entfernen, was wie Geld aussieht, aber keines ist:
// Datum (01.10.2025 -> sonst "1.10"), Uhrzeit, UID-/IBAN-Nummer, Steuersatz (20,00 %).
function stripNonMoney(line) {
  return String(line || '')
    .replace(/\b\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}\b/g, ' ')
    .replace(/\b\d{1,2}\s*[.:]\s*\d{2}\s*(?:uhr|h)\b/gi, ' ')  // "19.42 Uhr"
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\bATU\s*[\d\s]+/gi, ' ')
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,}\b/g, ' ')  // IBAN
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

// Zeile besteht im Wesentlichen nur aus einem Geldbetrag
// ("125.12", "€ 12,50", "12,50 EUR", "*24,00", "24,-")
export function isMoneyLine(line) {
  return /^\s*[*=]?\s*(?:€|eur|euro)?\s*-?\s*\d[\d.\s]*(?:[.,]\d{2}|,[-–—]{1,2})\s*[*]?\s*(?:€|eur|euro)?\s*$/i.test(
    String(line || '')
  );
}

function toLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Zweispaltige Belege: die OCR liefert oft ERST alle Bezeichnungen und DANACH
 * alle Beträge (weil zwischen den Spalten viel Platz ist):
 *
 *   Zwischensumme          Zwischensumme  50,00
 *   Rabatt            ->   Rabatt         -5,00
 *   Zu zahlen              Zu zahlen      45,00
 *   50,00
 *   -5,00
 *   45,00
 *
 * Gleich lange Blöcke werden hier wieder zeilenweise zusammengeführt. Ohne das
 * landet der falsche Betrag beim Stichwort (oder gar keiner).
 */
function mergeColumnBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    // Block A: Textzeilen ganz ohne Betrag
    let a = i;
    while (a < lines.length && /\p{L}/u.test(lines[a]) && !amountsOn(lines[a]).length) a++;
    // Block B: direkt danach nur noch reine Betragszeilen
    let b = a;
    while (b < lines.length && isMoneyLine(lines[b])) b++;

    const labels = a - i;
    const monies = b - a;
    if (labels >= 2 && labels === monies) {
      for (let k = 0; k < labels; k++) out.push(`${lines[i + k]} ${lines[a + k]}`);
      i = b;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out;
}

// Zeilen für die Betrags-/MwSt-Erkennung (inkl. Spalten-Reparatur)
function toAmountLines(text) {
  return mergeColumnBlocks(toLines(text));
}

// ---------- Brutto-/Endbetrag ----------

// Stichwörter für den Endbetrag, nach Priorität
const TOTAL_TIERS = [
  /(zu\s*(zahlen|bezahlen)|zahlbetrag|zahlungsbetrag|endbetrag|endsumme|rechnungssumme|offener\s*betrag)/i,
  /(gesamtbetrag|rechnungsbetrag|gesamtsumme|gesamt\s*brutto|brutto\s*gesamt|gesamt|total|bruttobetrag|brutto\s*summe|summe\s*brutto)/i,
  /(brutto|summe|betrag|saldo)/i
];

// Zahlungszeilen: der am Terminal/an der Kassa bezahlte Betrag IST der Endbetrag.
// Wird erst geprüft, wenn kein Summen-Stichwort gefunden wurde.
const PAYMENT_LINE =
  /(kartenzahlung|karten\s*umsatz|bankomat|debitkarte|kreditkarte|maestro|mastercard|\bvisa\b|\bkarte\b|kontaktlos|\bec[-\s]?cash\b|zahlung\b|bezahlt|betrag\s*(in\s*)?(eur|euro|€))/i;

// Zeilen, die NIE der Rechnungsbetrag sind
const TOTAL_SKIP =
  /(zwischensumme|zw\.?\s*summe|zwischen\s*summe|gegeben|geg\.|r(ü|ue)ckgeld|wechselgeld|herausgeld|retour|zur(ü|ue)ck|trinkgeld|rabatt|skonto|gutschein|einzahlung|spende|pfand\b|leergut|guthaben|bonus|ersparnis|sie\s*sparen|rundung|anzahlung|mindestbestell|versand(kosten)?|liefergeb(ü|ue)hr)/i;

// Zeilen der Steuer-Aufstellung (Netto/MwSt) sind kein Endbetrag ...
const VAT_LINE = /(netto|mwst|mehrwertsteuer|umsatzsteuer|steuerbetrag|\bu\.?\s?st\.?\b|\bvat\b)/i;
// ... außer die Zeile nennt ausdrücklich den Endbetrag ("Gesamtbetrag inkl. MwSt")
const STRONG_TOTAL =
  /(gesamtbetrag|rechnungsbetrag|gesamtsumme|rechnungssumme|zu\s*(zahlen|bezahlen)|zahlbetrag|endbetrag|endsumme)/i;

// Bargeld: gegebener Betrag und Rückgeld
const CASH_GIVEN = /(gegeben|geg\.|bar\s*erhalten|erhalten|barzahlung|^\s*bar\b|^\s*cash\b|kunde\s*gibt)/i;
const CASH_CHANGE = /(r(ü|ue)ckgeld|wechselgeld|herausgeld|zur(ü|ue)ck|retour|change)/i;

// Wert steht in einer der nächsten Zeilen (Label und Betrag in zwei Spalten/Zeilen)
function amountFromNextLines(lines, i) {
  for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
    const l = lines[k];
    if (!l) continue;
    if (TOTAL_SKIP.test(l) || VAT_LINE.test(l)) break;
    const a = amountsOn(l);
    if (!a.length) continue;
    // Reine Betragszeile, oder eine kurze Zeile mit genau EINEM Betrag
    // ("EUR 24,00"). Mehrere Beträge = Tabellenzeile -> gehört nicht dazu.
    if (isMoneyLine(l) || (a.length === 1 && l.length <= 25)) return a;
    break;
  }
  return [];
}

/**
 * Endbetrag (Brutto) aus dem OCR-Text lesen.
 * @returns {{value: number|null, source: string|null}}
 *   source: 'keyword' | 'keyword+cash' | 'cash' | 'payment' | 'fallback' | null
 *   'fallback' = geraten, sollte vom Benutzer geprüft werden.
 */
export function detectTotalInfo(text) {
  const lines = toAmountLines(text);
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

  // 4) Kein Summen-Stichwort: der am Terminal bezahlte Betrag ist der Endbetrag
  const payCands = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!PAYMENT_LINE.test(line)) continue;
    if (TOTAL_SKIP.test(line) || VAT_LINE.test(line)) continue;
    if (CASH_GIVEN.test(line) || CASH_CHANGE.test(line)) continue;
    let a = amountsOn(line);
    if (!a.length) a = amountFromNextLines(lines, i);
    if (a.length) payCands.push(Math.max(...a));
  }
  if (payCands.length) return { value: Math.max(...payCands), source: 'payment' };

  // 5) Notfall: größter Betrag – Bargeld-/Steuerzeilen aber ausgenommen
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
  /(summe\s*(mwst|ust|steuer|vat)|(mwst|ust|steuer|vat)\s*[-\s]?(summe|betrag|gesamt|total)|gesamt\s*(mwst|ust|steuer)|enthaltene?\s*(mwst|ust|steuer)|darin\s*enthalten|davon\s*(mwst|ust|steuer)|zzgl\.?\s*(mwst|ust)|inkl\.?\s*(mwst|ust|vat|\d{1,2}\s*%\s*(mwst|ust)))/i;
const VAT_KEY_RE = /(mwst|mw\.?\s?st|mehrwertsteuer|umsatzsteuer|\bu\.?\s?st\.?\b|steuer|\bvat\b|\btax\b)/i;
const VAT_KEY_SKIP = /(steuer\s*-?\s*nr|st\.?\s?-?\s?nr|\buid\b|\batu\b|finanzamt|steuerberat)/i;

// Netto-Zeilen: aus Brutto − Netto lässt sich die MwSt notfalls ableiten
const NET_LINE_RE = /(nettobetrag|netto\s*summe|summe\s*netto|gesamt\s*netto|warenwert|\bnetto\b|\bexkl\.?\s*(mwst|ust)|zwischensumme\s*netto)/i;

// In Österreich gültige Steuersätze (0/10/13/20 %) – ein daraus errechnetes
// Verhältnis MwSt/Brutto ist ein starkes Indiz dafür, dass der Wert stimmt.
const AT_RATIOS = [10 / 110, 13 / 113, 20 / 120];
function ratioLooksLikeVat(total, vat) {
  if (!total || !vat) return false;
  return AT_RATIOS.some((r) => Math.abs(vat / total - r) < 0.012);
}

/**
 * Bezahlte MwSt aus dem OCR-Text lesen.
 * @param {string} text
 * @param {number|null} total Brutto (falls bekannt) – dient als Plausibilitätsgrenze
 * @returns {{value: number|null, source: string|null}}
 *   source: 'sum' | 'rates' | 'table' | 'keyword' | 'keyword-sum' | 'computed' | 'net-diff' | null
 */
export function detectVatInfo(text, total = null) {
  const lines = toAmountLines(text);
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
      // Rundungs-Toleranz: 2 Cent, bei großen Beträgen 0,2 %
      const tol = Math.max(0.02, Math.abs(base) * 0.002);
      for (const vat of a) {
        if (base === vat) continue;
        if (Math.abs((base * r) / 100 - vat) <= tol) { found = vat; break; }
        if (Math.abs((base * r) / (100 + r) - vat) <= tol) { found = vat; break; }
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

  // 4) Zeilen mit MwSt-Stichwort: der kleinste Betrag der Zeile ist die Steuer.
  //    Der Wert steht auch mal erst in der Folgezeile ("MwSt 20%" / "4,00").
  const vals = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!VAT_KEY_RE.test(line) || VAT_KEY_SKIP.test(line)) continue;
    let a = amountsOn(line);
    if (!a.length && isMoneyLine(lines[i + 1] || '')) a = amountsOn(lines[i + 1]);
    if (a.length) vals.push(Math.min(...a));
  }
  if (vals.length === 1 && plausible(vals[0])) return { value: vals[0], source: 'keyword' };
  if (vals.length > 1) {
    // Passt EIN Einzelwert exakt zu einem österreichischen Steuersatz, ist das
    // die Summenzeile – dann nicht zusätzlich die Einzelzeilen dazuaddieren.
    const single = vals.find((v) => ratioLooksLikeVat(total, v));
    const sum = round2(vals.reduce((a, b) => a + b, 0));
    if (single !== undefined && !ratioLooksLikeVat(total, sum)) {
      return { value: single, source: 'keyword' };
    }
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

  // 6) Letzte Möglichkeit: Brutto − Netto. Nur übernehmen, wenn die Differenz
  //    genau einem gültigen Steuersatz entspricht (sonst ist es Zufall).
  if (total) {
    for (const line of lines) {
      if (!NET_LINE_RE.test(line) || VAT_KEY_SKIP.test(line)) continue;
      for (const net of amountsOn(line)) {
        if (net >= total) continue;
        const v = round2(total - net);
        if (v > 0 && ratioLooksLikeVat(total, v)) return { value: v, source: 'net-diff' };
      }
    }
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
    // Adresse – eine Hausnummer ist nie die Belegnummer
    'stra(ß|ss)e', '\\bstr\\.', 'gasse\\b', '\\bplatz\\b', '\\bweg\\b', '\\bring\\b', '\\ballee\\b',
    // Sonstiges
    'tracking', 'sendung', 'paket', '\\bplz\\b', 'postfach',
    'seite\\s*\\d', 'blatt', 'version'
  ].join('|'),
  'i'
);

// Label-Bausteine: "Nr", "Nummer", "No", "N°", "Number" – längste zuerst,
// damit "Nummer" nicht als "Nr" + Rest gelesen wird.
// Trennzeichen zwischen Label und "Nr" sind beliebig: "Bel.-Nr.", "BelegNr", "Beleg Nr"
const NR_WORD = '(?:[\\s.\\-–/]*(?:nummer|number|num|n°|nr|no|id)\\b)';

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
      'bewirtungsbeleg', 'barumsatz', 'eingangsbeleg', 'ausgangsbeleg', 'kassenbeleg',
      'registrierbeleg', 'umsatzbeleg', 'verkaufsbeleg', 'bonbeleg'
    ],
    short: ['bel', 'bon', 'blg', 'kb']
  },
  // 2) Rechnung / Faktura
  {
    strong: true,
    words: [
      'rechnung', 'ausgangsrechnung', 'eingangsrechnung', 'barverkaufsrechnung',
      'schlussrechnung', 'teilrechnung', 'faktura', 'invoice', 'abrechnung', 'nota',
      'gutschrift', 'kassenrechnung', 'barrechnung', 'rechnungsbeleg', 'sammelrechnung',
      'proforma', 'proformarechnung'
    ],
    short: ['rg', 're', 'ar', 'er', 'inv', 'rechn', 'fakt', 'gs', 'rng']
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
// minLen 1 bei eindeutigem Label ("Rechnung Nr. 7"), sonst 2.
function isUsableNumber(v, minLen = 2) {
  if (!v) return false;
  if (v.length < minLen || v.length > 20) return false;
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
function grabNumber(s, minLen = 2) {
  const clean = stripRnNoise(s);
  RN_NUMBER_RE.lastIndex = 0;
  let m;
  while ((m = RN_NUMBER_RE.exec(clean)) !== null) {
    const v = m[1].replace(/^[-/.]+|[-/.]+$/g, '');
    if (!isUsableNumber(v, minLen)) continue;
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
// "2025/0001" / "0001-2025": Ziffernblöcke mit Trenner, ein Block mind. 3-stellig.
// Muss die GANZE Zeile ausmachen – sonst wären Telefonnummern in Gefahr.
const RN_SPLITNUM_RE = /^[^\dA-Za-z]*(\d{3,6}\s?[-/]\s?\d{2,6}|\d{2,6}\s?[-/]\s?\d{3,6})[^\dA-Za-z]*$/;

/**
 * Beleg-/Rechnungsnummer lesen.
 * Grundsatz: lieber null als eine falsche Nummer – es wird nur ein Wert
 * übernommen, der zu einem eindeutigen Label oder einem klaren Muster gehört.
 */
export function detectReceiptNumber(text) {
  const lines = toLines(text);
  if (!lines.length) return null;

  // Label und Wert stehen in zwei Spalten -> Wert in einer der nächsten Zeilen.
  // Hier gilt immer mindestens 2 Stellen: eine einzelne "1" in einer Folgezeile
  // ist viel öfter eine Hausnummer als eine Belegnummer.
  const valueFromNextLines = (i) => {
    for (let k = i + 1; k < Math.min(i + 4, lines.length); k++) {
      if (!lines[k] || RN_SKIP.test(lines[k])) continue;
      const v = grabNumber(lines[k], 2);
      if (v) return v;
    }
    return null;
  };

  const valueFrom = (rest, i) => grabNumber(rest) || valueFromNextLines(i);

  // Stufe 1-3: Labels nach Priorität
  for (const tier of RN_TIERS_COMPILED) {
    // Bei eindeutigem Label ist auch eine einstellige Nummer glaubwürdig
    const minLen = tier.strong ? 1 : 2;
    for (const re of tier.regexes) {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (!m) continue;
        // Schwaches Label (Vorgang/Referenz/...): die ganze Zeile muss sauber sein.
        // Starkes Label (Beleg/Rechnung): der Wert direkt dahinter zählt, auch
        // wenn vorne auf der Zeile z.B. "Kasse 2" steht.
        if (!tier.strong && RN_SKIP.test(lines[i])) continue;
        const direct = grabNumber(m[1], minLen);
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

  // Stufe 5: gar kein Label -> nur eindeutige Muster:
  // "#1234", Kürzel-Muster ("RE-2025-0012") oder geteilte Nummern ("2025/0001").
  // Reine Ziffernfolgen ohne Label bleiben bewusst außen vor.
  for (const line of lines) {
    if (RN_SKIP.test(line) || line.length > 60) continue;
    const clean = stripRnNoise(line);
    for (const re of [RN_HASH_RE, RN_DOCNUM_RE, RN_SPLITNUM_RE]) {
      const m = clean.match(re);
      if (!m) continue;
      const v = m[1].replace(/\s/g, '').replace(/^[-/.]+|[-/.]+$/g, '');
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

const LEGAL_FORM_RE =
  /\b(gmbh|gesmbh|ges\.?\s?m\.?\s?b\.?\s?h|e\.?\s?u\.?|e\.?\s?k\.?|kg|og|ohg|ag|kgaa|ug|gbr|e\.?\s?gen|gen\.?\s?m\.?\s?b\.?\s?h|ltd|limited|s\.?r\.?l|b\.?v\.?|n\.?v\.?)\b/i;
const ONLY_LEGAL_FORM_RE =
  /^(&\s*co\.?\s*)?(gmbh|gesmbh|ges\.?\s?m\.?\s?b\.?\s?h\.?|e\.?\s?u\.?|e\.?\s?k\.?|kg|og|ohg|ag|ug|gbr|ltd\.?)\.?$/i;

// Zeilen im Belegkopf, die KEIN Firmenname sein können.
// WICHTIG: alles mit Wortgrenze. Ohne \b hat "ust" auf "Gusto", "atu" auf
// "Naturkost" und "tel" auf "Hotel" angeschlagen – dadurch sind ganze
// Lieferanten unerkannt durchgerutscht.
const HEADER_NOISE_RE = new RegExp(
  [
    '\\brechnung', '\\bkassab', '\\bkassenb', '\\bkassa\\b', '\\bkasse\\b',
    '\\bbeleg', '\\bbon\\b', '\\bquittung', '\\bdatum\\b', '\\buhrzeit\\b',
    '\\buid\\b', '\\batu\\s*\\d', '\\bsteuer\\s*-?\\s*nr', '\\bsteuernummer\\b',
    '\\bsteuersatz\\b', '\\bfinanzamt\\b', '\\bfirmenbuch\\b', '\\bdvr\\b',
    '\\btel\\b', '\\btel\\.', '\\btelefon\\b', '\\bfax\\b', '\\bmobil\\b',
    'www\\.', 'https?:', '@', '\\biban\\b', '\\bbic\\b', '\\bblz\\b',
    '\\bfiliale\\b', '\\bkunde', '\\bseite\\b', '\\bbetrag\\b', '\\bsumme\\b',
    '\\bgesamt', '\\bmwst', '\\bu\\.?\\s?st\\.?\\b', '\\bnetto\\b', '\\bbrutto\\b',
    '\\bdanke', '\\bwillkommen\\b', '\\bbediener\\b', '\\bkellner\\b', '\\btisch\\b',
    '\\bnr\\.?\\b', '\\bstk\\b', '\\bmenge\\b', '\\bartikel', '\\bpreis\\b',
    // "Bar" nur als ganze Zeile ausschließen – "Bar Milano" wäre ein Lieferant
    '\\bzahlung', '^\\s*bar\\s*$', '\\bbarzahlung\\b', '\\bkarte\\b',
    'ffnungszeit', 'gesch(ä|ae)ftszeit'
  ].join('|'),
  'i'
);

// Ab hier steht der RECHNUNGSEMPFÄNGER (also wir selbst), nicht mehr der Absender
const RECIPIENT_RE =
  /(rechnungsempf(ä|ae)nger|rechnung\s*an|lieferadresse|liefer\s*an|rechnungsadresse|kundenadresse|an\s*:\s*$)/i;

const ADDRESS_RE = /(stra(ss|ß)e\b|\bstr\.|\w*gasse\b|\bplatz\b|\bweg\b|\bring\b|\ballee\b|\bpostfach\b|\b\d{4,5}\b)/i;
const DATE_LINE_RE = /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/;

function cleanSupplierName(line) {
  return (line || '')
    .replace(/[*_`|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(fa\.?|firma|lieferant:?|verk(ä|ae)ufer:?)\s+/i, '')
    .replace(/^[^\p{L}\d]+/u, '')
    .replace(/[^\p{L}\d.)\s&+-]+$/u, '')
    .trim();
}

// Zeile taugt überhaupt als Firmenname? (genug Buchstaben, nicht nur Zahlen)
function looksLikeName(line) {
  const letters = (line.match(/\p{L}/gu) || []).length;
  const digits = (line.match(/\d/gu) || []).length;
  if (letters < 3 || digits > letters) return false;
  // Zeilen aus lauter Einzelbuchstaben ("A B C") sind OCR-Müll
  return /\p{L}{3}/u.test(line);
}

/**
 * Lieferantennamen frei aus dem Belegkopf lesen (volle Firmenbezeichnung inkl. Rechtsform).
 * @param {string} text OCR-Text
 * @param {string[]} ignore Namen/Stichwörter, die NIE Lieferant sind (z.B. der
 *   eigene Betrieb – er steht auf Eingangsrechnungen als Empfänger im Kopf).
 */
export function guessSupplierFromText(text, ignore = []) {
  const all = toLines(text);
  if (!all.length) return null;

  const ignoreNorm = (ignore || []).map((s) => normalize(s)).filter(Boolean);
  const isIgnored = (line) => {
    const n = normalize(line);
    return ignoreNorm.some((ig) => n.includes(ig));
  };

  // Nur der Belegkopf – ab dem Empfänger-Block gar nicht mehr weitersuchen
  const stop = all.findIndex((l) => RECIPIENT_RE.test(l));
  const raw = all.slice(0, stop > 0 ? Math.min(stop, 20) : 20);

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

  const usable = (line) =>
    !HEADER_NOISE_RE.test(line) && !DATE_LINE_RE.test(line) && !isIgnored(line) && looksLikeName(line);

  // 1) Zeile mit Rechtsform = mit hoher Sicherheit der Firmenname
  for (const line of header) {
    if (!LEGAL_FORM_RE.test(line) || !usable(line)) continue;
    // Adresszeilen mit Rechtsform gibt es praktisch nicht – aber "1020 Wien AG"
    // wäre eine; PLZ-Zeilen daher trotzdem aussortieren.
    if (/^\s*\d{4,5}\b/.test(line)) continue;
    const name = cleanSupplierName(line);
    if (name.length >= 3 && name.length <= 60) return name;
  }

  // 2) Sonst: erste „firmen-artige" Zeile (ohne Adresse)
  for (const line of header) {
    if (!usable(line) || ADDRESS_RE.test(line)) continue;
    const name = cleanSupplierName(line);
    if (name.length >= 3 && name.length <= 60) return name;
  }

  // 3) Notnagel: irgendwo im Text eine Zeile mit Rechtsform
  for (const line of all.slice(0, 40)) {
    if (!LEGAL_FORM_RE.test(line) || !usable(line) || ADDRESS_RE.test(line)) continue;
    const name = cleanSupplierName(line);
    if (name.length >= 3 && name.length <= 60) return name;
  }

  return null;
}

// Allgemeine Wörter, die als alleiniges Stichwort zu viele Fehltreffer liefern.
// "Hotel Sacher" darf nicht über "hotel" jeden anderen Beleg an sich reißen.
const GENERIC_NAME_WORDS = new Set([
  'gmbh', 'gesmbh', 'mbh', 'ges', 'ohg', 'gbr', 'ltd', 'limited', 'gen', 'kgaa',
  'firma', 'gesellschaft', 'holding', 'group', 'gruppe', 'partner', 'zentrale',
  'filiale', 'handel', 'handels', 'handelsgesellschaft', 'vertrieb', 'vertriebs',
  'einzelhandel', 'grosshandel', 'grosshandels', 'import', 'export', 'trade',
  'trading', 'service', 'services', 'dienst', 'dienstleistung',
  'gastro', 'gastronomie', 'restaurant', 'pizzeria', 'imbiss', 'cafe', 'kaffee',
  'hotel', 'markt', 'market', 'supermarkt', 'shop', 'store', 'lebensmittel',
  'feinkost', 'metzgerei', 'baeckerei', 'backerei', 'fleischerei', 'tankstelle',
  'apotheke', 'zentrum', 'center', 'food', 'foods', 'fresh', 'company',
  'wien', 'graz', 'linz', 'salzburg', 'austria', 'osterreich', 'oesterreich',
  'international', 'united', 'gesellschaft', 'betrieb', 'betriebs'
]);

/**
 * Stichwörter für einen neu gelernten Lieferanten ableiten.
 * Immer der volle Name; zusätzlich ein markantes Einzelwort und – falls
 * abweichend – der Name ohne Rechtsform.
 */
export function supplierKeywords(name) {
  const norm = normalize(name);
  if (!norm) return [];
  const out = [norm];

  const words = norm.split(/[\s.,&/-]+/).filter(Boolean);
  const distinct = words.filter(
    (w) => w.length >= 4 && !/^\d+$/.test(w) && !GENERIC_NAME_WORDS.has(w)
  );
  // längstes markantes Wort = am wenigsten fehleranfällig
  distinct.sort((a, b) => b.length - a.length);
  if (distinct.length && distinct[0] !== norm) out.push(distinct[0]);

  const noLegal = norm
    .replace(new RegExp(LEGAL_FORM_RE.source, 'gi'), ' ')
    .replace(/[&,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (noLegal.length >= 4 && !out.includes(noLegal)) out.push(noLegal);

  return out;
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
  if (best) return best.name;

  // Zweiter Versuch ohne Leer- und Trennzeichen: die OCR trennt Firmennamen
  // gern anders als erwartet ("MEGAGASTRO", "T MOBILE", "Gastro-Genius").
  const compact = norm.replace(/[\s.\-–_/]/g, '');
  if (!compact) return null;
  let bestCompactPos = Infinity;
  let bestCompactLen = 0;
  for (const supplier of suppliers) {
    for (const kw of supplier.keywords || []) {
      const ck = normalize(kw).replace(/[\s.\-–_/]/g, '');
      if (ck.length < 5) continue; // kurze Kürzel wären hier zu unscharf
      const pos = compact.indexOf(ck);
      if (pos < 0) continue;
      if (pos < bestCompactPos || (pos === bestCompactPos && ck.length > bestCompactLen)) {
        best = supplier;
        bestCompactPos = pos;
        bestCompactLen = ck.length;
      }
    }
  }

  return best ? best.name : null;
}
