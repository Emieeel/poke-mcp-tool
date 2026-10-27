/**
 * abilities.ts — how abilities change a Pokémon's DEFENSIVE PROFILE ("what is it weak to?").
 *
 * Damage calcs don't use this file: @smogon/calc's Champions generation models every ability,
 * the Champions-original ones included (Mega Sol, Dragonize, Fire Mane, Piercing Drill,
 * Eelevate, Aura Guard, ...). These tables exist only so get_pokemon can show ability-adjusted
 * type matchups next to the raw typing.
 */

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
  // Champions-original; the damage-relevant half is exactly Levitate.
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
  'Aura Guard': 'Aura Guard: halves damage from moves that make contact.',
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
