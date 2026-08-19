import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTotal,
  detectTotalInfo,
  detectVat,
  detectVatInfo,
  detectReceiptNumber,
  detectDate,
  guessSupplierFromText,
  matchSupplier,
  supplierKeywords,
  parseAmount,
  amountsOn,
  ratesOn,
  euro
} from '../api/detect.js';

const HEUTE = new Date('2025-10-15T12:00:00Z');

// ---------- Beträge ----------

test('parseAmount versteht deutsche und englische Schreibweise', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('12,50'), 12.5);
  assert.equal(parseAmount('12.50'), 12.5);
  assert.equal(parseAmount('€ 8,00'), 8);
});

test('euro() schreibt Betraege oesterreichisch mit Tausenderpunkt', () => {
  assert.equal(euro(8.71), '8,71 €');
  assert.equal(euro(1200), '1.200,00 €');
  assert.equal(euro(1399.51), '1.399,51 €');
  assert.equal(euro(1234567.8), '1.234.567,80 €');
  assert.equal(euro(0), '0,00 €');
  assert.equal(euro(null), '—');
});

test('Datum und Uhrzeit werden nicht als Betrag gelesen', () => {
  assert.deepEqual(amountsOn('Datum 01.10.2025 12:30 Summe 44,90'), [44.9]);
  assert.deepEqual(amountsOn('20,00 % MwSt 4,00'), [4]);
});

test('Tausenderpunkt wird nicht zerschnitten', () => {
  assert.deepEqual(amountsOn('Gesamt 1.234,56'), [1234.56]);
  assert.deepEqual(amountsOn('Artikelnummer 12345'), []);
});

// ---------- Brutto ----------

test('BAR gegeben + Rückgeld: Summe statt gegebenem Bargeld', () => {
  const bon = `
Metro Cash & Carry
Kassabon-Nr: 4711
01.10.2025 12:30
Ware A          20,00
Ware B          24,90
SUMME           44,90
BAR             50,00
RÜCKGELD         5,10
`;
  const info = detectTotalInfo(bon);
  assert.equal(info.value, 44.9);
  assert.equal(info.source, 'keyword+cash');
});

test('Gegeben/Rückgeld auch ohne Summen-Zeile', () => {
  const bon = `
Imbiss Wien
Cola             2,50
Gegeben         10,00
Rückgeld         7,50
`;
  const info = detectTotalInfo(bon);
  assert.equal(info.value, 2.5);
  assert.equal(info.source, 'cash');
});

test('Zwischensumme wird nicht als Endbetrag genommen', () => {
  const bon = `
Zwischensumme   50,00
Rabatt          -5,00
Zu zahlen       45,00
`;
  assert.equal(detectTotal(bon), 45);
});

test('Steuertabellen-Zeile: Brutto ist der größte Wert der Zeile', () => {
  const bon = `
Brutto Netto MwSt
SUMME  24,00  20,00  4,00
`;
  assert.equal(detectTotal(bon), 24);
});

test('Betrag in der Folgezeile (zweispaltiger Beleg)', () => {
  const bon = `
Rechnungsbetrag
1.234,56
`;
  assert.equal(detectTotal(bon), 1234.56);
});

test('Trinkgeld zählt nicht als Rechnungsbetrag', () => {
  const bon = `
Summe           30,00
Trinkgeld        5,00
Gegeben         35,00
`;
  assert.equal(detectTotal(bon), 30);
});

// ---------- MwSt ----------

test('MwSt aus Satz-Zeile rechnerisch bestimmt (nicht Netto/Brutto)', () => {
  const bon = `
Zu zahlen        24,00
20% 20,00 4,00 24,00
`;
  assert.equal(detectVat(bon, 24), 4);
});

test('Zwei Steuersätze werden addiert', () => {
  const bon = `
Gesamt           34,00
20%  20,00  4,00  24,00
10%   9,09  0,91  10,00
`;
  assert.equal(detectVat(bon, 34), 4.91);
});

test('"davon MwSt" wird direkt übernommen', () => {
  const bon = `
Gesamtbetrag     120,00
davon MwSt        20,00
`;
  assert.equal(detectVat(bon, 120), 20);
});

