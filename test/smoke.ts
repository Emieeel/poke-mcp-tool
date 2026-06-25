/**
 * smoke.ts — exercises all 5 tools through a real in-memory MCP client/server pair.
 *
 *   npm test
 *
 * This mounts the actual server (createServer()) on an in-memory transport and calls each
 * tool exactly as a Claude client would, then asserts the results match the spec's
 * definition of done. Run after `npm run scrape -- m-b` so the regulation tools have data.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';

let failures = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  const status = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${status}] ${label}${detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ''}`);
}

async function callJson(client: Client, name: string, args: Record<string, unknown>) {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '{}';
  return { parsed: JSON.parse(text), isError: Boolean(res.isError) };
}

async function main() {
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'smoke-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // Sanity: all five tools registered.
  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  console.log('\nRegistered tools:', toolNames.join(', '));
  check(
    'all 10 tools present',
    ['calculate_damage', 'check_legality', 'find_pokemon_by_move', 'get_item', 'get_pokemon', 'list_items', 'list_legal_moves', 'list_legal_pokemon', 'list_regulations', 'type_effectiveness'].every(
      (n) => toolNames.includes(n),
    ),
  );

  // 1. calculate_damage — plausible percent range, with abilities/stats auto-filled.
  console.log('\ncalculate_damage:');
  {
    const { parsed } = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Staraptor-Mega', level: 50, nature: 'Adamant', statPoints: { atk: 32 }, item: 'Choice Band' },
      defender: { name: 'Garchomp', level: 50, nature: 'Jolly', statPoints: { hp: 4 } },
      move: 'Close Combat',
      field: { gameType: 'Doubles' },
    });
    console.log('   ', parsed.description);
    check('percent range is plausible (min>0, max<=300)', parsed.percentRange.min > 0 && parsed.percentRange.max <= 300, parsed.percentRange);
    check('produced a KO/hits result', typeof parsed.koChance?.hitsToKO === 'number', parsed.koChance);
    check('auto-filled attacker ability Contrary from Champions dex', parsed.notes.some((n: string) => /Contrary/.test(n)), parsed.notes);
    // A Champions-original Mega @smogon/calc has never heard of still calcs via overrides.
    const orig = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Mega Eelektross', level: 50, nature: 'Modest', statPoints: { spa: 32 } },
      defender: { name: 'Gholdengo', level: 50 },
      move: 'Thunderbolt',
    });
    console.log('   ', orig.parsed.description);
    check('Champions-original Mega Eelektross calc works (overrides)', orig.parsed.percentRange.max > 0, orig.parsed.percentRange);
    // Immunity (Electric vs Ground) must not crash and reports 0 damage.
    const immune = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Pikachu', level: 50 }, defender: { name: 'Garchomp', level: 50 }, move: 'Thunderbolt',
    });
    check('type immunity returns 0 damage without crashing', immune.isError === false && immune.parsed.percentRange.max === 0, immune.parsed.percentRange);

    // Champions Stat Points: investing Attack SP must raise damage (1 SP = +1 stat at Lv50).
    const spOff = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Garchomp', level: 50, nature: 'Serious', statPoints: { atk: 0 } },
      defender: { name: 'Gholdengo', level: 50 }, move: 'Earthquake',
    });
    const spOn = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Garchomp', level: 50, nature: 'Serious', statPoints: { atk: 32 } },
      defender: { name: 'Gholdengo', level: 50 }, move: 'Earthquake',
    });
    check('Attack Stat Points raise damage (32 SP > 0 SP)', spOn.parsed.damageRange.max > spOff.parsed.damageRange.max, { zero: spOff.parsed.damageRange.max, maxed: spOn.parsed.damageRange.max });
    check('defender with 0 SP still yields a real percent range (no NaN)', spOff.parsed.percentRange.max > 0, spOff.parsed.percentRange);
    // The 66-SP total cap must be enforced (this spread totals 96 SP). The schema rejects it,
    // which surfaces as a thrown protocol error rather than a tool result.
    let capRejected = false;
    try {
      const overCap = await callJson(client, 'calculate_damage', {
        attacker: { name: 'Garchomp', level: 50, statPoints: { atk: 32, spe: 32, hp: 32 } },
        defender: { name: 'Gholdengo', level: 50 }, move: 'Earthquake',
      });
      capRejected = overCap.isError === true;
    } catch {
      capRejected = true;
    }
    check('over-66 Stat Point total is rejected', capRejected);

    // The old EV/IV system must be COMPLETELY gone from the surface: a legacy `evs` key is
    // rejected, and the calc string is rewritten into Stat Points (no leftover EV numbers).
    let legacyRejected = false;
    try {
      const legacy = await callJson(client, 'calculate_damage', {
        attacker: { name: 'Garchomp', level: 50, evs: { atk: 252 } },
        defender: { name: 'Gholdengo', level: 50 }, move: 'Earthquake',
      });
      legacyRejected = legacy.isError === true;
    } catch {
      legacyRejected = true;
    }
    check('legacy `evs` input is rejected (no EV/IV system)', legacyRejected);

    const descCase = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Torkoal', level: 50, nature: 'Modest', statPoints: { spa: 32 } },
      defender: { name: 'Garchomp', level: 50, statPoints: { hp: 2 } }, move: 'Eruption',
    });
    // No "<number> <Stat>" group in the calc string may exceed the 32-SP cap (would mean a
    // raw EV like 252/12 leaked through). BP/percent/KO numbers aren't "<n> <Stat>" so are safe.
    const statInvest = [...descCase.parsed.description.matchAll(/(\d+)[+-]?\s+(?:HP|Atk|Def|SpA|SpD|Spe)\b/g)];
    check('calc string is in Stat Points, not EVs (all stat numbers <= 32)',
      statInvest.length > 0 && statInvest.every((m) => Number(m[1]) <= 32),
      { desc: descCase.parsed.description });
  }

  // 1a. Battle-history scaling moves: Rage Fist (per hit taken), Last Respects (per fainted
  // ally), and the universal basePowerOverride escape hatch. @smogon/calc defaults these to a
  // flat 50 BP, so each stack must strictly raise damage and be reflected in the notes.
  console.log('\ncalculate_damage (variable-power moves):');
  {
    const base = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Annihilape', level: 50, nature: 'Adamant', statPoints: { atk: 32 } },
      defender: { name: 'Garchomp', level: 50 }, move: 'Rage Fist',
      field: { gameType: 'Singles' },
    });
    const hit3 = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Annihilape', level: 50, nature: 'Adamant', statPoints: { atk: 32 } },
      defender: { name: 'Garchomp', level: 50 }, move: 'Rage Fist',
      field: { gameType: 'Singles' }, moveContext: { timesHit: 3 },
    });
    const hitCap = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Annihilape', level: 50, nature: 'Adamant', statPoints: { atk: 32 } },
      defender: { name: 'Garchomp', level: 50 }, move: 'Rage Fist',
      field: { gameType: 'Singles' }, moveContext: { timesHit: 99 },
    });
    console.log('   ', base.parsed.percentRange, '->', hit3.parsed.percentRange, '-> cap', hitCap.parsed.percentRange);
    check('Rage Fist with 3 hits taken out-damages base 50 BP', hit3.parsed.damageRange.max > base.parsed.damageRange.max, { base: base.parsed.damageRange.max, hit3: hit3.parsed.damageRange.max });
    check('Rage Fist 6+ hits out-damages 3 hits', hitCap.parsed.damageRange.max > hit3.parsed.damageRange.max, { hit3: hit3.parsed.damageRange.max, cap: hitCap.parsed.damageRange.max });
    check('Rage Fist caps at 350 BP (99 hits == 6 hits)', hitCap.parsed.notes.some((n: string) => /capped at 350/.test(n)), hitCap.parsed.notes);
    check('Rage Fist scaling surfaced in notes', hit3.parsed.notes.some((n: string) => /Rage Fist scaled to/.test(n)), hit3.parsed.notes);

    // Last Respects: more fainted allies => more damage.
    const lr0 = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Houndstone', level: 50, nature: 'Adamant', statPoints: { atk: 32 } },
      defender: { name: 'Garchomp', level: 50 }, move: 'Last Respects', field: { gameType: 'Singles' },
    });
    const lr3 = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Houndstone', level: 50, nature: 'Adamant', statPoints: { atk: 32 } },
      defender: { name: 'Garchomp', level: 50 }, move: 'Last Respects',
      field: { gameType: 'Singles' }, moveContext: { faintedAllies: 3 },
    });
    check('Last Respects with 3 fainted allies out-damages base', lr3.parsed.damageRange.max > lr0.parsed.damageRange.max, { base: lr0.parsed.damageRange.max, lr3: lr3.parsed.damageRange.max });

    // basePowerOverride: universal escape hatch for any variable-power move.
    const ovr = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Annihilape', level: 50, nature: 'Adamant', statPoints: { atk: 32 } },
      defender: { name: 'Garchomp', level: 50 }, move: 'Rage Fist',
      field: { gameType: 'Singles' }, moveContext: { basePowerOverride: 350, timesHit: 0 },
    });
    check('basePowerOverride wins over the hit counter', ovr.parsed.damageRange.max === hitCap.parsed.damageRange.max, { override: ovr.parsed.damageRange.max, cap: hitCap.parsed.damageRange.max });
    check('basePowerOverride surfaced in notes', ovr.parsed.notes.some((n: string) => /forced to 350 BP/.test(n)), ovr.parsed.notes);
  }

  // 1c. Offensive-ability parity with the canonical CHAMP calculator, for Champions-original
  // abilities @smogon/calc doesn't know natively (Mega Sol, Dragonize). We make the ENGINE apply
  // them — Mega Sol as Sun on the field (so Weather Ball becomes 100 BP Fire, Fire ×1.5, ...),
  // Dragonize as a move retype + a base-power boost folded into BP — rather than post-multiplying
  // the rolls (which mis-rounds). Damage range + percent are transcribed from the reference and
  // must match EXACTLY. NB: the wrapper's calc string omits the Champions-original ability name
  // (stock @smogon/calc doesn't recognize it, so it can't print it — we surface it in `notes`
  // instead); Mega Sol's string additionally reads "in Sun" since we model the ability as Sun.
  console.log('\ncalculate_damage (offensive-ability parity):');
  {
    // Reference: "32+ SpA Mega Sol Mega Meganium Weather Ball (100 BP Fire) vs. 32 HP / 12+ SpD
    //             Sinistcha: 198-234 (111.2 - 131.4%) -- guaranteed OHKO"
    // Mega Sol makes it act as harsh sun: Weather Ball turns into a 100 BP Fire move.
    const sol = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Mega Meganium', level: 50, nature: 'Modest', ability: 'Mega Sol', statPoints: { spa: 32 } },
      defender: { name: 'Sinistcha', level: 50, nature: 'Careful', statPoints: { hp: 32, spd: 12 } },
      move: 'Weather Ball', field: { gameType: 'Singles' },
    });
    console.log('   ', sol.parsed.description);
    check('Mega Sol Weather Ball vs Sinistcha: damage 198-234',
      sol.parsed.damageRange.min === 198 && sol.parsed.damageRange.max === 234, sol.parsed.damageRange);
    check('Mega Sol Weather Ball vs Sinistcha: percent 111.2-131.4%',
      sol.parsed.percentRange.min === 111.2 && sol.parsed.percentRange.max === 131.4, sol.parsed.percentRange);
    check('Mega Sol turned Weather Ball into a 100 BP Fire move (engine saw the Sun)',
      /Weather Ball \(100 BP Fire\)/.test(sol.parsed.description), sol.parsed.description);
    check('Mega Sol note surfaced', sol.parsed.notes.some((n: string) => /Mega Sol/.test(n)), sol.parsed.notes);

    // Reference: "32 Atk Dragonize Mega Feraligatr Double-Edge vs. 32 HP / 22 Def Sinistcha:
    //             117-138 (65.7 - 77.5%) -- guaranteed 2HKO after Leftovers recovery"
    // Dragonize: Double-Edge (Normal, 120 BP) becomes Dragon and gets +20% BP (-> 144) + STAB.
    const dz = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Mega Feraligatr', level: 50, nature: 'Serious', ability: 'Dragonize', statPoints: { atk: 32 } },
      defender: { name: 'Sinistcha', level: 50, nature: 'Serious', item: 'Leftovers', statPoints: { hp: 32, def: 22 } },
      move: 'Double-Edge', field: { gameType: 'Singles' },
    });
    console.log('   ', dz.parsed.description);
    check('Dragonize Double-Edge vs Sinistcha: damage 117-138',
      dz.parsed.damageRange.min === 117 && dz.parsed.damageRange.max === 138, dz.parsed.damageRange);
    check('Dragonize Double-Edge vs Sinistcha: percent 65.7-77.5%',
      dz.parsed.percentRange.min === 65.7 && dz.parsed.percentRange.max === 77.5, dz.parsed.percentRange);
    check('Dragonize Double-Edge vs Sinistcha: full calc string matches (less the ability name)',
      dz.parsed.description === '32 Atk Mega Feraligatr Double-Edge vs. 32 HP / 22 Def Sinistcha: 117-138 (65.7 - 77.5%) -- guaranteed 2HKO after Leftovers recovery',
      dz.parsed.description);
    check('Dragonize note surfaced', dz.parsed.notes.some((n: string) => /Dragonize/.test(n)), dz.parsed.notes);
  }

  // 1b. Parity with the canonical Smogon VGC calculator (CHAMP tab). Each case is transcribed
  // from that calculator's own output; we assert the exact damage range, truncated percent
  // range, and full calc string. These lock the engine wrapper to the trusted reference.
  console.log('\ncalculate_damage (reference parity):');
  {
    // Reference: "32+ SpA Charcoal Torkoal Eruption (150 BP) vs. 2 HP / 0 SpD Garchomp in Sun:
    //             81-96 (43.7 - 51.8%) -- 14.06% chance to 2HKO"  (Doubles, Drought Sun)
    const torkoal = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Torkoal', level: 50, nature: 'Quiet', item: 'Charcoal', ability: 'Drought', statPoints: { hp: 32, spa: 32, spd: 2 } },
      defender: { name: 'Garchomp', level: 50, nature: 'Adamant', item: 'Choice Scarf', statPoints: { hp: 2, atk: 32, spe: 32 } },
      move: 'Eruption',
      field: { gameType: 'Doubles', weather: 'Sun' },
    });
    check('Torkoal Eruption vs Garchomp in Sun: damage 81-96',
      torkoal.parsed.damageRange.min === 81 && torkoal.parsed.damageRange.max === 96, torkoal.parsed.damageRange);
    check('Torkoal Eruption vs Garchomp in Sun: percent 43.7-51.8%',
      torkoal.parsed.percentRange.min === 43.7 && torkoal.parsed.percentRange.max === 51.8, torkoal.parsed.percentRange);
    check('Torkoal Eruption vs Garchomp in Sun: calc string matches reference',
      torkoal.parsed.description === '32+ SpA Charcoal Torkoal Eruption (150 BP) vs. 2 HP / 0 SpD Garchomp in Sun: 81-96 (43.7 - 51.8%) -- 14.1% chance to 2HKO',
      torkoal.parsed.description);

    // Reference: "32+ Atk Meowscarada Flower Trick vs. 32 HP / 0 Def Aegislash-Shield on a
    //             critical hit: 33-40 (19.7 - 23.9%) -- possible 5HKO"  (Flower Trick always crits)
    const meow = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Meowscarada', level: 50, nature: 'Adamant', ability: 'Protean', statPoints: { atk: 32 } },
      defender: { name: 'Aegislash-Shield', level: 50, nature: 'Brave', item: 'Spell Tag', ability: 'Stance Change', statPoints: { hp: 32, atk: 32, spd: 2 } },
      move: 'Flower Trick',
      field: { gameType: 'Doubles' },
    });
    check('Meowscarada Flower Trick (crit) vs Aegislash-Shield: damage 33-40',
      meow.parsed.damageRange.min === 33 && meow.parsed.damageRange.max === 40, meow.parsed.damageRange);
    check('Meowscarada Flower Trick (crit) vs Aegislash-Shield: percent 19.7-23.9%',
      meow.parsed.percentRange.min === 19.7 && meow.parsed.percentRange.max === 23.9, meow.parsed.percentRange);
    check('Meowscarada Flower Trick (crit) vs Aegislash-Shield: calc string matches reference',
      meow.parsed.description === '32+ Atk Meowscarada Flower Trick vs. 32 HP / 0 Def Aegislash-Shield on a critical hit: 33-40 (19.7 - 23.9%) -- possible 5HKO',
      meow.parsed.description);
  }

  // 2. type_effectiveness — the two spec assertions.
  console.log('\ntype_effectiveness:');
  {
    const a = await callJson(client, 'type_effectiveness', { attackingType: 'Fighting', defendingTypes: ['Normal'] });
    check('Fighting vs Normal = 2x', a.parsed.multiplier === 2, a.parsed.multiplier);
    const b = await callJson(client, 'type_effectiveness', { attackingType: 'Fighting', defendingTypes: ['Flying', 'Psychic'] });
    check('Fighting vs Flying/Psychic = 0.25x', b.parsed.multiplier === 0.25, b.parsed.multiplier);
  }

  // 3. get_pokemon — Champions-accurate: Mega Staraptor must be Fighting/Flying + Contrary.
  console.log('\nget_pokemon:');
  {
    const { parsed } = await callJson(client, 'get_pokemon', { name: 'Staraptor-Mega', regulation: 'm-b' });
    check('Staraptor-Mega typing is Fighting/Flying', JSON.stringify(parsed.types) === JSON.stringify(['Fighting', 'Flying']), parsed.types);
    check('data came from the Champions dex', parsed.source === 'champions-dex', { source: parsed.source });
    console.log('    abilities:', JSON.stringify(parsed.abilities));
    check('Mega Staraptor ability is Contrary (Champions-accurate)', parsed.abilities.includes('Contrary'), parsed.abilities);
    check('returns a full movelist', Array.isArray(parsed.moves) && parsed.moves.length > 10 && parsed.moves.includes('Brave Bird'), { count: parsed.moves?.length });
    check('regulation legality attached', parsed.regulation?.legal === true, { legal: parsed.regulation?.legal });
    check('regulation-legal moves listed (= learnset)', Array.isArray(parsed.regulation?.regulationLegalMoves) && parsed.regulation.regulationLegalMoves.length > 10, { count: parsed.regulation?.regulationLegalMoves?.length });
    // Multi-mega naming: "Mega Raichu X" resolves and differs from "Mega Raichu Y".
    const rx = await callJson(client, 'get_pokemon', { name: 'Mega Raichu X' });
    const ry = await callJson(client, 'get_pokemon', { name: 'Mega Raichu Y' });
    check('Mega Raichu X and Y resolve to distinct abilities',
      rx.parsed.abilities?.[0] && ry.parsed.abilities?.[0] && JSON.stringify(rx.parsed.abilities) !== JSON.stringify(ry.parsed.abilities),
      { x: rx.parsed.abilities, y: ry.parsed.abilities });
  }

  // 4. check_legality — full roster, a banned Mega form, and a missing regulation.
  console.log('\ncheck_legality:');
  {
    const legal = await callJson(client, 'check_legality', { regulation: 'm-b', pokemon: 'Garchomp', moves: ['Earthquake', 'Recover'] });
    check('Garchomp is legal in m-b (full roster)', legal.parsed.pokemonLegal === true, { legal: legal.parsed.pokemonLegal });
    check('move legality now available (learnset)', legal.parsed.moveLegalityAvailable === true);
    check('Garchomp can learn Earthquake but not Recover', legal.parsed.moves?.find((m: any) => m.move === 'Earthquake')?.legal === true && legal.parsed.moves?.find((m: any) => m.move === 'Recover')?.legal === false, legal.parsed.moves);
    const banned = await callJson(client, 'check_legality', { regulation: 'm-b', pokemon: 'Mega Garchomp Z' });
    check('Mega Garchomp Z is banned in m-b', banned.parsed.pokemonLegal === false, { legal: banned.parsed.pokemonLegal });
    const missing = await callJson(client, 'check_legality', { regulation: 'zz-nonexistent', pokemon: 'Pikachu' });
    check('missing regulation returns a clear error', missing.isError === true && /scrape/i.test(missing.parsed.error ?? ''), missing.parsed.error);
    // Item legality is regulation-scoped: a real held item is legal, a non-held ticket is not.
    const withItems = await callJson(client, 'check_legality', { regulation: 'm-b', pokemon: 'Garchomp', items: ['Life Orb', 'Bug-Type Affinity Ticket'] });
    check('item legality available for m-b', withItems.parsed.itemLegalityAvailable === true);
    check('Life Orb legal, ticket illegal in m-b',
      withItems.parsed.items?.find((i: any) => i.item === 'Life Orb')?.legal === true &&
        withItems.parsed.items?.find((i: any) => /Ticket/.test(i.item))?.legal === false,
      withItems.parsed.items);
  }

  // 5. list_regulations — m-b present with meta + full-roster counts.
  console.log('\nlist_regulations:');
  {
    const { parsed } = await callJson(client, 'list_regulations', {});
    const mb = parsed.regulations.find((r: any) => r.id === 'm-b');
    check('m-b is listed', Boolean(mb), parsed.regulations.map((r: any) => r.id));
    check('m-b has meta with source + dates', Boolean(mb?.meta?.source && mb?.meta?.validFrom), mb?.meta);
    check('m-b full roster has 100+ legal Pokémon', mb?.legalPokemonCount > 100, { count: mb?.legalPokemonCount });
    check('m-b reports banned + newly-useable counts', mb?.bannedPokemonCount > 0 && mb?.newlyUseableCount > 0, { banned: mb?.bannedPokemonCount, newly: mb?.newlyUseableCount });
  }

  // 6. get_item — Champions-accurate effect/category, plus regulation legality.
  console.log('\nget_item:');
  {
    const { parsed } = await callJson(client, 'get_item', { name: 'Choice Scarf', regulation: 'm-b' });
    check('Choice Scarf is a held Hold Item', parsed.category === 'Hold Item' && parsed.held === true, { category: parsed.category, held: parsed.held });
    check('data came from the Champions item catalog', parsed.source === 'champions-items', { source: parsed.source });
    check('Choice Scarf effect mentions Speed', /speed/i.test(parsed.effect ?? ''), parsed.effect);
    check('Choice Scarf is legal in m-b', parsed.regulation?.legal === true, { legal: parsed.regulation?.legal });
    // A Mega Stone resolves with its category.
    const stone = await callJson(client, 'get_item', { name: 'Garchompite' });
    check('Garchompite is a Mega Stone', stone.parsed.category === 'Mega Stone', { category: stone.parsed.category });
    // Name normalization: "lum-berry" resolves to "Lum Berry".
    const lum = await callJson(client, 'get_item', { name: 'lum-berry' });
    check('"lum-berry" resolves to Lum Berry (Berry)', lum.parsed.name === 'Lum Berry' && lum.parsed.category === 'Berry', { name: lum.parsed.name, category: lum.parsed.category });
    // Unknown item is a clear error.
    const bad = await callJson(client, 'get_item', { name: 'Definitely Not An Item' });
    check('unknown item returns a clear error', bad.isError === true, bad.parsed.error);
  }

  // 7. list_items — category filter, held-only default, and regulation legality marking.
  console.log('\nlist_items:');
  {
    const berries = await callJson(client, 'list_items', { category: 'Berry' });
    check('Berry filter returns only Berries', berries.parsed.count > 10 && berries.parsed.items.every((i: any) => i.category === 'Berry'), { count: berries.parsed.count });
    const all = await callJson(client, 'list_items', {});
    check('default list excludes non-held items', all.parsed.items.every((i: any) => i.held === true), { count: all.parsed.count });
    const misc = await callJson(client, 'list_items', { includeNonHeld: true, nameContains: 'ticket' });
    check('includeNonHeld surfaces tickets', misc.parsed.count > 0 && misc.parsed.items.some((i: any) => i.held === false), { count: misc.parsed.count });
    const reg = await callJson(client, 'list_items', { category: 'Hold Item', regulation: 'm-b' });
    check('regulation marks Hold Items legal in m-b', reg.parsed.items.length > 0 && reg.parsed.items.every((i: any) => i.regulationLegal === true), { sample: reg.parsed.items.slice(0, 2) });
  }

  // 8. find_pokemon_by_move — legal learners of a move in m-b (defaults to m-b).
  console.log('\nfind_pokemon_by_move:');
  {
    const fo = await callJson(client, 'find_pokemon_by_move', { move: 'Fake Out' });
    check('Fake Out is learnable in m-b (defaulted regulation)', fo.parsed.learnable === true && fo.parsed.count > 0, { count: fo.parsed.count });
    check('Fake Out learners include Incineroar', fo.parsed.pokemon.some((p: any) => p.name === 'Incineroar'), fo.parsed.pokemon.slice(0, 3));
    check('move metadata enriched (Normal/Physical)', fo.parsed.move.type === 'Normal' && fo.parsed.move.category === 'Physical', fo.parsed.move);
    // A move no legal Champions mon learns -> learnable false, empty list, no crash.
    const none = await callJson(client, 'find_pokemon_by_move', { regulation: 'm-b', move: 'Glacial Lance' });
    check('Glacial Lance has no legal learners in m-b', none.parsed.learnable === false && none.parsed.count === 0, { count: none.parsed.count });
    // Name normalization: hyphen/spacing variants resolve to the same move.
    const wisp = await callJson(client, 'find_pokemon_by_move', { move: 'willowisp' });
    check('"willowisp" resolves to Will-O-Wisp learners', wisp.parsed.learnable === true && wisp.parsed.move.name === 'Will-O-Wisp', { name: wisp.parsed.move.name, count: wisp.parsed.count });
  }

  // 9. list_legal_moves — the regulation's learnable-move pool, with filters.
  console.log('\nlist_legal_moves:');
  {
    const all = await callJson(client, 'list_legal_moves', {});
    check('m-b has a large legal-move pool (100+)', all.parsed.totalLegalMoves > 100, { total: all.parsed.totalLegalMoves });
    check('each move carries a learnableByCount', all.parsed.moves.every((m: any) => typeof m.learnableByCount === 'number' && m.learnableByCount > 0), { sample: all.parsed.moves.slice(0, 2) });
    const fire = await callJson(client, 'list_legal_moves', { type: 'Fire' });
    check('type filter returns only Fire moves', fire.parsed.count > 0 && fire.parsed.moves.every((m: any) => m.type === 'Fire'), { count: fire.parsed.count });
    const status = await callJson(client, 'list_legal_moves', { category: 'Status', nameContains: 'spore' });
    check('category + name filters compose (Status "spore")',
      status.parsed.count > 0 &&
        status.parsed.moves.every((m: any) => m.category === 'Status' && /spore/i.test(m.displayName)) &&
        status.parsed.moves.some((m: any) => m.name === 'Stun Spore'),
      status.parsed.moves);
  }

  // 10. list_legal_pokemon — the regulation's legal roster, with filters.
  console.log('\nlist_legal_pokemon:');
  {
    const all = await callJson(client, 'list_legal_pokemon', {});
    check('m-b has a large legal-Pokémon pool (100+)', all.parsed.totalLegalPokemon > 100, { total: all.parsed.totalLegalPokemon });
    check('resolved entries carry typing and base stats', all.parsed.pokemon.some((p: any) => p.resolved && p.types.length > 0 && p.baseStats), { sample: all.parsed.pokemon.slice(0, 2) });
    const dragon = await callJson(client, 'list_legal_pokemon', { type: 'Dragon' });
    check('type filter returns only Dragon types', dragon.parsed.count > 0 && dragon.parsed.pokemon.every((p: any) => p.types.includes('Dragon')), { count: dragon.parsed.count });
    const name = await callJson(client, 'list_legal_pokemon', { nameContains: 'char' });
    check('name filter matches substring (case-insensitive)', name.parsed.count > 0 && name.parsed.pokemon.every((p: any) => /char/i.test(p.name)), { matches: name.parsed.pokemon.map((p: any) => p.name) });
  }

  await client.close();
  await server.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
