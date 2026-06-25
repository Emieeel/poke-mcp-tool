/**
 * server.ts — transport-agnostic MCP server definition for the Pokémon Champions tool.
 *
 * This module declares all 10 tools and returns a configured McpServer. It deliberately
 * imports NO transport (no stdio, no HTTP) and NO Node-only APIs at the top level, so it can
 * be mounted on any transport:
 *   - src/index.ts   → stdio (local subprocess; the default for desktop MCP clients)
 *   - src/worker.ts  → Streamable HTTP on Cloudflare Workers (filesystem-less; data injected)
 *   - test/smoke.ts  → in-memory transport
 *
 * Two separate datasets back this server (never conflate them):
 *   - Engine data (dex, stats, moves, type chart, damage formula): bundled in @smogon/calc.
 *   - Legality data (which Pokémon/moves are legal per Champions regulation): our own JSON.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  calculateDamage,
  typeEffectiveness,
  pokemonSchema,
  fieldSchema,
  moveContextSchema,
  TYPE_NAMES,
} from './calc.js';
import { getPokemonInfo } from './dex.js';
import { getItemInfo, listItems, championsItemsMeta, type ItemCategory } from './items.js';
import { findPokemonByMove, listLegalMoves, MOVE_CATEGORIES, type MoveCategory } from './movedex.js';
import {
  checkLegality,
  checkItemLegality,
  listRegulations,
  listLegalPokemon,
  loadRegulation,
} from './regulations.js';

const ITEM_CATEGORIES = ['Hold Item', 'Mega Stone', 'Berry', 'Miscellaneous'] as const;

// ---- helpers ---------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
  };
}

// ---- server ----------------------------------------------------------------

/**
 * Build and configure the MCP server with all ten tools. Exported so any transport (stdio,
 * HTTP, in-memory test) can mount it without this module knowing which one is in use.
 */
