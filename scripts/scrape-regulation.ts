/**
 * scrape-regulation.ts — standalone, on-demand scraper for Pokémon Champions regulations.
 *
 *   npm run scrape -- m-b
 *
 * It fetches the Serebii Champions regulation page for the given id, parses out the
 * legality-relevant data, and writes regulations/<id>.json with a fresh scrapedAt
 * timestamp. This script is NEVER run by the MCP server — the server only reads the JSON.
 *
 * ── Why this is the only data we scrape ──────────────────────────────────────
 * Engine data (dex, stats, moves, type chart, damage formula) all comes from the
 * @smogon/calc package. Regulation legality is Champions-specific, fast-changing, and
 * exists in no package — so we source it here.
 *
 * ── Defensiveness ────────────────────────────────────────────────────────────
 * Serebii's markup changes over time and a freshly published regulation page may be
 * only partially filled. If parsing yields suspiciously little, we print a LOUD warning
 * and write what we found rather than crashing. All the brittle, page-specific selectors
 * are isolated in parseRegulationPage() below so they're easy to fix later.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { scrapeItems, ITEMS_URL } from './scrape-champions-items.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGULATIONS_DIR = join(__dirname, '..', 'regulations');

// Serebii uses the regulation id verbatim in the URL, e.g. m-b -> regulationm-b.shtml.
function sourceUrl(id: string): string {
  return `https://www.serebii.net/pokemonchampions/rankedbattle/regulation${id}.shtml`;
}

interface ScrapeResult {
  name: string;
  validFrom?: string;
  validTo?: string;
  // The reg page only lists what's NEWLY useable in this regulation (the delta). The full
  // legal roster is sourced separately from the Champions Pokédex index (see main()).
  newlyUseable: { name: string; notes?: string }[];
  listScope: string;
  // Every regulation ids, oldest first, from the page's own regulation selector — used to tell
  // whether the requested regulation is the current one (see the guard in main()).
  allRegulationIds: string[];
  warnings: string[];
}

// ── Page-specific parsing (the brittle bit — keep it isolated & commented) ──────
function parseRegulationPage(html: string, id: string): ScrapeResult {
  const $ = cheerio.load(html);
  const warnings: string[] = [];

  // Regulation display name comes from the <title> or the first heading.
  const heading = $('h1, h2').first().text().trim();
  const name = heading || `Regulation ${id.toUpperCase()}`;

  // Every regulation page carries the same selector listing all regulations in order
  // (<option value="/pokemonchampions/rankedbattle/regulationm-c.shtml">). Reading it tells us
  // which regulation is the newest — a source-of-truth signal the guard in main() relies on,
  // and sturdier than comparing dates (consecutive regulations share a boundary date, and
  // Serebii revises published end dates after the fact).
  const allRegulationIds: string[] = [];
  $('option').each((_, o) => {
    const m = ($(o).attr('value') || '').match(/\/rankedbattle\/regulation([a-z0-9-]+)\.shtml$/i);
    if (!m) return;
    const rid = m[1].toLowerCase();
    if (!allRegulationIds.includes(rid)) allRegulationIds.push(rid);
  });
  if (allRegulationIds.length === 0) {
    warnings.push('Could not read the regulation selector, so "is this the current regulation?" is unknown.');
  }

  // Date range: Serebii prints "June 17th 2026 - September 2nd 2026" in the Details block.
  // We scan the whole page text for that pattern and convert to ISO dates.
  const pageText = $('body').text().replace(/\s+/g, ' ');
  let validFrom: string | undefined;
  let validTo: string | undefined;
  const dateRange = pageText.match(
    /([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?\s+\d{4})\s*[-–]\s*([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?\s+\d{4})/,
  );
  if (dateRange) {
    validFrom = toISODate(dateRange[1]);
    validTo = toISODate(dateRange[2]);
  } else {
    warnings.push('Could not find a "<date> - <date>" range on the page.');
  }

  // Legal-Pokémon list. The Champions regulation page lists Pokémon in a class="tab"
  // table whose header row reads "No. Pic Name Type". We locate that table by its header
  // text, then pull each row's name from the cell that links to a /pokedex-champions/
  // entry. Names carry a trailing Japanese name we strip (keep the leading ASCII portion).
  const seen = new Set<string>();
  const newlyUseable: { name: string }[] = [];
  let listScope = 'newly-useable';

  const pokeTable = $('table.tab').filter((_, t) => {
    const header = $(t).find('tr').first().text().replace(/\s+/g, ' ').trim();
    return /No\.?\s*Pic\s*Name\s*Type/i.test(header) || /Name\s*Type/i.test(header);
  }).first();

  if (pokeTable.length === 0) {
    warnings.push('Could not find the Pokémon listing table (header "No. Pic Name Type").');
  } else {
    pokeTable.find('tr').each((_, row) => {
      // The name cell is the <td> that contains a non-image link to a pokedex entry
      // and has Latin letters.
      let cellText = '';
      $(row).find('td').each((_, td) => {
        const hasDexLink =
          $(td).find('a[href*="/pokedex-champions/"]').filter(
            (_, a) => !($(a).attr('href') || '').includes('.shtml'),
          ).length > 0;
        const txt = $(td).text().replace(/\s+/g, ' ').trim();
        if (hasDexLink && /[A-Za-z]/.test(txt) && !cellText) cellText = txt;
      });
      if (!cellText) return;
      // Drop the trailing Japanese name: keep everything up to the first non-ASCII char.
      const english = cellText.replace(/[^\x00-\x7F].*$/, '').trim();
      const key = english.toLowerCase();
      if (english && !seen.has(key)) {
        seen.add(key);
        newlyUseable.push({ name: english });
      }
    });
  }

  // The M-B page section is "Newly Useable Pokémon" — i.e. additions in THIS regulation,
  // not the full cumulative legal roster. Detect that heading so we record the scope
  // honestly and can warn downstream.
  if (/newly\s+useable\s+pok/i.test(pageText)) {
    listScope = 'newly-useable';
    warnings.push(
      'The page lists only NEWLY-useable Pokémon for this regulation, not the full ' +
        'cumulative legal roster. Pokémon legal since an earlier regulation will be absent.',
    );
  } else {
    listScope = 'unknown';
  }

  return { name, validFrom, validTo, newlyUseable, listScope, allRegulationIds, warnings };
}

// ── Full roster (the cumulative legal pool) from the Champions Pokédex index ─────
// The reg page only shows the delta. Game8 / the official site confirm the legal roster is
// "all Pokémon transferable via Pokémon HOME" = the entire Champions Pokédex. We read that
// roster from the dex index's <option value="/pokedex-champions/<slug>/">### Name</option>.
const DEX_INDEX_URL = 'https://www.serebii.net/pokedex-champions/';
// Keep in sync with SLUG_PATH in scrape-champions-dex.ts.
const SLUG_PATH = /^\/pokedex-champions\/[a-z0-9.'-]+\/$/;

async function fetchFullRoster(): Promise<{ name: string; num: number | null }[]> {
  const res = await fetch(DEX_INDEX_URL, {
    headers: { 'User-Agent': 'pokemon-champions-mcp scraper (personal use)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching dex index ${DEX_INDEX_URL}`);
  // Serebii serves ISO-8859-1; decode as latin1 to keep names intact.
  const html = Buffer.from(await res.arrayBuffer()).toString('latin1');
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: { name: string; num: number | null }[] = [];
  $('option').each((_, o) => {
    const val = $(o).attr('value') || '';
    // Slugs are lowercase but can contain an apostrophe or a period (farfetch'd, mr.mime,
    // sirfetch'd, mr.rime) — omitting those from the character class silently drops them
    // from the roster. The trailing `+` still rejects the empty "choose a Pokémon" option.
    if (!SLUG_PATH.test(val)) return;
    const text = $(o).text().replace(/\s+/g, ' ').trim(); // "003 Venusaur"
    const num = parseInt((text.match(/#?(\d+)/) || [])[1] || '', 10);
    const name = text.replace(/^#?\d+\s*/, '').trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      out.push({ name, num: Number.isFinite(num) ? num : null });
    }
  });
  return out;
}

