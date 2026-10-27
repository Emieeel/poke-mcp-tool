/**
 * scrape-champions-moves.ts — builds the Pokémon CHAMPIONS move data from Serebii.
 *
 *   npm run scrape:moves                 # every usable move (one page each, throttled)
 *   npm run scrape:moves -- snipeshot    # just one or more move slugs (for testing)
 *
 * WHY THIS EXISTS: @smogon/calc's Champions generation has each move's power, type, category
 * and flags (enough for damage), but no effect text, effect chance, accuracy, PP or priority,
 * and no record of what Champions changed from Scarlet/Violet. Those are what a player asks
 * about, so we source them from Serebii.
 *
 * This is an on-demand script. The MCP server never runs it; it only reads the JSON output.
 *
 * SOURCES (the page-specific parsing is isolated in the parse* functions):
 *   - pokemonchampions/moves.shtml          "Useable Moves": every move usable in Champions.
 *   - attackdex-champions/<slug>.shtml      one page per move: effect, effect chance, crit
 *                                           rate, priority, target, and the move flags.
 *   - pokemonchampions/updatedattacks.shtml every move Champions rebalanced, Champions vs S/V.
 *   - pokemonchampions/statusconditions.shtml  the status conditions Champions changed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const BASE = 'https://www.serebii.net';
const USABLE_URL = `${BASE}/pokemonchampions/moves.shtml`;
const UPDATED_URL = `${BASE}/pokemonchampions/updatedattacks.shtml`;
const STATUS_URL = `${BASE}/pokemonchampions/statusconditions.shtml`;
const moveUrl = (slug: string) => `${BASE}/attackdex-champions/${slug}.shtml`;

const UA = 'pokemon-champions-mcp moves scraper (personal use)';

export type Category = 'Physical' | 'Special' | 'Status';

export interface MoveFlags {
  contact: boolean;
  sound: boolean;
  punch: boolean;
  bite: boolean;
  slicing: boolean;
  bullet: boolean;
  wind: boolean;
  powder: boolean;
  snatchable: boolean;
  metronome: boolean;
  affectedByGravity: boolean;
  defrostsUser: boolean;
  reflectable: boolean;
  blockedByProtect: boolean;
  copyableByMirrorMove: boolean;
}

export interface ChampionsMove {
  name: string;
  slug: string;
  type: string;
  category: Category;
  pp: number | null;
  /** null for moves without a fixed power ("--": status moves, Grass Knot, ...). */
  basePower: number | null;
  /** null when the move never misses (Serebii writes 101 or "--"). */
  accuracy: number | null;
  effect: string;
  /** Chance of the secondary effect in percent, or null when the move has none. */
  effectChance: number | null;
  /** Critical-hit stage (0 = 1/24, 1 = 1/8, 2 = 1/2, 3+ = always), or null if unreadable. */
  critStage: number | null;
  priority: number;
  target: string;
  flags: MoveFlags;
}

export interface MoveChange {
  effect: string;
  champions: ChangeRow;
  scarletViolet: ChangeRow;
}
interface ChangeRow {
  type: string;
  category: Category;
  pp: number | null;
  basePower: number | null;
  accuracy: number | null;
  effectChance: number | null;
}

export interface StatusConditionChange {
  condition: string;
  scarletViolet: string;
  champions: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // Serebii serves ISO-8859-1; decode as latin1 to keep names intact.
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('latin1');
}

