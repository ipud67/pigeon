// lib/weighit/tenets.ts
//
// The eight WEIGH-IT tenets from Clark's value-lens corpus (§1a/§1b), encoded as a fixed,
// mechanical rule set. Each tenet carries:
//   - the template QUESTION (interrogative; never a conclusion)
//   - the primary-document anchor (we cite the canon, never a modern commentator voice)
//
// FIRING IS NOT KEYWORD-PRESENCE. A tenet's relevance gate lives in `generate.ts`
// (RELEVANCE map). A tenet fires only when the event's ACTOR and ACTION actually
// implicate that tenet's domain — and, for the US-constitutional tenets, only when the
// event has a genuine US nexus. A lone incidental keyword ("appoints", "state", "rule")
// is NOT enough. This is deliberate: precision over coverage. A routine or foreign-
// bureaucratic item that maps to no tenet shows FACT + CONTEXT and NO WEIGH-IT block —
// showing nothing is honest; a forced irrelevant prompt is an editorial failure.
//
// HARD RULE (Clark Part 0): this is the value-lens layer. It emits QUESTIONS ONLY.
// It never asserts. It never enters the FACT/CONTEXT track. Lens voices (Beck/Limbaugh/
// Kirk/Elder/Hillsdale) are NOT cited here — only the primary documents are.

export type Tenet = {
  id: string;
  label: string;
  question: string; // {event} / {actor} / {eventRef} slots filled at generation time
  anchor: string;
  // CONSTITUTIONAL ANALYSIS contrast (SPEC v2 §B + DIRECTIONAL rework, Timn 2026-06-26).
  // The founding standard IS the measure. `within` = the case the action lines up with that
  // standard; `beyond` = the founding-BASED tension or limit (critique comes FROM the founders
  // — limited federal power, anti-standing-army, consent — never from modern-liberal courts).
  // Both sides are anchored to PRIMARY founding documents only. Voice: plain, blue-collar —
  // short sentences, concrete words, no academic jargon. {actor} is slotted at gen time.
  ideal?: string; // the founding IDEAL at stake — foregrounded, hard (LOCKED rule 3)
  within?: string; // the case the action lines up with the founding standard
  beyond?: string; // the founding-based tension / limit
};

