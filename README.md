# Pokémon Champions MCP Server

An [MCP](https://modelcontextprotocol.io) server (TypeScript, stdio) that gives an AI
client accurate, current information for competitive **Pokémon Champions** (the VGC-style
battle game). It exposes tools for damage calculation, type effectiveness, Pokémon lookup,
**held-item** lookup, **move search** (which moves are usable in a regulation, and which
legal Pokémon learn a given move), and **regulation legality** (e.g. which Pokémon and items
are allowed in Regulation M-B).

## Datasets

The server reads four local datasets at startup and **never touches the network on a
normal tool call** — only the on-demand scraper scripts do.

1. **Damage engine** — the damage *formula* and its mechanics (abilities like Contrary,
   weather, items, crits, multi-hit, spread reduction) come from
   [`@smogon/calc`](https://www.npmjs.com/package/@smogon/calc), whose engine descends from
   the same Honko/Zarel codebase the trusted community calculators use. We wrap it; we never
   reimplement the formula. (Generation 9.)

2. **Champions engine dex** — per-Pokémon facts (base stats, typing, abilities, weight, and
   the full learnable **movelist**), in [`data/champions-dex.json`](data/champions-dex.json),
   scraped from [Serebii's Champions Pokédex](https://www.serebii.net/pokedex-champions/)
   (207 Pokémon, 282 forms incl. Megas, ~62 moves each).
   **Why not just use `@smogon/calc` for this?** Because `@smogon/calc` ships *mainline*
   data, which is wrong or missing for Pokémon Champions' game-original Mega Evolutions —
   e.g. Champions' **Mega Staraptor has Contrary**, but `@smogon/calc` says Intimidate; and
   forms like Mega Eelektross don't exist there at all. `get_pokemon` uses this dex as the
   source of truth, and `calculate_damage` **overrides** `@smogon/calc`'s species data with
   it (auto-filling stats/typing/ability) so even Champions-original Megas calc correctly.
   This is a deliberate deviation from the original "never scrape engine data" rule, made
   because the package doesn't match the game.

3. **Champions held-item catalog** — the items a Pokémon can hold (Hold Items, Mega Stones,
   Berries) with each one's effect, how to obtain it, and category, in
   [`data/champions-items.json`](data/champions-items.json), scraped from
   [Serebii's Champions items page](https://www.serebii.net/pokemonchampions/items.shtml)
   (148 held items). **Why not `@smogon/calc`?** Same reason as the dex: it ships a *mainline*
   item list with no Champions effect/location text and no notion of which items exist in the
   game. `get_item` / `list_items` use this catalog as the source of truth.

4. **Legality data** — which Pokémon and held items are legal in a specific Champions
   regulation, in [`regulations/`](regulations/). Small, fast-changing, Champions-specific,
   in no package. Item legality is **regulation-scoped** (each regulation file carries its own
   `legalItems` list).

## Build

```bash
npm install
npm run build      # tsc -> dist/
```

Requires **Node 18+** (uses built-in `fetch` in the scraper).

Optional sanity check — runs all nine tools through an in-memory MCP client:

```bash
npm test
```

## Add to your MCP client

This is a standard stdio MCP server, so any MCP-capable client (Claude Desktop, Claude Code,
Cursor, or your own [SDK](https://modelcontextprotocol.io) host) can launch it. The recipe is
always the same: tell the client to run `node <path>/dist/index.js`.

1. **Build it** so `dist/index.js` exists:

   ```bash
   npm install
   npm run build
   ```

2. **Get the absolute path** to the built entry point — you'll paste this into the client:

   ```bash
   node -e "console.log(require('path').resolve('dist/index.js'))"
   ```

3. **Register the server** in your client's MCP config, using that path. The server entry is:

   ```json
   {
     "mcpServers": {
       "pokemon-champions": {
         "command": "node",
         "args": ["/ABSOLUTE/PATH/TO/poke-mcp-tool/dist/index.js"]
       }
     }
   }
   ```

   Where this config lives depends on the client:
   - **Claude Desktop** — `claude_desktop_config.json` (Settings → Developer → Edit Config; or
     `~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows). Merge
     the `mcpServers` entry into that file.
   - **Claude Code** — run `claude mcp add pokemon-champions node /ABSOLUTE/PATH/dist/index.js`,
     or add the same block to your `.mcp.json` / settings.
   - **Other clients** — add an equivalent stdio server entry (`command: node`, `args: [path]`).

4. **Restart the client** (or reload its MCP servers) so it picks up the new entry.

5. **Verify** — the client should now list tools like `calculate_damage` and
   `find_pokemon_by_move`. Ask it something like *"Is Garchomp legal in Regulation M-B, and
   who can learn Fake Out there?"*

Use an **absolute path** — relative paths won't resolve, since the client sets its own working
directory. The server requires **Node 18+** on the machine that runs the client.

## Tools

| Tool | What it answers |
| --- | --- |
| `calculate_damage` | "Does my Choice Band Staraptor-Mega OHKO that Garchomp?" — full damage/percent range, hits-to-KO, and the human-readable calc string. Auto-fills stats/typing/ability from the Champions dex (so Mega Staraptor uses Contrary, and even Champions-only Megas like Mega Eelektross calc correctly). Handles items, weather, terrain, Tera, crits, multi-hit, and Doubles spread reduction via `@smogon/calc`. |
| `type_effectiveness` | The multiplier (0–4x) of an attacking type against 1–2 defending types, from the bundled type chart. |
| `get_pokemon` | Base stats, typing, abilities, weight, and full **movelist** for a Pokémon (Mega forms accepted, e.g. `Staraptor-Mega`, `Mega Staraptor`, `Mega Raichu X`), Champions-accurate. Pass a `regulation` id to also get legality and regulation-legal moves. |
| `get_item` | Effect, how-to-obtain, and category (Hold Item / Mega Stone / Berry) for a held item, e.g. `Choice Scarf`, `Garchompite`, `Lum Berry`. Pass a `regulation` id to also get whether it's legal there. |
| `list_items` | Browse the held-item catalog, optionally filtered by `category` or a `nameContains` substring (held-only by default; `includeNonHeld` adds tickets). Pass a `regulation` id to mark which items are legal there. Answers "what berries can I hold?" / "which Mega Stones exist?". |
| `check_legality` | Whether a Pokémon — and optionally listed moves and/or held `items` — is legal in a regulation. Move legality checks against the Pokémon's Champions learnset; item legality against the regulation's held-item list. |
| `find_pokemon_by_move` | "Who can run Fake Out in M-B?" — every Pokémon legal in a regulation that can learn a given move (with the move's type/category/base power). Name-tolerant (`willowisp` → Will-O-Wisp). Defaults to `m-b`. |
| `list_legal_moves` | The pool of moves usable in a regulation (every move learnable by ≥1 legal Pokémon), each with type, category, base power, and how many legal Pokémon learn it. Filter by `type`, `category`, or a `nameContains` substring. Defaults to `m-b`. |
| `list_regulations` | Which regulations are available locally, with each one's metadata and counts. |

## Refresh the data

Both scrapers are standalone and run manually — the server **never** invokes them, it only
reads their JSON output.

**Regulation legality** (the full legal roster + bans for a regulation):

```bash
npm run scrape -- m-b
```

This reads three Serebii pages: the regulation page (dates + what's *newly* useable), the
Champions Pokédex index (the full legal roster — all HOME-transferable Pokémon), and the
Champions items page (the legal held-item pool). It writes `regulations/m-b.json` with
`legalPokemon` (the full roster, 207 for M-B), `legalItems` (the held-item catalog, 148 for
M-B), `bannedPokemon` (format-excluded Mega forms — for M-B, Mega Garchomp Z & Mega Lucario
Z), `bannedItems` (none published), and `meta` (dates, source URLs, `newlyUseable`,
`scrapedAt`). Parameterize by id for future regulations (`npm run scrape -- m-c`). Per the
official rules there are no Restricted Pokémon and no per-item bans, so everything in the dex
is legal except the listed Mega exclusions, and every held item is legal.

**Champions held-item catalog** (item effects/locations — only needed when the game adds or
changes items):

```bash
npm run scrape:items               # the full items page (one request)
```

This writes `data/champions-items.json` with every Hold Item, Mega Stone, and Berry
(`held: true`) plus the non-held Miscellaneous tickets (`held: false`), each with its effect,
location, and category. The regulation scraper reuses this same parser to fill a regulation's
`legalItems`.

**Champions engine dex** (per-Pokémon stats/types/abilities — only needed when the game
adds Pokémon/forms):

```bash
npm run scrape:dex                 # full roster (~207 pages, throttled — takes a minute)
npm run scrape:dex -- staraptor    # one or more slugs, for testing (writes a .sample.json)
```

All scrapers are **defensive**: if Serebii's markup changes or a page is only partially
published, they print a loud warning and write what they found rather than crashing. The
brittle, page-specific selectors are isolated in `parseRegulationPage()` /
`parsePokemonPage()` / `parseItemsPage()` so they're easy to fix.

## Known data limitations (surfaced honestly, not faked)

These come from the real source data and are reported in the tool output, not hidden:

- **The format publishes no per-move bans**, so move legality = whether the Pokémon can
  *learn* the move in Champions (its scraped learnset). `check_legality` and `get_pokemon`
  state this; a move marked "legal" means learnable, not separately whitelisted. By the same
  logic, `list_legal_moves` is the pool of moves *learnable by a legal Pokémon* (not a curated
  allowlist), and `find_pokemon_by_move` returns the legal Pokémon that learn a move — so a
  move with zero legal learners (e.g. Spore in M-B) is correctly reported as unusable.
- **Mega legality follows the base species.** A Mega isn't a separate roster entry, so
  `check_legality("Mega Staraptor")` resolves via base "Staraptor" (and the result note
  says so). Specific Mega forms in `bannedPokemon` (Mega Garchomp Z, Mega Lucario Z) are
  excluded even though their base species is legal.
- **The format publishes no per-item bans.** Item legality is regulation-scoped (resolved
  against the regulation's own `legalItems` list), but that list is the full Champions
  held-item catalog, so in practice an item is "legal" iff it's a real Champions held item.
  `bannedItems` exists in the schema for future regulations but is currently empty.
- **Champions-original ability *effects* aren't modelled by the damage engine.** `@smogon/calc`
  computes base damage from the correct (overridden) stats/types, but it can't simulate the
  special effect of an ability it doesn't know (e.g. Mega Eelektross's "Eelevate"). Stats,
  typing, and the named ability are Champions-accurate; the ability's mechanical effect on
  the calc may be ignored for game-original abilities.
- **Regional-form typing can be noisy.** A few Pokémon that share a dex page with a regional
  form (e.g. base Raichu vs Alolan Raichu) may show the union of both forms' type links in
  the base entry. Mega forms — the competitively relevant part — are parsed cleanly per form.

## Project layout

```text
src/index.ts                      MCP server: declares the 9 tools + stdio transport
src/calc.ts                       wraps @smogon/calc (damage formula + type effectiveness)
src/dex.ts                        get_pokemon lookups over data/champions-dex.json (fallback @smogon/calc)
src/items.ts                      get_item/list_items over data/champions-items.json (fallback @smogon/calc)
src/movedex.ts                    find_pokemon_by_move/list_legal_moves: reverse move-index over the dex, regulation-scoped
src/regulations.ts                loads/validates regulations/*.json, Pokémon/move/item legality checks
src/names.ts                      shared Pokémon-name canonicalization (Mega word order, base species)
scripts/scrape-champions-dex.ts   standalone scraper -> data/champions-dex.json (engine dex)
scripts/scrape-champions-items.ts standalone scraper -> data/champions-items.json (held-item catalog)
scripts/scrape-regulation.ts      standalone scraper -> regulations/<id>.json (legality; reuses the items parser)
data/champions-dex.json           Champions engine dex (generated; committed)
data/champions-items.json         Champions held-item catalog (generated; committed)
regulations/m-b.json              legality data (generated; committed)
test/smoke.ts                     in-memory MCP client exercising all 9 tools
```
