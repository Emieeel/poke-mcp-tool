/**
 * calc.ts — thin wrapper around @smogon/calc for Pokémon Champions.
 *
 * Engine data (Pokédex, base stats, move power/type/category, type chart, ability
 * effects, and the damage formula itself) all come from the dex BUNDLED inside
 * @smogon/calc. We never reimplement the formula or hand-maintain a type chart here.
 */
import {
  calculate,
  Generations,
  Pokemon,
  Move,
  Field,
  toID,
} from '@smogon/calc';
import { z } from 'zod';
import { getSpeciesOverride } from './dex.js';

// `Generation` isn't re-exported at the package root, so derive it from Generations.get.
type Generation = ReturnType<typeof Generations.get>;

// The latest generation the installed @smogon/calc supports. Champions descends from
// gen 9 mechanics (Tera, etc.), so we default everything to the newest gen available.
export const LATEST_GEN = 9;
export function gen(): Generation {
  return Generations.get(LATEST_GEN);
}

const STATUSES = ['slp', 'psn', 'brn', 'frz', 'par', 'tox'] as const;
const WEATHERS = [
  'Sand', 'Sun', 'Rain', 'Hail', 'Snow',
  'Harsh Sunshine', 'Heavy Rain', 'Strong Winds',
] as const;
const TERRAINS = ['Electric', 'Grassy', 'Psychic', 'Misty'] as const;
const GAME_TYPES = ['Singles', 'Doubles'] as const;

export const TYPE_NAMES = [
  'Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost',
  'Steel', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon',
  'Dark', 'Fairy', 'Stellar', '???',
] as const;

// A per-stat block. @smogon/calc uses spa/spd; we accept that shape directly.
const statsSchema = z
  .object({
    hp: z.number().int().optional(),
    atk: z.number().int().optional(),
    def: z.number().int().optional(),
    spa: z.number().int().optional(),
    spd: z.number().int().optional(),
    spe: z.number().int().optional(),
  })
  .strict();

const boostsSchema = z
  .object({
    atk: z.number().int().min(-6).max(6).optional(),
    def: z.number().int().min(-6).max(6).optional(),
    spa: z.number().int().min(-6).max(6).optional(),
    spd: z.number().int().min(-6).max(6).optional(),
    spe: z.number().int().min(-6).max(6).optional(),
  })
  .strict();

export const pokemonSchema = z.object({
  name: z.string().describe('Species name, e.g. "Garchomp" or "Staraptor-Mega".'),
  level: z.number().int().min(1).max(100).default(50),
  item: z.string().optional().describe('Held item, e.g. "Choice Band".'),
  ability: z.string().optional().describe('Ability name, e.g. "Intimidate".'),
  nature: z.string().optional().describe('Nature, e.g. "Adamant". Defaults to Serious.'),
  evs: statsSchema.optional().describe('Effort values per stat (0-252).'),
  ivs: statsSchema.optional().describe('Individual values per stat (0-31). Default 31.'),
  boosts: boostsSchema.optional().describe('Stat stage boosts per stat (-6..+6).'),
  teraType: z.enum(TYPE_NAMES).optional().describe('Tera type, if Terastallized.'),
  status: z.enum(STATUSES).optional().describe('Status condition.'),
});

export const fieldSchema = z
  .object({
    gameType: z.enum(GAME_TYPES).default('Doubles')
      .describe('Champions is a VGC-style format, so this defaults to Doubles.'),
    weather: z.enum(WEATHERS).optional(),
    terrain: z.enum(TERRAINS).optional(),
    isGravity: z.boolean().optional(),
    // Attacker-side / defender-side screens & support. These map onto @smogon/calc's
    // Side objects. We keep the common VGC-relevant ones.
    isReflect: z.boolean().optional().describe("Defender's side has Reflect up."),
    isLightScreen: z.boolean().optional().describe("Defender's side has Light Screen up."),
    isAuroraVeil: z.boolean().optional().describe("Defender's side has Aurora Veil up."),
    isTailwind: z.boolean().optional().describe("Attacker's side has Tailwind up."),
    isHelpingHand: z.boolean().optional().describe('Attacker is boosted by Helping Hand.'),
    isFriendGuard: z.boolean().optional().describe("Defender's side has a Friend Guard ally."),
    isProtected: z.boolean().optional().describe('Defender is protecting.'),
  })
  .strict();

