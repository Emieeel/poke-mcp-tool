/**
 * abilities.ts — manual implementations of Pokémon CHAMPIONS-original abilities that
 * @smogon/calc doesn't know, so they actually affect damage calcs.
 *
 * @smogon/calc applies ability effects by hardcoded logic keyed on the ability NAME, so an
 * unknown Champions ability does nothing on its own. We bridge that here using three levers:
 *
 *   1. engineAlias — pass an equivalent ability @smogon/calc DOES understand (e.g. model
 *      "Eelevate" as "Levitate" for its Ground immunity). The engine then handles it natively.
 *   2. moveTypeChange — change the move's type via the engine's move `overrides` (e.g.
 *      "Dragonize" turns Normal moves into Dragon), so the engine computes type effectiveness
 *      + STAB on the NEW type. (Must go through overrides: calculate() clones the move and a
 *      post-construction `move.type =` is discarded by that clone.)
 *   3. bpMultiplier — fold a "+X% power" boost into the move's BASE POWER via overrides, which
 *      is where the game applies these (e.g. "Fire Mane" +50% to Fire moves: 100→150 BP). This
 *      matches the reference calculator exactly; a post-hoc roll multiply mis-rounds.
 *   4. weather — act as if a weather is in effect (e.g. "Mega Sol" = harsh sunlight = Sun), set
 *      on the Field so the engine applies ALL of that weather's effects natively: the Fire ×1.5
 *      / Water ×0.5 modifiers AND Weather Ball's retype-to-Fire-at-100-BP, Solar Beam, etc.
 *
 * Each effect cites the in-game (Serebii) description it implements. Effects that don't change
 * a damage roll (e.g. "Spicy Spray" burns on contact) are listed as notes only.
 */

export interface OffensiveAbility {
  /** If the move's (current) type matches, change it to this type (via the move's overrides). */
  moveTypeChange?: { from: string; to: string };
  /**
   * "+X% power" boost folded into the move's BASE POWER (the game applies these as a base-power
   * modifier). Given the move's resolved (possibly retyped) type and its original type.
   */
  bpMultiplier?: (moveType: string, originalType: string) => number;
  /** Act as if this weather is in effect (e.g. Mega Sol -> "Sun"); set on the Field. */
  weather?: string;
  /** Whether contact moves bypass the target's Protect (dealing reduced damage). */
  bypassProtect?: { fraction: number };
  /** Human-readable note describing what was applied. */
  note: string;
}

export interface DefensiveAbility {
  /** Replace the defender's ability with one @smogon/calc understands. */
  engineAlias?: string;
  note: string;
}

// ── Offensive (attacker) abilities ──────────────────────────────────────────────
export const OFFENSIVE_ABILITIES: Record<string, OffensiveAbility> = {
  // "Boosts the power of the Pokémon's Fire-type moves by 50%." Folded into base power.
  'Fire Mane': {
    bpMultiplier: (t) => (t === 'Fire' ? 1.5 : 1),
    note: 'Fire Mane: +50% base power to Fire-type moves.',
  },
  // "The Pokémon's Normal-type moves become Dragon-type moves and their power is boosted by 20%."
  // Retype via overrides + fold the +20% into base power (matches the reference calculator).
  Dragonize: {
    moveTypeChange: { from: 'Normal', to: 'Dragon' },
    bpMultiplier: (_t, orig) => (orig === 'Normal' ? 1.2 : 1),
    note: 'Dragonize: Normal-type moves become Dragon-type, +20% base power.',
  },
  // "...can use its moves as if the weather were harsh sunlight." We model this as actual Sun
  // on the field, so the engine applies the full package: Fire ×1.5 / Water ×0.5, plus Weather
  // Ball becoming 100 BP Fire, Solar Beam skipping charge, etc.
  'Mega Sol': {
    weather: 'Sun',
    note: 'Mega Sol: acts as if in harsh sunlight (modeled as Sun: Fire ×1.5, Water ×0.5, Weather Ball -> 100 BP Fire, ...).',
  },
  // "When the Pokémon uses contact moves, it can hit even targets that are protecting
  // themselves, dealing 1/4 of the damage..."
  'Piercing Drill': {
    bypassProtect: { fraction: 0.25 },
    note: 'Piercing Drill: contact moves hit through Protect for 1/4 damage.',
  },
};

// ── Defensive (defender) abilities ──────────────────────────────────────────────
export const DEFENSIVE_ABILITIES: Record<string, DefensiveAbility> = {
  // "...immune to Ground-type moves..." (plus a post-KO stat boost we don't model). The
  // damage-relevant half is exactly Levitate's Ground immunity.
  Eelevate: {
    engineAlias: 'Levitate',
    note: 'Eelevate modeled as Levitate (immune to Ground-type moves). Its post-KO stat boost is not damage-relevant.',
  },
};

// Champions-original abilities with no effect on a damage roll — surfaced as a note so the
// model knows we recognized them and chose not to alter the numbers.
export const NO_DAMAGE_EFFECT: Record<string, string> = {
  'Spicy Spray': 'Spicy Spray burns the attacker on contact; it does not change damage dealt.',
};

export function offensiveAbility(name?: string): OffensiveAbility | undefined {
  return name ? OFFENSIVE_ABILITIES[name] : undefined;
}
export function defensiveAbility(name?: string): DefensiveAbility | undefined {
  return name ? DEFENSIVE_ABILITIES[name] : undefined;
}
