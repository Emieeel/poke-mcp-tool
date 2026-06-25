/**
 * movedex.ts — reverse move-index over the Champions dex, scoped to a regulation.
 *
 * Two questions this answers:
 *   - "Which moves are legal in regulation X?"  -> listLegalMoves
 *   - "Which legal Pokémon can learn move M?"   -> findPokemonByMove
 *
 * IMPORTANT: Champions publishes NO per-move bans (see regulations.ts / the m-b file note).
 * So "a move is legal in a regulation" is defined honestly as "at least one Pokémon that is
 * legal in that regulation can learn it" — derived purely from per-Pokémon learnsets in the
 * Champions dex (data/champions-dex.json) intersected with the regulation's legal pool. We do
 * NOT fabricate a curated legal-move list.
 *
 * Move TYPE/CATEGORY/base power are enriched from the engine data bundled in @smogon/calc
 * (the same source calc.ts uses); a Champions move the engine has never heard of still appears
 * by name, just without that metadata.
 */
import { toID } from '@smogon/calc';
import { gen } from './calc.js';
import { getPokemonInfo } from './dex.js';
import { loadRegulation, type Regulation } from './regulations.js';

export interface MoveMeta {
  /** Engine-canonical move name, e.g. "Close Combat". */
  name: string;
  type?: string;
  /** "Physical" | "Special" | "Status". */
  category?: string;
  basePower?: number;
}

/** Look up a move's type/category/base power from the @smogon/calc engine dex. */
export function getMoveMeta(name: string): MoveMeta | undefined {
  const m = gen().moves.get(toID(name)) as
    | { name: string; type?: string; category?: string; basePower?: number }
    | undefined;
  if (!m || !m.name) return undefined;
  return { name: m.name, type: m.type, category: m.category, basePower: m.basePower };
}

/**
 * The legal Pokémon pool for a regulation, each with its Champions learnset and dex number.
 * Skips entries we can't resolve in the dex (reported via the returned `unresolved` list).
 */
function legalPool(reg: Regulation): {
  pool: { name: string; num: number | null; moves: string[] }[];
  unresolved: string[];
} {
  const pool: { name: string; num: number | null; moves: string[] }[] = [];
  const unresolved: string[] = [];
  for (const entry of reg.legalPokemon) {
    const info = getPokemonInfo(entry.name);
    // Only the Champions dex carries learnsets; the @smogon/calc fallback returns moves: [].
    if (info && info.source === 'champions-dex') {
      pool.push({ name: info.name, num: info.num ?? null, moves: info.moves });
    } else {
      unresolved.push(entry.name);
    }
  }
  return { pool, unresolved };
}

export interface FindPokemonByMoveResult {
  regulation: string;
  regulationName: string;
  move: MoveMeta & { queried: string };
  learnable: boolean;
  count: number;
  pokemon: { name: string; num: number | null }[];
  notes: string[];
}

/**
 * List the Pokémon that are legal in `regulationId` AND can learn `move`.
 * Move matching is by normalized id (toID), so "willowisp"/"Will-O-Wisp" etc. all match.
 */
export function findPokemonByMove(regulationId: string, move: string): FindPokemonByMoveResult {
  const reg = loadRegulation(regulationId);
  const meta = getMoveMeta(move);
  const wantId = toID(move);
  if (!wantId) {
    throw new Error(`Empty or invalid move name: "${move}".`);
  }

  const { pool, unresolved } = legalPool(reg);
  const learners = pool
    .filter((p) => p.moves.some((m) => toID(m) === wantId))
    .map((p) => ({ name: p.name, num: p.num }))
    .sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || a.name.localeCompare(b.name));

  const notes: string[] = [];
  if (!meta) {
    notes.push(
      `"${move}" was not found in the engine move data; type/category/power are unavailable. ` +
        `Results below match the learnset name regardless.`,
    );
  }
  notes.push(
    `Champions publishes no per-move bans, so "legal move" means a Pokémon legal in ` +
      `${reg.meta.name} can learn it. Learnsets come from the Champions dex.`,
  );
  if (unresolved.length > 0) {
    notes.push(
      `${unresolved.length} legal Pokémon could not be resolved in the Champions dex and were ` +
        `skipped (run \`npm run scrape:dex\`): ${unresolved.slice(0, 5).join(', ')}` +
        `${unresolved.length > 5 ? ', …' : ''}.`,
    );
  }

  return {
    regulation: reg.meta.id,
    regulationName: reg.meta.name,
    move: { queried: move, name: meta?.name ?? move, type: meta?.type, category: meta?.category, basePower: meta?.basePower },
    learnable: learners.length > 0,
    count: learners.length,
    pokemon: learners,
    notes,
  };
}