export type PokemonInput = z.infer<typeof pokemonSchema>;
export type FieldInput = z.infer<typeof fieldSchema>;

function buildPokemon(
  g: Generation,
  input: PokemonInput,
  // If set, this is the ability actually passed to @smogon/calc (an alias for a Champions
  // ability it understands, e.g. Eelevate -> Levitate), while resolvedAbility keeps the real
  // Champions ability name for our own logic/notes.
  engineAbilityAlias?: string,
): { pokemon: Pokemon; autofilled: string[]; resolvedAbility?: string } {
  // Override species data with the Champions dex so game-original Megas (correct stats/types/
  // ability) calc correctly even when @smogon/calc has never heard of them. User-supplied
  // values always win; we only fill what wasn't given.
  const override = getSpeciesOverride(input.name);
  const autofilled: string[] = [];
  let overrides: { baseStats: any; types: any; weightkg: number } | undefined;
  let resolvedAbility = input.ability;

  if (override) {
    overrides = {
      baseStats: override.baseStats,
      types: override.types,
      weightkg: override.weightkg ?? 0,
    };
    if (!resolvedAbility && override.defaultAbility) {
      resolvedAbility = override.defaultAbility;
      autofilled.push(`ability "${resolvedAbility}"`);
    }
    autofilled.push('stats/typing (Champions dex)');
  }

  const pokemon = new Pokemon(g, input.name, {
    level: input.level,
    item: input.item as any,
    ability: (engineAbilityAlias ?? resolvedAbility) as any,
    nature: input.nature as any,
    evs: input.evs,
    ivs: input.ivs,
    boosts: input.boosts,
    teraType: input.teraType as any,
    status: (input.status ?? '') as any,
    ...(overrides ? { overrides: overrides as any } : {}),
  });
  return { pokemon, autofilled, resolvedAbility };
}

function buildField(input?: FieldInput): Field {
  const f = input ?? ({ gameType: 'Doubles' } as FieldInput);
  return new Field({
    gameType: f.gameType,
    weather: f.weather,
    terrain: f.terrain,
    isGravity: f.isGravity,
    // Screens/Friend Guard/Protect protect the DEFENDER; Tailwind/Helping Hand aid the ATTACKER.
    attackerSide: {
      isTailwind: f.isTailwind,
      isHelpingHand: f.isHelpingHand,
    } as any,
    defenderSide: {
      isReflect: f.isReflect,
      isLightScreen: f.isLightScreen,
      isAuroraVeil: f.isAuroraVeil,
      isFriendGuard: f.isFriendGuard,
      isProtected: f.isProtected,
    } as any,
  });
}

export interface DamageResult {
  attacker: string;
  defender: string;
  move: string;
  damageRange: { min: number; max: number };
  percentRange: { min: number; max: number };
  damageRolls: number[];
  koChance: { chance: number; hitsToKO: number; text: string };
  description: string;
  notes: string[];
}

/**
 * Run a damage calculation. The heavy lifting (abilities like Contrary/Intimidate,
 * weather, items, crits, multi-hit, spread reduction in Doubles) is all handled by
 * @smogon/calc internally — we only translate input/output.
 */