export const TENETS: Tenet[] = [
  {
    id: 'power-scope',
    label: 'Enumerated & limited federal power',
    question:
      'Does {event} keep {actor} inside the powers the Constitution enumerates (Art. I §8; 10th Amendment), or does it extend federal reach beyond them?',
    anchor: 'Federalist No. 45 (Madison); Constitution Art. I §8; Amendment X',
    ideal:
      'The federal government was built to have only a few, named jobs. Everything else stays with the states and the people.',
    within:
      'If the action uses a power the Constitution actually lists in Article I §8, it stays inside the lines the founders drew. Madison called the federal powers "few and defined" (Federalist 45).',
    beyond:
      'If it reaches into matters the 10th Amendment leaves to the states or the people, it stretches past those lines. The founders meant the states\' powers to stay "numerous and indefinite" (Federalist 45).',
  },
  {
    id: 'federalism',
    label: 'Federalism / states’ rights',
    question:
      'Does {event} centralize a decision the founders left to the states or the people (Federalist 45; 10th Amendment)?',
    anchor: 'Federalist No. 45 & No. 39 (Madison); Amendment X',
    ideal:
      'Most decisions were meant to be made close to home — by the states and the people, not run out of Washington.',
    within:
      'If the matter is one the Constitution hands to the national government, acting on it is the system working as built — "partly federal, partly national" (Federalist 39).',
    beyond:
      'If it overrides a choice the founders left to the states or towns, it pulls power up to Washington that the 10th Amendment kept below it.',
  },
  {
    id: 'separation-of-powers',
    label: 'Separation of powers & checks',
    question:
      'Is {actor} exercising its own constitutional power here, or absorbing one assigned to another branch (Federalist 51; for war, Art. I §8 cl. 11)?',
    anchor: 'Federalist No. 51 & No. 47 (Madison); Constitution Art. I §8 cl. 11',
    ideal:
      'No single branch was meant to hold too much power. The founders set each one against the others on purpose.',
    within:
      'If {actor} is using a power that belongs to its own branch, it respects the split Madison built so "ambition counteract[s] ambition" (Federalist 51).',
    beyond:
      'If {actor} takes a power the Constitution gives another branch — only Congress can declare war (Art. I §8 cl. 11) — that piling-up of power in one hand is what Madison called "the very definition of tyranny" (Federalist 47).',
  },
  {
    id: 'natural-rights',
    label: 'Natural rights & consent',
    question:
      'Does {event} secure or erode an unalienable right, and does it rest on the consent of the governed (Declaration; Federalist 10)?',
    anchor: 'Declaration of Independence (1776); Federalist No. 10 (Madison)',
    ideal:
      'Government exists to protect rights people already have — not to hand them out or take them away.',
    within:
      'If the action protects a basic right and rests on the people\'s consent, it does the one job government is for — "to secure these rights" (Declaration, 1776).',
    beyond:
      'If it strips a right that comes before government, or acts without the people\'s consent, it flips the founding deal that just power comes "from the consent of the governed."',
  },
  {
    id: 'foreign-restraint',
    label: 'Foreign-policy restraint vs. interventionism',
    question:
      'Does {event} move American foreign policy toward permanent entanglement and standing-army interventionism, or toward the armed restraint Washington and Jefferson urged?',
    anchor:
      'Washington, Farewell Address (1796); Jefferson, First Inaugural (1801); Federalist No. 8 (Hamilton); Art. I §8 cl. 11',
    ideal:
      'Stay strong enough to defend the country, but stay out of permanent foreign fights.',
    within:
      'If the move keeps a solid defense without a permanent entanglement, it follows the founders\' restraint — Washington warned against "permanent alliances"; Jefferson, "entangling alliances with none."',
    beyond:
      'If it locks American force into an open-ended foreign commitment, it runs toward the constant-war footing Hamilton warned trades freedom for safety (Federalist 8).',
  },
  {
    id: 'originalism',
    label: 'Original intent / fixed constitution',
    question:
      'Is this change being made through the text’s original meaning and the Article V amendment process, or by reinterpreting the words (Federalist 78)?',
    anchor: 'Constitution Art. V; Federalist No. 78 (Hamilton)',
    ideal:
      'The Constitution means what it meant when it was written. To change it, you amend it — you do not just reread it.',
    within:
      'If the change sticks to the text\'s original meaning — or goes through the Article V amendment process — the court is using "merely judgment," not its own will (Federalist 78).',
    beyond:
      'If the words get reread to reach a new result the people never amended in, it skips Article V — the only honest way to change what the Constitution means.',
  },
  {
    id: 'virtue-covenant',
    label: 'Virtue & religion as preconditions',
    question:
      'Does {event} strengthen or corrode the moral and religious preconditions the founders held a free people requires (Adams 1798; Farewell Address; Northwest Ordinance Art. 3)?',
    anchor:
      'John Adams to the Mass. Militia (1798); Washington, Farewell Address (1796); Northwest Ordinance (1787) Art. 3',
    ideal:
      'A free country only holds together if the people stay moral and self-governing. The founders treated that as a precondition, not an extra.',
    within:
      'If it strengthens the moral and religious habits the founders said a republic needs, it backs Adams\'s point that the Constitution "was made only for a moral and religious People."',
    beyond:
      'If it eats away at those habits, it weakens what Washington called the "indispensable supports" of a free people — religion and morality (Farewell Address).',
  },
];

// Tenet 8 — the historical-contrast closer. Always appended when >=1 other tenet fires.
// {eventRef} resolves to a CLEAN actor/action reference ("this ruling", "this executive
// action") — never the raw headline string. Dumping the full title here reads badly.
export const HISTORICAL_CONTRAST: Tenet = {
  id: 'historical-contrast',
  label: 'Historical contrast',
  question:
    'Set against the founders’ framework and the presidents who best embodied it, is {eventRef} a step toward that tradition or away from it?',
  anchor: 'The founding canon, taken as a whole',
};
