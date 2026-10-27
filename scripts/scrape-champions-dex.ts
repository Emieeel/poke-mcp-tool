/**
 * scrape-champions-dex.ts — builds the Pokémon CHAMPIONS engine dex from Serebii.
 *
 *   npm run scrape:dex                 # scrape the whole roster (from the dex index)
 *   npm run scrape:dex -- staraptor    # scrape just one or more slugs (for testing)
 *
 * WHY THIS EXISTS: @smogon/calc's Champions generation carries stats and typing for the
 * Champions roster, but only one default ability per species and no learnsets. Serebii's
 * Champions Pokédex has every ability a species can have and its Champions learnset, so we
 * source those here. @smogon/calc stays the engine for damage calcs.
 *
 * This is an on-demand script. The MCP server never runs it; it only reads the JSON output.
 *
 * Parsing (the brittle, page-specific part) is isolated in parsePokemonPage(). Serebii lays
 * out each form as three consecutive tables in document order: a "Name … Type" table, an
 * "Abilities:" table, and a "Stats" table. We group them by document order so a page with
 * a base form + N Mega forms yields N+1 forms.
 *
 * Alternate forms (Alolan Ninetales, Rotom-Wash, Indeedee-F, ...) don't get tables of their
 * own; Serebii folds them into the base form's tables. Which forms exist, and their stats and
 * typing, come from the engine's Champions dex instead; Serebii's labels then say which
 * abilities and moves belong to which form (see addAlternateForms).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Generations, toID } from '@smogon/calc';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const INDEX_URL = 'https://www.serebii.net/pokedex-champions/';
const NEW_ABILITIES_URL = 'https://www.serebii.net/pokemonchampions/newabilities.shtml';
const entryUrl = (slug: string) => `https://www.serebii.net/pokedex-champions/${slug}/`;
// Slugs are lowercase but can contain an apostrophe or a period (farfetch'd, mr.mime,
// sirfetch'd, mr.rime) — omitting those from the character class silently drops those
// Pokémon from the roster. The trailing `+` still rejects the empty "choose a Pokémon"
// option. Keep in sync with SLUG_PATH in scrape-regulation.ts.
const SLUG_PATH = /^\/pokedex-champions\/([a-z0-9.'-]+)\/$/;

const UA = 'pokemon-champions-mcp dex scraper (personal use)';

export interface Form {
  name: string;
  types: string[];
  abilities: string[];
  baseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  weightkg: number | null;
  /** The form's own Champions learnset, when it differs from the species' (`moves`). */
  moves?: string[];
}
export interface DexEntry {
  slug: string;
  name: string;
  num: number | null;
  forms: Form[];
  // The Pokémon's full learnable movelist in Champions (shared by its Mega forms).
  moves: string[];
}
export interface AbilityEntry {
  name: string;
  /** Serebii's Champions description. */
  effect: string;
  /** True for abilities that are new in Champions (Mega Sol, Dragonize, ...). */
  isNew: boolean;
  /** Dex forms that can have it. */
  pokemon: string[];
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  // Serebii serves ISO-8859-1; decode as latin1 to keep names intact.
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('latin1');
}