export function calculateDamage(args: {
  attacker: PokemonInput;
  defender: PokemonInput;
  move: string;
  field?: FieldInput;
}): DamageResult {
  const g = gen();
  const { pokemon: attacker, autofilled: atkAuto } = buildPokemon(g, args.attacker);
  const { pokemon: defender, autofilled: defAuto } = buildPokemon(g, args.defender);
  const move = new Move(g, args.move);
  const field = buildField(args.field);

  const result = calculate(g, attacker, defender, move, field);

  // result.damage can be a number, an array of rolls, or (rarely) nested arrays.
  const rolls = normalizeRolls(result.damage as number | number[]);
  const min = rolls.length ? Math.min(...rolls) : 0;
  const max = rolls.length ? Math.max(...rolls) : 0;
  const maxHP = defender.maxHP();
  const pct = (n: number) => Math.round((n / maxHP) * 1000) / 10;

  const notes: string[] = [];
  if (atkAuto.length) notes.push(`Attacker auto-filled from Champions dex: ${atkAuto.join(', ')}.`);
  if (defAuto.length) notes.push(`Defender auto-filled from Champions dex: ${defAuto.join(', ')}.`);
  if (field.gameType === 'Doubles') {
    // In Doubles the engine applies the 0.75x spread-move reduction automatically
    // for moves that hit multiple targets.
    notes.push('Doubles field: spread moves get the 0.75x reduction automatically.');
  }
  if (attacker.ability) notes.push(`Attacker ability "${attacker.ability}" applied by the engine.`);
  if (defender.ability) notes.push(`Defender ability "${defender.ability}" applied by the engine.`);
  if (field.weather) notes.push(`Weather "${field.weather}" in effect.`);
  if (field.terrain) notes.push(`Terrain "${field.terrain}" in effect.`);
  if (attacker.teraType) notes.push(`Attacker Terastallized to ${attacker.teraType}.`);
  // Champions-original abilities (e.g. Eelevate) aren't modelled by the @smogon/calc engine;
  // base damage uses correct stats/types but the ability's special effect may be ignored.
  if (max === 0) notes.push('Move deals no damage here (likely a type immunity).');

  // @smogon/calc's desc()/kochance() throw on all-zero damage; guard them.
  let description: string;
  let ko: { chance?: number; n: number; text?: string };
  if (max === 0) {
    description = `${attacker.name} ${move.name} vs. ${defender.name}: 0 damage (no effect / immune).`;
    ko = { chance: 0, n: 0, text: 'no damage' };
  } else {
    description = result.desc();
    ko = result.kochance();
  }

  return {
    attacker: attacker.name,
    defender: defender.name,
    move: move.name,
    damageRange: { min, max },
    percentRange: { min: pct(min), max: pct(max) },
    damageRolls: rolls,
    koChance: { chance: ko.chance ?? 0, hitsToKO: ko.n, text: ko.text ?? '' },
    description,
    notes,
  };
}

function normalizeRolls(damage: number | number[] | number[][]): number[] {
  if (typeof damage === 'number') return [damage];
  if (Array.isArray(damage) && damage.length && Array.isArray(damage[0])) {
    // Multi-hit: array of roll-arrays. Sum the min of each and max of each for a range.
    const arrs = damage as number[][];
    return arrs.reduce<number[]>((acc, arr) => {
      if (acc.length === 0) return [...arr];
      // Pair up rolls index-wise to keep a comparable distribution.
      return acc.map((v, i) => v + (arr[i] ?? arr[arr.length - 1]));
    }, []);
  }
  return damage as number[];
}

export interface TypeEffectivenessResult {
  attackingType: string;
  defendingTypes: string[];
  multiplier: number;
  perType: { type: string; multiplier: number }[];
  explanation: string;
}

/**
 * Type effectiveness derived purely from the type chart bundled in @smogon/calc.
 * Returns the combined multiplier (0, 0.25, 0.5, 1, 2, 4) against 1 or 2 defending types.
 */
export function typeEffectiveness(
  attackingType: string,
  defendingTypes: string[],
): TypeEffectivenessResult {
  const g = gen();
  const atk = g.types.get(toID(attackingType));
  if (!atk) {
    throw new Error(`Unknown attacking type: "${attackingType}".`);
  }

  const perType: { type: string; multiplier: number }[] = [];
  let multiplier = 1;
  for (const dt of defendingTypes) {
    const defType = g.types.get(toID(dt));
    if (!defType) throw new Error(`Unknown defending type: "${dt}".`);
    // atk.effectiveness maps defending type NAME -> multiplier.
    const m = (atk.effectiveness as Record<string, number>)[defType.name];
    const mult = typeof m === 'number' ? m : 1;
    perType.push({ type: defType.name, multiplier: mult });
    multiplier *= mult;
  }

  const label =
    multiplier === 0
      ? 'has no effect (immune)'
      : multiplier < 1
        ? 'is not very effective'
        : multiplier > 1
          ? 'is super effective'
          : 'deals neutral damage';

  return {
    attackingType: atk.name,
    defendingTypes: perType.map((p) => p.type),
    multiplier,
    perType,
    explanation:
      `${atk.name} ${label} against ${perType.map((p) => p.type).join('/')} ` +
      `(${perType.map((p) => `${p.type} x${p.multiplier}`).join(', ')}) = x${multiplier}.`,
  };
}
