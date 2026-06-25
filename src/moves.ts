/**
 * moves.ts — Pokémon CHAMPIONS moves whose BASE POWER scales with battle HISTORY, which
 * @smogon/calc cannot model on its own.
 *
 * @smogon/calc recomputes a move's base power from the CURRENT snapshot it's handed: Gyro
 * Ball from Speed, Stored Power from boosts, Low Kick from weight, Eruption from HP, ... —
 * all of those it does natively. What it has no concept of is battle HISTORY: how many times
 * the user has been hit, or how many teammates have fainted. So moves that accumulate power
 * over the course of a battle fall through to their flat base 50 BP every time.
 *
 * We compute the scaled base power here and feed it to the engine (which still handles STAB,
 * typing, items, weather, spread reduction, crits, ...). For any OTHER variable-power move we
 * don't special-case, calculate_damage also accepts a raw `basePowerOverride`, so the caller
 * can always pin the exact BP and let the engine do the rest. That keeps the calculator
 * flexible without us hand-reimplementing every dynamic-power formula.
 */

export interface MoveContext {
  /** Rage Fist: times the user has been hit by a damaging move this battle (+50 BP each). */
  timesHit?: number;
  /** Last Respects: Pokémon that have fainted on the user's side this battle (+50 BP each). */
  faintedAllies?: number;
  /**
   * Escape hatch: force the move's base power to this exact value. Wins over the named-move
   * counters above and works for ANY variable-power move the engine doesn't model.
   */
  basePowerOverride?: number;
}

interface StackingMove {
  /** Which MoveContext counter drives this move (used to hint when it's missing). */
  readonly counter: 'timesHit' | 'faintedAllies';
  /** Effective base power + a human note, from the battle-history count. */
  compute(count: number): { bp: number; note: string };
}

// Rage Fist: 50 + 50 per hit taken, capped at 350 BP (reached after 6 hits).
const RAGE_FIST = { base: 50, step: 50, maxBp: 350 } as const;
// Last Respects: 50 + 50 per fainted ally; the count X is capped at 100 by the move itself.
const LAST_RESPECTS = { base: 50, step: 50, maxCount: 100 } as const;

export const STACKING_MOVES: Record<string, StackingMove> = {
  'Rage Fist': {
    counter: 'timesHit',
    compute(hits) {
      const x = Math.max(0, Math.floor(hits));
      const uncapped = RAGE_FIST.base + RAGE_FIST.step * x;
      const bp = Math.min(RAGE_FIST.maxBp, uncapped);
      const capped = uncapped > RAGE_FIST.maxBp;
      return {
        bp,
        note:
          `Rage Fist scaled to ${bp} BP (50 + 50 × ${x} hit${x === 1 ? '' : 's'} taken` +
          `${capped ? `; capped at ${RAGE_FIST.maxBp}` : ''}).`,
      };
    },
  },
  'Last Respects': {
    counter: 'faintedAllies',
    compute(fainted) {
      const raw = Math.max(0, Math.floor(fainted));
      const x = Math.min(LAST_RESPECTS.maxCount, raw);
      const bp = LAST_RESPECTS.base + LAST_RESPECTS.step * x;
      const capped = raw > LAST_RESPECTS.maxCount;
      return {
        bp,
        note:
          `Last Respects scaled to ${bp} BP (50 + 50 × ${x} fainted all${x === 1 ? 'y' : 'ies'}` +
          `${capped ? `; count capped at ${LAST_RESPECTS.maxCount}` : ''}).`,
      };
    },
  },
};

/**
 * Resolve the effective base power for a move given the caller's battle-history context.
 * Returns undefined when no context applies, so the engine's own (static or snapshot-based)
 * base power is left untouched. `moveName` must be the canonical engine name (move.name).
 */
export function resolveBasePower(
  moveName: string,
  ctx?: MoveContext,
): { bp: number; note: string } | undefined {
  if (!ctx) return undefined;

  // Explicit override always wins — the universal escape hatch.
  if (typeof ctx.basePowerOverride === 'number') {
    const bp = Math.max(1, Math.round(ctx.basePowerOverride));
    return { bp, note: `${moveName} base power forced to ${bp} BP (caller-supplied override).` };
  }

  const stack = STACKING_MOVES[moveName];
  if (stack) {
    const count = ctx[stack.counter];
    if (typeof count === 'number') return stack.compute(count);
  }
  return undefined;
}
