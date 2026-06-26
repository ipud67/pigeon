// lib/editorial/neutralize.ts
//
// FACT/CONTEXT advocacy-neutralization (Clark editorial-integrity must-fix, 2026-06-26).
// Several White-House-sourced records carry campaign/advocacy framing in their `context`
// field — "weaponized", "crushing blow", "America First in Action", "Radical Lunatics".
// That is opinion leaking into Pigeon's FACT/CONTEXT track and violates the facts-only
// spine. We MUST NOT render that phrasing as Pigeon's voice.
//
// This is a reader-layer best-effort scrub: it rewrites a curated set of advocacy phrases
// to neutral wire-desk language (or removes pure slogans) before display. It is deliberately
// conservative — a targeted phrase list, not an aggressive adjective shredder — so it never
// mangles a real fact. The durable fix is the Grok rewrite pass; this closes the integrity
// hole now. Pair with the ranking `voice:advocacy` discount (lib/ranking/importance.ts).

// Ordered phrase rules. Longer / more specific phrases first so they win over generic ones.
const RULES: Array<[RegExp, string]> = [
  // pure slogans → remove
  [/\bamerica first in action\b[.:,]?/gi, ''],
  [/\bpromises made,? promises kept\b[.:,]?/gi, ''],
  [/\bmake america [a-z ]+ again\b[.:,]?/gi, ''],
  // loaded epithets → remove the loaded modifier, keep the noun where one follows
  [/\bradical (left-wing |left )?lunatics?\b/gi, 'individuals'],
  [/\bradical (left-wing |left )?/gi, ''],
  [/\blunatics?\b/gi, 'individuals'],
  [/\bthugs?\b/gi, 'individuals'],
  [/\bhordes?\b/gi, 'group'],
  // advocacy verbs/nouns → neutral equivalents
  [/\bweaponiz(e|ed|ing|ation)\b/gi, 'used'],
  [/\bcrushing blow\b/gi, 'action'],
  [/\bhistoric (victory|win)\b/gi, 'outcome'],
  [/\bunprecedented\b/gi, ''],
  [/\bdevastating\b/gi, ''],
  [/\bcatastrophic\b/gi, ''],
  [/\bvicious\b/gi, ''],
  [/\bsacred\b/gi, ''],
  [/\bobliterat(e|ed|ing)\b/gi, 'ended'],
];

export function neutralizeText(input: string | undefined): string {
  if (!input) return '';
  let t = input;
  for (const [re, repl] of RULES) t = t.replace(re, repl);
  // tidy: collapse double spaces, spaces before punctuation, leftover empty parentheses,
  // doubled punctuation, and a stray leading separator.
  t = t
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.,;:])\1+/g, '$1')
    .replace(/^[\s.,;:—-]+/, '')
    .trim();
  return t;
}

// Does the raw text carry advocacy framing? Used by the ranking voice:advocacy discount.
const ADVOCACY_DETECT =
  /\b(america first|radical (left|lunatic)|lunatics?|weaponiz|crushing blow|promises made|make america|obliterat|thugs?\b|hordes?\b|witch ?hunt|hoax)\b/i;

export function hasAdvocacyVoice(text: string): boolean {
  return ADVOCACY_DETECT.test(text);
}
