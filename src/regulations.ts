/**
 * regulations.ts — loads and validates the Champions-specific legality data.
 *
 * This is the ONLY dataset we source and maintain ourselves (no npm package has it).
 * Files live in regulations/<id>.json and are produced by scripts/scrape-regulation.ts.
 * The server only READS these files — it never scrapes on a normal tool call.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { nameKey, baseSpeciesKey } from './names.js';
import { getPokemonMoves } from './dex.js';
import { itemKey } from './items.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/regulations.js -> ../regulations ; src/regulations.ts -> ../regulations
export const REGULATIONS_DIR = join(__dirname, '..', 'regulations');

export const regulationSchema = z.object({
  meta: z.object({
    id: z.string(),
    name: z.string(),
    game: z.string().default('Pokémon Champions'),
    validFrom: z.string().optional(),
    validTo: z.string().optional(),
    source: z.string().optional(),
    rosterSource: z.string().optional(),
    scrapedAt: z.string().optional(),
    // Scope of the legalPokemon list. "full-roster" = the complete Champions Pokédex (the
    // legal pool). "newly-useable" = only the Pokémon newly added in this regulation.
    listScope: z.string().optional(),
    // Pokémon newly introduced in this regulation (context, not the full legal list).
    newlyUseable: z.array(z.string()).optional(),
  }),
  legalPokemon: z
    .array(z.object({ name: z.string(), notes: z.string().optional() }))
    .default([]),
  // legalMoves is OPTIONAL: if the source doesn't express per-move legality we omit it
  // rather than fabricate, and legality checks then only cover Pokémon.
  legalMoves: z.array(z.string()).optional(),
  // legalItems is OPTIONAL and regulation-scoped: the set of items a Pokémon may legally hold
  // in THIS regulation. Populated by the scraper from the Champions held-item catalog. If
  // absent (e.g. a partial scrape), item-legality checks are unavailable rather than guessed.
  legalItems: z.array(z.object({ name: z.string(), notes: z.string().optional() })).optional(),
  bannedPokemon: z.array(z.object({ name: z.string(), notes: z.string().optional() }))
    .default([]),
  // Specific items banned in this regulation even though they're in the held-item catalog.
  bannedItems: z.array(z.object({ name: z.string(), notes: z.string().optional() }))
    .default([]),
  notes: z.string().optional(),
});

export type Regulation = z.infer<typeof regulationSchema>;

function regIdToFile(id: string): string {
  return join(REGULATIONS_DIR, `${normalizeId(id)}.json`);
}

export function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

/** List the regulation ids available locally, with each file's meta. */
export function listRegulations(): { id: string; meta: Regulation['meta'] | null; error?: string }[] {
  if (!existsSync(REGULATIONS_DIR)) return [];
  const files = readdirSync(REGULATIONS_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const id = f.replace(/\.json$/, '');
    try {
      const reg = loadRegulation(id);
      return { id: reg.meta.id, meta: reg.meta };
    } catch (err) {
      return { id, meta: null, error: (err as Error).message };
    }
  });
}

/** Load + validate a regulation file. Throws a clear error if missing or malformed. */
export function loadRegulation(id: string): Regulation {
  const file = regIdToFile(id);
  if (!existsSync(file)) {
    throw new Error(
      `No regulation data for "${normalizeId(id)}". Expected ${file}. ` +
        `Run the scraper to create it:  npm run scrape -- ${normalizeId(id)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Regulation file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = regulationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Regulation file ${file} failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

export interface LegalityResult {
  regulation: string;
  regulationName: string;
  pokemon: string;
  pokemonLegal: boolean;
  pokemonNote?: string;
  moves?: { move: string; legal: boolean }[];
  moveLegalityAvailable: boolean;
  items?: { item: string; legal: boolean; note?: string }[];
  itemLegalityAvailable: boolean;
  notes: string[];
}

export interface ItemLegality {
  legal: boolean;
  /** True when the regulation publishes a legal-items list to check against. */
  available: boolean;
  note?: string;
}

/**
 * Whether a single item is legal to hold in a regulation. Legal = on the regulation's
 * legalItems allowlist AND not on its bannedItems list. If the regulation has no legalItems
 * list (e.g. a partial scrape), legality is "unavailable" rather than guessed.
 *
 * Item legality is regulation-scoped, mirroring Pokémon/move legality — see checkLegality.
 */
export function checkItemLegality(reg: Regulation, item: string): ItemLegality {
  const wanted = itemKey(item);
  const banned = reg.bannedItems.find((i) => itemKey(i.name) === wanted);
  if (banned) {
    return { legal: false, available: true, note: banned.notes || `Banned in ${reg.meta.name}.` };
  }
  if (!reg.legalItems || reg.legalItems.length === 0) {
    return {
      legal: false,
      available: false,
      note:
        `Regulation ${reg.meta.id} has no legal-items list loaded (possibly a partial ` +
        `scrape). Cannot confirm item legality — re-run \`npm run scrape -- ${reg.meta.id}\`.`,
    };
  }
  const hit = reg.legalItems.find((i) => itemKey(i.name) === wanted);
  return hit
    ? { legal: true, available: true, note: hit.notes || undefined }
    : { legal: false, available: true, note: `"${item}" is not on the legal-items list for ${reg.meta.name}.` };
}

