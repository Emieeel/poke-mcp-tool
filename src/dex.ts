/**
 * dex.ts — Pokémon CHAMPIONS Pokédex lookups.
 *
 * Source of truth is data/champions-dex.json, scraped from Serebii's Champions Pokédex
 * (see scripts/scrape-champions-dex.ts). It carries what the engine's Champions dex doesn't:
 * every ability a species can have (the engine keeps one default) and its Champions learnset.
 *
 * If the Champions dex file is missing or doesn't contain a requested form, we fall back to
 * the engine's Champions dex (@smogon/calc gen 0) so the tool still answers, without
 * learnsets (and flag the source in the result).
 */
import { toID } from '@smogon/calc';
import { gen } from './calc.js';
import { nameKey } from './names.js';
import { dataSource } from './datasource.js';

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

// Serebii sometimes annotates abilities with the form they belong to, e.g.
// "Lightning Rod (Raichu)" or "Psychic Surge (Female)". Strip the parenthetical so lookups keyed
// on the bare ability name (@smogon/calc, our own ability tables) recognize it.
export function cleanAbilityName(a?: string): string | undefined {
  if (!a) return undefined;
  return a.replace(/\s*\(.*?\)\s*$/, '').trim() || undefined;
}

// A name -> form index over the Champions dex, tolerant of naming conventions (Mega word
// order, hyphens, casing).
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

// null when no Champions dex is available — callers fall back to the engine's data.
const source = dataSource(buildIndex);
export const provideDexData = source.provide;
export const registerDexLoader = source.register;
const loadIndex = source.get;

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

// Fallback: the engine's Champions dex (@smogon/calc gen 0), which has no learnsets.
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