/** Pull the full roster (slug + national number) from the dex index dropdowns. */
export async function fetchRoster(): Promise<{ slug: string; num: number | null }[]> {
  const html = await fetchText(INDEX_URL);
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: { slug: string; num: number | null }[] = [];
  // The index lists every Pokémon as <option value="/pokedex-champions/<slug>/">### Name</option>.
  $('option').each((_, o) => {
    const val = $(o).attr('value') || '';
    const m = val.match(SLUG_PATH);
    if (!m) return;
    const slug = m[1];
    if (seen.has(slug)) return;
    seen.add(slug);
    const num = parseInt(($(o).text().match(/#?(\d+)/) || [])[1] || '', 10);
    out.push({ slug, num: Number.isFinite(num) ? num : null });
  });
  return out;
}

// ── Per-page parser (brittle bit — isolated & commented) ────────────────────────
type Tagged = { kind: 'header' | 'name' | 'abilities' | 'stats'; el: AnyNode; label?: string };

// First-cell labels that are section tables, never a form-name header.
const SECTION_LABELS = new Set([
  'Picture', 'Name', 'Stats', 'Weakness', 'Damage Taken', 'Evolutionary Chain',
  'Gender Differences', 'Standard Moves', 'Egg Moves', 'Location', 'Flavor Text',
]);

export function parsePokemonPage(html: string, slug: string, warnings: string[] = []): DexEntry {
  const $ = cheerio.load(html);

  // Base name + national number come from the <title>: "Staraptor - #398 - Serebii.net Pokédex".
  const title = $('title').text();
  const baseName = (title.split(' - ')[0] || slug).trim();
  const numMatch = title.match(/#(\d+)/);
  const num = numMatch ? parseInt(numMatch[1], 10) : null;

  // Classify the relevant tables in document order. A form's display name (incl. the X/Y of
  // multi-Megas) lives in a "header" dextable: a picture block whose first cell is the form
  // name (e.g. "Mega Raichu X") rather than the literal word "Picture".
  const tagged: Tagged[] = [];
  $('table.dextable').each((_, t) => {
    const firstCell = $(t).find('tr').first().find('td,th').first().text().replace(/\s+/g, ' ').trim();
    const whole = $(t).text().replace(/\s+/g, ' ').trim();
    if (firstCell === 'Name') tagged.push({ kind: 'name', el: t });
    else if (/^Abilities:/.test(whole)) tagged.push({ kind: 'abilities', el: t });
    else if (/^Stats\b/.test(firstCell)) tagged.push({ kind: 'stats', el: t });
    else if (/Picture/.test(whole) && firstCell.length > 0 && firstCell.length < 40 && !SECTION_LABELS.has(firstCell)) {
      tagged.push({ kind: 'header', el: t, label: firstCell });
    }
  });

  // Walk the tables. A "header" sets the name for the form introduced by the next "name"
  // table; if there's no preceding header (the base form), fall back to the page's base name.
  const forms: Form[] = [];
  let pendingName: string | null = null;
  for (let i = 0; i < tagged.length; i++) {
    if (tagged[i].kind === 'header') {
      pendingName = tagged[i].label || null;
      continue;
    }
    if (tagged[i].kind !== 'name') continue;
    const nameTable = $(tagged[i].el);
    const form: Form = {
      name: pendingName || baseName,
      types: extractTypes(nameTable, $),
      abilities: [],
      baseStats: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      weightkg: extractWeight(nameTable),
    };
    pendingName = null;
    // Consume following abilities/stats until the next name/header table.
    for (let j = i + 1; j < tagged.length && tagged[j].kind !== 'name' && tagged[j].kind !== 'header'; j++) {
      if (tagged[j].kind === 'abilities' && form.abilities.length === 0) {
        form.abilities = extractAbilities($(tagged[j].el).find('tr').first().text());
      } else if (tagged[j].kind === 'stats' && form.baseStats.hp === 0) {
        form.baseStats = extractStats($(tagged[j].el), $);
      }
    }
    if (form.types.length || form.abilities.length || form.baseStats.hp) forms.push(form);
  }

  const sections = extractMoveSections($);
  const entry: DexEntry = { slug, name: baseName, num, forms, moves: sections[0]?.moves ?? [] };
  addAlternateForms(entry, sections, warnings);
  return entry;
}

interface MoveSection {
  /** "" for the base form, else Serebii's form label ("Alola Form", "Female", "Heat Rotom"). */
  label: string;
  moves: string[];
  /** Rotom's "Special Moves": extra moves on top of the base list, not a full learnset. */
  extra: boolean;
}

// Learnsets: one "… Moves" table per form, base form first ("Standard Moves", "Alola Form
// Standard Moves", "Standard Moves - Female", ...). Rotom's "Special Moves" table instead adds
// one move per appliance form, marked "Heat Rotom Only" etc.
function extractMoveSections($: cheerio.CheerioAPI): MoveSection[] {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const sections: MoveSection[] = [];
  $('table.dextable').each((_, t) => {
    const heading = clean($(t).find('tr').first().find('td,th').first().text());
    if (!/Moves\b/i.test(heading)) return;
    if (heading === 'Special Moves') {
      let move = '';
      $(t).find('tr').each((_, tr) => {
        move = clean($(tr).find('a[href*="/attackdex-champions/"]').first().text()) || move;
        const only = clean($(tr).children('td').last().text()).match(/^(\S+ \S+) Only$/);
        if (only && move) sections.push({ label: only[1], moves: [move], extra: true });
      });
      return;
    }
    const moves = new Set<string>();
    $(t).find('a[href*="/attackdex-champions/"]').each((_, a) => {
      const name = clean($(a).text());
      if (/[A-Za-z]/.test(name)) moves.add(name);
    });
    const label = heading.replace('Standard Moves', '').replace(/^\s*-\s*/, '').trim();
    sections.push({ label, moves: [...moves].sort((a, b) => a.localeCompare(b)), extra: false });
  });
  return sections;
}

// Serebii lists every form's abilities on one line and closes each form's group with its label:
// "Flash Fire - Drought (Ninetales) - Snow Cloak - Snow Warning (Alola Form)". The base form's
// group comes first. "(Female Hidden Ability)" marks a form that only swaps the hidden ability.
function abilityGroups(abilities: string[]) {
  const groups: { label: string; abilities: string[]; hiddenOnly: boolean }[] = [];
  let current: string[] = [];
  for (const ability of abilities) {
    const m = ability.match(/^(.*?)\s*\((.+)\)$/);
    current.push(m ? m[1] : ability);
    if (!m) continue;
    groups.push({ label: m[2].replace(/ Hidden Ability$/, ''), abilities: current, hiddenOnly: / Hidden Ability$/.test(m[2]) });
    current = [];
  }
  if (current.length || groups.length === 0) groups.push({ label: '', abilities: current, hiddenOnly: false });
  return groups;
}

// Serebii's form labels for each @smogon/calc form suffix, most specific first. A form not
// listed (Castform's weather forms, Gourgeist sizes, Vivillon patterns, ...) shares the base
// form's abilities and moves.
const FORM_LABELS: Record<string, string[]> = {
  Alola: ['Alola Form'],
  Galar: ['Galarian Form'],
  Hisui: ['Hisuian Form'],
  'Paldea-Combat': ['Paldean Form'],
  'Paldea-Blaze': ['Blaze Breed', 'Paldean Form'],
  'Paldea-Aqua': ['Aqua Breed', 'Paldean Form'],
  F: ['Female'],
  Midnight: ['Midnight Form'],
  Dusk: ['Dusk Form'],
  'Low-Key': ['Low Key Form'],
  Blue: ['Green & Blue'],
  Yellow: ['Yellow & White'],
  White: ['Yellow & White'],
  Heat: ['Heat Rotom'],
  Wash: ['Wash Rotom'],
  Frost: ['Frost Rotom'],
  Fan: ['Fan Rotom'],
  Mow: ['Mow Rotom'],
};

/**
 * Add the species' alternate forms (not Megas) from the engine's Champions dex, each with the
 * abilities and moves Serebii labels as theirs. Also fixes the base form, whose Serebii typing
 * and ability line mix in every form's.
 */
function addAlternateForms(entry: DexEntry, sections: MoveSection[], warnings: string[]): void {
  const g = Generations.get(0);
  const engineBase = g.species.get(toID(entry.name));
  const formNames = (engineBase?.otherFormes ?? []).filter((f) => !f.includes('-Mega'));
  if (!engineBase || formNames.length === 0) return;

  const base = entry.forms[0];
  const groups = abilityGroups(base.abilities);
  base.types = [...engineBase.types];
  base.abilities = groups[0].abilities;

  const used = new Set<string>();
  const pick = <T extends { label: string }>(items: T[], labels: string[]) => {
    const hit = labels.map((l) => items.find((i) => i.label === l)).find(Boolean);
    if (hit) used.add(hit.label);
    return hit;
  };
  for (const name of formNames) {
    const species = g.species.get(toID(name))!;
    const labels = FORM_LABELS[name.slice(entry.name.length + 1)] ?? [];
    const group = pick(groups.slice(1), labels);
    const section = pick(sections.filter((s, i) => i > 0 && !s.extra), labels);
    const extras = sections.filter((s) => s.extra && labels.includes(s.label)).flatMap((s) => s.moves);
    if (extras.length) labels.forEach((l) => used.add(l));
    const abilities = !group
      ? groups[0].abilities
      : group.hiddenOnly
        ? [...groups[0].abilities.slice(0, -1), ...group.abilities]
        : group.abilities;
    const { hp, atk, def, spa, spd, spe } = species.baseStats;
    entry.forms.push({
      name,
      types: [...species.types],
      abilities,
      baseStats: { hp, atk, def, spa, spd, spe },
      weightkg: species.weightkg,
      ...(section || extras.length
        ? { moves: [...new Set([...(section?.moves ?? entry.moves), ...extras])].sort((a, b) => a.localeCompare(b)) }
        : {}),
    });
  }
  // A Serebii label no form claimed means a form's abilities or moves would silently be lost.
  const labels = [...groups.slice(1), ...sections.slice(1)].map((x) => x.label);
  for (const label of new Set(labels)) {
    if (!used.has(label)) warnings.push(`${entry.slug}: Serebii form label "${label}" matched no form`);
  }
}

/**
 * Ability descriptions from a page's "Abilities" tables. The second row holds one
 * "<a href="/abilitydex/..."><b>Name</b> (Form)</a>: description" line per ability, separated
 * by <br>; lines without an ability link ("Female Abilities:") are sub-headings.
 */
export function parseAbilityEffects(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const out: Record<string, string> = {};
  $('table.dextable').each((_, t) => {
    if (!/^Abilities\s*:/.test($(t).text().replace(/\s+/g, ' ').trim())) return;
    const info = $(t).find('td.fooinfo').first();
    for (const part of (info.html() || '').split(/<br\s*\/?>/i)) {
      const line = cheerio.load(`<div>${part}</div>`);
      const link = line('a[href*="/abilitydex/"]').first();
      const name = link.find('b').first().text().replace(/\s+/g, ' ').trim();
      if (!name) continue;
      link.remove();
      const effect = line('div').text().replace(/\s+/g, ' ').trim()
        .replace(/^:\s*/, '').replace(/\s*:$/, '').trim();
      if (effect && !out[name]) out[name] = effect;
    }
  });
  return out;
}

/** Names on the New Abilities page (rows: Name | Effect). */
export function parseNewAbilities(html: string): string[] {
  const $ = cheerio.load(html);
  const names = new Set<string>();
  $('table.tab td.fooinfo a[href*="/abilitydex/"], table.dextable td.fooinfo a[href*="/abilitydex/"]').each((_, a) => {
    const name = $(a).text().replace(/\s+/g, ' ').trim();
    if (name) names.add(name);
  });
  return [...names];
}

function extractTypes(nameTable: cheerio.Cheerio<AnyNode>, $: cheerio.CheerioAPI): string[] {
  // Types are links ending in "<type>.shtml" (under /pokedex-champions/ or /pokedex-sm/).
  const types: string[] = [];
  nameTable.find('a[href*=".shtml"]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/\/([a-z]+)\.shtml$/);
    if (!m) return;
    const t = cap(m[1]);
    if (TYPES.has(t) && !types.includes(t)) types.push(t);
  });
  return types;
}

function extractAbilities(headerText: string): string[] {
  // "Abilities: Intimidate - Reckless" -> ["Intimidate", "Reckless"]. Serebii's separator is
  // a dash flanked by whitespace, but spacing is inconsistent (e.g. "Intimidate- Flash Fire"),
  // so we split on a dash that has whitespace on at least the right side. Hyphenated ability
  // names (e.g. "Soul-Heart") have no space after the dash and so survive intact.
  const after = headerText.replace(/\s+/g, ' ').trim().replace(/^Abilities:\s*/, '').trim();
  return after
    .split(/\s*-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractStats(statsTable: cheerio.Cheerio<AnyNode>, $: cheerio.CheerioAPI): Form['baseStats'] {
  // The "Base Stats - Total: N" row carries the six base stats in order.
  let row: string[] | null = null;
  statsTable.find('tr').each((_, r) => {
    const cells = $(r).find('td,th').map((_, c) => $(c).text().replace(/\s+/g, ' ').trim()).get();
    if (cells[0] && /^Base Stats/.test(cells[0])) row = cells;
  });
  if (!row) return { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  const n = (s: string) => parseInt(s, 10) || 0;
  return { hp: n(row[1]), atk: n(row[2]), def: n(row[3]), spa: n(row[4]), spd: n(row[5]), spe: n(row[6]) };
}

function extractWeight(nameTable: cheerio.Cheerio<AnyNode>): number | null {
  // The Classification/Height/Weight row contains e.g. "54.9lbs 24.9kg".
  const m = nameTable.text().match(/([\d.]+)\s*kg/);
  return m ? parseFloat(m[1]) : null;
}

const TYPES = new Set([
  'Normal', 'Fighting', 'Flying', 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Steel',
  'Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Ice', 'Dragon', 'Dark', 'Fairy',
]);
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2).map((s) => s.trim().toLowerCase()).filter(Boolean);

  let roster: { slug: string; num: number | null }[];
  if (args.length > 0) {
    console.error(`[dex] Scraping ${args.length} requested slug(s): ${args.join(', ')}`);
    roster = args.map((slug) => ({ slug, num: null }));
  } else {
    console.error(`[dex] Fetching roster index: ${INDEX_URL}`);
    roster = await fetchRoster();
    console.error(`[dex] Roster has ${roster.length} Pokémon. Fetching each page (throttled)…`);
  }

  const pokemon: Record<string, DexEntry> = {};
  const abilityEffects: Record<string, string> = {};
  const failures: string[] = [];
  let i = 0;
  for (const { slug, num } of roster) {
    i++;
    try {
      const html = await fetchText(entryUrl(slug));
      const entry = parsePokemonPage(html, slug, failures);
      for (const [name, effect] of Object.entries(parseAbilityEffects(html))) {
        abilityEffects[name] ??= effect;
      }
      if (num != null && entry.num == null) entry.num = num;
      pokemon[slug] = entry;
      if (entry.forms.length === 0) failures.push(`${slug} (no forms parsed)`);
      if (i % 25 === 0 || args.length > 0) {
        console.error(`[dex] (${i}/${roster.length}) ${slug}: ${entry.forms.length} form(s), ${entry.moves.length} moves ` +
          entry.forms.map((f) => `${f.name}[${f.abilities.join('/')}]`).join(' '));
      }
    } catch (err) {
      failures.push(`${slug} (${(err as Error).message})`);
      console.error(`[dex] FAILED ${slug}: ${(err as Error).message}`);
    }
    // Be polite to Serebii.
    if (args.length === 0) await sleep(200);
  }

  const output = {
    meta: {
      game: 'Pokémon Champions',
      source: INDEX_URL,
      scrapedAt: new Date().toISOString(),
      count: Object.keys(pokemon).length,
      note:
        'Champions Pokédex scraped from Serebii: stats, types, every ability and the ' +
        'Champions learnset per species (the engine keeps one default ability and no ' +
        'learnsets).',
    },
    pokemon,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  // For single-slug test runs, don't clobber the full file — write a preview instead.
  const outFile = join(DATA_DIR, args.length > 0 ? 'champions-dex.sample.json' : 'champions-dex.json');
  writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.error(`[dex] Wrote ${outFile} — ${output.meta.count} Pokémon.`);

  // Abilities: every ability a dex form can have, with its Champions description.
  const newAbilities = new Set(parseNewAbilities(await fetchText(NEW_ABILITIES_URL)));
  if (newAbilities.size === 0) failures.push('New Abilities page: no abilities found');
  const abilities: Record<string, AbilityEntry> = {};
  for (const entry of Object.values(pokemon)) {
    for (const form of entry.forms) {
      for (const raw of form.abilities) {
        const name = raw.replace(/\s*\(.*?\)\s*$/, '').trim();
        if (!name) continue;
        const a = (abilities[name] ??= {
          name,
          effect: abilityEffects[name] ?? '',
          isNew: newAbilities.has(name),
          pokemon: [],
        });
        if (!a.pokemon.includes(form.name)) a.pokemon.push(form.name);
      }
    }
  }
  for (const a of Object.values(abilities)) {
    if (!a.effect) failures.push(`ability ${a.name}: no description found`);
  }
  const abilitiesOut = {
    meta: {
      game: 'Pokémon Champions',
      source: INDEX_URL,
      newAbilitiesSource: NEW_ABILITIES_URL,
      scrapedAt: output.meta.scrapedAt,
      count: Object.keys(abilities).length,
      note:
        'Every ability a Champions Pokémon can have, with its Champions description (from the ' +
        'Pokédex pages) and whether it is new in Champions.',
    },
    abilities: Object.fromEntries(Object.entries(abilities).sort(([a], [b]) => a.localeCompare(b))),
  };
  const abilitiesFile = join(DATA_DIR, args.length > 0 ? 'champions-abilities.sample.json' : 'champions-abilities.json');
  writeFileSync(abilitiesFile, JSON.stringify(abilitiesOut, null, 2) + '\n', 'utf8');
  console.error(`[dex] Wrote ${abilitiesFile} — ${abilitiesOut.meta.count} abilities (${newAbilities.size} new in Champions).`);

  if (failures.length) {
    console.error(`[dex] ${failures.length} issue(s):`);
    for (const f of failures) console.error('   - ' + f);
  }
}

main().catch((err) => {
  console.error('[dex] fatal:', err);
  process.exit(1);
});
