# Pokémon Champions MCP Server

A small [MCP](https://modelcontextprotocol.io) server that gives an AI assistant accurate,
up-to-date data for competitive **Pokémon Champions**. Hook it up to Claude (or any MCP
client) and you can ask things like:

> *"Does my Choice Band Mega Staraptor OHKO Garchomp?"*
> *"Is Sneasler legal in Regulation M-B, and who else can run Fake Out there?"*
> *"What Fairy moves are usable this format?"*

It covers damage calculation, type matchups, Pokédex and item lookups, move search, and
regulation legality. Everything runs locally — normal queries never hit the network.

## Setup

You'll need **Node 18+**. Clone the repo, then:

```bash
npm install
npm run build
```

That compiles everything into `dist/`. Quick check that it works:

```bash
npm test
```

## Connecting it to your assistant

This is a standard stdio MCP server, so any MCP client can launch it — you just point it at
the built `dist/index.js`.

1. Grab the absolute path to the entry point (you'll paste this into your client):

   ```bash
   node -e "console.log(require('path').resolve('dist/index.js'))"
   ```

2. Add it to your client's MCP config:

   ```json
   {
     "mcpServers": {
       "pokemon-champions": {
         "command": "node",
         "args": ["/absolute/path/to/poke-mcp-tool/dist/index.js"]
       }
     }
   }
   ```

   - **Claude Desktop** — Settings → Developer → Edit Config, then merge in the block above.
   - **Claude Code** — `claude mcp add pokemon-champions node /absolute/path/dist/index.js`.
   - **Anything else** — add an equivalent stdio entry (`command: node`, `args: [path]`).

3. Restart the client. It should now list tools like `calculate_damage` and
   `find_pokemon_by_move`. Try asking it one of the questions up top.

Use the **absolute** path — the client runs from its own working directory, so a relative
one won't resolve.

## Hosting it online (Cloudflare Workers)

Want people to use it without installing anything — or from Claude on the web or your phone?
Deploy it as a remote HTTP server and they just paste a **URL**. It runs on Cloudflare
Workers' free tier.

Every tool is read-only over public data, so the hosted server is **stateless and needs no
login or API key** — there's no OAuth to set up. Workers has no filesystem, so the datasets are
bundled into the Worker ([`src/worker.ts`](src/worker.ts)) instead of read from disk; the local
stdio server is untouched.

```bash
npm install
npx wrangler login          # one-time: authorize Wrangler with your free Cloudflare account
npm run dev:worker          # optional: test locally (real Workers runtime, no account needed)
npm run deploy:worker       # deploy — prints your public URL
```

The MCP endpoint is the printed URL plus **`/mcp`** (e.g.
`https://pokemon-champions-mcp.<you>.workers.dev/mcp`); a plain `GET /` is a health check.
Add that `/mcp` URL as a **custom connector** in Claude (Settings → Connectors; requires a paid
plan, or one connector on Free) or as a remote MCP server in Cursor. Config lives in
[`wrangler.toml`](wrangler.toml).

## Tools

| Tool | What it answers |
| --- | --- |
| `calculate_damage` | "Does my Mystic Water Blastoise OHKO that Garchomp?" — full damage/percent range, hits-to-KO, and the human-readable calc string. Auto-fills stats/typing/ability from the Champions dex (so Mega Staraptor uses Contrary, and even Champions-only Megas like Mega Eelektross calc correctly). Handles items, weather, terrain, Tera, crits, multi-hit, and Doubles spread reduction. |
| `type_effectiveness` | The multiplier (0–4x) of an attacking type against 1–2 defending types. |
| `get_pokemon` | Base stats, typing, abilities, weight, and full **movelist** for a Pokémon (Mega forms accepted, e.g. `Staraptor-Mega`, `Mega Staraptor`, `Mega Raichu X`). Pass a `regulation` id to also get legality and regulation-legal moves. |
| `get_item` | Effect, how-to-obtain, and category (Hold Item / Mega Stone / Berry) for a held item, e.g. `Choice Scarf`, `Garchompite`, `Lum Berry`. Pass a `regulation` id to also check legality. |
| `list_items` | Browse the held-item catalog, optionally filtered by `category` or a `nameContains` substring (held-only by default; `includeNonHeld` adds tickets). Pass a `regulation` id to mark which items are legal. |
| `check_legality` | Whether a Pokémon — and optionally listed moves and/or held `items` — is legal in a regulation. |
| `find_pokemon_by_move` | "Who can run Fake Out in M-B?" — every Pokémon legal in a regulation that can learn a given move, with the move's type/category/base power. Name-tolerant (`willowisp` → Will-O-Wisp). Defaults to `m-b`. |
| `list_legal_moves` | The pool of moves usable in a regulation (everything learnable by at least one legal Pokémon), each with type, category, base power, and how many Pokémon learn it. Filter by `type`, `category`, or a `nameContains` substring. Defaults to `m-b`. |
| `list_legal_pokemon` | The regulation's legal roster, each with its dex number, typing, base stats, and abilities. Filter by `type` (e.g. `Dragon`) or a `nameContains` substring. The complement to `list_legal_moves`. Defaults to `m-b`. |
| `list_regulations` | Which regulations are available locally, with each one's metadata and counts. |

## Good to know

A few things that reflect how the format actually works, and which the tools tell you about
in their output rather than hiding:

- **There are no per-move bans.** A move is "legal" if a legal Pokémon can learn it, so
  `list_legal_moves` is really the pool of learnable moves — and a move with no legal learners
  (e.g. Spore in M-B) shows up as unusable.
- **Mega legality follows the base species.** `check_legality("Mega Staraptor")` resolves via
  Staraptor, unless that specific Mega is separately excluded (M-B drops Mega Garchomp Z and
  Mega Lucario Z).
- **A handful of Champions-original ability effects aren't simulated.** Stats, typing, and the
  ability name are accurate, but a brand-new ability's special mechanic may not factor into
  the damage number.

## Refreshing the data

The server only ever reads its data files; the scrapers below are run by hand when the game
changes. They pull from [Serebii](https://www.serebii.net/pokedex-champions/).

```bash
npm run scrape -- m-b      # regulation legality (roster + bans + legal items)
npm run scrape:items       # held-item catalog (effects, locations, categories)
npm run scrape:dex         # per-Pokémon stats, typing, abilities, learnsets
```

Pass a different id to the first one for future regulations (`npm run scrape -- m-c`). The
scrapers are deliberately forgiving — if a page changes shape they warn and write what they
found instead of crashing.

## Layout

```text
src/server.ts       the 9 MCP tools (transport-agnostic; no Node-only or filesystem code)
src/index.ts        stdio entry — mounts server.ts on stdio (the local default)
src/worker.ts       Cloudflare Workers entry — mounts server.ts on HTTP, with data bundled in
src/diskdata.ts     Node-only: reads the JSON datasets from disk and registers them (stdio)
src/calc.ts         damage formula + type effectiveness
src/dex.ts          Pokémon lookups (data/champions-dex.json; injected or disk-loaded)
src/items.ts        item lookups (data/champions-items.json; injected or disk-loaded)
src/movedex.ts      move search, regulation-scoped
src/regulations.ts  legality checks over regulations/*.json (injected or disk-loaded)
src/names.ts        Pokémon-name normalization (Mega word order, base species)
scripts/            the standalone scrapers
data/, regulations/ generated data (committed; bundled into the Worker)
test/smoke.ts       in-memory MCP client exercising every tool
wrangler.toml       Cloudflare Workers config (hosted deployment)
```