/**
 * Check whether a Pokémon (and optionally listed moves) is legal in a regulation.
 * Reads purely from the regulation JSON.
 */
export function checkLegality(
  regulationId: string,
  pokemon: string,
  moves?: string[],
  items?: string[],
): LegalityResult {
  const reg = loadRegulation(regulationId);
  const wantedPoke = nameKey(pokemon);

  const banned = reg.bannedPokemon.find((p) => nameKey(p.name) === wantedPoke);
  const legalEntry = reg.legalPokemon.find((p) => nameKey(p.name) === wantedPoke);

  // A Mega form usually isn't a separate roster entry; it's legal if its base species is
  // legal (and the specific Mega isn't separately banned). Resolve that here.
  const baseKey = baseSpeciesKey(pokemon);
  const baseEntry = baseKey ? reg.legalPokemon.find((p) => nameKey(p.name) === baseKey) : undefined;

  // If an explicit allowlist exists, legality = present on it (or via base species) AND not banned.
  // If the allowlist is empty (e.g. partial scrape), we can't assert legality.
  const hasAllowlist = reg.legalPokemon.length > 0;
  let pokemonLegal: boolean;
  const notes: string[] = [];
  if (banned) {
    pokemonLegal = false;
  } else if (hasAllowlist) {
    pokemonLegal = Boolean(legalEntry) || Boolean(baseEntry);
    if (!legalEntry && baseEntry) {
      notes.push(`"${pokemon}" is legal via its base species "${baseEntry.name}" (Mega forms follow base-species legality unless separately banned).`);
    }
    if (!legalEntry && !baseEntry) {
      notes.push(`"${pokemon}" is not on the legal-Pokémon list for ${reg.meta.name}.`);
      // If the list only covers newly-useable additions, "not found" does NOT mean illegal.
      if (reg.meta.listScope === 'newly-useable') {
        notes.push(
          `This regulation's list only contains Pokémon NEWLY useable in ${reg.meta.name}; ` +
            `"${pokemon}" may still be legal if it was introduced in an earlier regulation. ` +
            `Verify against ${reg.meta.source ?? 'the source'}.`,
        );
      }
    }
  } else {
    pokemonLegal = false;
    notes.push(
      `Regulation ${reg.meta.id} has no legal-Pokémon list loaded (possibly a partial ` +
        `scrape). Cannot confirm legality — please verify against the source and re-scrape.`,
    );
  }

  // Move legality is the Pokémon's Champions learnset (from the engine dex). This format
  // publishes no per-move bans, so a move is "legal" iff the Pokémon can learn it.
  const learnset = getPokemonMoves(pokemon);
  const moveLegalityAvailable = learnset !== null;
  let moveResults: { move: string; legal: boolean }[] | undefined;
  if (moves && moves.length > 0) {
    if (learnset) {
      const learnKeys = new Set(learnset.map(nameKey));
      moveResults = moves.map((m) => ({ move: m, legal: learnKeys.has(nameKey(m)) }));
      notes.push(
        `Move legality reflects whether ${pokemon} can learn the move in Champions ` +
          `(${learnset.length}-move learnset); the format publishes no separate per-move bans.`,
      );
    } else {
      notes.push(
        `No Champions learnset found for "${pokemon}", so move legality cannot be checked. ` +
          `Run \`npm run scrape:dex\` to build the engine dex.`,
      );
    }
  }

  // Item legality is regulation-scoped: an item is legal iff it's on this regulation's
  // legalItems allowlist (and not separately banned). The list is the Champions held-item
  // catalog; the format publishes no per-item bans, so legality is essentially "is it a real
  // Champions held item", but the check is still resolved against THIS regulation's data.
  const itemLegalityAvailable = Boolean(reg.legalItems && reg.legalItems.length > 0) || reg.bannedItems.length > 0;
  let itemResults: { item: string; legal: boolean; note?: string }[] | undefined;
  if (items && items.length > 0) {
    itemResults = items.map((it) => {
      const r = checkItemLegality(reg, it);
      return { item: it, legal: r.legal, note: r.note };
    });
    if (reg.legalItems && reg.legalItems.length > 0) {
      notes.push(
        `Item legality reflects this regulation's legal held-item list ` +
          `(${reg.legalItems.length} items); the format publishes no separate per-item bans.`,
      );
    } else {
      notes.push(
        `Regulation ${reg.meta.id} has no legal-items list loaded, so item legality cannot ` +
          `be checked. Re-run \`npm run scrape -- ${reg.meta.id}\`.`,
      );
    }
  }

  // Surface the regulation file's own top-level notes (e.g. scope/limitation warnings).
  if (reg.notes) notes.push(reg.notes);

  return {
    regulation: reg.meta.id,
    regulationName: reg.meta.name,
    pokemon,
    pokemonLegal,
    pokemonNote: legalEntry?.notes || banned?.notes,
    moves: moveResults,
    moveLegalityAvailable,
    items: itemResults,
    itemLegalityAvailable,
    notes,
  };
}
