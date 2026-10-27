/**
 * names.ts — canonical key for matching Pokémon names across naming conventions.
 *
 * Serebii and @smogon/calc write forms differently; these all collapse to one key:
 *   - Mega word order: "Mega Sceptile" / "Sceptile-Mega" -> "sceptilemega", and
 *     "Mega Raichu X" / "Raichu-Mega-X" -> "raichuxmega" (without colliding with "Raichu").
 *   - Regional forms: "Alolan Ninetales" / "Ninetales-Alola" -> "ninetalesalola".
 *   - Gender forms: "Female Indeedee" / "Indeedee-F" -> "indeedeef" (male is the base form).
 */

// Words Serebii puts before the species, mapped to the suffix @smogon/calc puts after it.
const FORM_WORDS: Record<string, string> = {
  alolan: 'alola',
  galarian: 'galar',
  hisuian: 'hisui',
  paldean: 'paldea',
  female: 'f',
  male: '',
};
const FORM_SUFFIXES = new Set(Object.values(FORM_WORDS).filter(Boolean));

export function nameKey(name: string): string {
  const tokens = name
    .trim()
    .toLowerCase()
    .replace(/[-_()]/g, ' ')
    .split(/\s+/)
    .map((t) => FORM_WORDS[t] ?? t)
    .filter(Boolean);
  // Species name first, then regional/gender form tokens, the rest, and "mega" last.
  const megas = tokens.filter((t) => t === 'mega');
  const forms = tokens.filter((t) => FORM_SUFFIXES.has(t));
  const rest = tokens.filter((t) => t !== 'mega' && !FORM_SUFFIXES.has(t));
  return [...rest.slice(0, 1), ...forms, ...rest.slice(1), ...megas].join('').replace(/[^a-z0-9]/g, '');
}
