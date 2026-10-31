// Grounding validator. Runs on every piece of LLM prose before it reaches the browser:
//  1. cited fact IDs must exist (interpretations need at least one),
//  2. every numeral must match a value in the cited facts (or the brief), and quantity
//     words ("ten times", "twice as", "one in five", "millions of") are refused outright,
//  3. every word of a proper-noun-like name must be a whole word of a name in the facts,
//     comps or brief (so an invented "Ghost Adventures Weekly" fails even with a "Ghost" tag),
//  4. in a cited sentence, every partner, show, artist, brand or city it names must be
//     the subject of one of that sentence's own cited facts (not just exist somewhere),
//  5. sensitive-trait language is blocked,
//  6. comparative claims ("higher than", "the strongest", "among the top") about named
//     partners or cities must match the run's scores (lib/validate/comparative.ts),
//  7. a sentence claiming genre or theme interest needs a tag fact, not only fan-concentration facts.

import type { Brief, Comp, Fact } from "@/lib/types";
import { CITIES, REGIONS } from "@/lib/geo/cities";
import { checkComparative, type ScoreScope } from "./comparative";
import { SENSITIVE } from "./sensitive";

export type Issue = { text: string; reason: string };

export type GroundingContext = {
  facts: Map<string, Fact>;
  knownNames: string[]; // lower-cased
  /** Lower-cased known names, for exact lookups (e.g. a partner literally named "F1"). */
  known: Set<string>;
  /** Every whole word of every known name. */
  knownWords: Set<string>;
  briefNumbers: number[];
  /** Matches any known name, longest first, so names are never read as numbers. */
  namePattern: RegExp | null;
  /**
   * Matches entity names only (comps, title, partners, cities), never taste tags, so a name like
   * "RuPaul's Drag Race" is not read as sensitive language but a tag named "Mental Illness" is.
   */
  entityPattern: RegExp | null;
  /** Matches partner/market names (affinity and heatmap subjects, reference cities), longest first. */
  subjectPattern: RegExp | null;
  /** Names a sentence may mention without citing a fact about them: comps, the release title. */
  exempt: Set<string>;
  /** Run scores for checking comparative claims (rule 6). Set once scores and concepts exist. */
  scores?: ScoreScope;
};

// Capitalised words that are ordinary English or product vocabulary, never entities.
const STOP = new Set(
  `a an the and or but if then this that these those it its we our you your they their he she i is are was were be been being
  lead leads leading bridge crossover campaign concept concepts market markets partner partners podcast podcasts artist artists
  brand brands tv film films series album tour audience audiences comp comps fans fan both all each every one two three four five
  hypothesis test before spending creative angle position positioning use run target pair pairing focus open opening start launch
  qloo affinity evidence signal signals strong strongest weak moderate shared overlap overlapping divergent music books book
  social video paid owned earned push pull build test-and-learn recommend recommended why not because since while with without
  first second third next then early late week weeks month months day days city cities region regions national local
  high medium low confidence risk risks tradeoff tradeoffs option options instead also only even more most less least
  january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday
  united states kingdom us uk usa gb`.split(/\s+/),
);

