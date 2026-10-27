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
import { getSpeciesOverride } from './dex.js';
import {
  offensiveAbility,
  defensiveAbility,
  typeDefenseAbility,
  DEFENSE_NOTES_ONLY,
  NO_DAMAGE_EFFECT,
} from './abilities.js';
import { resolveBasePower } from './moves.js';

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

// --- Pokémon Champions Stat Points (the EV/IV replacement) -------------------
//
// Champions threw out the traditional EV (0–252/stat, 510 total) and IV (0–31) systems and
// replaced BOTH with Stat Points (SP): 1 SP = +1 to that stat at the fixed Level 50 battle
// format, capped at 32 SP per stat and 66 SP total, and every Pokémon is treated as having
// maxed (31) IVs. (See Serebii/Bulbapedia/Champions stat-point guides.)
//
// We reproduce this exactly on top of @smogon/calc's real stat formula rather than faking it:
// with IV = 31 at Level 50, that formula bumps a stat by exactly one point at EV = 4, 12, 20,
// …, 252 — i.e. EV = 8·SP − 4 (clamped at 0). So 32 SP maps precisely onto the 252-EV cap and
// each SP contributes exactly one final stat point. No approximation; the engine still does
// the math.
export const MAX_SP_PER_STAT = 32;
export const MAX_SP_TOTAL = 66;

// Convert Stat Points to the EV the engine expects. Unspecified stats are 0 SP (the Champions
// default), and must yield a concrete 0 EV — a missing/undefined EV makes @smogon/calc compute
// a NaN stat rather than defaulting to 0.
export function spToEv(sp?: number): number {
  return Math.max(0, 8 * (sp ?? 0) - 4);
}

// Inverse of spToEv. @smogon/calc's calc string (result.desc()) is written in EV units; we
// translate those numbers back into Stat Points so NOTHING the tool emits speaks the old EV
// system. The EVs the engine ever sees here are exactly {0, 4, 12, …, 252}, which invert
// cleanly: SP = (EV + 4) / 8 for EV ≥ 4, and 0 EV → 0 SP.
export function evToSp(ev: number): number {
  return ev <= 0 ? 0 : Math.round((ev + 4) / 8);
}