test('Nur ein Steuersatz genannt -> MwSt wird aus dem Brutto gerechnet', () => {
  const bon = `
Summe            120,00
inkl. 20% USt
`;
  assert.equal(detectVat(bon, 120), 20);
});

test('Unplausible MwSt (größer als 21% vom Brutto) wird verworfen', () => {
  const bon = `
Summe             10,00
Steuernummer 123456789
`;
  assert.equal(detectVat(bon, 10), null);
});

test('MwSt-Zeile mit Satz und Betrag', () => {
  const bon = `
Gesamt            44,90
MwSt 20%           7,48
`;
  assert.equal(detectVat(bon, 44.9), 7.48);
});

// ---------- Belegnummer ----------

test('Belegnummer wird aus dem Label gelesen', () => {
  assert.equal(detectReceiptNumber('Beleg-Nr.: 2025-00123'), '2025-00123');
  assert.equal(detectReceiptNumber('Rechnungsnummer RE-4711'), 'RE-4711');
  assert.equal(detectReceiptNumber('Kassabon Nr 88231'), '88231');
});

test('Viele Schreibweisen für Beleg-/Rechnungsnummer', () => {
  const faelle = [
    ['Belegnummer 12345', '12345'],
    ['Beleg-Nr.: 2025-00123', '2025-00123'],
    ['BelegNr 4711', '4711'],
    ['Beleg # 5566', '5566'],
    ['Bel.-Nr. 8899', '8899'],
    ['Bon-Nr 77123', '77123'],
    ['BON 000442', '000442'],
    ['Bonnummer 3312', '3312'],
    ['Kassenbon-Nr. 99887', '99887'],
    ['Kassabon 12/2025-4', '12/2025-4'],
    ['Kassenbeleg Nr 5544', '5544'],
    ['Kaufbeleg 220033', '220033'],
    ['Barumsatz Nr. 3390', '3390'],
    ['Rechnungsnummer: RE-2025-88231', 'RE-2025-88231'],
    ['Rechnungs-Nr. 2024/0815', '2024/0815'],
    ['Rechnung Nr 100234', '100234'],
    ['RG-Nr. 55123', '55123'],
    ['Rg.Nr 7788', '7788'],
    ['Re.-Nr.: 4455', '4455'],
    ['AR-Nr. 202512', '202512'],
    ['Faktura-Nr. F-99881', 'F-99881'],
    ['Fakturanummer 33221', '33221'],
    ['Invoice No. INV-2025-77', 'INV-2025-77'],
    ['Invoice Number 445566', '445566'],
    ['Abrechnungsnummer 9911', '9911'],
    ['Gutschrift Nr. 3040', '3040'],
    ['Quittung Nr. 220', '220'],
    ['Auftragsnummer 556677', '556677'],
    ['Auftrag-Nr 4433', '4433'],
    ['Vorgangsnummer 887766', '887766'],
    ['Vorgang: 1122', '1122'],
    ['Geschäftsfall 4711', '4711'],
    ['Transaktionsnummer 99001', '99001'],
    ['Trans-Nr. 5060', '5060'],
    ['TA-Nr 7080', '7080'],
    ['Buchungsnummer 60504', '60504'],
    ['Lieferschein-Nr. LS-3344', 'LS-3344'],
    ['Bestellnummer 778899', '778899'],
    ['Dokument-Nr. D-2025-9', 'D-2025-9'],
    ['Journal-Nr 4321', '4321'],
    ['Ticket Nr. 9080', '9080'],
    ['Nr.: 556677', '556677'],
    ['Nummer 12345', '12345']
  ];
  for (const [zeile, erwartet] of faelle) {
    assert.equal(detectReceiptNumber(zeile), erwartet, `Zeile: "${zeile}"`);
  }
});

test('Label ohne Nummer daneben: Wert steht in der nächsten Zeile', () => {
  assert.equal(detectReceiptNumber('Rechnungsnummer\n2024/0815'), '2024/0815');
  assert.equal(detectReceiptNumber('Beleg-Nr.\n\n778812'), '778812');
});