export interface LegalMoveEntry extends MoveMeta {
  /** Serebii learnset name (kept as the stable display name; equals engine name when known). */
  displayName: string;
  /** How many Pokémon legal in this regulation can learn it. */
  learnableByCount: number;
}

export interface ListLegalMovesResult {
  regulation: string;
  regulationName: string;
  totalLegalMoves: number;
  count: number;
  filter: { nameContains?: string; type?: string; category?: string };
  moves: LegalMoveEntry[];
  notes: string[];
}

const MOVE_CATEGORIES = ['Physical', 'Special', 'Status'] as const;
export type MoveCategory = (typeof MOVE_CATEGORIES)[number];

/**
 * List every move learnable by at least one Pokémon legal in `regulationId` (the regulation's
 * legal move pool), enriched with type/category/base power and a count of how many legal
 * Pokémon learn each. Optional filters narrow by name substring, move type, or category.
 */
export function listLegalMoves(
  regulationId: string,
  opts: { nameContains?: string; type?: string; category?: MoveCategory } = {},
): ListLegalMovesResult {
  const reg = loadRegulation(regulationId);
  const { pool, unresolved } = legalPool(reg);

  // Union of learnsets, deduped by normalized move id, counting how many legal Pokémon learn each.
  const byId = new Map<string, { displayName: string; count: number }>();
  for (const p of pool) {
    const seenThisMon = new Set<string>();
    for (const raw of p.moves) {
      const id = toID(raw);
      if (!id || seenThisMon.has(id)) continue;
      seenThisMon.add(id);
      const cur = byId.get(id);
      if (cur) cur.count += 1;
      else byId.set(id, { displayName: raw, count: 1 });
    }
  }

  let entries: LegalMoveEntry[] = [...byId.values()].map(({ displayName, count }) => {
    const meta = getMoveMeta(displayName);
    return {
      displayName,
      name: meta?.name ?? displayName,
      type: meta?.type,
      category: meta?.category,
      basePower: meta?.basePower,
      learnableByCount: count,
    };
  });
  const totalLegalMoves = entries.length;

  // Filters.
  const nameNeedle = opts.nameContains?.trim().toLowerCase();
  if (nameNeedle) entries = entries.filter((e) => e.displayName.toLowerCase().includes(nameNeedle));
  if (opts.type) {
    const t = opts.type.toLowerCase();
    entries = entries.filter((e) => e.type?.toLowerCase() === t);
  }
  if (opts.category) entries = entries.filter((e) => e.category === opts.category);

  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const notes: string[] = [
    `Champions publishes no per-move bans; this is the pool of moves learnable by Pokémon ` +
      `legal in ${reg.meta.name}. Type/category/power come from @smogon/calc.`,
  ];
  if (unresolved.length > 0) {
    notes.push(
      `${unresolved.length} legal Pokémon could not be resolved in the Champions dex and were ` +
        `skipped (run \`npm run scrape:dex\`).`,
    );
  }

  return {
    regulation: reg.meta.id,
    regulationName: reg.meta.name,
    totalLegalMoves,
    count: entries.length,
    filter: { nameContains: opts.nameContains, type: opts.type, category: opts.category },
    moves: entries,
    notes,
  };
}

export { MOVE_CATEGORIES };