// Stat investment in @smogon/calc's desc string looks like "252+ SpA" / "12 HP" / "0 SpD".
// Rewrite each "<ev><+/-?> <Stat>" occurrence into Stat Points, preserving the nature marker
// (+/-) and spacing. The trailing \s+ before the stat keeps this from matching KO text like
// "4HKO" or move power like "150 BP".
const DESC_STAT_INVEST = /(\d+)([+-]?)(\s+)(HP|Atk|Def|SpA|SpD|Spe)\b/g;
export function descToStatPoints(desc: string): string {
  return desc.replace(
    DESC_STAT_INVEST,
    (_m, ev: string, sign: string, ws: string, stat: string) =>
      `${evToSp(Number(ev))}${sign}${ws}${stat}`,
  );
}

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
  name: z.string().describe('Species name, e.g. "Garchomp" or "Staraptor-Mega".'),
  // Champions battles are always Level 50; keep the field configurable but default to 50.
  level: z.number().int().min(1).max(100).default(50),
  item: z.string().optional().describe('Held item, e.g. "Choice Band".'),
  ability: z.string().optional().describe('Ability name, e.g. "Intimidate".'),
  nature: z.string().optional().describe('Nature, e.g. "Adamant". Defaults to Serious.'),
  statPoints: statPointsSchema
    .optional()
    .describe(
      'Pokémon Champions Stat Points (SP) per stat — the EV/IV replacement. 1 SP = +1 to ' +
      'that stat at Level 50; max 32 per stat, 66 total. IVs do not exist in Champions ' +
      '(treated as maxed). Defaults to 0 in every stat.',
    ),
  boosts: boostsSchema.optional().describe('Stat stage boosts per stat (-6..+6).'),
  teraType: z.enum(TYPE_NAMES).optional().describe('Tera type, if Terastallized.'),
  status: z.enum(STATUSES).optional().describe('Status condition.'),
})
  // Champions uses Stat Points, not EVs/IVs. Reject the legacy `evs`/`ivs` keys loudly (instead
  // of silently ignoring them) so an old-style call fails fast and the caller switches to
  // `statPoints` rather than wondering why their EV spread had no effect.
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

  // Translate Champions Stat Points into the EVs @smogon/calc's formula expects (EV = 8·SP−4),
  // and force maxed IVs since Champions has no IV system. The engine then produces exactly
  // "+1 final stat per SP" at Level 50 — see the spToEv() note above.
  const sp = input.statPoints ?? {};
  const evs = {
    hp: spToEv(sp.hp),
    atk: spToEv(sp.atk),
    def: spToEv(sp.def),
    spa: spToEv(sp.spa),
    spd: spToEv(sp.spd),
    spe: spToEv(sp.spe),
  };
  const maxedIvs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };

  const pokemon = new Pokemon(g, input.name, {
    level: input.level,
    item: input.item as any,
    ability: (engineAbilityAlias ?? resolvedAbility) as any,
    nature: input.nature as any,
    evs,
    ivs: maxedIvs,
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

export interface MoveEffectivenessResult {
  /** The move's type AS RESOLVED by the engine (after Aerilate, Weather Ball in sun, ...). */
  moveType: string;
  /** The defender's types actually used (its Tera type alone, if Terastallized). */
  defenderTypes: string[];
  multiplier: number;
  perType: TypeMultiplier[];
  /** "super effective" | "not very effective" | "neutral" | "no effect". */
  label: string;
  /** The line the game prints for this hit, e.g. "It's super effective!". */
  message: string;
  note?: string;
  /** Set when the defender's typing is suspect (see MERGED_FORM_WARNING). */
  warning?: string;
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
 * (Aerilate making Double-Edge Flying), weather retypes (Weather Ball in sun), Tera types and
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
  const tera = def.teraType && def.teraType !== 'Stellar' ? (def.teraType as string) : undefined;
  const defenderTypes: string[] = (tera ? [tera] : (def.types as string[])).filter(Boolean);

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
  if (tera) notes.push(`Defender is Terastallized to ${tera}, so only that type is used for effectiveness.`);
  if (mv.category === 'Status') notes.push('Status move: this is the type matchup, not damage dealt.');

  return {
    moveType: mv.type,
    defenderTypes,
    multiplier,
    perType,
    label: effectivenessLabel(multiplier),
    message: effectivenessMessage(multiplier, result.defender.name),
    note: notes.length ? notes.join(' ') : undefined,
    // Only meaningful when the defender's real typing was used; a Tera type is a single type.
    warning: tera ? undefined : mergedFormWarning(defenderTypes),
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
}): DamageResult {
  const g = gen();
  const notes: string[] = [];

  // Resolve Champions-original abilities before building calc objects.
  const atkAbilityEffect = offensiveAbility(args.attacker.ability);
  const defAbilityEffect = defensiveAbility(args.defender.ability);

  // Defensive ability: pass engine alias so @smogon/calc models the effect natively.
  const { pokemon: defender, autofilled: defAuto } = buildPokemon(
    g, args.defender, defAbilityEffect?.engineAlias,
  );
  if (defAbilityEffect) notes.push(defAbilityEffect.note);

  // Offensive ability: no engine alias needed (we post-process), but still build normally.
  const { pokemon: attacker, autofilled: atkAuto } = buildPokemon(g, args.attacker);

  // Build the move. IMPORTANT: calculate() internally calls move.clone(), and clone() rebuilds
  // the move from its name + `overrides` ONLY — a post-construction `move.bp = ` or
  // `move.type = ` is silently discarded by that clone. So every adjustment we want the engine
  // to actually apply (retype for STAB/effectiveness, scaled base power) MUST go through the
  // constructor's `overrides`, not a mutation. We probe once to read the move's canonical
  // name/type, then build the real move with whatever overrides we need.
  const probe = new Move(g, args.move);
  const originalMoveType = probe.type;
  const moveOverrides: { type?: string; basePower?: number } = {};

  // Offensive ability retype (e.g. Dragonize turns Normal moves Dragon) — via overrides so the
  // engine computes type effectiveness + STAB on the NEW type.
  const resolvedMoveType =
    atkAbilityEffect?.moveTypeChange && probe.type === atkAbilityEffect.moveTypeChange.from
      ? atkAbilityEffect.moveTypeChange.to
      : probe.type;
  if (resolvedMoveType !== probe.type) {
    moveOverrides.type = resolvedMoveType;
  }

  // Base power, resolved in one place so the engine sees the final number (it clones the move
  // and only honors `overrides`). Start from the move's own BP, scale it for battle-history
  // moves / caller overrides (Rage Fist, Last Respects, basePowerOverride), then fold in any
  // "+X% power" offensive ability (Fire Mane, Dragonize) — the game applies these as a
  // base-power modifier, which matches the reference calculator exactly. probe.name is
  // canonical even for aliased forms.
  const bpResolved = resolveBasePower(probe.name, args.moveContext);
  if (bpResolved) notes.push(bpResolved.note);
  let basePower = bpResolved?.bp ?? probe.bp;
  if (atkAbilityEffect?.bpMultiplier) {
    const mult = atkAbilityEffect.bpMultiplier(resolvedMoveType, originalMoveType);
    if (mult !== 1) basePower = Math.max(1, Math.round(basePower * mult));
  }
  if (basePower !== probe.bp) moveOverrides.basePower = basePower;

  const move = new Move(g, args.move, { overrides: moveOverrides as any });

  const field = buildField(args.field);
  // Offensive abilities that act as if a weather is present (Mega Sol -> Sun). Set it on the
  // field so the engine applies the full weather package, but never override a real weather the
  // caller already specified.
  if (atkAbilityEffect?.weather && !(field as any).weather) {
    (field as any).weather = atkAbilityEffect.weather;
  }

  // Handle Piercing Drill: if defender is protected and the move is contact, we still calc
  // through but will scale damage to the bypass fraction afterward.
  const isProtected = Boolean(args.field?.isProtected);
  const isContact = Boolean((move as any).flags?.contact);
  let bypassingProtect = false;
  if (atkAbilityEffect?.bypassProtect && isProtected && isContact) {
    // Remove Protect from the field so the engine computes full damage (we scale after).
    (field.defenderSide as any).isProtected = false;
    bypassingProtect = true;
  }

  const result = calculate(g, attacker, defender, move, field);

  // result.damage can be a number, an array of rolls, or (rarely) nested arrays.
  let rolls = normalizeRolls(result.damage as number | number[]);

  // NB: offensive-ability power boosts (Fire Mane, Dragonize) are already folded into the move's
  // base power above, and weather effects (Mega Sol) into the field, so the engine has applied
  // them natively here — nothing to post-multiply.

  // Apply Piercing Drill bypass fraction.
  if (bypassingProtect && atkAbilityEffect?.bypassProtect) {
    const frac = atkAbilityEffect.bypassProtect.fraction;
    rolls = rolls.map((r) => Math.max(1, Math.round(r * frac)));
  }

  if (atkAbilityEffect) notes.push(atkAbilityEffect.note);

  // Surface NO_DAMAGE_EFFECT abilities as notes (recognized but don't alter the calc).
  const atkNoDmg = args.attacker.ability ? NO_DAMAGE_EFFECT[args.attacker.ability] : undefined;
  const defNoDmg = args.defender.ability ? NO_DAMAGE_EFFECT[args.defender.ability] : undefined;
  if (atkNoDmg) notes.push(atkNoDmg);
  if (defNoDmg) notes.push(defNoDmg);

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
  if (attacker.teraType) notes.push(`Attacker Terastallized to ${attacker.teraType}.`);
  if (bypassingProtect) notes.push('Piercing Drill bypassed Protect; damage is 1/4 of the full hit.');

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
    // result.desc() writes stat investment in EV units; translate it back into Champions
    // Stat Points so the calc string never exposes the old EV/IV system.
    description = descToStatPoints(result.desc());
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
 * The 18 real battle types, in canonical order. TYPE_NAMES additionally carries "Stellar" and
 * "???", which are Tera/typeless markers rather than types a defender can be hit by, so they
 * are excluded from defensive profiles.
 */
export const BATTLE_TYPES: string[] = TYPE_NAMES.filter(
  (t) => t !== 'Stellar' && t !== '???',
);

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
