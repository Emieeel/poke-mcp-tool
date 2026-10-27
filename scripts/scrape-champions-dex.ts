/**
 * scrape-champions-dex.ts — builds the Pokémon CHAMPIONS engine dex from Serebii.
 *
 *   npm run scrape:dex                 # scrape the whole roster (from the dex index)
 *   npm run scrape:dex -- staraptor    # scrape just one or more slugs (for testing)
 *
 * WHY THIS EXISTS (and contradicts the original "never scrape engine data" rule):
 * @smogon/calc's bundled dex is MAINLINE data. Pokémon Champions has game-original Mega
 * Evolutions (Mega Staraptor, Mega Raichu X/Y, Mega Eelektross, ...) whose abilities/stats
 * differ from — or don't exist in — @smogon/calc. Example: Champions' Mega Staraptor has
 * Contrary, but @smogon/calc says Intimidate. So for Champions-accurate stats/types/
 * abilities we source the dex from Serebii's Champions Pokédex. @smogon/calc is still the
 * engine for the damage *formula* (calculate_damage) — only the per-Pokémon facts move here.
 *
 * This is an on-demand script. The MCP server never runs it; it only reads the JSON output.
 *
 * Parsing (the brittle, page-specific part) is isolated in parsePokemonPage(). Serebii lays
 * out each form as three consecutive tables in document order: a "Name … Type" table, an
 * "Abilities:" table, and a "Stats" table. We group them by document order so a page with
 * a base form + N Mega forms yields N+1 forms.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const INDEX_URL = 'https://www.serebii.net/pokedex-champions/';
const entryUrl = (slug: string) => `https://www.serebii.net/pokedex-champions/${slug}/`;
// Slugs are lowercase but can contain an apostrophe or a period (farfetch'd, mr.mime,
// sirfetch'd, mr.rime) — omitting those from the character class silently drops those
// Pokémon from the roster. The trailing `+` still rejects the empty "choose a Pokémon"
// option. Keep in sync with SLUG_PATH in scrape-regulation.ts.
const SLUG_PATH = /^\/pokedex-champions\/([a-z0-9.'-]+)\/$/;

const UA = 'pokemon-champions-mcp dex scraper (personal use)';

export interface Form {
  name: string;
  types: string[];
  abilities: string[];
  baseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  weightkg: number | null;
}
export interface DexEntry {
  slug: string;
  name: string;
  num: number | null;
  forms: Form[];
  // The Pokémon's full learnable movelist in Champions (shared by its Mega forms).
  moves: string[];
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // Serebii serves ISO-8859-1; decode as latin1 to keep names intact.
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('latin1');
}

/** Pull the full roster (slug + national number) from the dex index dropdowns. */
export async function fetchRoster(): Promise<{ slug: string; num: number | null }[]> {
  const html = await fetchText(INDEX_URL);
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: { slug: string; num: number | null }[] = [];
  // The index lists every Pokémon as <option value="/pokedex-champions/<slug>/">### Name</option>.
  $('option').each((_, o) => {
    const val = $(o).attr('value') || '';
    const m = val.match(SLUG_PATH);
    if (!m) return;
    const slug = m[1];
    if (seen.has(slug)) return;
    seen.add(slug);
    const num = parseInt(($(o).text().match(/#?(\d+)/) || [])[1] || '', 10);
    out.push({ slug, num: Number.isFinite(num) ? num : null });
  });
  return out;
}

// ── Per-page parser (brittle bit — isolated & commented) ────────────────────────
type Tagged = { kind: 'header' | 'name' | 'abilities' | 'stats'; el: AnyNode; label?: string };

// First-cell labels that are section tables, never a form-name header.
const SECTION_LABELS = new Set([
  'Picture', 'Name', 'Stats', 'Weakness', 'Damage Taken', 'Evolutionary Chain',
  'Gender Differences', 'Standard Moves', 'Egg Moves', 'Location', 'Flavor Text',
]);

export function parsePokemonPage(html: string, slug: string): DexEntry {
  const $ = cheerio.load(html);

  // Base name + national number come from the <title>: "Staraptor - #398 - Serebii.net Pokédex".
  const title = $('title').text();
  const baseName = (title.split(' - ')[0] || slug).trim();
  const numMatch = title.match(/#(\d+)/);
  const num = numMatch ? parseInt(numMatch[1], 10) : null;

  // Classify the relevant tables in document order. A form's display name (incl. the X/Y of
  // multi-Megas) lives in a "header" dextable: a picture block whose first cell is the form
  // name (e.g. "Mega Raichu X") rather than the literal word "Picture".
  const tagged: Tagged[] = [];
  $('table.dextable').each((_, t) => {
    const firstCell = $(t).find('tr').first().find('td,th').first().text().replace(/\s+/g, ' ').trim();
    const whole = $(t).text().replace(/\s+/g, ' ').trim();
    if (firstCell === 'Name') tagged.push({ kind: 'name', el: t });
    else if (/^Abilities:/.test(whole)) tagged.push({ kind: 'abilities', el: t });
    else if (/^Stats\b/.test(firstCell)) tagged.push({ kind: 'stats', el: t });
    else if (/Picture/.test(whole) && firstCell.length > 0 && firstCell.length < 40 && !SECTION_LABELS.has(firstCell)) {
      tagged.push({ kind: 'header', el: t, label: firstCell });
    }
  });

  // Walk the tables. A "header" sets the name for the form introduced by the next "name"
  // table; if there's no preceding header (the base form), fall back to the page's base name.
  const forms: Form[] = [];
  let pendingName: string | null = null;
  for (let i = 0; i < tagged.length; i++) {
    if (tagged[i].kind === 'header') {
      pendingName = tagged[i].label || null;
      continue;
    }
    if (tagged[i].kind !== 'name') continue;
    const nameTable = $(tagged[i].el);
    const form: Form = {
      name: pendingName || baseName,
      types: extractTypes(nameTable, $),
      abilities: [],
      baseStats: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      weightkg: extractWeight(nameTable),
    };
    pendingName = null;
    // Consume following abilities/stats until the next name/header table.
    for (let j = i + 1; j < tagged.length && tagged[j].kind !== 'name' && tagged[j].kind !== 'header'; j++) {
      if (tagged[j].kind === 'abilities' && form.abilities.length === 0) {
        form.abilities = extractAbilities($(tagged[j].el).find('tr').first().text());
      } else if (tagged[j].kind === 'stats' && form.baseStats.hp === 0) {
        form.baseStats = extractStats($(tagged[j].el), $);
      }
    }
    if (form.types.length || form.abilities.length || form.baseStats.hp) forms.push(form);
  }

  const moves = extractMoves($);
  return { slug, name: baseName, num, forms, moves };
}

// All learnable moves: the names linked to /attackdex-champions/ inside any "… Moves" table
// (Champions consolidates these into a "Standard Moves" list, but we scan all move tables).
function extractMoves($: cheerio.CheerioAPI): string[] {
  const seen = new Set<string>();
  const moves: string[] = [];
  $('table.dextable').each((_, t) => {
    const header = $(t).find('tr').first().find('td,th').first().text().replace(/\s+/g, ' ').trim();
    if (!/Moves\b/i.test(header)) return;
    $(t).find('a[href*="/attackdex-champions/"]').each((_, a) => {
      const name = $(a).text().replace(/\s+/g, ' ').trim();
      const key = name.toLowerCase();
      if (name && /[A-Za-z]/.test(name) && !seen.has(key)) {
        seen.add(key);
        moves.push(name);
      }
    });
  });
  return moves.sort((a, b) => a.localeCompare(b));
}

function extractTypes(nameTable: cheerio.Cheerio<AnyNode>, $: cheerio.CheerioAPI): string[] {
  // Types are links ending in "<type>.shtml" (under /pokedex-champions/ or /pokedex-sm/).
  const types: string[] = [];
  nameTable.find('a[href*=".shtml"]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/\/([a-z]+)\.shtml$/);
    if (!m) return;
    const t = cap(m[1]);
    if (TYPES.has(t) && !types.includes(t)) types.push(t);
  });
  return types;
}

function extractAbilities(headerText: string): string[] {
  // "Abilities: Intimidate - Reckless" -> ["Intimidate", "Reckless"]. Serebii's separator is
  // a dash flanked by whitespace, but spacing is inconsistent (e.g. "Intimidate- Flash Fire"),
  // so we split on a dash that has whitespace on at least the right side. Hyphenated ability
  // names (e.g. "Soul-Heart") have no space after the dash and so survive intact.
  const after = headerText.replace(/\s+/g, ' ').trim().replace(/^Abilities:\s*/, '').trim();
  return after
    .split(/\s*-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractStats(statsTable: cheerio.Cheerio<AnyNode>, $: cheerio.CheerioAPI): Form['baseStats'] {
  // The "Base Stats - Total: N" row carries the six base stats in order.
  let row: string[] | null = null;
  statsTable.find('tr').each((_, r) => {
    const cells = $(r).find('td,th').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
    if (cells[0] && /^Base Stats/.test(cells[0])) row = cells;
  });
  if (!row) return { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const n = (s: string) => parseInt(s, 10) || 0;
  return { hp: n(row[1]), atk: n(row[2]), def: n(row[3]), spa: n(row[4]), spd: n(row[5]), spe: n(row[6]) };
}

function extractWeight(nameTable: cheerio.Cheerio<AnyNode>): number | null {
  // The Classification/Height/Weight row contains e.g. "54.9lbs 24.9kg".
  const m = nameTable.text().match(/([\d.]+)\s*kg/);
  return m ? parseFloat(m[1]) : null;
}

const TYPES = new Set([
  'Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
  'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy',
]);
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter(Boolean);

  let roster: { slug: string; num: number | null }[];
  if (args.length > 0) {
    console.error(`[dex] Scraping ${args.length} requested slug(s): ${args.join(', ')}`);
    roster = args.map((slug) => ({ slug, num: null }));
  } else {
    console.error(`[dex] Fetching roster index: ${INDEX_URL}`);
    roster = await fetchRoster();
    console.error(`[dex] Roster has ${roster.length} Pokémon. Fetching each page (throttled)…`);
  }

  const pokemon: Record<string, DexEntry> = {};
  const failures: string[] = [];
  let i = 0;
  for (const { slug, num } of roster) {
    i++;
    try {
      const html = await fetchText(entryUrl(slug));
      const entry = parsePokemonPage(html, slug);
      if (num != null && entry.num == null) entry.num = num;
      pokemon[slug] = entry;
      if (entry.forms.length === 0) failures.push(`${slug} (no forms parsed)`);
      if (i % 25 === 0 || args.length > 0) {
        console.error(`[dex] (${i}/${roster.length}) ${slug}: ${entry.forms.length} form(s), ${entry.moves.length} moves ` +
          entry.forms.map((f) => `${f.name}[${f.abilities.join('/')}]`).join(' '));
      }
    } catch (err) {
      failures.push(`${slug} (${(err as Error).message})`);
      console.error(`[dex] FAILED ${slug}: ${(err as Error).message}`);
    }
    // Be polite to Serebii.
    if (args.length === 0) await sleep(200);
  }

  const output = {
    meta: {
      game: 'Pokémon Champions',
      source: INDEX_URL,
      scrapedAt: new Date().toISOString(),
      count: Object.keys(pokemon).length,
      note:
        'Champions-accurate engine data scraped from Serebii. Use this for per-Pokémon ' +
        'facts (stats/types/abilities), since @smogon/calc bundles mainline data that is ' +
        'wrong or missing for Champions-original Mega Evolutions.',
    },
    pokemon,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  // For single-slug test runs, don't clobber the full file — write a preview instead.
  const outFile = join(DATA_DIR, args.length > 0 ? 'champions-dex.sample.json' : 'champions-dex.json');
  writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[dex] Wrote ${outFile} — ${output.meta.count} Pokémon.`);
  if (failures.length) {
    console.error(`[dex] ${failures.length} issue(s):`);
    for (const f of failures) console.error('   - ' + f);
  }
}

main().catch((err) => {
  console.error('[dex] fatal:', err);
  process.exit(1);
});
