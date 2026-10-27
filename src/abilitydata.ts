/**
 * abilitydata.ts — Pokémon CHAMPIONS ability lookups (get_ability).
 *
 * Source of truth is data/champions-abilities.json, written by the dex scraper (see
 * scripts/scrape-champions-dex.ts): every ability a Champions Pokémon can have, with its
 * Champions description, whether it is new in Champions, and which dex forms can have it.
 * @smogon/calc's ability data is just a list of names, so there is no fallback text.
 */
import { toID } from '@smogon/calc';
import { gen } from './calc.js';
import { dataSource } from './datasource.js';

interface RawAbility {
  name: string;
  effect: string;
  isNew: boolean;
  pokemon: string[];
}
interface RawAbilitiesFile {
  meta: { source?: string; scrapedAt?: string; count?: number };
  abilities: Record<string, RawAbility>;
}

export interface AbilityInfo {
  name: string;
  effect: string;
  /** New in Champions (Mega Sol, Dragonize, Aura Guard, ...). */
  isNewInChampions: boolean;
  /** Champions dex forms that can have this ability. */
  pokemon: string[];
  source: 'champions-abilities' | 'smogon-calc';
}

const source = dataSource(
  (raw: RawAbilitiesFile) => new Map(Object.values(raw.abilities).map((a) => [toID(a.name), a])),
);
export const provideAbilitiesData = source.provide;
export const registerAbilitiesLoader = source.register;

/** One ability by name; falls back to the engine's Champions ability list (name only). */
export function getAbilityInfo(name: string): AbilityInfo | null {
  const hit = source.get()?.get(toID(name));
  if (hit) {
    return {
      name: hit.name,
      effect: hit.effect,
      isNewInChampions: hit.isNew,
      pokemon: hit.pokemon,
      source: 'champions-abilities',
    };
  }
  const a = gen().abilities.get(toID(name));
  if (!a) return null;
  return { name: a.name, effect: '', isNewInChampions: false, pokemon: [], source: 'smogon-calc' };
}
