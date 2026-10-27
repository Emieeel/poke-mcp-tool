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

// ── Defensive abilities that change a DEFENSIVE PROFILE ─────────────────────────
//
// These feed defensiveProfile() in calc.ts, which answers "what is this Pokémon weak to?".
// They are NOT applied to damage calcs — @smogon/calc already models every ability listed here
// natively inside calculate(), so applying them here too would double-count. This table exists
// purely so a profile can show the ability-adjusted matchups alongside the raw typing.
//
// Only abilities that actually appear in the Champions dex are listed. Effects that are not
// keyed on the attacking TYPE (Multiscale's full-HP halving, Fluffy's contact halving, ...) go
// in DEFENSE_NOTES_ONLY below instead of inventing a fake type multiplier for them.
export interface TypeDefenseAbility {
  /** Per-attacking-type multiplier applied to incoming damage (0 = immune). */
  typeMultipliers?: Record<string, number>;
  /** Multiplier applied to every super-effective hit (Filter / Solid Rock). */
  superEffectiveMultiplier?: number;
  /** What the ability does, including any part that is NOT reflected in the multipliers. */
  note: string;
}

export const DEFENSIVE_TYPE_ABILITIES: Record<string, TypeDefenseAbility> = {
  Levitate: {
    typeMultipliers: { Ground: 0 },
    note: 'Levitate: immune to Ground-type moves. Lost under Gravity, or while holding an Iron Ball.',
  },
  // Champions-original; the damage-relevant half is exactly Levitate (see DEFENSIVE_ABILITIES).
  Eelevate: {
    typeMultipliers: { Ground: 0 },
    note: 'Eelevate: immune to Ground-type moves (plus a post-KO stat boost that does not affect damage taken).',
  },
  'Earth Eater': {
    typeMultipliers: { Ground: 0 },
    note: 'Earth Eater: Ground-type moves heal it instead of damaging it.',
  },
  'Flash Fire': {
    typeMultipliers: { Fire: 0 },
    note: 'Flash Fire: immune to Fire-type moves, and powers up its own Fire moves when hit by one.',
  },
  'Water Absorb': {
    typeMultipliers: { Water: 0 },
    note: 'Water Absorb: Water-type moves heal it instead of damaging it.',
  },
  'Volt Absorb': {
    typeMultipliers: { Electric: 0 },
    note: 'Volt Absorb: Electric-type moves heal it instead of damaging it.',
  },
  'Lightning Rod': {
    typeMultipliers: { Electric: 0 },
    note: 'Lightning Rod: draws in Electric-type moves, taking no damage and raising its Sp. Atk instead.',
  },
  'Motor Drive': {
    typeMultipliers: { Electric: 0 },
    note: 'Motor Drive: immune to Electric-type moves, raising its Speed instead.',
  },
  'Sap Sipper': {
    typeMultipliers: { Grass: 0 },
    note: 'Sap Sipper: immune to Grass-type moves, raising its Attack instead.',
  },
  'Dry Skin': {
    typeMultipliers: { Water: 0, Fire: 1.25 },
    note: 'Dry Skin: Water-type moves heal it, but Fire-type moves deal 25% MORE damage. It also loses HP in sun and recovers in rain.',
  },
  'Thick Fat': {
    typeMultipliers: { Fire: 0.5, Ice: 0.5 },
    note: 'Thick Fat: halves damage from Fire- and Ice-type moves.',
  },
  Heatproof: {
    typeMultipliers: { Fire: 0.5 },
    note: 'Heatproof: halves damage from Fire-type moves (and halves burn damage).',
  },
  'Water Bubble': {
    typeMultipliers: { Fire: 0.5 },
    note: 'Water Bubble: halves damage from Fire-type moves, doubles the power of its own Water moves, and prevents burns.',
  },
  Fluffy: {
    typeMultipliers: { Fire: 2 },
    note: 'Fluffy: takes DOUBLE damage from Fire-type moves, but halves damage from contact moves (a contact check, not a type one, so it is not in the multipliers below).',
  },
  'Purifying Salt': {
    typeMultipliers: { Ghost: 0.5 },
    note: 'Purifying Salt: halves damage from Ghost-type moves and blocks all status conditions.',
  },
  Filter: {
    superEffectiveMultiplier: 0.75,
    note: 'Filter: reduces damage from super-effective hits to 3/4.',
  },
  'Solid Rock': {
    superEffectiveMultiplier: 0.75,
    note: 'Solid Rock: reduces damage from super-effective hits to 3/4.',
  },
};

// Defensive abilities whose effect is real but NOT keyed on the attacking type, so they change
// nothing in a type-multiplier table. Surfaced as plain notes on a defensive profile so the
// full defensive picture is visible without pretending these are type matchups.
export const DEFENSE_NOTES_ONLY: Record<string, string> = {
  Multiscale: 'Multiscale: halves damage from any move taken at full HP.',
  'Punk Rock': 'Punk Rock: halves damage from sound-based moves (and boosts its own).',
  Bulletproof: 'Bulletproof: immune to ball and bomb moves (Shadow Ball, Sludge Bomb, ...) regardless of their type.',
  Overcoat: 'Overcoat: immune to powder/spore moves and to weather damage.',
  'Thermal Exchange': 'Thermal Exchange: cannot be burned, and raises its Attack when hit by a Fire-type move — but takes normal Fire damage.',
  'Rough Skin': 'Rough Skin: damages attackers that make contact; it does not reduce damage taken.',
  'Magic Guard': 'Magic Guard: takes damage only from direct attacks (no damage from poison, burn, hazards, weather, recoil).',
  'Ice Body': 'Ice Body: recovers HP each turn in snow; it does not reduce damage taken.',
  'Marvel Scale': 'Marvel Scale: raises Defense by 50% while statused.',
  'Shell Armor': 'Shell Armor: cannot be hit by critical hits.',
  'Battle Armor': 'Battle Armor: cannot be hit by critical hits.',
};

export function typeDefenseAbility(name?: string): TypeDefenseAbility | undefined {
  return name ? DEFENSIVE_TYPE_ABILITIES[name] : undefined;
}

export function offensiveAbility(name?: string): OffensiveAbility | undefined {
  return name ? OFFENSIVE_ABILITIES[name] : undefined;
}
export function defensiveAbility(name?: string): DefensiveAbility | undefined {
  return name ? DEFENSIVE_ABILITIES[name] : undefined;
}
