/**
 * scrape-champions-items.ts — builds the Pokémon CHAMPIONS held-item catalog from Serebii.
 *
 *   npm run scrape:items
 *
 * WHY THIS EXISTS: @smogon/calc's item data has no effect text, no "how to obtain" info and
 * no categories, so we source the Champions item catalog from Serebii's Champions items page,
 * like the dex.
 *
 * This is an on-demand script. The MCP server never runs it; it only reads the JSON output.
 *
 * SOURCE LAYOUT (the brittle, page-specific part — isolated in parseItemsPage()):
 * https://www.serebii.net/pokemonchampions/items.shtml is four `table.dextable` tables in
 * document order — "Hold Items", "Mega Stone", "Berries", "Miscellaneous Items" — each with
 * columns: Picture | Name | Effect | Location. The first three are HELD items (a Pokémon can
 * hold them in battle); "Miscellaneous Items" are tickets/coupons that are NOT held, so we
 * record them with held=false and exclude them from the held-item catalog.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
export const ITEMS_URL = 'https://www.serebii.net/pokemonchampions/items.shtml';

const UA = 'pokemon-champions-mcp items scraper (personal use)';

// The four sections of the page, in document order. `held` marks whether a Pokémon can
// actually hold items in this category during battle.
type Category = 'Hold Item' | 'Mega Stone' | 'Berry' | 'Miscellaneous';
const SECTIONS: { heading: RegExp; category: Category; held: boolean }[] = [
  { heading: /^hold items$/i, category: 'Hold Item', held: true },
  { heading: /^mega stone/i, category: 'Mega Stone', held: true },
  { heading: /^berries$/i, category: 'Berry', held: true },
  { heading: /^miscellaneous/i, category: 'Miscellaneous', held: false },
];

export interface Item {
  name: string;
  category: Category;
  /** Whether a Pokémon can hold this item in battle (false for Miscellaneous tickets). */
  held: boolean;
  /** Serebii's effect/description text. */
  effect: string;
  /** How to obtain it in Champions, e.g. "Shop, 700 VP" or "Beginning". */
  location: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // Serebii serves ISO-8859-1; decode as latin1 to keep names/accents intact.
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('latin1');
}

// ── Page-specific parsing (the brittle bit — keep it isolated & commented) ──────
export function parseItemsPage(html: string): { items: Item[]; warnings: string[] } {
  const $ = cheerio.load(html);
  const warnings: string[] = [];
  const items: Item[] = [];
  const seen = new Set<string>();

  // Each section is a `table.dextable` (columns "Picture | Name | Effect | Location")
  // introduced by an underlined-bold heading (<b><u>Hold Items</u></b>). Selecting both in
  // ONE combined selector yields them in document order, so we just walk the sequence and
  // attribute each table to the most recent heading — sturdier than relying on table position
  // if the page ever reorders or inserts a section.
  let section: (typeof SECTIONS)[number] | undefined;
  $('b u, table.dextable').each((_, el) => {
    if (isHeading(el)) {
      const heading = $(el).text().replace(/\s+/g, ' ').trim();
      section = SECTIONS.find((s) => s.heading.test(heading));
      return;
    }
    // It's a table. Skip any dextable not under a recognized section heading.
    if (!section) {
      warnings.push('Skipped a dextable with no recognized preceding section heading.');
      return;
    }
    const sec = section;

    const rows = $(el).find('tr');
    // Verify the header row looks like the expected Name/Effect/Location layout.
    const header = $(rows[0]).find('td,th').map((_, c) => cellText($, c)).get();
    const nameCol = header.findIndex((h) => /^name$/i.test(h));
    const effectCol = header.findIndex((h) => /^effect$/i.test(h));
    const locCol = header.findIndex((h) => /^location$/i.test(h));
    if (nameCol < 0) {
      warnings.push(`"${sec.category}" table header had no "Name" column: ${JSON.stringify(header)}.`);
      return;
    }

    rows.slice(1).each((_, row) => {
      const cells = $(row).find('td');
      const name = cellText($, cells[nameCol]);
      if (!name || !/[A-Za-z]/.test(name)) return; // skip spacer/empty rows
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        name,
        category: sec.category,
        held: sec.held,
        effect: effectCol >= 0 ? cellText($, cells[effectCol]) : '',
        location: cleanLocation(locCol >= 0 ? cellText($, cells[locCol]) : ''),
      });
    });
  });

  return { items, warnings };
}

function isHeading(el: AnyNode): boolean {
  return Boolean((el as any).tagName) && (el as any).tagName.toLowerCase() === 'u';
}

function cellText($: cheerio.CheerioAPI, el: AnyNode | undefined): string {
  if (!el) return '';
  return $(el).text().replace(/\s+/g, ' ').trim();
}

// Serebii concatenates the location with its cost, e.g. "Shop700 VP" -> "Shop, 700 VP".
// Insert a separator where a letter abuts a digit so the field reads cleanly.
function cleanLocation(loc: string): string {
  return loc.replace(/([A-Za-z])(\d)/g, '$1, $2').trim();
}

/**
 * Fetch + parse the Champions items page. Exported so the regulation scraper can reuse it to
 * populate a regulation's legal held-item list without duplicating the fetch/parse logic.
 */
export async function scrapeItems(): Promise<{ items: Item[]; warnings: string[] }> {
  const html = await fetchText(ITEMS_URL);
  return parseItemsPage(html);
}

async function main() {
  console.error(`[items] Fetching ${ITEMS_URL}`);
  const { items, warnings } = await scrapeItems();
  for (const w of warnings) console.error(`[items] note: ${w}`);

  const heldCount = items.filter((i) => i.held).length;
  const byCategory = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.category] = (acc[i.category] ?? 0) + 1;
    return acc;
  }, {});
  console.error(`[items] Parsed ${items.length} items (${heldCount} held): ${JSON.stringify(byCategory)}`);

  // Defensiveness: a freshly published page or a markup change may yield very little. Warn
  // loudly but still write what we found (matching the regulation scraper's behavior).
  if (heldCount < 50) {
    console.error(
      '\n*************************************************************************\n' +
        `[items] WARNING: only ${heldCount} held items parsed. The page markup may have\n` +
        '         changed. Writing what was found anyway — PLEASE VERIFY against the\n' +
        '         source before trusting it.\n' +
        '*************************************************************************\n',
    );
  }

  const output = {
    meta: {
      game: 'Pokémon Champions',
      source: ITEMS_URL,
      scrapedAt: new Date().toISOString(),
      count: items.length,
      heldCount,
      byCategory,
      note:
        'Champions held-item catalog scraped from Serebii. Hold Items, Mega Stones, and ' +
        'Berries are items a Pokémon can hold in battle (held=true); Miscellaneous tickets ' +
        'are not held (held=false). @smogon/calc\'s item data has no effect/location text, ' +
        'which is why we source this ourselves.',
    },
    // Keyed by lowercased name for stable, greppable diffs.
    items: items.reduce<Record<string, Item>>((acc, i) => {
      acc[i.name.toLowerCase()] = i;
      return acc;
    }, {}),
  };

  mkdirSync(DATA_DIR, { recursive: true });
  const outFile = join(DATA_DIR, 'champions-items.json');
  writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[items] Wrote ${outFile} — ${items.length} items (${heldCount} held).`);
}

// Only run when executed directly (not when imported by the regulation scraper or a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[items] fatal:', err);
    process.exit(1);
  });
}
