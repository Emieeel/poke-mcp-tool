/**
 * scrape-champions-moves.ts — builds the Pokémon CHAMPIONS move data from Serebii.
 *
 *   npm run scrape:moves
 *
 * WHY THIS EXISTS: @smogon/calc's Champions generation has what a damage calc needs, but no
 * move descriptions, accuracy or PP, and no record of what Champions changed from
 * Scarlet/Violet. Move flags (contact, sound, ...) are NOT scraped: the engine has them, and
 * where Serebii disagrees the engine is the more accurate one.
 *
 * This is an on-demand script. The MCP server never runs it; it only reads the JSON output.
 *
 * SOURCES (three pages):
 *   - pokemonchampions/moves.shtml            "Useable Moves": every move usable in Champions
 *                                             with its type, category, PP, power, accuracy and
 *                                             in-game description.
 *   - pokemonchampions/updatedattacks.shtml   every move Champions rebalanced, Champions vs S/V.
 *   - pokemonchampions/statusconditions.shtml the status conditions Champions changed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const BASE = 'https://www.serebii.net/pokemonchampions';
const USABLE_URL = `${BASE}/moves.shtml`;
const UPDATED_URL = `${BASE}/updatedattacks.shtml`;
const STATUS_URL = `${BASE}/statusconditions.shtml`;

const UA = 'pokemon-champions-mcp moves scraper (personal use)';

type Category = 'Physical' | 'Special' | 'Status';

/** The numbers Serebii lists per move; also one side of a Champions-vs-S/V change. */
interface MoveNumbers {
  type: string;
  category: Category;
  pp: number | null;
  /** null for moves without a fixed power (status moves, Grass Knot, Heavy Slam, ...). */
  basePower: number | null;
  /** null when the move never misses. */
  accuracy: number | null;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // Serebii serves ISO-8859-1; decode as latin1 to keep names intact.
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('latin1');
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * A table as a grid with rowspan/colspan expanded, so every row has a cell in every column.
 * Serebii merges a cell across rows when the value is the same in both.
 */
function tableGrid($: cheerio.CheerioAPI, table: AnyNode): AnyNode[][] {
  const grid: AnyNode[][] = [];
  $(table).find('tr').each((r, tr) => {
    grid[r] ??= [];
    let c = 0;
    $(tr).children('td,th').each((_, cell) => {
      while (grid[r][c]) c++;
      const rowspan = parseInt($(cell).attr('rowspan') || '1', 10);
      const colspan = parseInt($(cell).attr('colspan') || '1', 10);
      for (let dr = 0; dr < rowspan; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < colspan; dc++) grid[r + dr][c + dc] = cell;
      }
      c += colspan;
    });
  });
  return grid;
}

/**
 * Type, category, PP, power and accuracy from cells laid out as Type | Cat | PP | Power | Acc.
 * Type and category are images (type/water.gif, type/special.png). Serebii writes "--" for
 * no value, 101 for "never misses" and 1 as the power of variable-power moves.
 */
function readNumbers($: cheerio.CheerioAPI, cells: AnyNode[]): MoveNumbers {
  const img = (cell: AnyNode, ext: string) =>
    ($(cell).find('img').attr('src') || '').match(new RegExp(`type/([a-z]+)\\.${ext}$`))?.[1] ?? '';
  const num = (cell: AnyNode) => {
    const n = parseInt(clean($(cell).text()), 10);
    return Number.isFinite(n) ? n : null;
  };
  const type = img(cells[0], 'gif');
  const categories: Record<string, Category> = { physical: 'Physical', special: 'Special', other: 'Status' };
  const power = num(cells[3]);
  const accuracy = num(cells[4]);
  return {
    type: type.charAt(0).toUpperCase() + type.slice(1),
    category: categories[img(cells[1], 'png')] ?? 'Status',
    pp: num(cells[2]),
    basePower: power !== null && power > 1 ? power : null,
    accuracy: accuracy !== null && accuracy <= 100 ? accuracy : null,
  };
}

