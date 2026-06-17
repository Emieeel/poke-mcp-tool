/**
 * names.ts — canonical key for matching Pokémon names across naming conventions.
 *
 * Reconciles Mega-form word order so "Mega Sceptile" (Serebii), "Sceptile-Mega"
 * (@smogon/calc), and "sceptilemega" collapse to one key — and "Mega Raichu X" /
 * "Raichu-Mega-X" both become "raichuxmega" — without letting "Mega Raichu X" collide
 * with plain "Raichu".
 */
export function nameKey(name: string): string {
  const tokens = name
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  // Move any "mega" token to the end so prefix/suffix orderings match.
  const megas = tokens.filter((t) => t === 'mega');
  const rest = tokens.filter((t) => t !== 'mega');
  return [...rest, ...megas].join('').replace(/[^a-z0-9]/g, '');
}

/**
 * For a Mega form, the key of its BASE species (e.g. "Mega Staraptor" -> "staraptor",
 * "Mega Raichu X" -> "raichu", "Staraptor-Mega" -> "staraptor"). Returns null for
 * non-Mega names. Used for legality: a Mega is legal iff its base species is legal and
 * the specific Mega form isn't separately banned.
 */
export function baseSpeciesKey(name: string): string | null {
  const tokens = name
    .trim()
    .toLowerCase()
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.includes('mega')) return null;
  let rest = tokens.filter((t) => t !== 'mega');
  // Drop a trailing single-letter form indicator (the X / Y of multi-Megas).
  if (rest.length > 1 && rest[rest.length - 1].length === 1) rest = rest.slice(0, -1);
  return rest.join('').replace(/[^a-z0-9]/g, '');
}
