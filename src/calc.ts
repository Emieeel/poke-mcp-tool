/**
 * calc.ts — thin wrapper around @smogon/calc for Pokémon Champions.
 *
 * @smogon/calc ships a dedicated Champions generation (gen 0): the Champions roster (Megas and
 * alternate forms included), the rebalanced moves, the Champions-original abilities (Mega Sol,
 * Dragonize, Aura Guard, Piercing Drill, ...), Stat Points and the Champions damage rules. Every
 * calc runs on it. We never reimplement the formula or hand-maintain a type chart here; this
 * file only translates tool input/output.
 */
import {
  calculate,
  Generations,
  Pokemon,
  Move,
  Field,
  toID,
} from '@smogon/calc';
// Deep import: the effectiveness helper isn't re-exported from the package root, but it is the
// ENGINE's own function — the same one calculate() uses internally — so using it keeps the
// effectiveness we report identical to the one baked into the damage rolls, including move-
// specific exceptions (Freeze-Dry hitting Water for 2x, Flying Press's dual typing, Ring Target,
// Gravity, Scrappy). Reimplementing that logic from the raw type chart is exactly the kind of
// hand-rolled duplication this file exists to avoid. The package ships no "exports" map, so the
// path resolves under Node and bundles cleanly for Workers; test/smoke.ts pins the behaviour
// (Freeze-Dry vs Water = 2x) so a dependency bump that moves this file fails loudly.
import { getMoveEffectiveness } from '@smogon/calc/dist/mechanics/util.js';
import { z } from 'zod';
import { getPokemonInfo, cleanAbilityName } from './dex.js';
import { nameKey } from './names.js';
import { typeDefenseAbility, DEFENSE_NOTES_ONLY } from './abilities.js';
import { resolveBasePower } from './moves.js';

// `Generation` isn't re-exported at the package root, so derive it from Generations.get.
type Generation = ReturnType<typeof Generations.get>;

// @smogon/calc's generation number for Pokémon Champions.
export const CHAMPIONS_GEN = 0;
export function gen(): Generation {
  return Generations.get(CHAMPIONS_GEN);
}

const STATUSES = ['slp', 'psn', 'brn', 'frz', 'par', 'tox'] as const;
const WEATHERS = [
  'Sand', 'Sun', 'Rain', 'Hail', 'Snow',
  'Harsh Sunshine', 'Heavy Rain', 'Strong Winds',
] as const;
const TERRAINS = ['Electric', 'Grassy', 'Psychic', 'Misty'] as const;
const GAME_TYPES = ['Singles', 'Doubles'] as const;

// The 18 battle types plus "???" (typeless, e.g. Struggle). Champions has no Terastallization,
// so there is no Stellar type.
export const TYPE_NAMES = [
  'Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost',
  'Steel', 'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon',
  'Dark', 'Fairy', '???',
] as const;

// --- Pokémon Champions Stat Points (the EV/IV replacement) -------------------
//
// Champions replaced EVs and IVs with Stat Points (SP): 1 SP = +1 to that stat at the fixed
// Level 50, capped at 32 SP per stat and 66 SP total. The engine's Champions generation takes
// SP directly in the `evs` slot and prints them as-is in the calc string, so all we enforce
// here are the caps.
export const MAX_SP_PER_STAT = 32;
export const MAX_SP_TOTAL = 66;

