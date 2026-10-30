# Qloo API findings

Run: 2026-10-25T06:35:35.401Z · host https://hackathon.api.qloo.com · 29 calls

Only shapes and pass/fail results are recorded here. No Qloo response values are committed.

## Test results

| Test | Pass | Notes |
|---|---|---|
| 1 search "Hereditary" | ✅ | exact name in top 3 (rank 1), type=movie, year present=true |
| 1 search "The Witch" | ✅ | exact name in top 3 (rank 1), type=movie, year present=true |
| 1 search "Midsommar" | ✅ | exact name in top 3 (rank 1), type=movie, year present=true |
| 1 search "Lady Bird" | ✅ | exact name in top 3 (rank 1), type=movie, year present=true |
| 1 search "Lady Bird" | ✅ | exact name in top 3 (rank 1), type=movie, year present=true |
| 1 search "Eighth Grade" | ✅ | exact name in top 3 (rank 1), type=movie, year present=true |
| 1 search "The Perks of Being a Wallflower" | ✅ | exact name in top 3 (rank 1), type=movie, year present=true |
| 1 search "Booksmart" | ✅ | exact name in top 3 (rank 1), type=movie, year present=true |
| 1 search "Fleabag" | ✅ | exact name in top 3 (rank 1), type=tv_show, year present=true |
| 1 search "Barry" | ✅ | exact name in top 3 (rank 1), type=tv_show, year present=true |
| 1 search "Russian Doll" | ✅ | exact name in top 3 (rank 1), type=tv_show, year present=true |
| 1 search "The Bear" | ✅ | exact name in top 3 (rank 1), type=tv_show, year present=true |
| 2 podcast specificity (Hereditary vs Lady Bird) | ✅ | top-10 overlap 0%, explainability present=true, affinity at query.affinity |
| 2b filter.type=urn:entity:artist | ✅ | ok |
| 2b filter.type=urn:entity:brand | ✅ | ok |
| 2b filter.type=urn:entity:tv_show | ✅ | ok |
| 2b filter.type=urn:entity:book | ✅ | ok |
| 2b filter.type=urn:tag | ✅ | ok |
| 2b filter.type=urn:demographics | ✅ | ok |
| 2c urn:tag honours signal.interests.entities | ✅ | 1/12 tags identical across comps; affinity field present=true |
| 3 heatmap US | ❌ | status 400 |
| 3 heatmap GB | ❌ | status 400 |
| 4 filter.exclude.entities honoured | ✅ |  |
| 4 invalid param | n/a | silently ignored (200) — allowlist required |
| 5 /v2/analysis/compare (default type) | ✅ | ok; parseCompare recognised 63 items |
| 5 /v2/analysis/compare (urn:entity:artist) | ✅ | ok; parseCompare recognised 63 items |

## Response shapes

**/search**

```
{ results: [{ name: string, entity_id: string, types: [string] (len 1), properties: { akas: […] (len 23), content_rating: string, description: string, external: { facebook: …, imdb: …, instagram: …, metacritic: …, rottentomatoes: …, twitter: …, wikidata: … }, filming_location: string, image: { url: … }, is_special: boolean, production_company: string, release_country: string, release_date: string, release_year: number, short_descriptions: […] (len 4), website: string }, popularity: number, disambiguation: string, tags: [{ name: …, tag_id: …, type: … }] (len 309) }] (len 1) }
```

**/v2/insights podcast**

```
{ success: boolean, results: { entities: [{ name: string, entity_id: string, type: string, subtype: string, properties: { akas: …, image: …, rating: …, channel: …, description: …, release_date: …, episode_count: …, content_rating: …, short_description: …, short_descriptions: … }, popularity: number, tags: […] (len 3), query: { affinity: …, measurements: …, explainability: … }, disambiguation: string, external: { itunes: … } }] (len 10) }, query: { explainability: { signal.interests.entities: { effect_on_top3_recs: […] (len 1), effect_on_top5_recs: […] (len 1), effect_on_top10_recs: […] (len 1), effect_on_all_recs: […] (len 1) } } } }
```

**/v2/insights urn:entity:artist**

