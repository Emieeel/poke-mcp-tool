/**
 * items.ts — Pokémon CHAMPIONS held-item catalog lookups.
 *
 * Source of truth is data/champions-items.json, scraped from Serebii's Champions items page
 * (see scripts/scrape-champions-items.ts). We use THIS instead of @smogon/calc's bundled item
 * list because @smogon/calc's item data has no effect text, no "how to obtain" info and no
 * categories.
 *
 * If the Champions items file is missing or doesn't contain a requested item, we fall back to
 * @smogon/calc's bundled item list so the tool still answers (flagging the source).
 *
 * NOTE: this module only knows the item *catalog* (what items exist + their facts). Which
 * items are LEGAL in a given regulation is regulation data — see regulations.ts.
 */
import { gen } from './calc.js';
import { toID } from '@smogon/calc';

// NOTE: intentionally free of `node:*` imports so it can be bundled for filesystem-less
// runtimes (Cloudflare Workers). Data arrives INJECTED via provideItemsData() or via a disk
// LOADER registered by the Node-only src/diskdata.ts. See those two files.

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

// Data can be INJECTED (Workers bundle the JSON) or read from disk via a LOADER the Node-only
// src/diskdata.ts registers. Either way this module stays free of `node:*` imports.
let injectedItems: RawItemsFile | undefined;
export function provideItemsData(raw: unknown): void {
  injectedItems = raw as RawItemsFile;
  indexCache = undefined; // force a rebuild from the injected data on next access
}

// A disk loader returns the parsed items JSON, or null if the file is missing/unreadable.
type ItemsLoader = () => RawItemsFile | null;
let diskLoader: ItemsLoader | undefined;
export function registerItemsLoader(loader: ItemsLoader): void {
  diskLoader = loader;
  indexCache = undefined;
}

function buildIndex(raw: RawItemsFile) {
  const byKey = new Map<string, RawItem>();
  const all: RawItem[] = [];
  for (const item of Object.values(raw.items)) {
    const key = itemKey(item.name);
    if (!byKey.has(key)) byKey.set(key, item);
    all.push(item);
  }
  return { byKey, all, meta: raw.meta };
}

function loadIndex() {
  if (indexCache !== undefined) return indexCache;
  const raw = injectedItems ?? diskLoader?.() ?? null;
  // null means no Champions catalog available — callers fall back to @smogon/calc data.
  indexCache = raw ? buildIndex(raw) : null;
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

// Fallback: confirm the item exists in the engine's Champions item list. That data
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
 * for Champions — it has no effect/location/category).
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
