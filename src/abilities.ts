/**
 * abilities.ts — manual implementations of Pokémon CHAMPIONS-original abilities that
 * @smogon/calc doesn't know, so they actually affect damage calcs.
 *
 * @smogon/calc applies ability effects by hardcoded logic keyed on the ability NAME, so an
 * unknown Champions ability does nothing on its own. We bridge that here using three levers:
 *
 *   1. engineAlias — pass an equivalent ability @smogon/calc DOES understand (e.g. model
 *      "Eelevate" as "Levitate" for its Ground immunity). The engine then handles it natively.
 *   2. moveTypeOverride — change the move's type before the calc (e.g. "Dragonize" turns
 *      Normal moves into Dragon), so the engine computes type effectiveness + STAB correctly.
 *   3. damageMultiplier — a final multiplier we apply to the damage rolls ourselves, for
 *      flat power boosts the engine can't be told about (e.g. "Fire Mane" +50% to Fire moves).
 *
 * Each effect cites the in-game (Serebii) description it implements. Effects that don't change
 * a damage roll (e.g. "Spicy Spray" burns on contact) are listed as notes only.
 */

export interface OffensiveAbility {
  /** If the move's (current) type matches, change it to this type before calc. */
  moveTypeChange?: { from: string; to: string };
  /** Multiplier applied to final damage, given the move's (possibly changed) type. */
  multiplier?: (moveType: string, originalType: string) => number;
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
  // "Boosts the power of the Pokémon's Fire-type moves by 50%."
  'Fire Mane': {
    multiplier: (t) => (t === 'Fire' ? 1.5 : 1),
    note: 'Fire Mane: +50% power to Fire-type moves.',
  },
  // "The Pokémon's Normal-type moves become Dragon-type moves and their power is boosted by 20%."
  Dragonize: {
    moveTypeChange: { from: 'Normal', to: 'Dragon' },
    multiplier: (_t, orig) => (orig === 'Normal' ? 1.2 : 1),
    note: 'Dragonize: Normal-type moves become Dragon-type, +20% power.',
  },
  // "...can use its moves as if the weather were harsh sunlight." For damage that means the
  // user's Fire moves ×1.5 and Water moves ×0.5 (the offensive half of harsh sun).
  'Mega Sol': {
    multiplier: (t) => (t === 'Fire' ? 1.5 : t === 'Water' ? 0.5 : 1),
    note: 'Mega Sol: acts as if in harsh sunlight (its Fire moves ×1.5, Water moves ×0.5).',
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