export function makeContext(facts: Fact[], comps: Comp[], brief: Brief): GroundingContext {
  const names = new Set<string>();
  for (const f of facts) if (f.subject?.name) names.add(f.subject.name.toLowerCase());
  for (const c of comps) names.add(c.name.toLowerCase());
  for (const c of brief.comps) names.add(c.toLowerCase());
  names.add(brief.title.toLowerCase());
  for (const c of CITIES) names.add(c.name.toLowerCase());
  for (const r of Object.values(REGIONS)) names.add(r.label.toLowerCase());
  for (const e of brief.exclusions) names.add(e.toLowerCase());
  const briefNumbers = [...(brief.logline ?? "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  for (const c of comps) if (c.year) briefNumbers.push(c.year);
  const knownNames = [...names];
  const entities = new Set<string>([...comps.map((c) => c.name), ...brief.comps, brief.title, ...CITIES.map((c) => c.name)].map((n) => n.toLowerCase()));
  for (const f of facts) if ((f.kind === "affinity" || f.kind === "heatmap") && f.subject?.name) entities.add(f.subject.name.toLowerCase());
  const knownWords = new Set<string>();
  for (const n of knownNames)
    for (const w of wordsOf(n)) {
      knownWords.add(w);
      knownWords.add(w.replace(/[’']s$/, ""));
    }
  const subjects = new Set<string>(CITIES.map((c) => c.name.toLowerCase()));
  for (const f of facts) if ((f.kind === "affinity" || f.kind === "heatmap") && f.subject?.name) subjects.add(f.subject.name.toLowerCase());
  const exempt = new Set([...comps.map((c) => c.name.toLowerCase()), ...brief.comps.map((c) => c.toLowerCase()), brief.title.toLowerCase()]);
  for (const e of exempt) subjects.delete(e);
  return {
    facts: new Map(facts.map((f) => [f.id, f])),
    knownNames,
    known: names,
    knownWords,
    briefNumbers,
    namePattern: buildNamePattern(knownNames),
    entityPattern: buildNamePattern([...entities]),
    subjectPattern: buildSubjectPattern([...subjects]),
    exempt,
  };
}

/** Whole-word, longest-first matcher. Unicode-aware so names with accents or "&" work. */
function buildSubjectPattern(names: string[]): RegExp | null {
  const usable = names.filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
  return usable.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${usable.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, longest-first. Two-letter names count only if they hold a digit ("F1"), not "us" or "uk". */
function buildNamePattern(names: string[]): RegExp | null {
  const usable = names.filter((n) => n.length >= 3 || (n.length === 2 && /\d/.test(n))).sort((a, b) => b.length - a.length);
  return usable.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${usable.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
}

/** Lower-cased words with surrounding punctuation removed ("“Wren", "Ash." → "wren", "ash"). */
function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, ""))
    .filter(Boolean);
}

/** Replace known entity names (e.g. "The 1975", "RuPaul's Drag Race") with a neutral token. */
export function maskKnownNames(text: string, ctx: GroundingContext, pattern: RegExp | null = ctx.namePattern): string {
  return pattern ? text.replace(pattern, "‹name›") : text;
}

function factNumbers(f: Fact): number[] {
  const out: number[] = [];
  if (typeof f.value === "number") out.push(f.value);
  for (const v of Object.values(f.detail ?? {})) if (typeof v === "number") out.push(v);
  return out;
}

function numberMatches(n: number, isPercent: boolean, candidates: number[]): boolean {
  return candidates.some((v) => {
    if (isPercent) return Math.abs(n - v * 100) <= 0.6 || Math.abs(n - v) <= 0.6;
    return Math.abs(n - v) <= 0.006 || (Number.isInteger(n) && n === Math.round(v * 100)) || Math.abs(n - v) < 1e-9;
  });
}

/**
 * Strip fact markers like (F3, F7) or [F3] before analysing prose. A bare "F12" is a marker too,
 * unless it is a known name (a partner or film called "F1"), which is kept.
 */
export function stripCitations(text: string, keep?: Set<string>) {
  return text.replace(/\s*[[(]\s*F\d+(?:\s*[,;]\s*F\d+)*\s*[\])]/g, "").replace(/\bF\d+\b/g, (m) => (keep?.has(m.toLowerCase()) ? m : ""));
}

// Quantities written in words cannot match a fact value, so they are refused like an unknown number.
const NUM_WORD = "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|a hundred|hundred";
const QUANTITY_WORDS = new RegExp(
  [
    `\\b(?:${NUM_WORD})[\\s-]*(?:times|fold|percent|per\\s*cent)\\b`,
    `\\b(?:twice|thrice)\\s+(?:as|the)\\b`,
    `\\b(?:double|triple|quadruple)\\s+as\\b`,
    `\\b(?:${NUM_WORD})\\s+(?:in|out of)\\s+(?:${NUM_WORD}|\\d+)\\b`,
    `\\b(?:dozens|hundreds|thousands|millions|billions)\\s+of\\b`,
    `\\b(?:${NUM_WORD}|a)\\s+(?:thousand|million|billion)\\b`,
  ].join("|"),
  "i",
);

export function checkNumbers(text: string, factIds: string[], ctx: GroundingContext): Issue | null {
  const clean = maskKnownNames(stripCitations(text, ctx.known), ctx);
  const words = clean.match(QUANTITY_WORDS);
  if (words) return { text, reason: `quantity "${words[0]}" is not a Qloo value` };
  const cands = [...factIds.flatMap((id) => (ctx.facts.get(id) ? factNumbers(ctx.facts.get(id)!) : [])), ...ctx.briefNumbers];
  for (const m of clean.matchAll(/(\d+(?:\.\d+)?)(\s*%|\s*percent)?/g)) {
    const n = Number(m[1]);
    if (!numberMatches(n, Boolean(m[2]), cands)) return { text, reason: `number ${m[0].trim()} not in cited facts` };
  }
  return null;
}

/** Candidate entity mentions: quoted strings and runs of Capitalised words. */
export function entityMentions(text: string, keep?: Set<string>, knownWords?: Set<string>): string[] {
  const clean = stripCitations(text, keep);
  const out = new Set<string>();
  for (const m of clean.matchAll(/["“]([^"”]{2,60})["”]/g)) out.add(m[1].trim());
  const bare = (w: string) => w.replace(/^[("'‘“]+/, "").replace(/[.,!?;:'’)"”]+$/, "");
  const isCap = (w: string) => /^[A-Z]/.test(bare(w)) || bare(w) === "&";
  const stop = (w: string) => STOP.has(bare(w).toLowerCase().replace(/[’']s$/, ""));
  for (const s of clean.split(/(?<=[.!?:;])\s+|\n+/)) {
    const words = s.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      if (!isCap(words[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j < words.length && isCap(words[j])) {
        j++;
        if (/[,;:)]$/.test(words[j - 1])) break;
      }
      let run = words.slice(i, j);
      // A lone capitalised word at sentence start is usually just capitalised by position. So is the
      // first word of a longer run when it is no word of any known name ("Expand The Tithe's",
      // "Connect Glass Summer"): drop it and check the rest.
      if (i === 0 && run.length === 1) run = [];
      else if (i === 0 && knownWords && !knownWords.has(bare(run[0]).toLowerCase().replace(/[’']s$/, ""))) run = run.slice(1);
      while (run.length && stop(run[0])) run = run.slice(1);
      if (run.some((w) => !stop(w))) out.add(run.map(bare).join(" "));
      i = j;
    }
  }
  return [...out];
}

/**
 * A mention is known when it is a known name, or when each of its non-stop words is a whole word
 * of some known name (allowing a plural or possessive "s"). Substrings do not count: "Ghostbusters"
 * is not known because "Ghost" is.
 */
/** Descriptive suffixes on a name ("Portland-centric", "Fleabag-themed") are not part of the name. */
const NAME_SUFFIX = /-(centric|themed|style|styled|based|focused|inspired|esque|like|adjacent|loving|led|first|heavy|leaning|friendly)\b/g;

function isKnown(mention: string, ctx: GroundingContext): boolean {
  const m = mention.toLowerCase().replace(NAME_SUFFIX, "").replace(/[’']s$/, "").trim();
  if (!m || ctx.known.has(m)) return true;
  const words = wordsOf(m).filter((w) => !STOP.has(w.replace(/[^a-z&'-]/g, "")));
  if (!words.length) return true;
  const has = (w: string) => ctx.knownWords.has(w) || ctx.knownWords.has(w.replace(/[’']s$/, "")) || (w.endsWith("s") && ctx.knownWords.has(w.slice(0, -1)));
  return words.every(has);
}

export function checkEntities(text: string, ctx: GroundingContext): Issue | null {
  for (const mention of entityMentions(text, ctx.known, ctx.knownWords)) {
    if (!isKnown(mention, ctx)) return { text, reason: `unknown entity "${mention}"` };
  }
  return null;
}

/**
 * Rule 4: every partner, show, artist, brand or city named in a cited sentence must be the
 * subject of one of the sentence's own cited facts. A name in lower case is treated as an
 * ordinary word (a podcast called "Criminal" vs. "criminal intent"), so only capitalised
 * mentions count.
 */
/** Capitalised mentions of partners and cities (not comps or the title), with positions in `clean`. */
export function namedSubjects(clean: string, ctx: GroundingContext): { name: string; index: number }[] {
  if (!ctx.subjectPattern) return [];
  const out: { name: string; index: number }[] = [];
  for (const m of clean.matchAll(ctx.subjectPattern)) {
    if (!/^[\p{Lu}\p{N}]/u.test(m[0]) || ctx.exempt.has(m[0].toLowerCase())) continue;
    out.push({ name: m[0], index: m.index ?? 0 });
  }
  return out;
}

export function checkCitedSubjects(text: string, factIds: string[], ctx: GroundingContext): Issue | null {
  const cited = new Set(factIds.map((id) => ctx.facts.get(id)?.subject?.name?.toLowerCase()).filter((n): n is string => !!n));
  for (const { name } of namedSubjects(stripCitations(text, ctx.known), ctx)) {
    if (!cited.has(name.toLowerCase())) return { text, reason: `names "${name}" but none of its cited facts is about it` };
  }
  return null;
}

/** Rule 6: comparative and superlative claims must match the run's scores. */
export function checkComparativeClaim(text: string, ctx: GroundingContext): Issue | null {
  if (!ctx.scores) return null;
  const clean = stripCitations(text, ctx.known);
  const issue = checkComparative(clean, namedSubjects(clean, ctx), ctx.scores);
  return issue ? { text, reason: issue.reason } : null;
}

export function checkSensitive(text: string, ctx?: GroundingContext): Issue | null {
  const m = (ctx ? maskKnownNames(text, ctx, ctx.entityPattern) : text).match(SENSITIVE);
  return m ? { text, reason: `sensitive-trait language "${m[0]}"` } : null;
}

/**
 * Rule 7: a fan-concentration (heatmap) fact says where a comp's fans concentrate, nothing about
 * interest in a genre or theme. "Cities with strong horror interest" needs a tag fact.
 */
const INTEREST = /\b(interest|enthusias\w*|appetite|passion|demand)\s+(in|for)\b|\b(horror|comedy|drama|thriller|music|indie)\s+(interest|fans?|lovers?|scene)\b/i;
export function checkInterpretation(text: string, factIds: string[], ctx: GroundingContext): Issue | null {
  const kinds = new Set(factIds.map((id) => ctx.facts.get(id)?.kind));
  if (!INTEREST.test(stripCitations(text, ctx.known))) return null;
  if (kinds.has("tag") || kinds.has("compare")) return null;
  if (kinds.has("heatmap")) return { text, reason: "claims genre or theme interest, but its only evidence is where fans concentrate" };
  return null;
}

/** Validate an interpretation: needs ≥1 valid fact ID, grounded numbers and names. */
export function validateCited(item: { text: string; factIds: string[] }, ctx: GroundingContext): { ok: true; factIds: string[] } | { ok: false; issue: Issue } {
  const valid = item.factIds.filter((id) => ctx.facts.has(id));
  if (!valid.length) return { ok: false, issue: { text: item.text, reason: "no valid fact citation" } };
  const issue =
    checkSensitive(item.text, ctx) ??
    checkNumbers(item.text, valid, ctx) ??
    checkEntities(item.text, ctx) ??
    checkCitedSubjects(item.text, valid, ctx) ??
    checkComparativeClaim(item.text, ctx) ??
    checkInterpretation(item.text, valid, ctx);
  return issue ? { ok: false, issue } : { ok: true, factIds: valid };
}

/** Validate uncited prose (hypotheses, risks, tradeoffs): no ungrounded numbers or names. */
export function validateUncited(text: string, ctx: GroundingContext): Issue | null {
  return checkSensitive(text, ctx) ?? checkNumbers(text, [], ctx) ?? checkEntities(text, ctx);
}
