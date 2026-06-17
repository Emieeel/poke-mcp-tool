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
    'all 5 tools present',
    ['calculate_damage', 'check_legality', 'get_pokemon', 'list_regulations', 'type_effectiveness'].every(
      (n) => toolNames.includes(n),
    ),
  );

  // 1. calculate_damage — plausible percent range, with abilities/stats auto-filled.
  console.log('\ncalculate_damage:');
  {
    const { parsed } = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Staraptor-Mega', level: 50, nature: 'Adamant', evs: { atk: 252 }, item: 'Choice Band' },
      defender: { name: 'Garchomp', level: 50, nature: 'Jolly', evs: { hp: 4 } },
      move: 'Close Combat',
      field: { gameType: 'Doubles' },
    });
    console.log('   ', parsed.description);
    check('percent range is plausible (min>0, max<=300)', parsed.percentRange.min > 0 && parsed.percentRange.max <= 300, parsed.percentRange);
    check('produced a KO/hits result', typeof parsed.koChance?.hitsToKO === 'number', parsed.koChance);
    check('auto-filled attacker ability Contrary from Champions dex', parsed.notes.some((n: string) => /Contrary/.test(n)), parsed.notes);
    // A Champions-original Mega @smogon/calc has never heard of still calcs via overrides.
    const orig = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Mega Eelektross', level: 50, nature: 'Modest', evs: { spa: 252 } },
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

  await client.close();
  await server.close();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