test('Ähnliche Wörter lösen keinen Treffer aus', () => {
  // "Bonus", "Rechnungsdatum", "Belegdatum" sind KEINE Nummern-Labels
  assert.equal(detectReceiptNumber('Bonuspunkte 5000'), null);
  assert.equal(detectReceiptNumber('Rechnungsdatum 03.10.2025\nRechnungsbetrag 44,90'), null);
  assert.equal(detectReceiptNumber('Belegdatum 03.10.2025'), null);
  assert.equal(detectReceiptNumber('Rechnungsempfänger Musterfirma 1020 Wien'), null);
});

test('Ohne Label: nur eindeutige Muster (#4711 / RE-2025-12)', () => {
  assert.equal(detectReceiptNumber('Metro Wien\n#004711\nSumme 44,90'), '004711');
  assert.equal(detectReceiptNumber('Mega Gastro GmbH\nRE-2025-0012\nSumme 44,90'), 'RE-2025-0012');
  // reine Ziffernfolge ohne Label -> lieber nichts
  assert.equal(detectReceiptNumber('Mega Gastro GmbH\n884422\nSumme 44,90'), null);
});

test('Starkes Label gewinnt auch neben Kassen-/Terminalnummer in derselben Zeile', () => {
  assert.equal(detectReceiptNumber('Kasse 2   Bon-Nr 4711'), '4711');
  assert.equal(detectReceiptNumber('Terminal-ID 99887  Beleg-Nr. 5544'), '5544');
  // umgekehrt: die Kundennummer NACH dem Label darf nicht gewinnen
  assert.equal(detectReceiptNumber('Rechnung Nr 100234  Kunden-Nr 55'), '100234');
  // steht nach dem Label nur eine Kundennummer -> nicht übernehmen
  assert.equal(detectReceiptNumber('Rechnung für Kunden-Nr 4455'), null);
});

test('Register-, Vertrags- und Zählernummern werden ignoriert', () => {
  const bon = `
Firmenbuch FN 123456a
GISA-Zahl 12345678
DVR 0012345
Vertragsnummer 55667788
Zählernummer 998877
Gerätenummer 4455
Seriennummer SN-9988
TSE-Signatur 445566
Trace-Nr. 001234
Genehmigungsnr. 998877
`;
  assert.equal(detectReceiptNumber(bon), null);
});

test('Telefon-, UID-, Kunden- und Kassennummern werden ignoriert', () => {
  const bon = `
Tel. 01 234 56 78
UID: ATU12345678
Kundennummer 998877
Kassen-Nr 3
Terminal-ID 12345678
`;
  assert.equal(detectReceiptNumber(bon), null);
});

test('Jahreszahl allein ist keine Belegnummer', () => {
  assert.equal(detectReceiptNumber('Rechnung 2025'), null);
});

test('Kein Label -> lieber keine Nummer als eine falsche', () => {
  const bon = `
Metro Cash & Carry
Wien 1110
Artikel 123456
Summe 44,90
`;
  assert.equal(detectReceiptNumber(bon), null);
});

// ---------- Datum ----------

test('Datum mit Label hat Vorrang', () => {
  const bon = `
Lieferschein 20.09.2025
Rechnungsdatum: 01.10.2025
`;
  assert.equal(detectDate(bon, HEUTE), '2025-10-01');
});

test('Zukünftiges Datum wird verworfen', () => {
  assert.equal(detectDate('Gültig bis 01.12.2030', HEUTE), null);
});

test('Zweistelliges Jahr wird ergänzt', () => {
  assert.equal(detectDate('Datum 05.03.25', HEUTE), '2025-03-05');
});

test('Alle gängigen Datums-Schreibweisen', () => {
  const faelle = [
    ['Datum 03.10.2025', '2025-10-03'],
    ['Datum 03/10/2025', '2025-10-03'],
    ['Datum 03-10-2025', '2025-10-03'],
    ['Beleg vom 3.10.25', '2025-10-03'],
    ['Datum: 2025-10-03', '2025-10-03'],           // ISO
    ['Datum 03. 10. 2025', '2025-10-03'],          // mit Leerzeichen
    ['Rechnungsdatum 3. Oktober 2025', '2025-10-03'],
    ['Wien, am 3. Okt 2025', '2025-10-03'],
    ['Datum 3 Sept 2025', '2025-09-03'],
    ['Datum 1. Jänner 2025', '2025-01-01'],
    ['Datum 15. März 2025', '2025-03-15'],
    ['Invoice date: October 3, 2025', '2025-10-03'],
    ['Date: 3 December 2024', '2024-12-03']
  ];
  for (const [zeile, erwartet] of faelle) {
    assert.equal(detectDate(zeile, HEUTE), erwartet, `Zeile: "${zeile}"`);
  }
});