// A per-stat Stat-Point block: 0–32 per stat, 66 total (the Champions caps).
const statPointsSchema = z
  .object({
    hp: z.number().int().min(0).max(MAX_SP_PER_STAT).optional(),
    atk: z.number().int().min(0).max(MAX_SP_PER_STAT).optional(),
    def: z.number().int().min(0).max(MAX_SP_PER_STAT).optional(),
    spa: z.number().int().min(0).max(MAX_SP_PER_STAT).optional(),
    spd: z.number().int().min(0).max(MAX_SP_PER_STAT).optional(),
    spe: z.number().int().min(0).max(MAX_SP_PER_STAT).optional(),
  })
  .strict()
  .refine(
    (sp) => Object.values(sp).reduce((sum: number, v) => sum + (v ?? 0), 0) <= MAX_SP_TOTAL,
    { message: `Stat Points must total at most ${MAX_SP_TOTAL} across all stats (Pokémon Champions cap).` },
  );

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
  name: z.string().describe('Species name, e.g. "Garchomp", "Mega Raichu X" or "Raichu-Mega-X".'),
  // Champions battles are always Level 50; the engine fixes it, so only 50 is accepted.
  level: z.literal(50).optional().describe('Always 50 in Pokémon Champions.'),
  item: z.string().optional().describe('Held item, e.g. "Choice Band".'),
  ability: z.string().optional().describe('Ability name, e.g. "Intimidate".'),
  nature: z.string().optional().describe('Nature, e.g. "Adamant". Defaults to Serious.'),
  statPoints: statPointsSchema
    .optional()
    .describe(
      'Pokémon Champions Stat Points (SP) per stat — the EV/IV replacement. 1 SP = +1 to ' +
      'that stat at Level 50; max 32 per stat, 66 total. IVs do not exist in Champions. ' +
      'Defaults to 0 in every stat.',
    ),
  boosts: boostsSchema.optional().describe('Stat stage boosts per stat (-6..+6).'),
  status: z.enum(STATUSES).optional().describe('Status condition.'),
})
  // Champions uses Stat Points, not EVs/IVs, and has no Terastallization. Reject the legacy
  // `evs`/`ivs`/`teraType` keys loudly (instead of silently ignoring them) so an old-style call
  // fails fast rather than leaving the caller wondering why it had no effect.
  .strict();

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

// Battle-HISTORY context for moves whose base power accumulates over a battle — something
// @smogon/calc can't know from a single-turn snapshot. Each field drives the matching move;
// `basePowerOverride` is the universal escape hatch for any other variable-power move.
export const moveContextSchema = z
  .object({
    timesHit: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Rage Fist: number of times the attacker has been hit by a damaging move this ' +
        'battle. Each hit adds +50 BP (50 base), capped at 350 BP after 6 hits.',
      ),
    faintedAllies: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Last Respects: number of Pokémon that have fainted on the attacker's side this " +
        'battle. Each adds +50 BP (50 base); the count is capped at 100.',
      ),
    basePowerOverride: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Force the move\'s base power to this exact value. Wins over the counters above and ' +
        'works for ANY variable-power move the engine does not model. Use when you already ' +
        'know the move\'s current BP.',
      ),
  })
  .strict();

export type PokemonInput = z.infer<typeof pokemonSchema>;
export type FieldInput = z.infer<typeof fieldSchema>;
export type MoveContextInput = z.infer<typeof moveContextSchema>;

// Engine species by name key, so Serebii-style names ("Mega Raichu X") and engine names
// ("Raichu-Mega-X") resolve to the same Champions species. Built lazily, once.
let engineSpeciesByKey: Map<string, string> | undefined;
export function engineSpeciesName(name: string): string | undefined {
  if (!engineSpeciesByKey) {
    engineSpeciesByKey = new Map();
    for (const s of gen().species) engineSpeciesByKey.set(nameKey(s.name), s.name);
  }
  return engineSpeciesByKey.get(nameKey(name));
}