// ── Shared helpers ──────────────────────────────────────────────────────────────

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** "16" -> 16; "--", "", "-- %" -> null. */
function num(s: string): number | null {
  const n = parseInt(s.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// Type and category are images: /pokedex-bw/type/water.gif, /pokedex-bw/type/special.png.
const CATEGORIES: Record<string, Category> = { physical: 'Physical', special: 'Special', other: 'Status' };
function typeOf($: cheerio.CheerioAPI, cell: AnyNode | undefined): string {
  const m = ($(cell).find('img').attr('src') || '').match(/type\/([a-z]+)\.gif$/);
  return m ? cap(m[1]) : '';
}
function categoryOf($: cheerio.CheerioAPI, cell: AnyNode | undefined): Category | undefined {
  const m = ($(cell).find('img').attr('src') || '').match(/type\/([a-z]+)\.png$/);
  return m ? CATEGORIES[m[1]] : undefined;
}

/**
 * A table as a grid of cells with rowspan/colspan expanded, so every row has a value in every
 * column. Serebii merges a cell across rows whenever the value is the same (e.g. the type of a
 * move whose type didn't change), and reading rows naively shifts every later column.
 */
function tableGrid($: cheerio.CheerioAPI, table: AnyNode): AnyNode[][] {
  const grid: AnyNode[][] = [];
  $(table).children('tbody').add($(table)).children('tr').each((r, tr) => {
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

// ── Useable Moves page ─────────────────────────────────────────────────────────

/** Rows: Name | Type | Cat | PP | Base Power | Accuracy | Effect. */
export function parseUsableMoves(html: string): { name: string; slug: string }[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: { name: string; slug: string }[] = [];
  $('table.tab tr').each((_, tr) => {
    const a = $(tr).children('td').first().find('a[href^="/attackdex-champions/"]').first();
    const m = (a.attr('href') || '').match(/^\/attackdex-champions\/([a-z0-9-]+)\.shtml$/);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    out.push({ name: clean(a.text()), slug: m[1] });
  });
  return out;
}

// ── Per-move page ──────────────────────────────────────────────────────────────

// Serebii flag headers (with " - Details" links and trailing "?" removed) -> our flag names.
const FLAG_HEADERS: Record<string, keyof MoveFlags> = {
  'Physical Contact': 'contact',
  'Sound-Type': 'sound',
  'Punch Move': 'punch',
  'Biting Move': 'bite',
  'Slicing Move': 'slicing',
  'Bullet-Type': 'bullet',
  'Wind Move': 'wind',
  'Powder Move': 'powder',
  Snatchable: 'snatchable',
  Metronome: 'metronome',
  'Affected by Gravity': 'affectedByGravity',
  'Defrosts When Used': 'defrostsUser',
  'Reflected By Magic Coat/Magic Bounce': 'reflectable',
  'Blocked by Protect/Detect': 'blockedByProtect',
  'Copyable by Mirror Move': 'copyableByMirrorMove',
};

// Serebii's crit rate column, as the stage it stands for.
const CRIT_STAGES: Record<string, number> = { '4.17%': 0, '12.5%': 1, '50%': 2, '100%': 3 };

export function parseMovePage(html: string, slug: string, warnings: string[]): ChampionsMove {
  const $ = cheerio.load(html);
  // The data lives in two dextables: the first (stats/effects) and the flags table, which some
  // pages (Heavy Slam, Fling, ...) push down with an extra table in between. Both are laid out
  // as a row of header cells (td.fooevo) followed by a row of values in the same columns.
  const all = $('table.dextable').toArray();
  const flagsTable = all.find((t) => clean($(t).find('td').first().text()) === 'Physical Contact');
  const tables = [all[0], flagsTable].filter((t): t is AnyNode => Boolean(t));
  const values = new Map<string, AnyNode>();
  let effect = '';
  let inDepthEffect = '';
  let secondaryEffect = '';
  let effectRate = '';
  for (const table of tables) {
    const grid = tableGrid($, table);
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      const label = clean($(row[0]).text());
      if (label === 'Battle Effect:') {
        effect = clean($(grid[r + 1]?.[0]).text());
        continue;
      }
      if (label === 'In-Depth Effect:') {
        inDepthEffect = clean($(grid[r + 1]?.[0]).text());
        continue;
      }
      if (label === 'Secondary Effect:') {
        secondaryEffect = clean($(grid[r + 1]?.[0]).text());
        effectRate = clean($(grid[r + 1]?.[row.length - 1]).text());
        continue;
      }
      if (!row.every((cell) => $(cell).hasClass('fooevo'))) continue;
      const next = grid[r + 1];
      if (!next) continue;
      row.forEach((cell, c) => {
        const header = clean($(cell).text()).replace(/\s*-\s*Details$/, '').replace(/\?$/, '').trim();
        if (header && !values.has(header)) values.set(header, next[c]);
      });
    }
  }

  const text = (header: string) => clean($(values.get(header)).text());
  const name = clean(($(values.get('Attack Name')).contents().first().text())) || slug;
  const flags = {} as MoveFlags;
  for (const [header, flag] of Object.entries(FLAG_HEADERS)) {
    const v = text(header);
    if (v !== 'Yes' && v !== 'No') warnings.push(`${slug}: flag "${header}" unreadable ("${v}")`);
    flags[flag] = v === 'Yes';
  }
  const category = categoryOf($, values.get('Category'));
  if (!category) warnings.push(`${slug}: category unreadable`);
  const type = typeOf($, values.get('Battle Type'));
  if (!type) warnings.push(`${slug}: type unreadable`);
  // Status moves can't crit; Serebii writes "None" for them.
  const critText = text('Base Critical Hit Rate');
  const critStage = CRIT_STAGES[critText] ?? null;
  if (critStage === null && critText !== 'None') warnings.push(`${slug}: crit rate "${critText}" not recognized`);
  const accuracy = num(text('Accuracy'));

  return {
    name,
    slug,
    type,
    category: category ?? 'Status',
    pp: num(text('Power Points')),
    // Serebii lists variable-power moves (Heavy Slam, Fling, ...) as 1 and status moves as 0.
    basePower: ((bp) => (bp !== null && bp > 1 ? bp : null))(num(text('Base Power'))),
    accuracy: accuracy === null || accuracy > 100 ? null : accuracy,
    // Serebii repeats the battle effect as the "secondary effect" for some moves; keep it once.
    effect: [effect, inDepthEffect, secondaryEffect].filter((s, i, all) => s && all.indexOf(s) === i).join(' '),
    effectChance: num(effectRate) || null,
    critStage,
    priority: num(text('Speed Priority')) ?? 0,
    target: text('Pokémon Hit in Battle'),
    flags,
  };
}

// ── Updated Attacks page ───────────────────────────────────────────────────────

/**
 * One table, two rows per move: "Champions" then "S/V". Columns: Name | Game | Type | Cat |
 * PP | Base Power | Accuracy | Effect | Effect Chance. Name and Effect span both rows, and so
 * does any other cell whose value didn't change.
 */
export function parseUpdatedAttacks(html: string, warnings: string[]): Record<string, MoveChange> {
  const $ = cheerio.load(html);
  const out: Record<string, MoveChange> = {};
  const table = $('table.dextable, table.tab')
    .filter((_, t) => $(t).find('a[href^="/attackdex-champions/"]').length > 0)
    .first()
    .get(0);
  if (!table) {
    warnings.push('Updated Attacks: table not found');
    return out;
  }
  const grid = tableGrid($, table);
  const rowOf = (row: AnyNode[]): ChangeRow => ({
    type: typeOf($, row[2]),
    category: categoryOf($, row[3]) ?? 'Status',
    pp: num(clean($(row[4]).text())),
    basePower: num(clean($(row[5]).text())),
    accuracy: ((a) => (a === null || a > 100 ? null : a))(num(clean($(row[6]).text()))),
    effectChance: num(clean($(row[8]).text())) || null,
  });
  for (let r = 0; r + 1 < grid.length; r++) {
    const row = grid[r];
    if (clean($(row[1]).text()) !== 'Champions') continue;
    const sv = grid[r + 1];
    if (clean($(sv[1]).text()) !== 'S/V') {
      warnings.push(`Updated Attacks: no S/V row after ${clean($(row[0]).text())}`);
      continue;
    }
    const name = clean($(row[0]).text());
    out[name] = { effect: clean($(row[7]).text()), champions: rowOf(row), scarletViolet: rowOf(sv) };
  }
  return out;
}

// ── Changed Status Conditions page ─────────────────────────────────────────────

/** Rows: Condition | Prior Effect | New Effect, with one rule per line (<br>) in a cell. */
export function parseStatusConditions(html: string, warnings: string[]): StatusConditionChange[] {
  const $ = cheerio.load(html);
  const out: StatusConditionChange[] = [];
  const lines = (cell: AnyNode) =>
    ($(cell).html() || '')
      .split(/<br\s*\/?>/i)
      .map((part) => clean(cheerio.load(part).text()).replace(/\.$/, ''))
      .filter(Boolean)
      .join('; ');
  $('table.dextable, table.tab').each((_, t) => {
    const grid = tableGrid($, t);
    const header = (grid[0] ?? []).map((c) => clean($(c).text()));
    if (header[0] !== 'Condition' || header[2] !== 'New Effect') return;
    for (const row of grid.slice(1)) {
      const cells = row.map(lines);
      if (cells[0]) out.push({ condition: cells[0], scarletViolet: cells[1], champions: cells[2] });
    }
  });
  if (out.length === 0) warnings.push('Changed Status Conditions: table not found');
  return out;
}

// ── main ───────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const warnings: string[] = [];

  let list: { name: string; slug: string }[];
  if (args.length > 0) {
    list = args.map((slug) => ({ name: slug, slug }));
  } else {
    console.error(`[moves] Fetching usable moves: ${USABLE_URL}`);
    list = parseUsableMoves(await fetchText(USABLE_URL));
    console.error(`[moves] ${list.length} usable moves. Fetching each page (throttled)…`);
  }

  const moves: Record<string, ChampionsMove> = {};
  let i = 0;
  for (const { slug } of list) {
    i++;
    try {
      const move = parseMovePage(await fetchText(moveUrl(slug)), slug, warnings);
      moves[slug] = move;
      if (i % 50 === 0 || args.length > 0) {
        console.error(`[moves] (${i}/${list.length}) ${move.name}: ${move.type} ${move.category} ` +
          `${move.basePower ?? '--'} BP, crit stage ${move.critStage}, ${move.target}`);
      }
    } catch (err) {
      warnings.push(`${slug}: ${(err as Error).message}`);
    }
    // Be polite to Serebii.
    if (args.length === 0) await sleep(200);
  }

  const changes = parseUpdatedAttacks(await fetchText(UPDATED_URL), warnings);
  const statusConditions = parseStatusConditions(await fetchText(STATUS_URL), warnings);

  const output = {
    meta: {
      game: 'Pokémon Champions',
      source: USABLE_URL,
      changesSource: UPDATED_URL,
      statusSource: STATUS_URL,
      scrapedAt: new Date().toISOString(),
      count: Object.keys(moves).length,
      note:
        'Champions move data scraped from Serebii: every usable move with its effect, effect ' +
        'chance, accuracy, PP, priority, target and flags; the moves Champions rebalanced ' +
        '(Champions vs Scarlet/Violet); and the status conditions it changed.',
    },
    moves,
    changesFromScarletViolet: changes,
    statusConditions,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  // For single-slug test runs, don't clobber the full file — write a preview instead.
  const outFile = join(DATA_DIR, args.length > 0 ? 'champions-moves.sample.json' : 'champions-moves.json');
  writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[moves] Wrote ${outFile} — ${output.meta.count} moves, ` +
    `${Object.keys(changes).length} changed from S/V, ${statusConditions.length} status changes.`);
  if (warnings.length) {
    console.error(`[moves] ${warnings.length} warning(s):`);
    for (const w of warnings) console.error('   - ' + w);
  }
}

main().catch((err) => {
  console.error('[moves] fatal:', err);
  process.exit(1);
});