test('Unmögliche und unpassende Datumsangaben werden verworfen', () => {
  assert.equal(detectDate('Datum 31.02.2025', HEUTE), null, '31. Februar gibt es nicht');
  assert.equal(detectDate('Datum 45.13.2025', HEUTE), null);
  assert.equal(detectDate('Artikel 12345 Menge 3', HEUTE), null);
  assert.equal(detectDate('Summe 1.234,56', HEUTE), null, 'Betrag ist kein Datum');
  assert.equal(detectDate('Zahlbar bis 30.11.2029', HEUTE), null, 'Zukunft');
});

test('Rechnungsdatum schlägt Liefer- und Zahlungsdatum', () => {
  const rg = `
Lieferdatum 20.09.2025
Zahlbar bis 10.10.2025
Rechnungsdatum: 01.10.2025
Skonto bis 05.10.2025
`;
  assert.equal(detectDate(rg, HEUTE), '2025-10-01');
});

test('Ohne Rechnungsdatum gilt das Lieferdatum, nie das Zahlungsziel', () => {
  const rg = `
Zahlbar bis 10.10.2025
Lieferdatum 20.09.2025
`;
  assert.equal(detectDate(rg, HEUTE), '2025-09-20');
});

test('Zahlungsziel/MHD werden auch ohne anderes Datum nicht genommen', () => {
  assert.equal(detectDate('Zahlbar bis 10.10.2025', HEUTE), null);
  assert.equal(detectDate('MHD 01.09.2025', HEUTE), null);
  assert.equal(detectDate('Gültig bis 01.09.2025', HEUTE), null);
});

// ---------- Lieferant ----------

test('Firmenname mit Rechtsform wird komplett gelesen', () => {
  const bon = `
Mega Gastro GmbH
Handelskai 100
1020 Wien
Rechnung
`;
  assert.equal(guessSupplierFromText(bon), 'Mega Gastro GmbH');
});

test('Rechtsform in eigener Zeile wird angehängt', () => {
  const bon = `
Sahan Einzelhandel
GmbH
Favoritenstraße 1
`;
  assert.equal(guessSupplierFromText(bon), 'Sahan Einzelhandel GmbH');
});

// ---------- Komplette Belege ----------

test('Kompletter Kassabon: Bargeld, zwei Steuersätze, Belegnummer', () => {
  const bon = `
Restaurant Zeytoon
Mega Gastro GmbH
Favoritenstraße 12
1100 Wien
UID: ATU12345678
Tel. 01/234 56 78

KASSABON
Beleg-Nr: 2025-004711
Datum: 03.10.2025  19:42
Kassen-Nr 2  Bediener 7

2x Kebap Teller        24,00
1x Cola                 3,50
1x Bier                 4,50

ZWISCHENSUMME          32,00
SUMME                  32,00

Satz    Netto   Steuer  Brutto
20%     20,00    4,00   24,00
10%      7,27    0,73    8,00

Gegeben BAR            50,00
Rückgeld               18,00

Vielen Dank für Ihren Besuch!
`;
  const suppliers = [{ name: 'Mega Gastro GmbH', keywords: ['mega gastro'] }];
  assert.equal(detectTotal(bon), 32, 'Brutto');
  assert.equal(detectVat(bon, 32), 4.73, 'MwSt = 4,00 + 0,73');
  assert.equal(detectReceiptNumber(bon), '2025-004711', 'Beleg-Nr.');
  assert.equal(detectDate(bon, HEUTE), '2025-10-03', 'Datum');
  assert.equal(matchSupplier(bon, suppliers), 'Mega Gastro GmbH', 'Lieferant');
});

