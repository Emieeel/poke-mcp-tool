/**
 * movedata.ts — Pokémon CHAMPIONS move lookups (get_move).
 *
 * Type, category, power, accuracy, PP and the in-game description come from
 * data/champions-moves.json (Serebii, see scripts/scrape-champions-moves.ts), together with what
 * Champions changed from Scarlet/Violet and its changed status conditions. Flags and target
 * come from @smogon/calc's Champions data, which is the more accurate source for those.
 */
import { toID } from '@smogon/calc';
import { gen } from './calc.js';
import { dataSource } from './datasource.js';

type Category = 'Physical' | 'Special' | 'Status';

interface MoveNumbers {
  type: string;
  category: Category;
  pp: number | null;
  basePower: number | null;
  accuracy: number | null;
}
type ChangeSide = MoveNumbers & { effectChance: number | null };
interface RawMovesFile {
  meta: { scrapedAt?: string; count?: number };
  moves: Record<string, MoveNumbers & { name: string; description: string }>;
  changesFromScarletViolet: Record<string, { champions: ChangeSide; scarletViolet: ChangeSide }>;
  statusConditions: { condition: string; scarletViolet: string; champions: string }[];
}

export interface MoveInfo extends MoveNumbers {
  name: string;
  /** The in-game description (empty when only the engine knows the move). */
  description: string;
  /** Who it hits, in @smogon/calc's terms ("normal", "allAdjacentFoes", ...). */
  target: string;
  /** The move's flags that are set (contact, sound, punch, slicing, ...). */
  flags: string[];
  /** What Champions changed from Scarlet/Violet, e.g. "Base power 80 -> 85". */
  changesFromScarletViolet?: string[];
  /** Champions' changed rules for a status condition this move inflicts. */
  statusConditionNotes?: string[];
  source: 'champions-moves' | 'smogon-calc';
}

const source = dataSource((raw: RawMovesFile) => ({
  raw,
  byId: new Map(Object.values(raw.moves).map((m) => [toID(m.name), m])),
}));
export const provideMovesData = source.provide;
export const registerMovesLoader = source.register;

const CHANGE_FIELDS: [keyof ChangeSide, string, string][] = [
  ['type', 'Type', ''],
  ['category', 'Category', ''],
  ['basePower', 'Base power', ''],
  ['accuracy', 'Accuracy', ''],
  ['pp', 'PP', ''],
  ['effectChance', 'Effect chance', '%'],
];

// Words a move's description uses when it inflicts the condition.
const STATUS_WORDS: Record<string, RegExp> = {
  Paralysis: /paraly/i,
  Sleep: /asleep|sleep/i,
  Freeze: /freez|frozen/i,
};

/** One move, as it works in Champions; falls back to the engine's numbers alone. */
export function getMoveInfo(name: string): MoveInfo | null {
  const engine = gen().moves.get(toID(name)) as any;
  const engineFacts = {
    target: engine?.target ?? '',
    flags: Object.entries(engine?.flags ?? {}).filter(([, on]) => on).map(([flag]) => flag),
  };
  const data = source.get();
  const move = data?.byId.get(toID(name));
  if (move && data) {
    const change = data.raw.changesFromScarletViolet[move.name];
    const show = (v: unknown, unit: string) => (v === null || v === undefined ? '--' : `${v}${unit}`);
    const changes = change
      ? CHANGE_FIELDS.filter(([key]) => change.scarletViolet[key] !== change.champions[key]).map(
          ([key, label, unit]) => `${label} ${show(change.scarletViolet[key], unit)} -> ${show(change.champions[key], unit)}`,
        )
      : [];
    // Listed as changed with no number changing: the change is in the description itself.
    if (change && changes.length === 0) changes.push('Effect changed (see description)');
    const statusNotes = data.raw.statusConditions
      .filter((s) => STATUS_WORDS[s.condition]?.test(move.description))
      .map((s) => `${s.condition} in Champions: ${s.champions} (Scarlet/Violet: ${s.scarletViolet}).`);
    return {
      name: move.name,
      type: move.type,
      category: move.category,
      basePower: move.basePower,
      accuracy: move.accuracy,
      pp: move.pp,
      description: move.description,
      ...engineFacts,
      ...(changes.length ? { changesFromScarletViolet: changes } : {}),
      ...(statusNotes.length ? { statusConditionNotes: statusNotes } : {}),
      source: 'champions-moves',
    };
  }
  if (!engine?.name) return null;
  return {
    name: engine.name,
    type: engine.type,
    category: engine.category ?? 'Status',
    basePower: engine.basePower || null,
    accuracy: null,
    pp: null,
    description: '',
    ...engineFacts,
    source: 'smogon-calc',
  };
}

/** Type/category/power for list views, from the Champions data when present. */
export function championsMoveNumbers(name: string) {
  const move = source.get()?.byId.get(toID(name));
  return move ? { name: move.name, type: move.type, category: move.category, basePower: move.basePower ?? 0 } : undefined;
}
