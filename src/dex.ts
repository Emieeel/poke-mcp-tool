/**
 * dex.ts — Pokémon CHAMPIONS engine dex lookups.
 *
 * Source of truth is data/champions-dex.json, scraped from Serebii's Champions Pokédex
 * (see scripts/scrape-champions-dex.ts). We use THIS instead of @smogon/calc's bundled dex
 * because @smogon/calc ships mainline data that is wrong or missing for Champions-original
 * Mega Evolutions (e.g. Champions' Mega Staraptor has Contrary; @smogon/calc says Intimidate).
 *
 * If the Champions dex file is missing or doesn't contain a requested form, we fall back to
 * @smogon/calc's bundled dex so the tool still answers (and flag the source in the result).
 *
 * @smogon/calc remains the engine for the damage *formula* (see calc.ts) — only per-Pokémon
 * facts (stats/types/abilities/weight) are sourced here.
 */
import { toID } from '@smogon/calc';
import { gen } from './calc.js';
import { nameKey } from './names.js';

// NOTE: this module is intentionally free of `node:*` imports so it can be bundled for
// filesystem-less runtimes (Cloudflare Workers). Data arrives either INJECTED via
// provideDexData() (Workers bundle the JSON) or through a disk LOADER registered by the
// Node-only src/diskdata.ts (the stdio server). See those two files.

interface RawForm {
  name: string;
  types: string[];
  abilities: string[];
  baseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  weightkg: number | null;
}
interface RawEntry {
  slug: string;
  name: string;
  num: number | null;
  forms: RawForm[];
  moves?: string[];
}
interface RawDex {
  meta: { source?: string; scrapedAt?: string; count?: number };
  pokemon: Record<string, RawEntry>;
}

export interface PokemonInfo {
  name: string;
  baseSpecies?: string;
  num?: number | null;
  types: string[];
  baseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  abilities: string[];
  weightkg: number | null;
  /** Full learnable movelist in Champions (shared across the species' forms). */
  moves: string[];
  source: 'champions-dex' | 'smogon-calc';
  /** Other forms of this species available in Champions (names only), for discoverability. */
  otherForms?: string[];
}

/**
 * Champions-accurate species data used to OVERRIDE @smogon/calc when building a Pokémon for
 * a damage calc, so game-original Megas (correct stats/types/ability) calc correctly even
 * when @smogon/calc has never heard of them. Returns null if the form isn't in the dex.
 */
export interface SpeciesOverride {
  name: string;
  types: string[];
  baseStats: RawForm['baseStats'];
  weightkg: number | null;
  /** Primary ability (parenthetical form annotations stripped), for a sensible default. */
  defaultAbility?: string;
}
export function getSpeciesOverride(name: string): SpeciesOverride | null {
  const idx = loadIndex();
  const hit = idx?.byKey.get(nameKey(name));
  if (!hit) return null;
  const { form } = hit;
  return {
    name: form.name,
    types: form.types,
    baseStats: form.baseStats,
    weightkg: form.weightkg,
    defaultAbility: cleanAbility(form.abilities[0]),
  };
}

// Serebii sometimes annotates abilities with the form they belong to, e.g.
// "Lightning Rod (Raichu)". Strip the parenthetical so @smogon/calc recognizes the name.
function cleanAbility(a?: string): string | undefined {
  if (!a) return undefined;
  return a.replace(/\s*\(.*?\)\s*$/, '').trim() || undefined;
}

// Lazily build a name -> form index from the Champions dex so lookups are O(1) and tolerant
// of naming conventions (Mega word order, hyphens, casing).
let indexCache:
  | { byKey: Map<string, { entry: RawEntry; form: RawForm }>; meta: RawDex['meta'] }
  | null
  | undefined;

// Data can be INJECTED (Workers bundle the JSON) or read from disk via a LOADER the Node-only
// src/diskdata.ts registers. Either way this module stays free of `node:*` imports.
let injectedDex: RawDex | undefined;
export function provideDexData(raw: unknown): void {
  injectedDex = raw as RawDex;
  indexCache = undefined; // force a rebuild from the injected data on next access
}

// A disk loader returns the parsed dex JSON, or null if the file is missing/unreadable. The
// stdio entry registers this (src/diskdata.ts); Workers never do (they inject instead).
type DexLoader = () => RawDex | null;
let diskLoader: DexLoader | undefined;
export function registerDexLoader(loader: DexLoader): void {
  diskLoader = loader;
  indexCache = undefined;
}

function buildIndex(raw: RawDex) {
  const byKey = new Map<string, { entry: RawEntry; form: RawForm }>();
  for (const entry of Object.values(raw.pokemon)) {
    for (const form of entry.forms) {
      const key = nameKey(form.name);
      if (!byKey.has(key)) byKey.set(key, { entry, form });
    }
    // Also index the bare species name/slug so "Staraptor" resolves to its base form.
    const baseKey = nameKey(entry.name);
    if (!byKey.has(baseKey) && entry.forms[0]) byKey.set(baseKey, { entry, form: entry.forms[0] });
  }
  return { byKey, meta: raw.meta };
}

function loadIndex() {
  if (indexCache !== undefined) return indexCache;
  const raw = injectedDex ?? diskLoader?.() ?? null;
  // null means no Champions dex available — callers fall back to @smogon/calc data.
  indexCache = raw ? buildIndex(raw) : null;
  return indexCache;
}

/** Source URL + timestamp for the Champions dex, if loaded (used by tools for provenance). */
export function championsDexMeta(): RawDex['meta'] | null {
  const idx = loadIndex();
  return idx ? idx.meta : null;
}

/**
 * Look up a Pokémon (including Mega forms like "Staraptor-Mega" / "Mega Staraptor") in the
 * Champions dex; fall back to @smogon/calc's bundled dex if not found there.
 */
export function getPokemonInfo(name: string): PokemonInfo | null {
  const idx = loadIndex();
  if (idx) {
    const hit = idx.byKey.get(nameKey(name));
    if (hit) {
      const { entry, form } = hit;
      return {
        name: form.name,
        baseSpecies: form.name !== entry.name ? entry.name : undefined,
        num: entry.num,
        types: form.types,
        baseStats: form.baseStats,
        abilities: form.abilities,
        weightkg: form.weightkg,
        moves: entry.moves ?? [],
        source: 'champions-dex',
        otherForms: entry.forms.length > 1 ? entry.forms.map((f) => f.name) : undefined,
      };
    }
  }
  return getFromSmogon(name);
}

// Fallback: read from @smogon/calc's bundled (mainline) dex.
function getFromSmogon(name: string): PokemonInfo | null {
  const g = gen();
  const species = g.species.get(toID(name));
  if (!species) return null;
  const bs = species.baseStats;
  const abilities = species.abilities
    ? Object.values(species.abilities as Record<string, string>).filter(Boolean)
    : [];
  return {
    name: species.name,
    baseSpecies: species.baseSpecies !== species.name ? species.baseSpecies : undefined,
    types: [...species.types],
    baseStats: { hp: bs.hp, atk: bs.atk, def: bs.def, spa: bs.spa, spd: bs.spd, spe: bs.spe },
    abilities,
    weightkg: species.weightkg,
    moves: [], // @smogon/calc has no learnsets; movelist only exists in the Champions dex.
    source: 'smogon-calc',
  };
}

/** A Pokémon's full learnable movelist in Champions, or null if not in the dex. */
export function getPokemonMoves(name: string): string[] | null {
  const idx = loadIndex();
  const hit = idx?.byKey.get(nameKey(name));
  return hit ? hit.entry.moves ?? [] : null;
}