/** "Useable Moves" rows: Name | Type | Cat | PP | Base Power | Accuracy | Effect. */
function parseUsableMoves(html: string) {
  const $ = cheerio.load(html);
  const moves: Record<string, MoveNumbers & { name: string; description: string }> = {};
  $('table.tab tr').each((_, tr) => {
    const cells = $(tr).children('td').toArray();
    const name = clean($(cells[0]).find('a[href^="/attackdex-champions/"]').text());
    if (!name || cells.length < 7) return;
    moves[name] = { name, ...readNumbers($, cells.slice(1, 6)), description: clean($(cells[6]).text()) };
  });
  return moves;
}

/**
 * "Updated Attacks": two rows per move, "Champions" then "S/V", columns Name | Game | Type |
 * Cat | PP | Base Power | Accuracy | Effect | Effect Chance.
 */
function parseUpdatedAttacks(html: string) {
  type Side = MoveNumbers & { effectChance: number | null };
  const $ = cheerio.load(html);
  const changes: Record<string, { champions: Side; scarletViolet: Side }> = {};
  const table = $('table').filter((_, t) => $(t).find('a[href^="/attackdex-champions/"]').length > 0).first().get(0);
  if (!table) return changes;
  const grid = tableGrid($, table);
  const side = (row: AnyNode[]): Side => ({
    ...readNumbers($, row.slice(2, 7)),
    effectChance: parseInt(clean($(row[8]).text()), 10) || null,
  });
  for (let r = 0; r + 1 < grid.length; r++) {
    if (clean($(grid[r][1]).text()) !== 'Champions') continue;
    changes[clean($(grid[r][0]).text())] = { champions: side(grid[r]), scarletViolet: side(grid[r + 1]) };
  }
  return changes;
}

/** "Changed Status Conditions" rows: Condition | Prior Effect | New Effect (one rule per line). */
function parseStatusConditions(html: string) {
  const $ = cheerio.load(html);
  const lines = (cell: AnyNode) =>
    ($(cell).html() || '')
      .split(/<br\s*\/?>/i)
      .map((part) => clean(cheerio.load(part).text()).replace(/\.$/, ''))
      .filter(Boolean)
      .join('; ');
  const out: { condition: string; scarletViolet: string; champions: string }[] = [];
  $('table.dextable tr').slice(1).each((_, tr) => {
    const cells = $(tr).children('td').toArray();
    if (cells.length === 3) {
      out.push({ condition: clean($(cells[0]).text()), scarletViolet: lines(cells[1]), champions: lines(cells[2]) });
    }
  });
  return out;
}

async function main() {
  const moves = parseUsableMoves(await fetchText(USABLE_URL));
  const changesFromScarletViolet = parseUpdatedAttacks(await fetchText(UPDATED_URL));
  const statusConditions = parseStatusConditions(await fetchText(STATUS_URL));

  // Refuse to write a half-parsed file if the pages changed shape.
  const problems: string[] = [];
  if (Object.keys(moves).length < 400) problems.push(`only ${Object.keys(moves).length} usable moves found`);
  if (Object.keys(changesFromScarletViolet).length === 0) problems.push('no changed moves found');
  if (statusConditions.length === 0) problems.push('no changed status conditions found');
  for (const m of Object.values(moves)) if (!m.type) problems.push(`${m.name}: type unreadable`);
  if (problems.length) {
    for (const p of problems) console.error(`[moves] PROBLEM: ${p}`);
    process.exit(1);
  }

  const output = {
    meta: {
      game: 'Pokémon Champions',
      sources: [USABLE_URL, UPDATED_URL, STATUS_URL],
      scrapedAt: new Date().toISOString(),
      count: Object.keys(moves).length,
    },
    moves,
    changesFromScarletViolet,
    statusConditions,
  };
  mkdirSync(DATA_DIR, { recursive: true });
  const outFile = join(DATA_DIR, 'champions-moves.json');
  writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[moves] Wrote ${outFile} — ${output.meta.count} moves, ` +
    `${Object.keys(changesFromScarletViolet).length} changed from S/V, ${statusConditions.length} status changes.`);
}

main().catch((err) => {
  console.error('[moves] fatal:', err);
  process.exit(1);
});
