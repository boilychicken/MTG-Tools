// Records today's Cardmarket (EUR) prices for every card in cards.json via Scryfall,
// plus the EUR->GBP exchange rate, into data/prices/YYYY-MM-DD.json and data/index.json.
import fs from 'node:fs';

const H = {
  'User-Agent': 'mtg-tools-price-recorder/1.0',
  'Accept': 'application/json',
  'Content-Type': 'application/json'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const date = new Date().toISOString().slice(0, 10); // UTC date, same as the run time

if (!fs.existsSync('cards.json')) {
  console.error('cards.json is missing. Download it from the app (Price tracker page) and add it to the repository.');
  process.exit(1);
}
const names = [...new Set(JSON.parse(fs.readFileSync('cards.json', 'utf8')))].filter(n => typeof n === 'string' && n);
if (!names.length) { console.error('cards.json is empty.'); process.exit(1); }

async function post(batch) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST', headers: H,
        body: JSON.stringify({ identifiers: batch.map(n => ({ name: n.split(' // ')[0] })) })
      });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error('Scryfall returned ' + r.status);
      return (await r.json()).data || [];
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw new Error('Scryfall did not respond');
}

const p = {};
let missing = 0;
for (let i = 0; i < names.length; i += 75) {
  const batch = names.slice(i, i + 75), by = {};
  const data = await post(batch);
  data.forEach(c => {
    by[c.name.toLowerCase()] = c;
    c.name.split(' // ').forEach(x => { by[x.toLowerCase()] = by[x.toLowerCase()] || c; });
  });
  batch.forEach(n => {
    const c = by[n.toLowerCase()] || by[n.split(' // ')[0].toLowerCase()], pr = c && c.prices;
    if (pr && (pr.eur != null || pr.eur_foil != null)) {
      p[n] = [pr.eur != null ? +pr.eur : null, pr.eur_foil != null ? +pr.eur_foil : null];
    } else missing++;
  });
  await sleep(150); // stay well inside Scryfall's rate limit
}

// Scryfall's default printing of a card sometimes has no Cardmarket price (basic lands, some promos and reprints).
// For those, use the newest paper printing that does have one.
let fallback = 0;
for (const n of names.filter(n => !(n in p)).slice(0, 60)) {
  try {
    const r = await fetch('https://api.scryfall.com/cards/search?q=' + encodeURIComponent('!"' + n.split(' // ')[0] + '" game:paper') + '&unique=prints&order=released&dir=desc', { headers: H });
    if (r.ok) {
      const x = ((await r.json()).data || []).find(c => c.prices && (c.prices.eur != null || c.prices.eur_foil != null));
      if (x) { p[n] = [x.prices.eur != null ? +x.prices.eur : null, x.prices.eur_foil != null ? +x.prices.eur_foil : null]; fallback++; missing--; }
    }
  } catch (e) { /* leave it unpriced */ }
  await sleep(150);
}
if (!Object.keys(p).length) { console.error('No prices came back, so nothing was saved.'); process.exit(1); }

// Also record every card that is currently legal in Standard, so cards you add later already have history.
// Standard rotates, so this follows it automatically. A failure here is not fatal: your own cards are still saved.
let std = 0;
try {
  let url = 'https://api.scryfall.com/cards/search?q=' + encodeURIComponent('f:standard') + '&unique=cards&order=name';
  for (let page = 0; url && page < 40; page++) {
    const r = await fetch(url, { headers: H });
    if (!r.ok) throw new Error('Scryfall returned ' + r.status);
    const j = await r.json();
    for (const c of j.data || []) {
      const pr = c.prices;
      if (!(c.name in p) && pr && (pr.eur != null || pr.eur_foil != null)) {
        p[c.name] = [pr.eur != null ? +pr.eur : null, pr.eur_foil != null ? +pr.eur_foil : null];
        std++;
      }
    }
    url = j.has_more ? j.next_page : null;
    await sleep(150);
  }
} catch (e) { console.warn('Could not record Standard cards: ' + e.message); }

let fx = null;
try {
  const r = await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=GBP');
  const j = await r.json();
  if (j.rates && j.rates.GBP > 0) fx = j.rates.GBP;
} catch (e) { console.warn('Could not fetch the exchange rate; the app will use the last known one.'); }

fs.mkdirSync('data/prices', { recursive: true });
fs.writeFileSync(`data/prices/${date}.json`, JSON.stringify({ date, fx, p }));
let dates = [];
try { dates = JSON.parse(fs.readFileSync('data/index.json', 'utf8')).dates || []; } catch (e) {}
dates = [...new Set([...dates, date])].sort();
fs.writeFileSync('data/index.json', JSON.stringify({ dates }));
console.log(`Saved ${Object.keys(p).length} prices for ${date}: your cards plus ${std} extra Standard cards (${missing} of your cards had no price, ${fallback} priced from another printing). EUR to GBP: ${fx}`);