// Forms excluded from this format even though their base species is legal. Serebii's reg
// page does not encode these, so we carry them explicitly (source: Game8 / official rules).
// Keyed by regulation id.
//
// To re-derive this list for a new regulation: collect every Mega form name in
// data/champions-dex.json and subtract the union of the "Newly Useable Pokémon" lists from all
// regulation pages so far. A Mega that exists in the dex but was never announced as useable is
// an exclusion candidate. For M-C that difference is EMPTY — the Z Megas that M-B excluded
// (Mega Garchomp Z, Mega Lucario Z) are on M-C's newly-useable list, hence no 'm-c' entry.
const KNOWN_EXCLUSIONS: Record<string, { name: string; notes: string }[]> = {
  'm-b': [
    { name: 'Mega Garchomp Z', notes: 'Excluded Mega form (base Garchomp is legal). Source: Game8.' },
    { name: 'Mega Lucario Z', notes: 'Excluded Mega form (base Lucario is legal). Source: Game8.' },
  ],
  // 'm-c': none — M-C newly enabled Mega Garchomp Z, Mega Lucario Z and Mega Absol Z.
};

function toISODate(human: string): string | undefined {
  // "June 17th 2026" -> "2026-06-17"
  const cleaned = human.replace(/(st|nd|rd|th)/g, '');
  const d = new Date(cleaned + ' UTC');
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

async function main() {
  const id = (process.argv[2] || '').trim().toLowerCase();
  if (!id) {
    console.error('Usage: npm run scrape -- <regulation-id>   (e.g. npm run scrape -- m-b)');
    process.exit(1);
  }

  const url = sourceUrl(id);
  console.error(`[scrape] Fetching ${url}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'pokemon-champions-mcp scraper (personal use)' },
  });
  if (!res.ok) {
    console.error(`[scrape] HTTP ${res.status} fetching ${url}. Aborting.`);
    process.exit(1);
  }
  const html = await res.text();

  const parsed = parseRegulationPage(html, id);
  for (const w of parsed.warnings) console.error(`[scrape] note: ${w}`);
  console.error(`[scrape] Reg page: ${parsed.newlyUseable.length} newly-useable Pokémon parsed.`);

  // The roster and item sources below are live pages showing the game AS IT IS TODAY, not as it
  // was during some past regulation. So this script can only faithfully scrape whichever
  // regulation is CURRENT — re-running it against a superseded one would overwrite that file
  // with today's larger roster/item catalog and silently make it wrong (e.g. re-scraping m-b
  // once m-c is out hands m-b all 231 of m-c's Pokémon). Refuse instead.
  //
  // "Current" = the newest regulation Serebii lists, not a date comparison: consecutive
  // regulations share a boundary date (m-b ends the same day m-c starts), and Serebii revises
  // published end dates after the fact, so dates can't distinguish the two.
  const newest = parsed.allRegulationIds[parsed.allRegulationIds.length - 1];
  if (newest && newest !== id) {
    console.error(
      '\n*************************************************************************\n' +
        `[scrape] REFUSING to write ${id}: ${newest} supersedes it.\n` +
        `         (Serebii lists: ${parsed.allRegulationIds.join(', ')}.)\n` +
        "         The roster and item catalog come from live pages reflecting TODAY'S game\n" +
        `         state, so re-scraping ${id} now would inflate its legal lists with the\n` +
        `         Pokémon and items ${newest} added. Run \`npm run scrape -- ${newest}\`\n` +
        `         instead, or hand-edit regulations/${id}.json if it needs a correction.\n` +
        '*************************************************************************\n',
    );
    process.exit(1);
  }

  // The full legal roster = the entire Champions Pokédex (all HOME-transferable Pokémon).
  console.error(`[scrape] Fetching full roster from ${DEX_INDEX_URL}`);
  const roster = await fetchFullRoster();
  const legalPokemon = roster.map((r) => ({ name: r.name }));
  console.error(`[scrape] Full roster: ${legalPokemon.length} Pokémon.`);

  // Legal held items = the Champions held-item catalog (Hold Items + Mega Stones + Berries).
  // Item legality is regulation-scoped, but Champions publishes no per-regulation item bans,
  // so the legal pool for this regulation is the full held-item catalog. We reuse the items
  // scraper to source it (see scrape-champions-items.ts).
  console.error(`[scrape] Fetching held-item catalog from ${ITEMS_URL}`);
  let legalItems: { name: string }[] = [];
  try {
    const { items, warnings } = await scrapeItems();
    for (const w of warnings) console.error(`[scrape] item note: ${w}`);
    legalItems = items.filter((i) => i.held).map((i) => ({ name: i.name }));
    console.error(`[scrape] Held-item catalog: ${legalItems.length} legal items.`);
    if (legalItems.length < 50) {
      console.error(
        `[scrape] WARNING: only ${legalItems.length} held items parsed — the items page markup ` +
          `may have changed. Writing what was found; PLEASE VERIFY.`,
      );
    }
  } catch (err) {
    console.error(
      `[scrape] WARNING: failed to fetch held items (${(err as Error).message}). ` +
        `Writing the regulation WITHOUT a legalItems list; item-legality checks will be unavailable.`,
    );
  }

  // Defensiveness: loud warning if either source looks suspiciously thin, but still write.
  if (legalPokemon.length < 50) {
    console.error(
      '\n*************************************************************************\n' +
        `[scrape] WARNING: only ${legalPokemon.length} Pokémon in the full roster. The dex\n` +
        '         index may have changed format. Writing what was found anyway —\n' +
        '         PLEASE VERIFY against the source before trusting it.\n' +
        '*************************************************************************\n',
    );
  }

  const bannedPokemon = KNOWN_EXCLUSIONS[id] ?? [];

  const notes =
    'legalPokemon is the full Champions Pokédex (all Pokémon transferable via Pokémon ' +
    'HOME), which is the legal pool for this regulation; per the official rules there are ' +
    'no Restricted Pokémon. bannedPokemon lists specific Mega forms excluded from this ' +
    'format (their base species remain legal). newlyUseable (in meta) is what this ' +
    'regulation newly added. No per-move legality is published, so legalMoves is omitted ' +
    'and move-legality checks are unavailable for this regulation. legalItems is the full ' +
    'Champions held-item catalog (Hold Items, Mega Stones, Berries); the format publishes no ' +
    'per-item bans, so bannedItems is empty.';

  const output = {
    meta: {
      id,
      name: parsed.name,
      game: 'Pokémon Champions',
      validFrom: parsed.validFrom,
      validTo: parsed.validTo,
      source: url,
      rosterSource: DEX_INDEX_URL,
      itemSource: ITEMS_URL,
      scrapedAt: new Date().toISOString(),
      listScope: 'full-roster',
      // What this regulation newly introduced (from the reg page) — handy context.
      newlyUseable: parsed.newlyUseable.map((p) => p.name),
    },
    legalPokemon,
    // legalMoves intentionally omitted: the source has no per-move legality data.
    // legalItems omitted entirely if the held-item fetch failed, so item-legality checks
    // report "unavailable" rather than falsely claiming everything is illegal.
    ...(legalItems.length > 0 ? { legalItems } : {}),
    bannedPokemon,
    bannedItems: [] as { name: string; notes: string }[],
    notes,
  };

  mkdirSync(REGULATIONS_DIR, { recursive: true });
  const outFile = join(REGULATIONS_DIR, `${id}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(
    `[scrape] Wrote ${outFile} — ${legalPokemon.length} legal, ${bannedPokemon.length} banned, ` +
      `${legalItems.length} legal items, ` +
      `${parsed.newlyUseable.length} newly-useable, dates ${parsed.validFrom ?? '?'}..${parsed.validTo ?? '?'}.`,
  );
}

main().catch((err) => {
  console.error('[scrape] fatal:', err);
  process.exit(1);
});