export function createServer(): McpServer {
const server = new McpServer({
  name: 'pokemon-champions',
  version: '0.1.0',
});

// 1. calculate_damage --------------------------------------------------------
server.registerTool(
  'calculate_damage',
  {
    title: 'Calculate battle damage (Pokémon Champions)',
    description:
      'Calculate the damage one Pokémon deals to another with a given move in Pokémon ' +
      'Champions (VGC-style, defaults to Doubles). Wraps the trusted @smogon/calc engine, ' +
      'so abilities (Contrary, Intimidate, ...), items, weather, terrain, Tera, crits, ' +
      'multi-hit, screens and Doubles spread reduction are all handled correctly. ' +
      'For moves whose power builds up over a battle — Rage Fist (per hit taken), Last ' +
      'Respects (per fainted ally) — pass moveContext so the base power scales correctly; ' +
      'or pin any variable-power move with moveContext.basePowerOverride. ' +
      'Answers questions like "does my Choice Band Staraptor-Mega OHKO that Garchomp?". ' +
      'Returns the damage range, percent range, hits-to-KO, and the human-readable calc string.',
    inputSchema: {
      attacker: pokemonSchema.describe('The attacking Pokémon and its set.'),
      defender: pokemonSchema.describe('The defending Pokémon and its set.'),
      move: z.string().describe('The move the attacker uses, e.g. "Close Combat".'),
      field: fieldSchema.optional().describe('Battle field/side conditions. Defaults to Doubles.'),
      moveContext: moveContextSchema
        .optional()
        .describe(
          'Battle-history context for moves whose base power accumulates (Rage Fist, Last ' +
          'Respects), or a raw basePowerOverride for any other variable-power move.',
        ),
    },
  },
  async (args) => {
    try {
      return ok(calculateDamage(args as any));
    } catch (err) {
      return fail(`calculate_damage failed: ${(err as Error).message}`);
    }
  },
);

// 2. type_effectiveness ------------------------------------------------------
server.registerTool(
  'type_effectiveness',
  {
    title: 'Type effectiveness multiplier (Pokémon Champions)',
    description:
      'Given an attacking type and 1 or 2 defending types, return the damage multiplier ' +
      '(0, 0.25, 0.5, 1, 2, or 4) and a short explanation, for Pokémon Champions. Derived ' +
      'from the type chart bundled in @smogon/calc. Answers "how effective is Fighting vs ' +
      'a Flying/Psychic Pokémon?".',
    inputSchema: {
      attackingType: z.enum(TYPE_NAMES).describe('The move\'s type, e.g. "Fighting".'),
      defendingTypes: z
        .array(z.enum(TYPE_NAMES))
        .min(1)
        .max(2)
        .describe('The defending Pokémon\'s type(s), 1 or 2 entries.'),
    },
  },
  async ({ attackingType, defendingTypes }) => {
    try {
      return ok(typeEffectiveness(attackingType, defendingTypes));
    } catch (err) {
      return fail(`type_effectiveness failed: ${(err as Error).message}`);
    }
  },
);

// 3. get_pokemon -------------------------------------------------------------
server.registerTool(
  'get_pokemon',
  {
    title: 'Look up a Pokémon (Pokémon Champions)',
    description:
      'Look up a Pokémon by name (Mega forms accepted, e.g. "Staraptor-Mega" or "Mega ' +
      'Staraptor") in Pokémon Champions: returns base stats, typing, abilities, and weight. ' +
      'Data comes from the Champions Pokédex (Serebii) so game-original Mega Evolutions are ' +
      'accurate — e.g. Mega Staraptor has Contrary, which @smogon/calc gets wrong. Also ' +
      'returns the Pokémon\'s full learnable movelist ("moves"). The "source" field shows ' +
      'whether the answer came from the Champions dex or the @smogon/calc fallback. ' +
      'Optionally pass a regulation id (e.g. "m-b") to also get whether the Pokémon is legal ' +
      'there and its regulation-legal moves.',
    inputSchema: {
      name: z.string().describe('Pokémon species name, e.g. "Garchomp", "Staraptor-Mega", or "Mega Raichu X".'),
      regulation: z
        .string()
        .optional()
        .describe('Optional regulation id (e.g. "m-b") to also check legality.'),
    },
  },
  async ({ name, regulation }) => {
    try {
      const info = getPokemonInfo(name);
      if (!info) {
        return fail(`Unknown Pokémon "${name}". Check spelling or form name (e.g. "Staraptor-Mega").`);
      }
      const out: Record<string, unknown> = { ...info };
      if (info.source === 'smogon-calc') {
        out.sourceNote =
          'Served from the @smogon/calc fallback (not found in the Champions dex). For ' +
          'Champions-original forms this may be inaccurate; run `npm run scrape:dex` to ' +
          'refresh the Champions dex.';
      }

      if (regulation) {
        try {
          const legality = checkLegality(regulation, name);
          out.regulation = {
            id: legality.regulation,
            name: legality.regulationName,
            legal: legality.pokemonLegal,
            note: legality.pokemonNote,
            // No per-move bans exist in this format, so the regulation-legal moves are simply
            // the Pokémon's full Champions learnset.
            regulationLegalMoves: legality.pokemonLegal ? info.moves : [],
            regulationLegalMovesNote: legality.pokemonLegal
              ? 'Equals the full Champions learnset; the format publishes no per-move bans.'
              : 'Pokémon is not legal in this regulation, so it has no legal moves here.',
            notes: legality.notes,
          };
        } catch (err) {
          out.regulation = { error: (err as Error).message };
        }
      }
      return ok(out);
    } catch (err) {
      return fail(`get_pokemon failed: ${(err as Error).message}`);
    }
  },
);

// 4. check_legality ----------------------------------------------------------
server.registerTool(
  'check_legality',
  {
    title: 'Check regulation legality (Pokémon Champions)',
    description:
      'Check whether a Pokémon — and optionally specific moves and/or held items — is legal ' +
      'in a given Pokémon Champions regulation (e.g. "m-b"). Reads purely from local ' +
      'regulation JSON (fully offline). If the regulation file is missing, returns an error ' +
      'telling you to run the scraper. If the regulation has no per-move or per-item legality ' +
      'data, that is stated explicitly rather than guessed.',
    inputSchema: {
      regulation: z.string().describe('Regulation id, e.g. "m-b".'),
      pokemon: z.string().describe('Pokémon species name to check.'),
      moves: z
        .array(z.string())
        .optional()
        .describe('Optional list of move names to check for legality.'),
      items: z
        .array(z.string())
        .optional()
        .describe('Optional list of held-item names to check for legality, e.g. ["Life Orb"].'),
    },
  },
  async ({ regulation, pokemon, moves, items }) => {
    try {
      return ok(checkLegality(regulation, pokemon, moves, items));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

// 5. list_regulations --------------------------------------------------------
server.registerTool(
  'list_regulations',
  {
    title: 'List available regulations (Pokémon Champions)',
    description:
      'List the Pokémon Champions regulations currently available locally (the JSON files ' +
      'in regulations/), with each one\'s metadata (name, date range, source URL, ' +
      'last-scraped timestamp) and counts of legal Pokémon/moves. Cheap way to know what ' +
      'legality data this server has before calling check_legality.',
    inputSchema: {},
  },
  async () => {
    try {
      const regs = listRegulations();
      const detailed = regs.map((r) => {
        if (!r.meta) return { id: r.id, error: r.error };
        try {
          const full = loadRegulation(r.id);
          return {
            id: full.meta.id,
            meta: full.meta,
            legalPokemonCount: full.legalPokemon.length,
            bannedPokemonCount: full.bannedPokemon.length,
            newlyUseableCount: Array.isArray(full.meta.newlyUseable) ? full.meta.newlyUseable.length : null,
            legalMovesCount: Array.isArray(full.legalMoves) ? full.legalMoves.length : null,
            moveLegalityAvailable: Array.isArray(full.legalMoves),
          };
        } catch (err) {
          return { id: r.id, error: (err as Error).message };
        }
      });
      return ok({ count: detailed.length, regulations: detailed });
    } catch (err) {
      return fail(`list_regulations failed: ${(err as Error).message}`);
    }
  },
);

// 6. list_items --------------------------------------------------------------
server.registerTool(
  'list_items',
  {
    title: 'List held items (Pokémon Champions)',
    description:
      'Browse the items a Pokémon can hold in Pokémon Champions: Hold Items (Choice Scarf, ' +
      'Life Orb, Leftovers, ...), Mega Stones (Garchompite, Charizardite X, ...), and Berries ' +
      '(Sitrus, Lum, type-resist berries, ...). Each item includes its in-game effect, how to ' +
      'obtain it, and its category. Data is scraped from the Champions items page (Serebii). ' +
      'Optionally filter by category or a name substring, and pass a regulation id (e.g. ' +
      '"m-b") to mark which items are legal there. Answers "what berries can I hold?" or ' +
      '"which Mega Stones exist in Champions?".',
    inputSchema: {
      category: z
        .enum(ITEM_CATEGORIES)
        .optional()
        .describe('Filter to one category: "Hold Item", "Mega Stone", "Berry", or "Miscellaneous".'),
      nameContains: z
        .string()
        .optional()
        .describe('Case-insensitive substring to filter item names, e.g. "berry" or "choice".'),
      includeNonHeld: z
        .boolean()
        .optional()
        .describe('Include non-held Miscellaneous items (tickets/coupons). Defaults to false.'),
      regulation: z
        .string()
        .optional()
        .describe('Optional regulation id (e.g. "m-b") to mark each item legal/illegal there.'),
    },
  },
  async ({ category, nameContains, includeNonHeld, regulation }) => {
    try {
      const items = listItems({
        category: category as ItemCategory | undefined,
        nameContains,
        heldOnly: !includeNonHeld,
      });
      if (items === null) {
        return fail(
          'No Champions item catalog loaded. Run `npm run scrape:items` to build ' +
            'data/champions-items.json.',
        );
      }

      // If a regulation was given, attach per-item legality (regulation-scoped).
      let reg: ReturnType<typeof loadRegulation> | undefined;
      let regError: string | undefined;
      if (regulation) {
        try {
          reg = loadRegulation(regulation);
        } catch (err) {
          regError = (err as Error).message;
        }
      }
      const withLegality = items.map((it) => {
        if (!reg) return it;
        const leg = checkItemLegality(reg, it.name);
        return { ...it, regulationLegal: leg.available ? leg.legal : null };
      });

      return ok({
        count: withLegality.length,
        meta: championsItemsMeta(),
        filter: { category, nameContains, includeNonHeld: Boolean(includeNonHeld) },
        regulation: reg ? { id: reg.meta.id, name: reg.meta.name } : regError ? { error: regError } : undefined,
        items: withLegality,
      });
    } catch (err) {
      return fail(`list_items failed: ${(err as Error).message}`);
    }
  },
);

// 7. get_item ----------------------------------------------------------------
server.registerTool(
  'get_item',
  {
    title: 'Look up a held item (Pokémon Champions)',
    description:
      'Look up a single Pokémon Champions held item by name (e.g. "Choice Scarf", ' +
      '"Garchompite", "Sitrus Berry"): returns its in-game effect, how to obtain it, its ' +
      'category (Hold Item / Mega Stone / Berry), and whether it can be held in battle. Data ' +
      'comes from the Champions items page (Serebii). The "source" field shows whether the ' +
      'answer came from the Champions catalog or the @smogon/calc fallback (which lacks ' +
      'effect/location text). Optionally pass a regulation id (e.g. "m-b") to also get whether ' +
      'the item is legal there.',
    inputSchema: {
      name: z.string().describe('Item name, e.g. "Life Orb", "Charizardite X", or "Lum Berry".'),
      regulation: z
        .string()
        .optional()
        .describe('Optional regulation id (e.g. "m-b") to also check item legality.'),
    },
  },
  async ({ name, regulation }) => {
    try {
      const info = getItemInfo(name);
      if (!info) {
        return fail(`Unknown item "${name}". Check spelling (e.g. "Choice Scarf", "Garchompite").`);
      }
      const out: Record<string, unknown> = { ...info };
      if (info.source === 'smogon-calc') {
        out.sourceNote =
          'Served from the @smogon/calc fallback (not found in the Champions item catalog). ' +
          'Effect/location text is unavailable there; run `npm run scrape:items` to build the ' +
          'Champions catalog.';
      }

      if (regulation) {
        try {
          const reg = loadRegulation(regulation);
          const leg = checkItemLegality(reg, info.name);
          out.regulation = {
            id: reg.meta.id,
            name: reg.meta.name,
            legal: leg.available ? leg.legal : null,
            note: leg.note,
          };
        } catch (err) {
          out.regulation = { error: (err as Error).message };
        }
      }
      return ok(out);
    } catch (err) {
      return fail(`get_item failed: ${(err as Error).message}`);
    }
  },
);

// 8. find_pokemon_by_move ----------------------------------------------------
server.registerTool(
  'find_pokemon_by_move',
  {
    title: 'Find legal Pokémon that learn a move (Pokémon Champions)',
    description:
      'Given a move and a Pokémon Champions regulation (e.g. "m-b"), list every Pokémon that ' +
      'is legal in that regulation AND can learn the move. Answers "who can run Fake Out in ' +
      'M-B?" or "which legal mons get Spore?". Learnsets come from the Champions dex; the ' +
      'move\'s type/category/base power are included when the engine knows the move. NOTE: ' +
      'Champions publishes no per-move bans, so "legal move" means a legal Pokémon can learn ' +
      'it. Defaults to regulation "m-b".',
    inputSchema: {
      move: z.string().describe('Move name, e.g. "Fake Out", "Will-O-Wisp", "Spore".'),
      regulation: z
        .string()
        .optional()
        .describe('Regulation id (e.g. "m-b"). Defaults to "m-b".'),
    },
  },
  async ({ move, regulation }) => {
    try {
      return ok(findPokemonByMove(regulation ?? 'm-b', move));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

// 9. list_legal_moves --------------------------------------------------------
server.registerTool(
  'list_legal_moves',
  {
    title: 'List legal moves in a regulation (Pokémon Champions)',
    description:
      'List the moves available in a Pokémon Champions regulation (e.g. "m-b") — i.e. every ' +
      'move learnable by at least one legal Pokémon — each with its type, category ' +
      '(Physical/Special/Status), base power, and how many legal Pokémon can learn it. ' +
      'Optionally filter by name substring, move type (e.g. "Fire"), or category. Answers ' +
      '"what Fairy moves are usable in M-B?" or "is Glacial Lance legal here?". NOTE: ' +
      'Champions publishes no per-move bans, so this is the pool of learnable moves, not a ' +
      'separate curated allowlist. Defaults to regulation "m-b".',
    inputSchema: {
      regulation: z
        .string()
        .optional()
        .describe('Regulation id (e.g. "m-b"). Defaults to "m-b".'),
      nameContains: z
        .string()
        .optional()
        .describe('Case-insensitive substring to filter move names, e.g. "beam" or "punch".'),
      type: z
        .enum(TYPE_NAMES)
        .optional()
        .describe('Filter to one move type, e.g. "Fire", "Fairy".'),
      category: z
        .enum(MOVE_CATEGORIES)
        .optional()
        .describe('Filter by category: "Physical", "Special", or "Status".'),
    },
  },
  async ({ regulation, nameContains, type, category }) => {
    try {
      return ok(
        listLegalMoves(regulation ?? 'm-b', {
          nameContains,
          type,
          category: category as MoveCategory | undefined,
        }),
      );
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

// 10. list_legal_pokemon -----------------------------------------------------
server.registerTool(
  'list_legal_pokemon',
  {
    title: 'List legal Pokémon in a regulation (Pokémon Champions)',
    description:
      'List the Pokémon legal in a Pokémon Champions regulation (e.g. "m-b") — the regulation\'s ' +
      'legal pool — each enriched with its National Dex number, typing, base stats, and ' +
      'abilities from the Champions dex. Optionally filter by name substring or by type (e.g. ' +
      '"Dragon"). Answers "what Fairy types are legal in M-B?" or "show me the M-B roster". ' +
      'Reads the regulation\'s legal-Pokémon allowlist directly (the complement to ' +
      'list_legal_moves). Defaults to regulation "m-b".',
    inputSchema: {
      regulation: z
        .string()
        .optional()
        .describe('Regulation id (e.g. "m-b"). Defaults to "m-b".'),
      nameContains: z
        .string()
        .optional()
        .describe('Case-insensitive substring to filter Pokémon names, e.g. "char" or "mega".'),
      type: z
        .enum(TYPE_NAMES)
        .optional()
        .describe('Filter to one type, e.g. "Dragon", "Fairy".'),
    },
  },
  async ({ regulation, nameContains, type }) => {
    try {
      return ok(listLegalPokemon(regulation ?? 'm-b', { nameContains, type }));
    } catch (err) {
      return fail((err as Error).message);
    }
  },
);

  return server;
}
