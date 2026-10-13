// Records how many decks each of your commanders appears in on EDHREC (a site built from public Moxfield, Archidekt and other deck lists)
// into data/commander-popularity.json. Reads the same cards.json as the price recorder.
import fs from 'node:fs';

const UA = { 'User-Agent': 'mtg-tools-commander-popularity/1.0 (personal collection tool)', 'Accept': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FILE = 'data/commander-popularity.json';
const REFRESH_DAYS = 30; // commander popularity moves slowly, so each commander is re-read about monthly

if (!fs.existsSync('cards.json')) { console.error('cards.json is missing.'); process.exit(1); }
const names = [...new Set(JSON.parse(fs.readFileSync('cards.json', 'utf8')))].filter(n => typeof n === 'string' && n);

// 1. Which of the cards can be a commander? Ask Scryfall.
const cands = [];
for (let i = 0; i < names.length; i += 75) {
  const batch = names.slice(i, i + 75);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: batch.map(n => ({ name: n.split(' // ')[0] })) })
      });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error('Scryfall returned ' + r.status);
      for (const c of (await r.json()).data || []) {
        const front = (c.type_line || '').split(' // ')[0], o = c.oracle_text || (c.card_faces && c.card_faces[0].oracle_text) || '';
        const legal = c.legalities && (c.legalities.commander === 'legal');
        if (legal && ((/Legendary/.test(front) && /Creature/.test(front)) || /can be your commander/i.test(o))) cands.push(c.name);
      }
      break;
    } catch (e) { if (attempt === 3) throw e; await sleep(1500 * (attempt + 1)); }
  }
  await sleep(150);
}
console.log(cands.length + ' possible commanders in cards.json');

// 2. EDHREC page slug: lower case, accents removed, apostrophes dropped, other punctuation to hyphens. Double-faced cards use the front name.
const slug = n => n.split(' // ')[0].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Each card entry on the page has num_decks (decks that run it) and potential_decks (decks it could be in), so num/potential is how often it is played.
// The commander's own deck count is the largest potential_decks on the page.
const isBasic = n => /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest)$|^Wastes$/.test(n);
function parsePage(j, self) {
  let decks = 0;
  const best = new Map();
  const walk = o => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    if (typeof o.name === 'string' && typeof o.num_decks === 'number' && typeof o.potential_decks === 'number' && o.potential_decks > 0) {
      decks = Math.max(decks, o.potential_decks);
      best.set(o.name, Math.max(best.get(o.name) || 0, o.num_decks / o.potential_decks));
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(j);
  if (!decks && j && j.budget_counts) {
    const v = Object.values(j.budget_counts).filter(x => typeof x === 'number'); // fallback only
    if (v.length) decks = v.reduce((a, b) => a + b, 0);
  }
  const c = [...best].filter(([n]) => n !== self && !isBasic(n)).sort((a, b) => b[1] - a[1]).slice(0, 120).map(([n, p]) => [n, Math.round(p * 100)]);
  return { decks, c };
}

let prev = { cards: {} };
try { prev = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const out = { updated: new Date().toISOString(), source: 'EDHREC', cards: { ...prev.cards } };
const stale = n => { const p = prev.cards && prev.cards[n]; return !p || !p.c || (Date.now() - Date.parse(p.t || 0)) > REFRESH_DAYS * 864e5; };

let ok = 0, notFound = 0, failed = 0;
for (const n of cands.filter(stale)) {
  let done = false;
  for (let attempt = 0; attempt < 3 && !done; attempt++) {
    try {
      const r = await fetch('https://json.edhrec.com/pages/commanders/' + slug(n) + '.json', { headers: UA });
      if (r.status === 404) { out.cards[n] = { decks: 0, t: new Date().toISOString() }; notFound++; done = true; break; }
      if (r.status === 429 || r.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
      if (!r.ok) { failed++; done = true; break; }
      const d = parsePage(await r.json(), n);
      out.cards[n] = { decks: d.decks, c: d.c, t: new Date().toISOString() }; ok++; done = true;
    } catch (e) { await sleep(2000 * (attempt + 1)); }
  }
  if (!done) failed++;
  await sleep(1200); // be gentle: this is an unofficial endpoint
}
console.log(`EDHREC: ${ok} read, ${notFound} not found, ${failed} failed`);
if (!ok && failed) { console.error('Nothing could be read from EDHREC, so the file was left as it was.'); process.exit(1); }
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(out));
