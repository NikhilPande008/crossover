# Devpost story — DRAFT

> Status: draft written before any live Qloo run. Every `[TBD]` must be filled from the live app or docs/eval.md, or deleted. Run the claims checklist at the bottom before submitting.

## Inspiration

Every release campaign starts with the same argument: *is our film more like Comp A or Comp B?* That one choice decides which cities get the budget, which podcasts and artists to partner with, and which angle leads the trailer. Mid-size distributors, streamers and labels make it with gut feel and the last campaign's playbook, because audience research is expensive and slow.

## What it does

Crossover is a release-marketing agent. A marketer enters a release and 2–4 comparable titles. Crossover:

1. resolves the comps to Qloo entities (and asks the user to confirm them before spending any research calls),
2. researches the comps' audiences in Qloo's taste graph: cross-domain affinities (podcasts, artists, TV, film, books, brands), taste tags, aggregate demographic skew, where fans concentrate (heatmap), whether two comps share an audience (overlap of each comp's own top affinities), and which themes they share or split (compare),
3. proposes three campaign concepts with different levers (market-led, partner-led bridge, crossover into an adjacent fandom), each with ranked markets, a partner shortlist, a creative angle, a computed confidence label and the main risk,
4. recommends one, with cited rationale, trade-offs and a "test before you spend" checklist, printable as a one-page brief.

The moment that shows why Qloo matters: **swap one comp**. The markets, partners and lead concept change, and a diff banner shows exactly what moved and which Qloo facts drove each change.

## How Qloo powers it

| Capability | Endpoint | Used for |
|---|---|---|
| Entity search | `GET /search` | Resolve comps; fact-check the no-Qloo baseline |
| Cross-domain affinities | `GET /v2/insights` (`urn:entity:*`) | Partner shortlists with per-comp attribution |
| Taste tags | `GET /v2/insights` (`urn:tag`) | Creative-angle evidence |
| Demographics | `GET /v2/insights` (`urn:demographics`) | Aggregate audience skew |
| Heatmap | `GET /v2/insights` (`urn:heatmap`) | City ranking by fan concentration |
| Theme compare | `GET /v2/analysis/compare` | Themes two comps share and themes unique to each (Qloo compares the titles' tags, not their audiences) |

Without Qloo, a language model can only offer genre-typical partners and big-city guesses. It cannot say where *these* comps' fans live, whether two comps share an audience, or which comp a partner's affinity comes from. The product includes a **Without Qloo** tab: the same model, the same brief, no tools, with every partner it names fact-checked against Qloo. `[TBD: verifiability and grounding numbers from docs/eval.md]`

## Request-to-result walkthrough (redacted)

Required by the kit's submission guide. Fill from one live preset run; never include the key.

1. `GET /search?query=Hereditary&types=urn:entity:movie` → chosen entity `[TBD id]`, confirmed by the user.
2. `GET /v2/insights?filter.type=urn:entity:podcast&signal.interests.entities=[TBD]` → `[TBD: top results, affinities]` → facts `F…`.
3. `GET /v2/insights?filter.type=urn:heatmap&signal.interests.entities=[TBD]&filter.location.query=United States` → cities ranked by mean percentile.
4. `GET /v2/analysis/compare?a.signal.interests.entities=[A]&b.signal.interests.entities=[B]` → themes the two comps share and themes unique to each. The "one audience or two?" verdict comes from step 2 run per comp: the share of top affinities both comps have.
5. Concept card: each partner and market chip opens the exact request above.

What the result does **not** establish: demand, box office, streams, ticket sales, or any individual's taste.

## How we built it

- Next.js (App Router, TypeScript) on a long-running Node host; Server-Sent Events stream the agent's steps and a live Qloo call counter.
- A hand-written agent loop (plan → research → assess → recover → conceive → critique → brief). Claude chooses research calls through bounded tools and writes interpretations; code does all retrieval, scoring, constraint checks and validation.
- Every Qloo value becomes a **Fact** with the request that produced it. The model only sees compact fact summaries and selects partners and markets by candidate key, so every name on screen comes from Qloo.
- A grounding validator removes any sentence that cites no valid fact, contains a number not in its cited facts, names an entity not in the facts or brief, or describes audiences by sensitive traits.
- Confidence labels are computed deterministically from comp agreement and affinity strength.
- Quota protection: per-run call cap, per-visitor caps, a quota floor, response caching, and recorded live runs for presets that are clearly labelled as recorded.
- Fixture mode with invented entities so the repo runs from a clean clone without keys; no Qloo response data is committed.

## Challenges

`[TBD after the live API spike: parameter surprises, heatmap granularity, compare endpoint path.]`

## Accomplishments

- Evidence, interpretation and hypothesis are separated and styled differently, and the separation is enforced in code.
- Comp swap re-uses still-valid facts, so a re-plan costs far fewer calls than a full run. `[TBD: measured live call counts]`

## What we learned

`[TBD]`

## What's next

More regions once location coverage is verified; artist-led presets for album rollouts; an MCP endpoint so other agents can call Crossover.

## Testing instructions

1. Open `[TBD: live URL]` and click **Prestige horror film**.
2. Keep the confirmed comps; click **Plan campaign** (about 20–60 s).
3. On the recommended concept, click any fact chip (e.g. `F12`) to see the exact Qloo request.
4. Click **Swap comp** (pre-filled Midsommar → Lady Bird), then **Re-plan**; read the diff banner and click **What moved?**
5. Open **Without Qloo** → **Show without Qloo**.
6. Open **Decision brief** → **Print / PDF**.
7. Negative case: **Plan my own release** with a made-up comp title.

## Built with

Next.js, TypeScript, Tailwind CSS, Qloo Insights API, Claude (Anthropic SDK), zod, Vitest, Playwright.

---

## Claims checklist (run before submitting)

- [ ] Every number above appears in the app or docs/eval.md
- [ ] Endpoints listed match those in the agent trace
- [ ] Baseline arm uses the identical brief and model
- [ ] Live, recorded and synthetic labels are accurate
- [ ] No forecast, ROI or audience-size claims anywhere
- [ ] Feedback quotes are real and permitted
- [ ] All `[TBD]` resolved or removed
- [ ] Screenshots or a short demo attached, with no key or personal data visible (kit submission guide)