function buildPokemon(
  g: Generation,
  input: PokemonInput,
): { pokemon: Pokemon; autofilled: string[] } {
  const autofilled: string[] = [];
  const engineName = engineSpeciesName(input.name);
  const info = getPokemonInfo(input.name);
  const inChampionsDex = info?.source === 'champions-dex';
  if (!engineName && !inChampionsDex) {
    throw new Error(`"${input.name}" is not in the Pokémon Champions Pokédex.`);
  }

  // Default ability from the Champions dex (Serebii). The engine keeps one default ability per
  // species and has a few Champions Megas wrong (Mega Skarmory, Mega Hawlucha); user input wins.
  let ability = input.ability;
  if (!ability && inChampionsDex && info.abilities[0]) {
    ability = cleanAbilityName(info.abilities[0]);
    autofilled.push(`ability "${ability}"`);
  }

  // A species the engine's Champions dex doesn't carry yet: calc it from Champions-dex
  // stats/typing instead.
  let overrides: { baseStats: any; types: any; weightkg: number } | undefined;
  if (!engineName && inChampionsDex) {
    overrides = { baseStats: info.baseStats, types: info.types, weightkg: info.weightkg ?? 0 };
    autofilled.push('stats/typing (not in the engine\'s Champions dex)');
  }

  // Champions Stat Points go straight into the engine's `evs` slot (see the Stat Points note).
  const sp = input.statPoints ?? {};
  const pokemon = new Pokemon(g, engineName ?? input.name, {
    item: input.item as any,
    ability: ability as any,
    nature: input.nature as any,
    evs: {
      hp: sp.hp ?? 0,
      atk: sp.atk ?? 0,
      def: sp.def ?? 0,
      spa: sp.spa ?? 0,
      spd: sp.spd ?? 0,
      spe: sp.spe ?? 0,
    },
    boosts: input.boosts,
    status: (input.status ?? '') as any,
    ...(overrides ? { overrides: overrides as any } : {}),
  });
  return { pokemon, autofilled };
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

export interface MoveEffectivenessResult {
  /** The move's type AS RESOLVED by the engine (after Aerilate, Weather Ball in sun, ...). */
  moveType: string;
  /** The defender's types. */
  defenderTypes: string[];
  multiplier: number;
  perType: TypeMultiplier[];
  /** "super effective" | "not very effective" | "neutral" | "no effect". */
  label: string;
  /** The line the game prints for this hit, e.g. "It's super effective!". */
  message: string;
  note?: string;
}

export interface DamageResult {
  attacker: string;
  defender: string;
  move: string;
  damageRange: { min: number; max: number };
  percentRange: { min: number; max: number };
  damageRolls: number[];
  koChance: { chance: number; hitsToKO: number; text: string };
  /** How effective this hit was, in the game's own terms. Always present. */
  typeEffectiveness: MoveEffectivenessResult;
  description: string;
  notes: string[];
}

/**
 * Type effectiveness for a hit that was just calculated. Read off the ENGINE's own effectiveness
 * function and the RESOLVED move/defender on the result, so it accounts for ability retypes
 * (Aerilate making Double-Edge Flying), weather retypes (Weather Ball in sun) and
 * move-specific exceptions (Freeze-Dry, Flying Press) — and therefore can never contradict the
 * damage rolls it is printed next to.
 */
function resolveMoveEffectiveness(
  g: Generation,
  result: ReturnType<typeof calculate>,
): MoveEffectivenessResult {
  const mv = result.move as any;
  const atk = result.attacker as any;
  const def = result.defender as any;
  const field = result.field as any;

  // Mirrors the engine's own preconditions (see @smogon/calc mechanics/gen789).
  const isGhostRevealed = Boolean(
    atk.hasAbility?.('Scrappy') || atk.hasAbility?.("Mind's Eye") || field.defenderSide?.isForesight,
  );
  const isRingTarget = Boolean(def.hasItem?.('Ring Target') && !def.hasAbility?.('Klutz'));
  const defenderTypes: string[] = (def.types as string[]).filter(Boolean);

  const perType: TypeMultiplier[] = defenderTypes.map((type) => ({
    type,
    multiplier: getMoveEffectiveness(g, mv, type as any, isGhostRevealed, field.isGravity, isRingTarget),
  }));
  let multiplier = perType.reduce((m, e) => m * e.multiplier, 1);

  const notes: string[] = [];
  if (multiplier === 0 && mv.hasType?.('Ground') && def.hasItem?.('Iron Ball') && !def.hasAbility?.('Klutz')) {
    multiplier = 1;
    notes.push('Iron Ball grounds the defender, so its Ground immunity does not apply.');
  }
  if (mv.category === 'Status') notes.push('Status move: this is the type matchup, not damage dealt.');

  return {
    moveType: mv.type,
    defenderTypes,
    multiplier,
    perType,
    label: effectivenessLabel(multiplier),
    message: effectivenessMessage(multiplier, result.defender.name),
    note: notes.length ? notes.join(' ') : undefined,
  };
}

/** The human-readable effectiveness line added to `notes` so it is impossible to miss. */
function effectivenessNote(te: MoveEffectivenessResult): string {
  const tail =
    te.multiplier === 1
      ? 'the game prints no message for a neutral hit.'
      : `"${te.message}"`;
  return (
    `Type effectiveness: ${te.moveType} vs ${te.defenderTypes.join('/')} = ` +
    `x${te.multiplier} (${te.label}) — ${tail}`
  );
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
  moveContext?: MoveContextInput;
  /** Force a critical hit. Always-crit moves (Flower Trick, Wicked Blow, ...) crit regardless. */
  isCrit?: boolean;
}): DamageResult {
  const g = gen();
  const notes: string[] = [];

  const { pokemon: attacker, autofilled: atkAuto } = buildPokemon(g, args.attacker);
  const { pokemon: defender, autofilled: defAuto } = buildPokemon(g, args.defender);

  // Battle-history base power (Rage Fist, Last Respects, basePowerOverride). IMPORTANT:
  // calculate() clones the move, and clone() rebuilds it from its name + `overrides` ONLY, so a
  // post-construction `move.bp =` would be discarded — the BP must go in through `overrides`.
  const probe = new Move(g, args.move);
  const bpResolved = resolveBasePower(probe.name, args.moveContext);
  if (bpResolved) notes.push(bpResolved.note);

  // isCrit is a constructor option (not an override); Move.clone() carries it through, so the
  // engine applies the full crit package: x1.5 (x2.25 with Sniper), ignoring the defender's
  // positive defensive boosts, the attacker's negative offensive boosts, and screens.
  const move = new Move(g, args.move, {
    ...(bpResolved ? { overrides: { basePower: bpResolved.bp } as any } : {}),
    isCrit: Boolean(args.isCrit),
  });

  const field = buildField(args.field);
  const result = calculate(g, attacker, defender, move, field);

  // result.damage can be a number, an array of rolls, or (rarely) nested arrays.
  const rolls = normalizeRolls(result.damage as number | number[]);

  const min = rolls.length ? Math.min(...rolls) : 0;
  const max = rolls.length ? Math.max(...rolls) : 0;
  const maxHP = defender.maxHP();
  // Truncate to one decimal (NOT round) to match the canonical @smogon/calc desc string and
  // the online VGC calculator — e.g. 81/185 = 43.78% is shown as 43.7%, not 43.8%.
  const pct = (n: number) => Math.floor((n / maxHP) * 1000) / 10;

  if (atkAuto.length) notes.push(`Attacker auto-filled from Champions dex: ${atkAuto.join(', ')}.`);
  if (defAuto.length) notes.push(`Defender auto-filled from Champions dex: ${defAuto.join(', ')}.`);
  if (field.gameType === 'Doubles') {
    notes.push('Doubles field: spread moves get the 0.75x reduction automatically.');
  }
  if (attacker.ability) notes.push(`Attacker ability "${attacker.ability}" applied by the engine.`);
  if (defender.ability) notes.push(`Defender ability "${defender.ability}" applied by the engine.`);
  if (field.weather) notes.push(`Weather "${field.weather}" in effect.`);
  if (field.terrain) notes.push(`Terrain "${field.terrain}" in effect.`);
  if (move.isCrit) {
    // Same precondition the engine checks before applying the crit (mechanics/gen789).
    if (defender.hasAbility('Battle Armor', 'Shell Armor')) {
      notes.push(`Critical hit requested, but ${defender.ability} prevents critical hits, so this is a normal hit.`);
    } else if (args.isCrit) {
      notes.push(
        'Critical hit: x1.5 damage (x2.25 with Sniper), ignoring the defender\'s positive ' +
        'Def/SpD boosts, the attacker\'s negative Atk/SpA drops, and Reflect/Light Screen/Aurora Veil.',
      );
    } else {
      notes.push(`${move.name} always lands a critical hit.`);
    }
  }

  // Type effectiveness, reconciled against what the engine actually dealt. A 0-damage hit whose
  // TYPE matchup isn't 0x was blocked by something else (Levitate, Flash Fire, Air Balloon,
  // Protect, ...) — say which case it is instead of leaving the two facts to contradict.
  const te = resolveMoveEffectiveness(g, result);
  if (max === 0 && te.multiplier > 0) {
    te.label = 'no effect';
    te.message = effectivenessMessage(0, defender.name);
    te.note = [
      te.note,
      `The type matchup here is x${te.multiplier}, but the hit deals no damage — an ability, ` +
      'item or field effect (Levitate, Flash Fire, Air Balloon, Protect, ...) is blocking it, ' +
      'not the type chart.',
    ]
      .filter(Boolean)
      .join(' ');
  } else if (max > 0 && te.multiplier === 0) {
    te.note = [te.note, 'A type immunity was bypassed, so the move still deals damage.']
      .filter(Boolean)
      .join(' ');
  }
  notes.push(effectivenessNote(te));
  if (max === 0 && te.multiplier === 0) {
    notes.push('Move deals no damage here: the defender is immune by type.');
  }

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
    typeEffectiveness: te,
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

export interface TypeMultiplier {
  type: string;
  multiplier: number;
}

export interface TypeEffectivenessResult {
  attackingType: string;
  defendingTypes: string[];
  multiplier: number;
  perType: TypeMultiplier[];
  explanation: string;
}

/**
 * The 18 real battle types, in canonical order. TYPE_NAMES additionally carries "???", the
 * typeless marker, which no defender can be hit by, so it is excluded from defensive profiles.
 */
export const BATTLE_TYPES: string[] = TYPE_NAMES.filter((t) => t !== '???');

/** One attacking type vs 1–2 defending types, straight off the bundled type chart. */
function chartMultiplier(
  g: Generation,
  attackingType: string,
  defendingTypes: string[],
): { attackingTypeName: string; perType: TypeMultiplier[]; multiplier: number } {
  const atk = g.types.get(toID(attackingType));
  if (!atk) throw new Error(`Unknown attacking type: "${attackingType}".`);

  const perType: TypeMultiplier[] = [];
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
  return { attackingTypeName: atk.name, perType, multiplier };
}

/** Short classification of a multiplier, for machine-readable output. */
export function effectivenessLabel(multiplier: number): string {
  if (multiplier === 0) return 'no effect';
  if (multiplier > 1) return 'super effective';
  if (multiplier < 1) return 'not very effective';
  return 'neutral';
}

/**
 * The line the game itself prints for a hit of this effectiveness. Neutral hits print nothing
 * in-battle, so they get an explicit "(no message — neutral hit)" rather than a fake string.
 */
export function effectivenessMessage(multiplier: number, defenderName?: string): string {
  if (multiplier === 0) return `It doesn't affect ${defenderName ?? 'the target'}...`;
  if (multiplier > 1) return "It's super effective!";
  if (multiplier < 1) return "It's not very effective...";
  return '(no message — neutral hit)';
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
  const { attackingTypeName, perType, multiplier } = chartMultiplier(g, attackingType, defendingTypes);

  const label =
    multiplier === 0
      ? 'has no effect (immune)'
      : multiplier < 1
        ? 'is not very effective'
        : multiplier > 1
          ? 'is super effective'
          : 'deals neutral damage';

  return {
    attackingType: attackingTypeName,
    defendingTypes: perType.map((p) => p.type),
    multiplier,
    perType,
    explanation:
      `${attackingTypeName} ${label} against ${perType.map((p) => p.type).join('/')} ` +
      `(${perType.map((p) => `${p.type} x${p.multiplier}`).join(', ')}) = x${multiplier}.`,
  };
}

// ---- defensive profiles -----------------------------------------------------

export interface DefensiveProfile {
  types: string[];
  /** The ability folded into these multipliers, if any. */
  ability?: string;
  /** Every one of the 18 attacking types -> multiplier. The complete answer, no gaps. */
  multipliers: Record<string, number>;
  /** multiplier > 1, worst first. */
  weaknesses: TypeMultiplier[];
  /** 0 < multiplier < 1, best resist first. */
  resistances: TypeMultiplier[];
  /** multiplier === 0. */
  immunities: string[];
  /** multiplier === 1. */
  neutral: string[];
  summary: string;
  /** What the applied ability does (including parts not visible in the multipliers). */
  abilityNotes?: string[];
  /** Multipliers that differ from the typing-only profile, e.g. "Fire 4x -> 2x". */
  differsFromTyping?: string[];
  /** Set when the typing itself is suspect (see MERGED_FORM_WARNING). */
  warning?: string;
}

// A Pokémon can only ever have two types. A longer list means the Champions dex entry lumped
// several forms' typings together (the scraper does this for a handful of species with regional
// forms, e.g. Rotom, Slowbro, Tauros), so a profile built from it describes no single form. Say
// so loudly rather than emitting a confident, wrong table.
const MERGED_FORM_WARNING =
  'This dex entry lists more than two types, which means it merges several of the species\' ' +
  'forms (regional/alternate) into one entry. The multipliers below combine ALL of those types, ' +
  'so they do not describe any single form — look up the specific form, or treat this as ' +
  'unreliable.';

function mergedFormWarning(types: string[]): string | undefined {
  return types.length > 2 ? MERGED_FORM_WARNING : undefined;
}

/**
 * The complete defensive matchup table for a typing: what it is weak to, resists, and is immune
 * to, across all 18 attacking types. Computed from the bundled type chart every time — this
 * exists so no caller ever has to recall or re-derive the type chart by hand.
 *
 * Pass an ability to fold in the abilities that change damage TAKEN by type (Levitate, Thick
 * Fat, Heatproof, Flash Fire, Filter, ...); the ability's non-type effects come back as notes.
 */
export function defensiveProfile(
  types: string[],
  opts?: { ability?: string },
): DefensiveProfile {
  const g = gen();
  if (!types.length) throw new Error('A defensive profile needs at least one type.');

  const base: Record<string, number> = {};
  for (const attacking of BATTLE_TYPES) {
    base[attacking] = chartMultiplier(g, attacking, types).multiplier;
  }

  const ability = opts?.ability;
  const effect = typeDefenseAbility(ability);
  const multipliers: Record<string, number> = { ...base };
  const abilityNotes: string[] = [];
  if (effect) {
    abilityNotes.push(effect.note);
    for (const [t, mult] of Object.entries(effect.typeMultipliers ?? {})) {
      if (multipliers[t] === undefined) continue;
      multipliers[t] *= mult;
    }
    if (effect.superEffectiveMultiplier) {
      for (const t of BATTLE_TYPES) {
        if (multipliers[t] > 1) multipliers[t] *= effect.superEffectiveMultiplier;
      }
    }
  }
  if (ability && DEFENSE_NOTES_ONLY[ability]) abilityNotes.push(DEFENSE_NOTES_ONLY[ability]);

  const entries = BATTLE_TYPES.map((type) => ({ type, multiplier: multipliers[type] }));
  const weaknesses = entries.filter((e) => e.multiplier > 1).sort((a, b) => b.multiplier - a.multiplier);
  const resistances = entries.filter((e) => e.multiplier > 0 && e.multiplier < 1).sort((a, b) => a.multiplier - b.multiplier);
  const immunities = entries.filter((e) => e.multiplier === 0).map((e) => e.type);
  const neutral = entries.filter((e) => e.multiplier === 1).map((e) => e.type);

  const differsFromTyping = BATTLE_TYPES.filter((t) => multipliers[t] !== base[t]).map(
    (t) => `${t} ${base[t]}x -> ${multipliers[t]}x`,
  );

  const list = (es: TypeMultiplier[]) => es.map((e) => `${e.type} ${e.multiplier}x`).join(', ');
  const head = `${types.join('/')}${ability ? ` + ${ability}` : ''}`;
  const summary =
    `${head} — weak to: ${weaknesses.length ? list(weaknesses) : 'nothing'}; ` +
    `resists: ${resistances.length ? list(resistances) : 'nothing'}; ` +
    `immune to: ${immunities.length ? immunities.join(', ') : 'nothing'}; ` +
    `neutral to everything else (${neutral.length} types).`;

  return {
    types,
    ability,
    multipliers,
    weaknesses,
    resistances,
    immunities,
    neutral,
    summary,
    abilityNotes: abilityNotes.length ? abilityNotes : undefined,
    differsFromTyping: differsFromTyping.length ? differsFromTyping : undefined,
    warning: mergedFormWarning(types),
  };
}

/**
 * Defensive profiles for a species: the typing-only table, plus one variant per ability that
 * actually changes it, plus notes for defensive abilities whose effect isn't type-based.
 */
export function defensiveProfilesForAbilities(
  types: string[],
  abilities: string[],
): {
  profile: DefensiveProfile;
  byAbility: DefensiveProfile[];
  otherDefensiveAbilityNotes?: string[];
} {
  const profile = defensiveProfile(types);
  const seen = new Set<string>();
  const byAbility: DefensiveProfile[] = [];
  const otherNotes: string[] = [];

  for (const ability of abilities) {
    if (!ability || seen.has(ability)) continue;
    seen.add(ability);
    if (typeDefenseAbility(ability)) {
      byAbility.push(defensiveProfile(types, { ability }));
    } else if (DEFENSE_NOTES_ONLY[ability]) {
      otherNotes.push(DEFENSE_NOTES_ONLY[ability]);
    }
  }

  return {
    profile,
    byAbility,
    otherDefensiveAbilityNotes: otherNotes.length ? otherNotes : undefined,
  };
}
