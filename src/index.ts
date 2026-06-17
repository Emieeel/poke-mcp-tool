#!/usr/bin/env node
/**
 * index.ts — MCP server entry point for the Pokémon Champions tool.
 *
 * Transport: stdio (the client launches this as a subprocess).
 * IMPORTANT: stdout is the protocol channel — we log ONLY to stderr.
 *
 * Two separate datasets back this server (never conflate them):
 *   - Engine data (dex, stats, moves, type chart, damage formula): bundled in @smogon/calc.
 *   - Legality data (which Pokémon/moves are legal per Champions regulation): our own JSON.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import {
  calculateDamage,
  typeEffectiveness,
  pokemonSchema,
  fieldSchema,
  TYPE_NAMES,
} from './calc.js';
import { getPokemonInfo } from './dex.js';
import { checkLegality, listRegulations, loadRegulation } from './regulations.js';

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
 * Build and configure the MCP server with all five tools. Exported so a test harness
 * can mount it on an in-memory transport without spawning a subprocess.
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
      'Answers questions like "does my Choice Band Staraptor-Mega OHKO that Garchomp?". ' +
      'Returns the damage range, percent range, hits-to-KO, and the human-readable calc string.',
    inputSchema: {
      attacker: pokemonSchema.describe('The attacking Pokémon and its set.'),
      defender: pokemonSchema.describe('The defending Pokémon and its set.'),
      move: z.string().describe('The move the attacker uses, e.g. "Close Combat".'),
      field: fieldSchema.optional().describe('Battle field/side conditions. Defaults to Doubles.'),
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
      'Check whether a Pokémon — and optionally specific moves — is legal in a given ' +
      'Pokémon Champions regulation (e.g. "m-b"). Reads purely from local regulation JSON ' +
      '(fully offline). If the regulation file is missing, returns an error telling you to ' +
      'run the scraper. If the regulation has no per-move legality data, that is stated ' +
      'explicitly rather than guessed.',
    inputSchema: {
      regulation: z.string().describe('Regulation id, e.g. "m-b".'),
      pokemon: z.string().describe('Pokémon species name to check.'),
      moves: z
        .array(z.string())
        .optional()
        .describe('Optional list of move names to check for legality.'),
    },
  },
  async ({ regulation, pokemon, moves }) => {
    try {
      return ok(checkLegality(regulation, pokemon, moves));
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

  return server;
}

// ---- start -----------------------------------------------------------------

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for the MCP protocol.
  console.error('[pokemon-champions] MCP server running on stdio.');
}

// Only auto-start the stdio server when this file is executed directly (not when
// imported by the test harness).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[pokemon-champions] fatal:', err);
    process.exit(1);
  });
}