test('Komplette Lieferanten-Rechnung mit Überweisung', () => {
  const rg = `
METRO Cash & Carry Österreich GmbH
Metrostraße 1
1110 Wien
UID ATU 40 61 66 05

RECHNUNG
Rechnungsnummer: RE-2025-88231
Kundennummer: 4455667
Rechnungsdatum: 30.09.2025

Positionen ...
Nettobetrag              1.000,00
MwSt 20%                   200,00
Gesamtbetrag             1.200,00

Zahlbar innerhalb 14 Tage
IBAN AT12 3456 7890 1234 5678
`;
  assert.equal(detectTotal(rg), 1200, 'Brutto');
  assert.equal(detectVat(rg, 1200), 200, 'MwSt');
  assert.equal(detectReceiptNumber(rg), 'RE-2025-88231', 'Rechnungsnummer, nicht Kundennummer');
  assert.equal(detectDate(rg, HEUTE), '2025-09-30', 'Datum');
});

// ---------- Nachgebesserte Fälle (echte Fehlerbilder aus dem Betrieb) ----------

test('Firmennamen mit "versteckten" Stichwörtern werden erkannt', () => {
  // Frueher scheiterten diese Namen daran, dass "tel" in Hotel, "atu" in
  // Naturkost und "ust" in Gusto ohne Wortgrenze gesucht wurden.
  const faelle = [
    ['Hotel Sacher Betriebs GmbH\nPhilharmonikerstraße 4\n1010 Wien', 'Hotel Sacher Betriebs GmbH'],
    ['Naturkost Handels GmbH\nHauptstraße 5', 'Naturkost Handels GmbH'],
    ['Gusto Feinkost GmbH\nMarktgasse 3', 'Gusto Feinkost GmbH'],
    ['Statuen Bau GmbH\nRingstraße 1', 'Statuen Bau GmbH']
  ];
  for (const [bon, erwartet] of faelle) {
    assert.equal(guessSupplierFromText(bon), erwartet, `Beleg: "${bon.split('\n')[0]}"`);
  }
});

test('Der eigene Betrieb wird nie als Lieferant vorgeschlagen', () => {
  const rg = `
Zeytoon Gastronomie GmbH
Favoritenstraße 1
1100 Wien

Mega Gastro GmbH
Handelskai 100
`;
  assert.equal(guessSupplierFromText(rg, ['zeytoon']), 'Mega Gastro GmbH');
  // ohne Ignorier-Liste gewinnt der erste Firmenname
  assert.equal(guessSupplierFromText(rg), 'Zeytoon Gastronomie GmbH');
});

test('Ab dem Rechnungsempfänger wird nicht mehr nach dem Lieferanten gesucht', () => {
  const rg = `
Metro Cash & Carry GmbH
Metrostraße 1

Rechnungsempfänger:
Restaurant Zeytoon GmbH
`;
  assert.equal(guessSupplierFromText(rg), 'Metro Cash & Carry GmbH');
});

test('Stichwörter für neue Lieferanten meiden Allerweltswörter', () => {
  assert.deepEqual(supplierKeywords('Hotel Sacher GmbH'), ['hotel sacher gmbh', 'sacher', 'hotel sacher']);
  assert.deepEqual(supplierKeywords('Mega Gastro GmbH'), ['mega gastro gmbh', 'mega', 'mega gastro']);
  // ohne markantes Wort bleibt nur der volle Name (+ Name ohne Rechtsform)
  assert.deepEqual(supplierKeywords('Gastro GmbH'), ['gastro gmbh', 'gastro']);
});

test('Lieferant wird auch bei anderer Schreibweise der OCR gefunden', () => {
  const suppliers = [
    { name: 'Mega Gastro GmbH', keywords: ['mega gastro', 'megagastro'] },
    { name: 'GastroGenius GmbH', keywords: ['gastrogenius'] }
  ];
  assert.equal(matchSupplier('MEGA-GASTRO GMBH\nWien', suppliers), 'Mega Gastro GmbH');
  assert.equal(matchSupplier('Gastro Genius GmbH\nWien', suppliers), 'GastroGenius GmbH');
});

test('Zweispaltiger Beleg: Bezeichnungen und Beträge stehen als zwei Blöcke', () => {
  // So liefert die OCR breite Belege sehr oft: erst die Spalte links,
  // dann die Spalte rechts. Ohne Zusammenführung landet der falsche Wert.
  const bon = `
Metro Wien
Zwischensumme
Rabatt
Zu zahlen
50,00
5,00
45,00
`;
  assert.equal(detectTotal(bon), 45);
});

