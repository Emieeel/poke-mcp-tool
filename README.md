# Pokémon Champions MCP Server

An [MCP](https://modelcontextprotocol.io) server (TypeScript, stdio) that gives an AI
client accurate, current information for competitive **Pokémon Champions** (the VGC-style
battle game). It exposes tools for damage calculation, type effectiveness, Pokémon lookup,
and **regulation legality** (e.g. which Pokémon are allowed in Regulation M-B).

## Datasets

The server reads three local datasets at startup and **never touches the network on a
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

3. **Legality data** — which Pokémon are legal in a specific Champions regulation, in
   [`regulations/`](regulations/). Small, fast-changing, Champions-specific, in no package.

## Build

```bash
npm install
npm run build      # tsc -> dist/
```

Requires **Node 18+** (uses built-in `fetch` in the scraper).

Optional sanity check — runs all five tools through an in-memory MCP client:

```bash
npm test
```

## Register in Claude Code

Add this to your Claude Code MCP config (use an **absolute WSL/Linux path** — Claude Code
here runs via AWS Bedrock inside WSL2):

```json
{
  "mcpServers": {
    "pokemon-champions": {
      "command": "node",
      "args": ["/home/emielkoridon/git_repos/poke-mcp-tool/dist/index.js"]
    }
  }
}
```

Then restart Claude Code. (Run `npm run build` first so `dist/index.js` exists.)

## Tools

| Tool | What it answers |
| --- | --- |
| `calculate_damage` | "Does my Choice Band Staraptor-Mega OHKO that Garchomp?" — full damage/percent range, hits-to-KO, and the human-readable calc string. Auto-fills stats/typing/ability from the Champions dex (so Mega Staraptor uses Contrary, and even Champions-only Megas like Mega Eelektross calc correctly). Handles items, weather, terrain, Tera, crits, multi-hit, and Doubles spread reduction via `@smogon/calc`. |
| `type_effectiveness` | The multiplier (0–4x) of an attacking type against 1–2 defending types, from the bundled type chart. |
| `get_pokemon` | Base stats, typing, abilities, weight, and full **movelist** for a Pokémon (Mega forms accepted, e.g. `Staraptor-Mega`, `Mega Staraptor`, `Mega Raichu X`), Champions-accurate. Pass a `regulation` id to also get legality and regulation-legal moves. |
| `check_legality` | Whether a Pokémon — and optionally listed moves — is legal in a regulation. Move legality checks against the Pokémon's Champions learnset. |
| `list_regulations` | Which regulations are available locally, with each one's metadata and counts. |

## Refresh the data

Both scrapers are standalone and run manually — the server **never** invokes them, it only
reads their JSON output.

**Regulation legality** (the full legal roster + bans for a regulation):

```bash
npm run scrape -- m-b
```

This reads two Serebii pages: the regulation page (dates + what's *newly* useable) and the
Champions Pokédex index (the full legal roster — all HOME-transferable Pokémon). It writes
`regulations/m-b.json` with `legalPokemon` (the full roster, 207 for M-B), `bannedPokemon`
(format-excluded Mega forms — for M-B, Mega Garchomp Z & Mega Lucario Z), and `meta`
(dates, source URLs, `newlyUseable`, `scrapedAt`). Parameterize by id for future regulations
(`npm run scrape -- m-c`). Per the official rules there are no Restricted Pokémon, so
everything in the dex is legal except the listed Mega exclusions.

**Champions engine dex** (per-Pokémon stats/types/abilities — only needed when the game
adds Pokémon/forms):

```bash
npm run scrape:dex                 # full roster (~207 pages, throttled — takes a minute)
npm run scrape:dex -- staraptor    # one or more slugs, for testing (writes a .sample.json)
```

Both scrapers are **defensive**: if Serebii's markup changes or a page is only partially
published, they print a loud warning and write what they found rather than crashing. The
brittle, page-specific selectors are isolated in `parseRegulationPage()` /
`parsePokemonPage()` so they're easy to fix.

## Known data limitations (surfaced honestly, not faked)

These come from the real source data and are reported in the tool output, not hidden:

- **The format publishes no per-move bans**, so move legality = whether the Pokémon can
  *learn* the move in Champions (its scraped learnset). `check_legality` and `get_pokemon`
  state this; a move marked "legal" means learnable, not separately whitelisted.
- **Mega legality follows the base species.** A Mega isn't a separate roster entry, so
  `check_legality("Mega Staraptor")` resolves via base "Staraptor" (and the result note
  says so). Specific Mega forms in `bannedPokemon` (Mega Garchomp Z, Mega Lucario Z) are
  excluded even though their base species is legal.
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
src/index.ts                    MCP server: declares the 5 tools + stdio transport
src/calc.ts                     wraps @smogon/calc (damage formula + type effectiveness)
src/dex.ts                      get_pokemon lookups over data/champions-dex.json (fallback @smogon/calc)
src/regulations.ts              loads/validates regulations/*.json, legality checks
src/names.ts                    shared Pokémon-name canonicalization (Mega word order, base species)
scripts/scrape-champions-dex.ts standalone scraper -> data/champions-dex.json (engine dex)
scripts/scrape-regulation.ts    standalone scraper -> regulations/<id>.json (legality)
data/champions-dex.json         Champions engine dex (generated; committed)
regulations/m-b.json            legality data (generated; committed)
test/smoke.ts                   in-memory MCP client exercising all 5 tools
```
