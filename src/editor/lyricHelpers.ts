/**
 * Syllable counter and rhyme helper for song lyrics.
 */

/** Estimate the number of syllables in an English word. */
export function countWordSyllables(rawWord: string): number {
  const word = rawWord.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return 0;
  if (word.length <= 3) return 1;

  // Common suffix reductions
  let clean = word
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "");

  // Match vowel sequences
  const matches = clean.match(/[aeiouy]{1,2}/g);
  return matches ? Math.max(1, matches.length) : 1;
}

/** Count syllables across a full line of text. */
export function countLineSyllables(lineText: string): number {
  const words = lineText.trim().split(/\s+/).filter(Boolean);
  return words.reduce((sum, w) => sum + countWordSyllables(w), 0);
}

/** Built-in rhyme suggestions dictionary for common song ending words. */
const COMMON_RHYMES: Record<string, string[]> = {
  bend: ["mend", "pretend", "descend", "send", "blend"],
  hold: ["told", "cold", "gold", "fold", "bold"],
  be: ["free", "see", "tree", "plea", "sea"],
  night: ["light", "sight", "bright", "fight", "flight"],
  rain: ["pain", "drain", "stain", "remain", "refrain"],
  heart: ["part", "start", "apart", "art", "chart"],
  sky: ["fly", "high", "goodbye", "try", "lie"],
  love: ["above", "dove", "glove", "shove"],
  time: ["rhyme", "climb", "chime", "prime", "sublime"],
  stay: ["away", "day", "gray", "play", "sway"],
  mind: ["find", "blind", "kind", "behind", "wind"],
  fire: ["desire", "higher", "wire", "inspire"],
  know: ["grow", "glow", "flow", "slow", "show"],
  away: ["day", "say", "stay", "gray", "sway"],
  home: ["roam", "alone", "foam", "stone"],
  soul: ["whole", "control", "toll", "goal"],
};

/** Get rhyme suggestions for a given word. */
export function getRhymeSuggestions(word: string): { baseWord: string; rhymes: string[] } | null {
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!clean) return null;

  if (COMMON_RHYMES[clean]) {
    return { baseWord: clean, rhymes: COMMON_RHYMES[clean] };
  }

  // Look for rhyme ending match
  for (const [key, list] of Object.entries(COMMON_RHYMES)) {
    if (clean.endsWith(key.slice(-3)) && clean !== key) {
      return { baseWord: clean, rhymes: [key, ...list.filter((w) => w !== clean)].slice(0, 3) };
    }
  }

  return null;
}