test('Kartenzahlung ohne Summen-Stichwort ergibt den Endbetrag', () => {
  const bon = `
JET Tankstelle
Diesel 30,00 L
Kartenzahlung          52,80
Maestro **** 1234
`;
  const info = detectTotalInfo(bon);
  assert.equal(info.value, 52.8);
  assert.equal(info.source, 'payment');
});

test('Österreichische Kurzschreibweise "24,-" wird als Betrag gelesen', () => {
  assert.equal(parseAmount('24,-'), 24);
  assert.deepEqual(amountsOn('Summe 24,--'), [24]);
  assert.equal(detectTotal('Kebap 8,-\nSumme 24,-'), 24);
});

test('OCR-Leerzeichen im Betrag ("24, 90") wird verkraftet', () => {
  assert.deepEqual(amountsOn('Gesamtbetrag 1.234, 56'), [1234.56]);
  assert.equal(detectTotal('Zu zahlen 44, 90'), 44.9);
});

test('Betrag in EUR-Schreibweise in der Folgezeile', () => {
  assert.equal(detectTotal('Gesamtbetrag\nEUR 1.200,00'), 1200);
  assert.equal(detectTotal('Zu zahlen\n44,90 EUR'), 44.9);
});

test('MwSt aus Brutto minus Netto, wenn kein Steuerbetrag ausgewiesen ist', () => {
  const rg = `
Nettobetrag        100,00
Rechnungsbetrag    120,00
`;
  const info = detectVatInfo(rg, 120);
  assert.equal(info.value, 20);
  assert.equal(info.source, 'net-diff');
  // unpassende Differenz (kein gültiger Steuersatz) wird NICHT übernommen
  assert.equal(detectVat('Nettobetrag 100,00\nRechnungsbetrag 105,00', 105), null);
});

test('MwSt-Summenzeile gewinnt gegen doppelt gezählte Einzelzeilen', () => {
  const rg = `
Gesamtbetrag          120,00
MwSt 20%               20,00
Summe inkl. MwSt      120,00
`;
  assert.equal(detectVat(rg, 120), 20);
});

test('MwSt steht in der Zeile unter dem Stichwort', () => {
  const rg = `
Gesamt 120,00
MwSt 20%
20,00
`;
  assert.equal(detectVat(rg, 120), 20);
});

test('Belegnummer: weitere Schreibweisen aus der Praxis', () => {
  const faelle = [
    ['Beleg-ID: 4711-2025', '4711-2025'],
    ['Rechnung Nr. 7', '7'],
    ['Kassenrechnung Nr 8812', '8812'],
    ['Registrierbeleg 000123', '000123'],
    ['Rechnungs-Nr\n2025/0042', '2025/0042'],
    ['Mega Gastro GmbH\n2025/0042\nSumme 44,90', '2025/0042']
  ];
  for (const [zeile, erwartet] of faelle) {
    assert.equal(detectReceiptNumber(zeile), erwartet, `Zeile: "${zeile}"`);
  }
});

test('Telefonnummern bleiben auch ohne Label keine Belegnummer', () => {
  assert.equal(detectReceiptNumber('Mega Gastro GmbH\n01 234 56-78\nSumme 44,90'), null);
  assert.equal(detectReceiptNumber('Mega Gastro\nTel 0664 123-4567'), null);
});

// ---------- Ganze Belege, wie sie im Betrieb ankommen ----------

const BEKANNTE = [
  { name: 'Metro 1110', keywords: ['metro'] },
  { name: 'Hofer', keywords: ['hofer'] },
  { name: 'JET Tankstelle', keywords: ['jet tankstelle', 'jet '] }
];

// Prüft alle Felder eines Belegs auf einmal.
function pruefe(bon, erwartet) {
  const total = detectTotalInfo(bon);
  const vat = detectVatInfo(bon, total.value);
  const lieferant = matchSupplier(bon, BEKANNTE) || guessSupplierFromText(bon, ['zeytoon']);
  assert.equal(lieferant, erwartet.lieferant, 'Lieferant');
  assert.equal(total.value, erwartet.brutto, 'Brutto');
  assert.equal(vat.value, erwartet.mwst, 'MwSt');
  assert.equal(detectDate(bon, HEUTE), erwartet.datum, 'Datum');
  assert.equal(detectReceiptNumber(bon), erwartet.nummer, 'Beleg-Nr.');
}