```
{ success: boolean, results: { entities: [{ name: string, entity_id: string, type: string, subtype: string, properties: { image: …, vocals: …, aliases: …, members: …, is_group: …, biography: …, known_for: …, start_year: …, voice_type: …, description: …, instruments: …, lowest_note: …, vocal_range: …, highest_note: … }, popularity: number, tags: […] (len 55), query: { affinity: …, measurements: … }, disambiguation: string, external: { imdb: …, lastfm: …, spotify: …, twitter: …, facebook: …, wikidata: …, goodreads: …, instagram: …, musicbrainz: … } }] (len 5) } }
```

**/v2/insights urn:entity:brand**

```
{ success: boolean, results: { entities: [{ name: string, entity_id: string, type: string, subtype: string, properties: { akas: …, image: …, sport: …, tagline: …, industry: …, keywords: …, owned_by: …, products: …, inception: …, lifestyle: …, brand_type: …, industries: …, subsidiary: …, core_values: … }, popularity: number, tags: […] (len 119), query: { affinity: …, measurements: … }, disambiguation: string, external: { twitter: …, facebook: …, wikidata: …, instagram: … } }] (len 5) } }
```

**/v2/insights urn:entity:tv_show**

```
{ success: boolean, results: { entities: [{ name: string, entity_id: string, type: string, subtype: string, properties: { akas: …, image: …, genres: …, duration: …, keywords: …, websites: …, title_type: …, description: …, finale_year: …, wikidata_id: …, plot_summary: …, release_date: …, release_year: …, collaborators: … }, popularity: number, tags: […] (len 140), query: { affinity: …, measurements: … }, disambiguation: string, external: { imdb: …, netflix: …, twitter: …, wikidata: …, letterboxd: …, rottentomatoes: … } }] (len 5) } }
```

**/v2/insights urn:entity:book**

```
{ success: boolean, results: { entities: [{ name: string, entity_id: string, type: string, subtype: string, properties: { description: …, format: …, isbn10: …, isbn13: …, language: …, page_count: …, publication_date: …, publication_year: …, publisher: …, title: …, series_name: …, image: …, akas: …, short_descriptions: … }, popularity: number, tags: […] (len 56), query: { affinity: … }, disambiguation: string, external: { goodreads: … } }] (len 5) } }
```

**/v2/insights urn:tag**

```
{ success: boolean, results: { tags: [{ tag_id: string, name: string, types: […] (len 1), subtype: string, tag_value: string, popularity: number, query: { affinity: … } }] (len 5) } }
```

**/v2/insights urn:demographics**

```
{ success: boolean, results: { demographics: [{ entity_id: string, query: { age: …, gender: … } }] (len 1) } }
```

**/v2/analysis/compare default type**

```
{ duration: number, results: { tags: [{ tag_id: string, name: string, type: string, subtype: string, entity_id: string, popularity: number, query: { score: …, a.signal.interests.entities: …, b.signal.interests.entities: … } }] (len 3), a: [{ tag_id: string, name: string, type: string, subtype: string, entity_id: string, popularity: number, query: { count: … } }] (len 39), b: [{ tag_id: string, name: string, type: string, subtype: string, entity_id: string, popularity: number, query: { count: … } }] (len 31), matchEntities: [] } }
```

**/v2/analysis/compare urn:entity:artist**

```
{ duration: number, results: { tags: [{ tag_id: string, name: string, type: string, subtype: string, entity_id: string, popularity: number, query: { score: …, a.signal.interests.entities: …, b.signal.interests.entities: … } }] (len 3), a: [{ tag_id: string, name: string, type: string, subtype: string, entity_id: string, popularity: number, query: { count: … } }] (len 39), b: [{ tag_id: string, name: string, type: string, subtype: string, entity_id: string, popularity: number, query: { count: … } }] (len 31), matchEntities: [] } }
```

## Follow-ups

- Set thresholds in lib/thresholds.ts from observed affinity ranges.
- If compare shows 0 recognised items, extend lib/qloo/compare.ts to the shape above.
- If filter.location.query did not resolve for a country, switch heatmaps to per-city queries.
- Update lib/qloo/params.ts and lib/qloo/schemas.ts to match the shapes above.