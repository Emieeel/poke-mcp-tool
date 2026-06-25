/**
 * items.ts — Pokémon CHAMPIONS held-item catalog lookups.
 *
 * Source of truth is data/champions-items.json, scraped from Serebii's Champions items page
 * (see scripts/scrape-champions-items.ts). We use THIS instead of @smogon/calc's bundled item
 * list because @smogon/calc ships a MAINLINE item set with no Champions effect text, no
 * "how to obtain" info, and no notion of which items even exist in Champions.
 *
 * If the Champions items file is missing or doesn't contain a requested item, we fall back to
 * @smogon/calc's bundled item list so the tool still answers (flagging the source).
 *
 * NOTE: this module only knows the item *catalog* (what items exist + their facts). Which
 * items are LEGAL in a given regulation is regulation data — see regulations.ts.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gen } from './calc.js';
import { toID } from '@smogon/calc';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/items.js -> ../data ; src/items.ts -> ../data
const ITEMS_FILE = join(__dirname, '..', 'data', 'champions-items.json');

export type ItemCategory = 'Hold Item' | 'Mega Stone' | 'Berry' | 'Miscellaneous';

interface RawItem {
  name: string;
  category: ItemCategory;
  held: boolean;
  effect: string;
  location: string;
}
interface RawItemsFile {
  meta: { source?: string; scrapedAt?: string; count?: number; heldCount?: number };
  items: Record<string, RawItem>;
}

export interface ItemInfo {
  name: string;
  category: ItemCategory | 'Unknown';
  /** Whether a Pokémon can hold this item in battle (false for non-held items like tickets). */
  held: boolean;
  effect: string;
  location: string;
  source: 'champions-items' | 'smogon-calc';
}

// Canonical key for matching item names across spacing/casing/hyphens, e.g. "Choice Scarf",
// "choice-scarf", and "choicescarf" all collapse to "choicescarf".
export function itemKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Lazily build a name -> item index from the Champions items file so lookups are O(1) and
// tolerant of naming conventions.
let indexCache:
  | { byKey: Map<string, RawItem>; all: RawItem[]; meta: RawItemsFile['meta'] }
  | null
  | undefined;

function loadIndex() {
  if (indexCache !== undefined) return indexCache;
  if (!existsSync(ITEMS_FILE)) {
    console.error(
      `[items] ${ITEMS_FILE} not found — falling back to @smogon/calc data. ` +
        `Run \`npm run scrape:items\` to build the Champions item catalog.`,
    );
    indexCache = null;
    return indexCache;
  }
  try {
    const raw = JSON.parse(readFileSync(ITEMS_FILE, 'utf8')) as RawItemsFile;
    const byKey = new Map<string, RawItem>();
    const all: RawItem[] = [];
    for (const item of Object.values(raw.items)) {
      const key = itemKey(item.name);
      if (!byKey.has(key)) byKey.set(key, item);
      all.push(item);
    }
    indexCache = { byKey, all, meta: raw.meta };
  } catch (err) {
    console.error(`[items] Failed to read ${ITEMS_FILE}: ${(err as Error).message}. Falling back.`);
    indexCache = null;
  }
  return indexCache;
}

/** Source URL + timestamp for the Champions item catalog, if loaded (for provenance). */
export function championsItemsMeta(): RawItemsFile['meta'] | null {
  const idx = loadIndex();
  return idx ? idx.meta : null;
}

/** Whether the Champions item catalog is loaded (vs. only the @smogon/calc fallback). */
export function hasChampionsItems(): boolean {
  return Boolean(loadIndex());
}

/**
 * Look up a single item by name in the Champions catalog; fall back to @smogon/calc's bundled
 * item list if not found there (so the tool still answers, flagged via `source`).
 */
export function getItemInfo(name: string): ItemInfo | null {
  const idx = loadIndex();
  if (idx) {
    const hit = idx.byKey.get(itemKey(name));
    if (hit) {
      return {
        name: hit.name,
        category: hit.category,
        held: hit.held,
        effect: hit.effect,
        location: hit.location,
        source: 'champions-items',
      };
    }
  }
  return getFromSmogon(name);
}

// Fallback: confirm the item exists in @smogon/calc's bundled (mainline) item list. That data
// has no effect/location text, so those come back empty — flagged by source='smogon-calc'.
function getFromSmogon(name: string): ItemInfo | null {
  const g = gen();
  const item = g.items.get(toID(name));
  if (!item) return null;
  return {
    name: item.name,
    category: 'Unknown',
    held: true, // @smogon/calc only tracks battle-relevant (held) items.
    effect: '',
    location: '',
    source: 'smogon-calc',
  };
}

export interface ItemListFilter {
  /** Restrict to one category. */
  category?: ItemCategory;
  /** Only items a Pokémon can hold in battle (excludes Miscellaneous tickets). */
  heldOnly?: boolean;
  /** Case-insensitive substring match against the item name. */
  nameContains?: string;
}

/**
 * Browse the Champions item catalog, optionally filtered. Returns null if the catalog isn't
 * available (only the @smogon/calc fallback exists, which can't be enumerated meaningfully
 * for Champions — it's mainline data with no Champions effect/location/category).
 */
export function listItems(filter: ItemListFilter = {}): ItemInfo[] | null {
  const idx = loadIndex();
  if (!idx) return null;
  const needle = filter.nameContains?.trim().toLowerCase();
  return idx.all
    .filter((i) => (filter.category ? i.category === filter.category : true))
    .filter((i) => (filter.heldOnly ? i.held : true))
    .filter((i) => (needle ? i.name.toLowerCase().includes(needle) : true))
    .map((i) => ({
      name: i.name,
      category: i.category,
      held: i.held,
      effect: i.effect,
      location: i.location,
      source: 'champions-items' as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
