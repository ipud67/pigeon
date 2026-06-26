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
};

export const TENETS: Tenet[] = [
  {
    id: 'power-scope',
    label: 'Enumerated & limited federal power',
    question:
      'Does {event} keep {actor} inside the powers the Constitution enumerates (Art. I §8; 10th Amendment), or does it extend federal reach beyond them?',
    anchor: 'Federalist No. 45 (Madison); Constitution Art. I §8; Amendment X',
  },
  {
    id: 'federalism',
    label: 'Federalism / states’ rights',
    question:
      'Does {event} centralize a decision the founders left to the states or the people (Federalist 45; 10th Amendment)?',
    anchor: 'Federalist No. 45 & No. 39 (Madison); Amendment X',
  },
  {
    id: 'separation-of-powers',
    label: 'Separation of powers & checks',
    question:
      'Is {actor} exercising its own constitutional power here, or absorbing one assigned to another branch (Federalist 51; for war, Art. I §8 cl. 11)?',
    anchor: 'Federalist No. 51 & No. 47 (Madison); Constitution Art. I §8 cl. 11',
  },
  {
    id: 'natural-rights',
    label: 'Natural rights & consent',
    question:
      'Does {event} secure or erode an unalienable right, and does it rest on the consent of the governed (Declaration; Federalist 10)?',
    anchor: 'Declaration of Independence (1776); Federalist No. 10 (Madison)',
  },
  {
    id: 'foreign-restraint',
    label: 'Foreign-policy restraint vs. interventionism',
    question:
      'Does {event} move American foreign policy toward permanent entanglement and standing-army interventionism, or toward the armed restraint Washington and Jefferson urged?',
    anchor:
      'Washington, Farewell Address (1796); Jefferson, First Inaugural (1801); Federalist No. 8 (Hamilton); Art. I §8 cl. 11',
  },
  {
    id: 'originalism',
    label: 'Original intent / fixed constitution',
    question:
      'Is this change being made through the text’s original meaning and the Article V amendment process, or by reinterpreting the words (Federalist 78)?',
    anchor: 'Constitution Art. V; Federalist No. 78 (Hamilton)',
  },
  {
    id: 'virtue-covenant',
    label: 'Virtue & religion as preconditions',
    question:
      'Does {event} strengthen or corrode the moral and religious preconditions the founders held a free people requires (Adams 1798; Farewell Address; Northwest Ordinance Art. 3)?',
    anchor:
      'John Adams to the Mass. Militia (1798); Washington, Farewell Address (1796); Northwest Ordinance (1787) Art. 3',
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