test('Supermarkt-Kassabon mit Bankomatzahlung', () => {
  pruefe(
    `
HOFER KG
Filiale 0412
Triester Straße 20
1100 WIEN
Tel. 0800 400 400

Milch 1L            1,29 A
Brot                2,49 A
Käse                4,99 A
--------------------------
SUMME EUR           8,77
Bankomat            8,77

A = 10% MwSt   Netto 7,97   MwSt 0,80
Beleg-Nr. 0412-2025-08812
03.10.2025 18:22
`,
    { lieferant: 'Hofer', brutto: 8.77, mwst: 0.8, datum: '2025-10-03', nummer: '0412-2025-08812' }
  );
});

test('A4-Eingangsrechnung mit Empfängerblock', () => {
  pruefe(
    `
METRO Cash & Carry Österreich GmbH
Metrostraße 1
1110 Wien
UID: ATU40616605

RECHNUNG

Rechnungsempfänger:
Restaurant Zeytoon
Favoritenstraße 1

Rechnungsnummer      RE-2025-88231
Rechnungsdatum       30.09.2025
Kundennummer         4455667

Warenwert netto          1.000,00
20 % MwSt                  200,00
Rechnungsbetrag          1.200,00

Zahlbar bis 14.10.2025
IBAN AT12 3456 7890 1234 5678
`,
    { lieferant: 'Metro 1110', brutto: 1200, mwst: 200, datum: '2025-09-30', nummer: 'RE-2025-88231' }
  );
});

test('Kassabon, dessen Spalten die OCR getrennt hat', () => {
  pruefe(
    `
Naturkost Handels GmbH
Hauptstraße 5
1010 Wien
Bon-Nr 88231
Zwischensumme
Rabatt
Zu zahlen
Gegeben
Rückgeld
34,00
4,00
30,00
50,00
20,00
`,
    { lieferant: 'Naturkost Handels GmbH', brutto: 30, mwst: null, datum: null, nummer: '88231' }
  );
});

test('Tankstellen-Beleg ganz ohne Summen-Stichwort', () => {
  pruefe(
    `
JET Tankstelle Wien Süd
Triester Str. 100
Diesel      30,12 L
Preis/L      1,759
Kartenzahlung        52,98
Maestro **** 1234
Beleg 0099123
04.10.2025 07:14
`,
    { lieferant: 'JET Tankstelle', brutto: 52.98, mwst: null, datum: '2025-10-04', nummer: '0099123' }
  );
});

test('Kleiner Wirt mit Kurzschreibweise "8,-"', () => {
  pruefe(
    `
Gasthaus Zum Gusto
Inh. Alizadeh
Kebap                8,-
Cola                 3,-
------------------
Summe               11,-
Bar                 20,-
Retour               9,-
Bon 42
inkl. 10% MwSt
05.10.2025
`,
    { lieferant: 'Gasthaus Zum Gusto', brutto: 11, mwst: 1, datum: '2025-10-05', nummer: '42' }
  );
});

// ---------- Echte Belege, die der Bot falsch gelesen hatte ----------
// Die Texte sind gekürzte, aber zeilengetreue Auszüge der Google-Vision-Ausgabe.

test('EU-Lieferant ohne Umsatzsteuer: MwSt ist 0,00 und nicht "unbekannt"', () => {
  const rg = `
reichelt elektronik GmbH
Elektronikring 1 26452 Sande
ZEYTOON GMBH
UNGARGASSE 6/1
1030 WIEN
Rechnung:
Kunde:
3081253
57312126P
Datum:
13.08.2026
Steuerfreie innergemeinschaftliche Lieferung
Warenwert
260,54
Versandkosten
5,79
Nettowert
266,33
Mwst. 0,0%
0,00
Endbetrag (EUR)
266,33
Betrag per Kreditkarte bezahlt.
`;
  const total = detectTotalInfo(rg);
  assert.equal(total.value, 266.33, 'Endbetrag');
  const vat = detectVatInfo(rg, total.value);
  assert.equal(vat.value, 0, 'MwSt 0,00 bei steuerfreier Lieferung');
  assert.equal(vat.source, 'tax-free');
  assert.equal(detectReceiptNumber(rg), '3081253', 'Rechnung, nicht Kundennummer');
  assert.equal(guessSupplierFromText(rg, ['zeytoon']), 'reichelt elektronik GmbH');
});

