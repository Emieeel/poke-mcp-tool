/**
 * movedata.ts — Pokémon CHAMPIONS move data lookups (get_move).
 *
 * Source of truth is data/champions-moves.json, scraped from Serebii's Champions move pages
 * (see scripts/scrape-champions-moves.ts): effect text, effect chance, accuracy, PP, priority,
 * target and flags for every usable move, plus what Champions changed from Scarlet/Violet and
 * the status conditions it changed. @smogon/calc's Champions data has the numbers a damage calc
 * needs but none of that text, so it is only the fallback here.
 */
import { toID } from '@smogon/calc';
import { gen } from './calc.js';

// NOTE: intentionally free of `node:*` imports so it can be bundled for filesystem-less
// runtimes (Cloudflare Workers). Data arrives INJECTED via provideMovesData() or via a disk
// LOADER registered by the Node-only src/diskdata.ts.

type Category = 'Physical' | 'Special' | 'Status';

interface RawMove {
  name: string;
  slug: string;
  type: string;
  category: Category;
  pp: number | null;
  basePower: number | null;
  accuracy: number | null;
  effect: string;
  effectChance: number | null;
  critStage: number | null;
  priority: number;
  target: string;
  flags: Record<string, boolean>;
}
interface ChangeRow {
  type: string;
  category: Category;
  pp: number | null;
  basePower: number | null;
  accuracy: number | null;
  effectChance: number | null;
}
interface RawMovesFile {
  meta: { source?: string; scrapedAt?: string; count?: number };
  moves: Record<string, RawMove>;
  changesFromScarletViolet: Record<string, { effect: string; champions: ChangeRow; scarletViolet: ChangeRow }>;
  statusConditions: { condition: string; scarletViolet: string; champions: string }[];
}

export interface MoveInfo {
  name: string;
  type: string;
  category: Category;
  basePower: number | null;
  /** null = never misses. */
  accuracy: number | null;
  pp: number | null;
  priority: number;
  target: string;
  effect: string;
  effectChance: number | null;
  /** Critical-hit chance on its own (no Scope Lens, Focus Energy, ...), e.g. "1/8". */
  critChance: string | null;
  /** The move's flags that are set (contact, sound, punch, slicing, ...). */
  flags: string[];
  /** What Champions changed from Scarlet/Violet, e.g. "Base power 80 -> 85". */
  changesFromScarletViolet?: string[];
  /** Champions' changed rules for a status condition this move inflicts. */
  statusConditionNotes?: string[];
  source: 'champions-moves' | 'smogon-calc';
}

let indexCache: { byId: Map<string, RawMove>; raw: RawMovesFile } | null | undefined;

let injectedMoves: RawMovesFile | undefined;
export function provideMovesData(raw: unknown): void {
  injectedMoves = raw as RawMovesFile;
  indexCache = undefined;
}

type MovesLoader = () => RawMovesFile | null;
let diskLoader: MovesLoader | undefined;
export function registerMovesLoader(loader: MovesLoader): void {
  diskLoader = loader;
  indexCache = undefined;
}

function loadIndex() {
  if (indexCache !== undefined) return indexCache;
  const raw = injectedMoves ?? diskLoader?.() ?? null;
  indexCache = raw
    ? { byId: new Map(Object.values(raw.moves).map((m) => [toID(m.name), m])), raw }
    : null;
  return indexCache;
}

const CRIT_CHANCES = ['1/24', '1/8', '1/2', 'always'];

// "Paralysis" -> words a move's effect text uses when it inflicts that condition.
const STATUS_WORDS: Record<string, RegExp> = {
  Paralysis: /paraly/i,
  Sleep: /asleep|sleep/i,
  Freeze: /freez|frozen/i,
};

const CHANGE_FIELDS: [keyof ChangeRow, string, string][] = [
  ['type', 'Type', ''],
  ['category', 'Category', ''],
  ['basePower', 'Base power', ''],
  ['accuracy', 'Accuracy', ''],
  ['pp', 'PP', ''],
  ['effectChance', 'Effect chance', '%'],
];

function describeChanges(c: { champions: ChangeRow; scarletViolet: ChangeRow }): string[] {
  const show = (v: unknown, unit: string) => (v === null || v === undefined ? '--' : `${v}${unit}`);
  return CHANGE_FIELDS.filter(([key]) => c.scarletViolet[key] !== c.champions[key]).map(
    ([key, label, unit]) => `${label} ${show(c.scarletViolet[key], unit)} -> ${show(c.champions[key], unit)}`,
  );
}

/** Champions data for one move; falls back to the engine's Champions move data. */
export function getMoveInfo(name: string): MoveInfo | null {
  const idx = loadIndex();
  const hit = idx?.byId.get(toID(name));
  if (hit && idx) {
    const change = idx.raw.changesFromScarletViolet[hit.name];
    const changes = change ? describeChanges(change) : [];
    // Effect text that changed with no number changing (e.g. Make It Rain's -1 -> -2 SpA) still
    // shows up on Serebii's Updated Attacks page; point at it.
    if (change && changes.length === 0) changes.push('Effect changed (see effect text)');
    const statusNotes = idx.raw.statusConditions
      .filter((s) => STATUS_WORDS[s.condition]?.test(hit.effect))
      .map((s) => `${s.condition} in Champions: ${s.champions} (Scarlet/Violet: ${s.scarletViolet}).`);
    return {
      name: hit.name,
      type: hit.type,
      category: hit.category,
      basePower: hit.basePower,
      accuracy: hit.accuracy,
      pp: hit.pp,
      priority: hit.priority,
      target: hit.target,
      effect: hit.effect,
      effectChance: hit.effectChance,
      critChance: hit.critStage === null ? null : CRIT_CHANCES[Math.min(hit.critStage, 3)],
      flags: Object.entries(hit.flags).filter(([, v]) => v).map(([k]) => k),
      ...(changes.length ? { changesFromScarletViolet: changes } : {}),
      ...(statusNotes.length ? { statusConditionNotes: statusNotes } : {}),
      source: 'champions-moves',
    };
  }
  const m = gen().moves.get(toID(name)) as any;
  if (!m || !m.name) return null;
  return {
    name: m.name,
    type: m.type,
    category: m.category ?? 'Status',
    basePower: m.basePower || null,
    accuracy: null,
    pp: null,
    priority: m.priority ?? 0,
    target: m.target ?? '',
    effect: '',
    effectChance: null,
    critChance: null,
    flags: Object.entries(m.flags ?? {}).filter(([, v]) => v).map(([k]) => k),
    source: 'smogon-calc',
  };
}

/** Type/category/power for list views, from the Champions data when present. */
export function championsMoveNumbers(name: string): { name: string; type: string; category: Category; basePower: number } | undefined {
  const hit = loadIndex()?.byId.get(toID(name));
  return hit ? { name: hit.name, type: hit.type, category: hit.category, basePower: hit.basePower ?? 0 } : undefined;
}

/** Source URL + timestamp for the Champions move data, if loaded. */
export function championsMovesMeta(): RawMovesFile['meta'] | null {
  return loadIndex()?.raw.meta ?? null;
}
