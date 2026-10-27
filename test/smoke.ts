/**
 * smoke.ts — exercises all 5 tools through a real in-memory MCP client/server pair.
 *
 *   npm test
 *
 * This mounts the actual server (createServer()) on an in-memory transport and calls each
 * tool exactly as a Claude client would, then asserts the results match the spec's
 * definition of done. Run after `npm run scrape -- <current-reg>` so the regulation tools have
 * data. m-c is the current regulation; the m-b assertions below deliberately stay on m-b, since
 * an expired regulation's file is frozen and still exercises the per-regulation exclusion path.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { toID } from '@smogon/calc';
import { createServer } from '../src/index.js';
import { gen, engineSpeciesName } from '../src/calc.js';

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
    'all 12 tools present',
    ['calculate_damage', 'check_legality', 'find_pokemon_by_move', 'get_ability', 'get_item', 'get_move', 'get_pokemon', 'list_items', 'list_legal_moves', 'list_legal_pokemon', 'list_regulations', 'type_effectiveness'].every(
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
    // A Champions-original Mega (only in the engine's Champions generation) calcs.
    const orig = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Mega Eelektross', level: 50, nature: 'Modest', statPoints: { spa: 32 } },
      defender: { name: 'Gholdengo', level: 50 },
      move: 'Thunderbolt',
    });
    console.log('   ', orig.parsed.description);
    check('Champions-original Mega Eelektross calc works', orig.parsed.percentRange.max > 0, orig.parsed.percentRange);
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

  // 1a'. Critical hits on request. The engine applies the whole crit package (x1.5, Sniper's
  // extra x1.5, ignoring screens), and Battle Armor / Shell Armor still block it.
  console.log('\ncalculate_damage (critical hits):');
  {
    const snipe = (ability: string, isCrit?: boolean, field?: Record<string, unknown>) =>
      callJson(client, 'calculate_damage', {
        attacker: { name: 'Inteleon', level: 50, nature: 'Timid', ability, statPoints: { spa: 32, spe: 32 } },
        defender: { name: 'Incineroar', level: 50, statPoints: { hp: 32 } },
        move: 'Snipe Shot',
        ...(isCrit === undefined ? {} : { isCrit }),
        ...(field ? { field } : {}),
      });
    const normal = await snipe('Torrent');
    const crit = await snipe('Torrent', true);
    const sniperCrit = await snipe('Sniper', true);
    const ratio = crit.parsed.damageRange.max / normal.parsed.damageRange.max;
    const sniperRatio = sniperCrit.parsed.damageRange.max / normal.parsed.damageRange.max;
    check('isCrit raises damage by ~x1.5', ratio > 1.4 && ratio < 1.6, { normal: normal.parsed.damageRange, crit: crit.parsed.damageRange });
    check('Sniper crit is ~x2.25', sniperRatio > 2.1 && sniperRatio < 2.4, { sniperCrit: sniperCrit.parsed.damageRange });
    check('crit calc string says "on a critical hit"', /on a critical hit/.test(crit.parsed.description), crit.parsed.description);
    check('crit surfaced in notes', crit.parsed.notes.some((n: string) => /^Critical hit:/.test(n)), crit.parsed.notes);
    const screenCrit = await snipe('Torrent', true, { isLightScreen: true });
    check('a crit ignores Light Screen', screenCrit.parsed.damageRange.max === crit.parsed.damageRange.max, { withScreen: screenCrit.parsed.damageRange, without: crit.parsed.damageRange });

    const armorArgs = {
      attacker: { name: 'Garchomp', level: 50, nature: 'Adamant', statPoints: { atk: 32 } },
      defender: { name: 'Mega Scolipede', level: 50, ability: 'Shell Armor' },
      move: 'Earthquake',
    };
    const armorNormal = await callJson(client, 'calculate_damage', armorArgs);
    const armorCrit = await callJson(client, 'calculate_damage', { ...armorArgs, isCrit: true });
    check('Shell Armor blocks a requested crit', armorCrit.parsed.damageRange.max === armorNormal.parsed.damageRange.max, { normal: armorNormal.parsed.damageRange, crit: armorCrit.parsed.damageRange });
    check('blocked crit explained in notes', armorCrit.parsed.notes.some((n: string) => /prevents critical hits/.test(n)), armorCrit.parsed.notes);
  }

  // 1b'. The engine's Champions generation itself: rebalanced moves, Champions-only abilities,
  // and the Champions roster as the only pool (no silent fallback to mainline species).
  console.log('\ncalculate_damage (Champions engine):');
  {
    const snipe = (moveContext?: Record<string, unknown>) =>
      callJson(client, 'calculate_damage', {
        attacker: { name: 'Inteleon', nature: 'Timid', ability: 'Torrent', statPoints: { spa: 32 } },
        defender: { name: 'Incineroar', statPoints: { hp: 32 } },
        move: 'Snipe Shot',
        ...(moveContext ? { moveContext } : {}),
      });
    const champ = await snipe();
    const at85 = await snipe({ basePowerOverride: 85 });
    const at80 = await snipe({ basePowerOverride: 80 });
    check('Snipe Shot uses its Champions power (85, not 80)',
      champ.parsed.damageRange.max === at85.parsed.damageRange.max && champ.parsed.damageRange.max > at80.parsed.damageRange.max,
      { champions: champ.parsed.damageRange, at85: at85.parsed.damageRange, at80: at80.parsed.damageRange });

    // Aura Guard (Mega Lucario Z) halves contact damage, Fire contact moves included.
    const vsLucario = (move: string, ability?: string) =>
      callJson(client, 'calculate_damage', {
        attacker: { name: 'Garchomp', nature: 'Adamant', statPoints: { atk: 32 } },
        defender: { name: 'Mega Lucario Z', ...(ability ? { ability } : {}) },
        move,
      });
    for (const move of ['Dragon Claw', 'Fire Fang']) {
      const guarded = await vsLucario(move);
      const plain = await vsLucario(move, 'Steadfast');
      const ratio = guarded.parsed.damageRange.max / plain.parsed.damageRange.max;
      check(`Aura Guard halves contact ${move}`, ratio > 0.45 && ratio < 0.55,
        { auraGuard: guarded.parsed.damageRange, without: plain.parsed.damageRange });
    }
    const quake = await vsLucario('Earthquake');
    const quakePlain = await vsLucario('Earthquake', 'Steadfast');
    check('Aura Guard leaves non-contact moves alone',
      quake.parsed.damageRange.max === quakePlain.parsed.damageRange.max,
      { auraGuard: quake.parsed.damageRange, without: quakePlain.parsed.damageRange });

    // A species outside the Champions roster is an error, not a silent mainline calc.
    const outsider = await client.callTool({
      name: 'calculate_damage',
      arguments: { attacker: { name: 'Dondozo' }, defender: { name: 'Garchomp' }, move: 'Wave Crash' },
    }) as any;
    check('non-Champions species is rejected',
      outsider.isError === true && /not in the Pokémon Champions Pokédex/.test(outsider.content?.[0]?.text ?? ''),
      outsider.content?.[0]?.text);
  }

  // 1c. Parity with the canonical CHAMP calculator for Champions-original abilities (Mega Sol,
  // Dragonize), which the engine's Champions generation models natively. Damage range + percent
  // are transcribed from the reference and must match EXACTLY.
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
    check('Dragonize Double-Edge vs Sinistcha: full calc string matches',
      dz.parsed.description === '32 Atk Dragonize Feraligatr-Mega Double-Edge vs. 32 HP / 22 Def Sinistcha: 117-138 (65.7 - 77.5%) -- guaranteed 2HKO after Leftovers recovery',
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

  // 1d. Type effectiveness reported ON the damage result. Every calc must state how effective
  // the hit was, in the game's own words, taken from the ENGINE's effectiveness function and the
  // RESOLVED move/defender — so the label can never contradict the damage rolls beside it.
  console.log('\ncalculate_damage (type effectiveness):');
  {
    // Bug/Steel: 4x from Fire, and NEUTRAL to Ground (Bug resists Ground, Steel is weak to it).
    // The Ground case is the regression this field exists to prevent.
    const fire = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Mega Charizard Y', level: 50 }, defender: { name: 'Mega Golisopod', level: 50 }, move: 'Heat Wave',
    });
    check('Fire vs Bug/Steel = 4x, super effective',
      fire.parsed.typeEffectiveness?.multiplier === 4 && fire.parsed.typeEffectiveness.label === 'super effective',
      fire.parsed.typeEffectiveness);
    check('game message is "It\'s super effective!"',
      fire.parsed.typeEffectiveness?.message === "It's super effective!", fire.parsed.typeEffectiveness?.message);
    check('effectiveness is printed in notes',
      fire.parsed.notes.some((n: string) => /Type effectiveness: Fire vs Bug\/Steel = x4/.test(n)), fire.parsed.notes);

    const ground = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Mega Garchomp', level: 50 }, defender: { name: 'Mega Golisopod', level: 50 }, move: 'Earthquake',
    });
    check('Ground vs Bug/Steel = 1x (Bug resists Ground), neutral',
      ground.parsed.typeEffectiveness?.multiplier === 1 && ground.parsed.typeEffectiveness.label === 'neutral',
      ground.parsed.typeEffectiveness);

    const resisted = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Rillaboom', level: 50 }, defender: { name: 'Mega Golisopod', level: 50 }, move: 'Wood Hammer',
    });
    check('Grass vs Bug/Steel = 0.25x, not very effective',
      resisted.parsed.typeEffectiveness?.multiplier === 0.25 && resisted.parsed.typeEffectiveness.label === 'not very effective',
      resisted.parsed.typeEffectiveness);
    check('resisted hit prints "It\'s not very effective..."',
      resisted.parsed.typeEffectiveness?.message === "It's not very effective...", resisted.parsed.typeEffectiveness?.message);

    // Type immunity: the message names the defender, exactly as the game does.
    const immune = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Pikachu', level: 50 }, defender: { name: 'Garchomp', level: 50 }, move: 'Thunderbolt',
    });
    check('Electric vs Ground = 0x with "doesn\'t affect" message naming the defender',
      immune.parsed.typeEffectiveness?.multiplier === 0 && /doesn't affect Garchomp/.test(immune.parsed.typeEffectiveness?.message ?? ''),
      immune.parsed.typeEffectiveness);

    // Move-specific exception straight from the engine (Ice hits Water for 2x). This also pins
    // the deep import of the engine's own getMoveEffectiveness: reimplementing the chart by hand
    // would report 0.5x here.
    const fd = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Baxcalibur', level: 50 }, defender: { name: 'Blastoise', level: 50 }, move: 'Freeze-Dry',
    });
    check('Freeze-Dry vs Water = 2x (engine exception, not the raw chart)',
      fd.parsed.typeEffectiveness?.multiplier === 2, fd.parsed.typeEffectiveness);

    // Ability retype: Aerilate makes Double-Edge Flying, which Steel resists back to neutral.
    const aer = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Mega Salamence', level: 50, ability: 'Aerilate' }, defender: { name: 'Mega Golisopod', level: 50 }, move: 'Double-Edge',
    });
    check('Aerilate Double-Edge is reported as Flying (resolved type), 1x vs Bug/Steel',
      aer.parsed.typeEffectiveness?.moveType === 'Flying' && aer.parsed.typeEffectiveness.multiplier === 1,
      aer.parsed.typeEffectiveness);

    // Non-type immunity: typing says 2x but Levitate blocks it. The label must follow the actual
    // damage (no effect) while the note explains that the type chart is not what stopped it.
    const lev = await callJson(client, 'calculate_damage', {
      attacker: { name: 'Garchomp', level: 50 }, defender: { name: 'Eelektross', level: 50, ability: 'Levitate' }, move: 'Earthquake',
    });
    check('Levitate: typing 2x but label "no effect" and the note explains why',
      lev.parsed.typeEffectiveness?.multiplier === 2 &&
        lev.parsed.typeEffectiveness.label === 'no effect' &&
        /not the type chart/.test(lev.parsed.typeEffectiveness.note ?? ''),
      lev.parsed.typeEffectiveness);

    // Champions has no Terastallization, so a teraType input is rejected rather than ignored.
    let teraRejected = false;
    try {
      const tera = await callJson(client, 'calculate_damage', {
        attacker: { name: 'Mega Charizard Y', level: 50 }, defender: { name: 'Mega Golisopod', level: 50, teraType: 'Water' }, move: 'Heat Wave',
      });
      teraRejected = tera.isError === true;
    } catch {
      teraRejected = true;
    }
    check('teraType input is rejected (no Tera in Champions)', teraRejected);
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
    const { parsed } = await callJson(client, 'get_pokemon', { name: 'Staraptor-Mega', regulation: 'm-c' });
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

  // 3a. get_pokemon defensive profiles — the complete matchup table must come back on EVERY
  // lookup, so weaknesses never have to be recalled or re-derived by hand.
  console.log('\nget_pokemon (defensive profile):');
  {
    const { parsed } = await callJson(client, 'get_pokemon', { name: 'Mega Golisopod' });
    const dp = parsed.defensiveProfile;
    console.log('   ', dp?.summary);
    check('every one of the 18 attacking types is covered', Object.keys(dp?.multipliers ?? {}).length === 18, Object.keys(dp?.multipliers ?? {}).length);
    check('Bug/Steel has exactly one weakness: Fire 4x',
      dp?.weaknesses.length === 1 && dp.weaknesses[0].type === 'Fire' && dp.weaknesses[0].multiplier === 4,
      dp?.weaknesses);
    check('Bug/Steel is NEUTRAL to Ground (Bug resists it, Steel is weak to it)',
      dp?.multipliers?.Ground === 1 && dp.neutral.includes('Ground'), { ground: dp?.multipliers?.Ground });
    check('Bug/Steel is immune to Poison', dp?.immunities.includes('Poison'), dp?.immunities);
    check('Bug/Steel resists Grass at 0.25x', dp?.multipliers?.Grass === 0.25, { grass: dp?.multipliers?.Grass });
    check('weaknesses are ordered worst-first', (dp?.weaknesses ?? []).every((w: any, i: number, a: any[]) => i === 0 || a[i - 1].multiplier >= w.multiplier), dp?.weaknesses);
    check('summary names the weakness in prose', /weak to: Fire 4x/.test(dp?.summary ?? ''), dp?.summary);
    // Typing-only by default, with the ability variants kept separate.
    check('base profile applies no ability', dp?.ability === undefined && /Typing only/.test(dp?.note ?? ''), { ability: dp?.ability });

    // Abilities that change damage TAKEN get their own table plus an explicit diff.
    const sin = await callJson(client, 'get_pokemon', { name: 'Sinistcha' });
    const heatproof = sin.parsed.defensiveProfileByAbility?.find((p: any) => p.ability === 'Heatproof');
    check('Sinistcha lists a Heatproof defensive profile', Boolean(heatproof), sin.parsed.defensiveProfileByAbility?.map((p: any) => p.ability));
    check('Heatproof turns the 2x Fire weakness into 1x',
      heatproof?.multipliers?.Fire === 1 && !heatproof?.weaknesses.some((w: any) => w.type === 'Fire'),
      { fire: heatproof?.multipliers?.Fire });
    check('the change is spelled out in differsFromTyping',
      heatproof?.differsFromTyping?.some((d: string) => /Fire 2x -> 1x/.test(d)), heatproof?.differsFromTyping);
    check('Heatproof note explains the ability', heatproof?.abilityNotes?.some((n: string) => /Heatproof/.test(n)), heatproof?.abilityNotes);

    // Levitate must show up as a real immunity in the ability-adjusted table.
    const eel = await callJson(client, 'get_pokemon', { name: 'Eelektross' });
    const lev = eel.parsed.defensiveProfileByAbility?.find((p: any) => p.ability === 'Levitate');
    check('Eelektross + Levitate is immune to Ground', lev?.immunities?.includes('Ground'), lev?.immunities);
    check('base Eelektross profile still shows the Ground weakness',
      eel.parsed.defensiveProfile?.multipliers?.Ground === 2, { ground: eel.parsed.defensiveProfile?.multipliers?.Ground });

    // A dual-type immunity from typing alone.
    const hat = await callJson(client, 'get_pokemon', { name: 'Hatterene' });
    check('Psychic/Fairy is immune to Dragon and resists Fighting 0.25x',
      hat.parsed.defensiveProfile?.immunities?.includes('Dragon') && hat.parsed.defensiveProfile?.multipliers?.Fighting === 0.25,
      { immunities: hat.parsed.defensiveProfile?.immunities, fighting: hat.parsed.defensiveProfile?.multipliers?.Fighting });

    // Forms are separate entries: base Rotom is Electric/Ghost, Rotom-Wash Electric/Water.
    const rotom = await callJson(client, 'get_pokemon', { name: 'Rotom' });
    check('base Rotom is Electric/Ghost, with its forms listed',
      rotom.parsed.types.join('/') === 'Electric/Ghost' && rotom.parsed.otherForms?.includes('Rotom-Wash'),
      { types: rotom.parsed.types, otherForms: rotom.parsed.otherForms });
  }

  // 4. check_legality — full roster, a banned Mega form, and a missing regulation.
  console.log('\ncheck_legality:');
  {
    const legal = await callJson(client, 'check_legality', { regulation: 'm-c', pokemon: 'Garchomp', moves: ['Earthquake', 'Recover'] });
    check('Garchomp is legal in m-c (full roster)', legal.parsed.pokemonLegal === true, { legal: legal.parsed.pokemonLegal });
    check('move legality now available (learnset)', legal.parsed.moveLegalityAvailable === true);
    check('Garchomp can learn Earthquake but not Recover', legal.parsed.moves?.find((m: any) => m.move === 'Earthquake')?.legal === true && legal.parsed.moves?.find((m: any) => m.move === 'Recover')?.legal === false, legal.parsed.moves);
    // Per-regulation Mega exclusions: m-b excluded the Z Megas; m-c newly enables them. Both
    // resolve through the same base species, so this pins the exclusion list, not the name lookup.
    const banned = await callJson(client, 'check_legality', { regulation: 'm-b', pokemon: 'Mega Garchomp Z' });
    check('Mega Garchomp Z is banned in m-b', banned.parsed.pokemonLegal === false, { legal: banned.parsed.pokemonLegal });
    const unbanned = await callJson(client, 'check_legality', { regulation: 'm-c', pokemon: 'Mega Garchomp Z' });
    check('Mega Garchomp Z is legal in m-c', unbanned.parsed.pokemonLegal === true, { legal: unbanned.parsed.pokemonLegal });
    // Pokémon added in m-c must be legal there and absent from the frozen m-b roster.
    const newMon = await callJson(client, 'check_legality', { regulation: 'm-c', pokemon: 'Rillaboom' });
    const newMonOld = await callJson(client, 'check_legality', { regulation: 'm-b', pokemon: 'Rillaboom' });
    check('Rillaboom is legal in m-c but not m-b', newMon.parsed.pokemonLegal === true && newMonOld.parsed.pokemonLegal === false, { mc: newMon.parsed.pokemonLegal, mb: newMonOld.parsed.pokemonLegal });
    // Apostrophe/period slugs (farfetch'd, mr.mime) were once dropped by the roster scraper.
    const punct = await callJson(client, 'check_legality', { regulation: 'm-c', pokemon: "Farfetch'd" });
    check('"Farfetch\'d" is legal in m-c (punctuated slug)', punct.parsed.pokemonLegal === true, { legal: punct.parsed.pokemonLegal });
    const missing = await callJson(client, 'check_legality', { regulation: 'zz-nonexistent', pokemon: 'Pikachu' });
    check('missing regulation returns a clear error', missing.isError === true && /scrape/i.test(missing.parsed.error ?? ''), missing.parsed.error);
    // Item legality is regulation-scoped: a real held item is legal, a non-held ticket is not.
    const withItems = await callJson(client, 'check_legality', { regulation: 'm-c', pokemon: 'Garchomp', items: ['Life Orb', 'Bug-Type Affinity Ticket'] });
    check('item legality available for m-c', withItems.parsed.itemLegalityAvailable === true);
    check('Life Orb legal, ticket illegal in m-c',
      withItems.parsed.items?.find((i: any) => i.item === 'Life Orb')?.legal === true &&
        withItems.parsed.items?.find((i: any) => /Ticket/.test(i.item))?.legal === false,
      withItems.parsed.items);
    // Items added in m-c are legal there but not on the frozen m-b list.
    const newItem = await callJson(client, 'check_legality', { regulation: 'm-c', pokemon: 'Garchomp', items: ['Rocky Helmet'] });
    const newItemOld = await callJson(client, 'check_legality', { regulation: 'm-b', pokemon: 'Garchomp', items: ['Rocky Helmet'] });
    check('Rocky Helmet legal in m-c but not m-b', newItem.parsed.items?.[0]?.legal === true && newItemOld.parsed.items?.[0]?.legal === false, { mc: newItem.parsed.items?.[0]?.legal, mb: newItemOld.parsed.items?.[0]?.legal });
  }

  // 5. list_regulations — both regulations present with meta + full-roster counts.
  console.log('\nlist_regulations:');
  {
    const { parsed } = await callJson(client, 'list_regulations', {});
    const ids = parsed.regulations.map((r: any) => r.id);
    const mb = parsed.regulations.find((r: any) => r.id === 'm-b');
    const mc = parsed.regulations.find((r: any) => r.id === 'm-c');
    check('m-b and m-c are both listed', Boolean(mb) && Boolean(mc), ids);
    check('m-c has meta with source + dates', Boolean(mc?.meta?.source && mc?.meta?.validFrom), mc?.meta);
    check('m-c full roster has 100+ legal Pokémon', mc?.legalPokemonCount > 100, { count: mc?.legalPokemonCount });
    check('m-c roster is a superset of m-b\'s', mc?.legalPokemonCount > mb?.legalPokemonCount, { mc: mc?.legalPokemonCount, mb: mb?.legalPokemonCount });
    check('m-c reports newly-useable count', mc?.newlyUseableCount > 0, { newly: mc?.newlyUseableCount });
    check('m-b reports banned + newly-useable counts', mb?.bannedPokemonCount > 0 && mb?.newlyUseableCount > 0, { banned: mb?.bannedPokemonCount, newly: mb?.newlyUseableCount });
  }

  // 6. get_item — Champions-accurate effect/category, plus regulation legality.
  console.log('\nget_item:');
  {
    const { parsed } = await callJson(client, 'get_item', { name: 'Choice Scarf', regulation: 'm-c' });
    check('Choice Scarf is a held Hold Item', parsed.category === 'Hold Item' && parsed.held === true, { category: parsed.category, held: parsed.held });
    check('data came from the Champions item catalog', parsed.source === 'champions-items', { source: parsed.source });
    check('Choice Scarf effect mentions Speed', /speed/i.test(parsed.effect ?? ''), parsed.effect);
    check('Choice Scarf is legal in m-c', parsed.regulation?.legal === true, { legal: parsed.regulation?.legal });
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
    const reg = await callJson(client, 'list_items', { category: 'Hold Item', regulation: 'm-c' });
    check('regulation marks Hold Items legal in m-c', reg.parsed.items.length > 0 && reg.parsed.items.every((i: any) => i.regulationLegal === true), { sample: reg.parsed.items.slice(0, 2) });
  }

  // 8. find_pokemon_by_move — legal learners of a move in the default (current) regulation.
  console.log('\nfind_pokemon_by_move:');
  {
    const fo = await callJson(client, 'find_pokemon_by_move', { move: 'Fake Out' });
    check('Fake Out is learnable in the defaulted regulation', fo.parsed.learnable === true && fo.parsed.count > 0, { count: fo.parsed.count });
    check('defaulted regulation is the current one (m-c)', fo.parsed.regulation === 'm-c', { regulation: fo.parsed.regulation });
    check('Fake Out learners include Incineroar', fo.parsed.pokemon.some((p: any) => p.name === 'Incineroar'), fo.parsed.pokemon.slice(0, 3));
    check('move metadata enriched (Normal/Physical)', fo.parsed.move.type === 'Normal' && fo.parsed.move.category === 'Physical', fo.parsed.move);
    // A move no legal Champions mon learns -> learnable false, empty list, no crash.
    const none = await callJson(client, 'find_pokemon_by_move', { regulation: 'm-c', move: 'Glacial Lance' });
    check('Glacial Lance has no legal learners in m-c', none.parsed.learnable === false && none.parsed.count === 0, { count: none.parsed.count });
    // Name normalization: hyphen/spacing variants resolve to the same move.
    const wisp = await callJson(client, 'find_pokemon_by_move', { move: 'willowisp' });
    check('"willowisp" resolves to Will-O-Wisp learners', wisp.parsed.learnable === true && wisp.parsed.move.name === 'Will-O-Wisp', { name: wisp.parsed.move.name, count: wisp.parsed.count });
  }

  // 9. list_legal_moves — the regulation's learnable-move pool, with filters.
  console.log('\nlist_legal_moves:');
  {
    const all = await callJson(client, 'list_legal_moves', {});
    check('m-c has a large legal-move pool (100+)', all.parsed.totalLegalMoves > 100, { total: all.parsed.totalLegalMoves });
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
    check('m-c has a large legal-Pokémon pool (100+)', all.parsed.totalLegalPokemon > 100, { total: all.parsed.totalLegalPokemon });
    check('resolved entries carry typing and base stats', all.parsed.pokemon.some((p: any) => p.resolved && p.types.length > 0 && p.baseStats), { sample: all.parsed.pokemon.slice(0, 2) });
    const dragon = await callJson(client, 'list_legal_pokemon', { type: 'Dragon' });
    check('type filter returns only Dragon types', dragon.parsed.count > 0 && dragon.parsed.pokemon.every((p: any) => p.types.includes('Dragon')), { count: dragon.parsed.count });
    const name = await callJson(client, 'list_legal_pokemon', { nameContains: 'char' });
    check('name filter matches substring (case-insensitive)', name.parsed.count > 0 && name.parsed.pokemon.every((p: any) => /char/i.test(p.name)), { matches: name.parsed.pokemon.map((p: any) => p.name) });
  }

  // 11. get_move — Champions move data, including what changed from Scarlet/Violet.
  console.log('\nget_move:');
  {
    const snipe = (await callJson(client, 'get_move', { name: 'snipe shot' })).parsed;
    check('Snipe Shot: 85 BP Water Special from the Champions data',
      snipe.basePower === 85 && snipe.type === 'Water' && snipe.category === 'Special' && snipe.source === 'champions-moves', snipe);
    check('Snipe Shot: description has the crit boost; no contact flag',
      /Critical-Hit Ratio Boost/.test(snipe.description) && !snipe.flags.includes('contact'), { description: snipe.description, flags: snipe.flags });
    check('Snipe Shot: change from S/V listed', (snipe.changesFromScarletViolet ?? []).includes('Base power 80 -> 85'), snipe.changesFromScarletViolet);
    const moon = (await callJson(client, 'get_move', { name: 'Moonblast' })).parsed;
    check('Moonblast: 10% Sp. Atk drop in Champions (was 30%)',
      /10% chance/.test(moon.description) && (moon.changesFromScarletViolet ?? []).includes('Effect chance 30% -> 10%'), moon);
    const dry = (await callJson(client, 'get_move', { name: 'Freeze-Dry' })).parsed;
    check('Freeze-Dry: no freeze chance in Champions', !/freez/i.test(dry.description), dry.description);
    const curse = (await callJson(client, 'get_move', { name: "Forest's Curse" })).parsed;
    check("Forest's Curse (apostrophe in the name) is in the Champions data", curse.source === 'champions-moves', curse.source);
    const rain = (await callJson(client, 'get_move', { name: 'Make It Rain' })).parsed;
    check('Make It Rain: lowers Sp. Atk by 2 in Champions', /by 2 stages/.test(rain.description), rain.description);
    const twave = (await callJson(client, 'get_move', { name: 'Thunder Wave' })).parsed;
    check('Thunder Wave: Champions paralysis rule attached', (twave.statusConditionNotes ?? []).some((n: string) => /12\.5%/.test(n)), twave.statusConditionNotes);
    const unknown = await client.callTool({ name: 'get_move', arguments: { name: 'Not A Move' } }) as any;
    check('unknown move is an error', unknown.isError === true);
  }

  // 12. Our Champions data (Serebii) vs the engine's Champions generation. Both describe the same
  // game, so a difference means one side is stale (a patch landed on one first) or wrong. Known,
  // reviewed differences are listed with the reason; a new difference fails, and so does a listed
  // one that has gone away (so the list can't go stale).
  console.log('\nChampions data vs the engine (cross-check):');
  {
    const g = gen();
    const readData = (file: string) => JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8'));
    const sameKeys = (label: string, actual: Record<string, string>, known: Record<string, string>) => {
      const unexpected = Object.keys(actual).filter((k) => !(k in known)).map((k) => `${k}: ${actual[k]}`);
      const resolved = Object.keys(known).filter((k) => !(k in actual));
      check(`${label}: no unexpected differences`, unexpected.length === 0, unexpected);
      check(`${label}: every known difference still applies`, resolved.length === 0, resolved);
    };

    const KNOWN_SPECIES: Record<string, string> = {
      // The engine's default ability for these Champions Megas is the base species' one.
      'Mega Skarmory': 'engine ability', 'Mega Hawlucha': 'engine ability',
      // Named differently in the engine (Floette-Eternal, Aegislash-Shield, Meowstic-M-Mega).
      Floette: 'not in engine', Aegislash: 'not in engine', 'Mega Meowstic': 'not in engine',
    };
    const species: Record<string, string> = {};
    const dex = readData('champions-dex.json').pokemon;
    for (const entry of Object.values<any>(dex)) {
      for (const form of entry.forms) {
        const engineName = engineSpeciesName(form.name);
        const sp = engineName ? g.species.get(toID(engineName)) : undefined;
        if (!sp) { species[form.name] = 'not in engine'; continue; }
        const bs = form.baseStats;
        const e = sp.baseStats;
        const diffs: string[] = [];
        if (form.types.join('/') !== sp.types.join('/')) diffs.push(`types ${form.types.join('/')} vs ${sp.types.join('/')}`);
        if ([bs.hp, bs.atk, bs.def, bs.spa, bs.spd, bs.spe].join('/') !== [e.hp, e.atk, e.def, e.spa, e.spd, e.spe].join('/')) diffs.push('base stats');
        const abilities = form.abilities.map((a: string) => a.replace(/\s*\(.*?\)\s*$/, ''));
        if (sp.abilities?.[0] && !abilities.includes(sp.abilities[0])) diffs.push(`engine ability ${sp.abilities[0]}`);
        if (diffs.length) species[form.name] = diffs.join('; ');
      }
    }
    sameKeys('species', species, KNOWN_SPECIES);

    const KNOWN_MOVES: Record<string, string> = {
      Growth: 'Champions made it Grass-type; the engine still has Normal',
      Pound: "missing from the engine's Champions move list",
    };
    const moves: Record<string, string> = {};
    for (const m of Object.values<any>(readData('champions-moves.json').moves)) {
      const e = g.moves.get(toID(m.name)) as any;
      if (!e) { moves[m.name] = 'not in engine'; continue; }
      const diffs: string[] = [];
      if (m.type !== e.type) diffs.push(`type ${m.type} vs ${e.type}`);
      if (m.category !== (e.category ?? 'Status')) diffs.push(`category ${m.category} vs ${e.category}`);
      if (m.basePower !== null && e.basePower && m.basePower !== e.basePower) diffs.push(`power ${m.basePower} vs ${e.basePower}`);
      if (diffs.length) moves[m.name] = diffs.join('; ');
    }
    sameKeys('moves', moves, KNOWN_MOVES);
  }

  // 14. Alternate forms: each is its own Pokémon with its own typing, stats, abilities and moves,
  // legal when its base species is, and reachable by either spelling of its name.
  console.log('\nforms:');
  {
    const info = async (name: string) => (await callJson(client, 'get_pokemon', { name, regulation: 'm-c' })).parsed;
    const indeedee = await info('Indeedee-F');
    check('Indeedee-F: female stats, Own Tempo, legal in M-C',
      JSON.stringify(indeedee.baseStats) === JSON.stringify({ hp: 70, atk: 55, def: 65, spa: 95, spd: 105, spe: 85 }) &&
        indeedee.abilities.includes('Own Tempo') && !indeedee.abilities.includes('Inner Focus') && indeedee.regulation?.legal === true,
      { baseStats: indeedee.baseStats, abilities: indeedee.abilities, legal: indeedee.regulation?.legal });
    const alolan = await info('Alolan Ninetales');
    check('"Alolan Ninetales" resolves to Ninetales-Alola: Ice/Fairy, Snow Warning, learns Moonblast',
      alolan.name === 'Ninetales-Alola' && alolan.types.join('/') === 'Ice/Fairy' &&
        alolan.abilities.includes('Snow Warning') && alolan.moves.includes('Moonblast'),
      { name: alolan.name, types: alolan.types, abilities: alolan.abilities });
    const ninetales = await info('Ninetales');
    check('base Ninetales is Fire with Drought, not the Alolan abilities',
      ninetales.types.join('/') === 'Fire' && ninetales.abilities.includes('Drought') && !ninetales.abilities.includes('Snow Warning'),
      { types: ninetales.types, abilities: ninetales.abilities });
    const wash = await info('Rotom-Wash');
    check('Rotom-Wash: Electric/Water, learns Hydro Pump (base Rotom does not)',
      wash.types.join('/') === 'Electric/Water' && wash.moves.includes('Hydro Pump') && !(await info('Rotom')).moves.includes('Hydro Pump'),
      { types: wash.types });
    const meowF = await info('Meowstic-F');
    check('Meowstic-F swaps only the hidden ability: Keen Eye + Competitive, no Prankster',
      meowF.abilities.includes('Keen Eye') && meowF.abilities.includes('Competitive') && !meowF.abilities.includes('Prankster'),
      meowF.abilities);
    const blaze = await info('Tauros-Paldea-Blaze');
    check('Tauros-Paldea-Blaze: Fighting/Fire, Cud Chew', blaze.types.join('/') === 'Fighting/Fire' && blaze.abilities.includes('Cud Chew'), blaze);

    const pump = (await callJson(client, 'find_pokemon_by_move', { move: 'Hydro Pump' })).parsed;
    check('find_pokemon_by_move lists Rotom-Wash for Hydro Pump', pump.pokemon.some((p: any) => p.name === 'Rotom-Wash'), pump.count);
    const water = (await callJson(client, 'list_legal_pokemon', { type: 'Water' })).parsed;
    check('list_legal_pokemon (Water) includes Rotom-Wash, not base Rotom',
      water.pokemon.some((p: any) => p.name === 'Rotom-Wash') && !water.pokemon.some((p: any) => p.name === 'Rotom'), water.count);
    const megas = (await callJson(client, 'list_legal_pokemon', { nameContains: 'mega' })).parsed;
    check('list_legal_pokemon lists Megas as their own entries', megas.pokemon.some((p: any) => p.name === 'Mega Charizard Y' && p.baseSpecies === 'Charizard'), megas.count);
    const calc = (await callJson(client, 'calculate_damage', {
      attacker: { name: 'Garchomp', nature: 'Adamant', statPoints: { atk: 32 } },
      defender: { name: 'Rotom-Wash' },
      move: 'Earthquake',
    })).parsed;
    check('Rotom-Wash (Levitate) takes no Earthquake damage', calc.damageRange.max === 0, calc.damageRange);
  }

  // 13. get_ability — Champions ability text and who can have it.
  console.log('\nget_ability:');
  {
    const aura = (await callJson(client, 'get_ability', { name: 'Aura Guard' })).parsed;
    check('Aura Guard: new in Champions, Mega Lucario Z has it',
      aura.isNewInChampions === true && aura.pokemon.includes('Mega Lucario Z') && /contact/.test(aura.effect), aura);
    const intim = (await callJson(client, 'get_ability', { name: 'Intimidate', regulation: 'm-c' })).parsed;
    check('Intimidate in M-C: Incineroar among the legal holders, not new',
      intim.pokemon.includes('Incineroar') && intim.isNewInChampions === false && intim.regulation?.id === 'm-c', { count: intim.pokemon.length });
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