test('Metro-Beleg: Steuersätze stehen über mehrere Zeilen verteilt', () => {
  const bon = `
METRO Cash & Carry Österreich GmbH
Metro Platz 1
A-2331 Vösendorf
UID-Nr.: ATU19424905
Rechnung 180600072/20260818
Zeytoon GmbH
Kunde: 018 087518 02 SC
NETTO-WARENWERT:
279,05
9,36
NETTOWERT % MWST
MWST
BRUTTO
WARE F:
86, 55 B=10,00%
8,66
95,21
WARE F:
94, 87
C=20,00%
18,97
113,84
WARE F:
97, 38
F= 4,90%
4,77
102,15
LEERGUT:
0,25 A= 0,00%
0,00
0,25
279,05
32,40
311,45
SUMME EUR
311,45
Karte EUR
311,45
`;
  const total = detectTotalInfo(bon);
  assert.equal(total.value, 311.45, 'SUMME EUR');
  // 8,66 + 18,97 + 4,77 + 0,00 = 32,40
  assert.equal(detectVat(bon, total.value), 32.4, 'MwSt aller Steuersätze');
  assert.equal(detectReceiptNumber(bon), '180600072/20260818');
});

test('Orient-Rechnung: Stichwort am Zeilenende, Gewichtszeile daneben', () => {
  const rg = `
ZEYTOON GMBH
UNGARGASSE 6/3
WIEN
1030
Rechnung
orient
MARKETINGSERVICE GES.M.B.H. Nfg. KG
Nr. 45274727
Belegdatum 18. August 2026
Total Karton: 26
Total Stück: 52
Total KG: 0
Zwischensumme
915,95
St.Wert %4.9
245,13 MwSt. %4.9
12,01
Brutto-Gesamtgewicht:269,94
St.Wert %10
550,08 MwSt. %10
55,01
Netto-Gesamtgewicht: 269,94
St.Wert %20
108,74 MwSt. %20
21,75
St.Wert 0%
12,00 Gesamt € inkl. MwSt.
Zahlen mit QR Code:
1 004,72
`;
  const total = detectTotalInfo(rg);
  // NICHT 269,94 (das ist das Gesamtgewicht) und nicht 12,00 (St.Wert 0%)
  assert.equal(total.value, 1004.72, 'Gesamt inkl. MwSt.');
  // 12,01 + 55,01 + 21,75 = 88,77; Gegenprobe: 915,95 + 88,77 = 1.004,72
  assert.equal(detectVat(rg, total.value), 88.77, 'MwSt aller drei Sätze');
  assert.equal(detectReceiptNumber(rg), '45274727');
  assert.equal(detectDate(rg, new Date('2026-08-19T12:00:00Z')), '2026-08-18');
  assert.equal(matchSupplier(rg, [{ name: 'Orient GmbH', keywords: ['orient'] }]), 'Orient GmbH');
});

test('Prozentzeichen vor der Zahl ("%4.9") wird als Steuersatz gelesen', () => {
  assert.deepEqual(ratesOn('St.Wert %4.9'), [4.9]);
  assert.deepEqual(ratesOn('MwSt 20%'), [20]);
  // gleicher Satz zweimal in einer Zeile zählt einmal
  assert.deepEqual(ratesOn('St.Wert %10 550,08 MwSt. %10'), [10]);
});

test('Gewichts- und Stückzeilen sind keine Geldbeträge', () => {
  assert.equal(detectTotal('Brutto-Gesamtgewicht:269,94\nSumme 44,90'), 44.9);
  assert.equal(detectTotal('Netto-Gesamtgewicht: 269,94'), null);
});

test('Bekannter Lieferant im Kopf schlägt Nennung im Fließtext', () => {
  const suppliers = [
    { name: 'Metro 1110', keywords: ['metro'] },
    { name: 'Spar', keywords: ['spar'] }
  ];
  const bon = `
SPAR Österreich
Wien
Artikel: Metro Reiniger 3,99
`;
  assert.equal(matchSupplier(bon, suppliers), 'Spar');
});
