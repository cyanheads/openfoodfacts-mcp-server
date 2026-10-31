# openfoodfacts-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `off_get_product` | Fetch a product by barcode (4–40 digits). Returns name, brands, quantity, ingredients (raw text + parsed list), declared and trace allergens, additives, ingredient analysis, Nutri-Score, NOVA group, Green-Score, nutriments (per serving, and per 100 g, or per 100 ml for liquids), categories, labels, packaging, origins, countries of sale, image URL, and completeness signal. Missing fields mean "not yet entered in the database" — not that the attribute is absent from the real product — except that a read of prepared-product nutrition omits as-sold figures the record can still hold. | `barcode` (string, required), `fields` (optional field subset) | `readOnlyHint: true` |
| `off_search_products` | Search by keyword, structured tag filters, and/or numeric nutrient thresholds (per 100 g, or per 100 ml for liquids). Returns summary rows with barcodes for follow-up lookups. Use when the barcode is unknown or to explore a category. Filters use canonical tag IDs (e.g. `en:organic`, `en:no-gluten`) — use `off_browse_taxonomy` to resolve human terms to tag IDs. | `query` (text search), `categories_tag`, `brands_tag`, `labels_tag` (string or array), `allergens_tag`, `traces_tag`, `exclude_allergens`, `exclude_traces`, `ingredients_analysis_tag`, `additives_tag`, `nutrient_filters`, `nutrition_grade`, `nova_group`, `countries_tag`, `sort_by`, `page`, `page_size` | `readOnlyHint: true` |
| `off_compare_products` | Side-by-side nutrition and scoring comparison for up to 10 distinct barcodes per call; more are listed in `unprocessed`, unfetched. Returns a normalized table of calories, fat, saturated fat, carbohydrates, sugars, salt, protein, and fiber (per 100 g, or per 100 ml for liquids), plus Nutri-Score, NOVA, and Green-Score; figures for the prepared product arrive in a separate `prepared` object and table. Designed for "which of these cereals is healthiest?" workflows. | `barcodes` (array of 2–100 barcode strings, 4–40 digits each) | `readOnlyHint: true` |
| `off_browse_taxonomy` | Resolve a human term to the canonical tag ID for a filter facet: categories, labels, allergens, additives, countries, nova groups, nutrition grades. A search term resolves against the live Open Food Facts taxonomy, merged behind an in-process sample; omitting it lists that sample, which is all the upstream suggester can support. Use before `off_search_products` to build precise filter values. | `facet` (enum), `search` (optional term), `limit` | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

None. All data is reachable via tools. The barcode-keyed product data has a natural URI shape but tool-only clients are the primary target.

### Prompts

None. The server is data-oriented; no recurring analysis templates warrant a prompt definition.

---

## Overview

Wraps the [Open Food Facts API v2](https://world.openfoodfacts.org/) — a free, keyless, crowd-sourced global food product database covering 3M+ products. The primary access pattern is barcode → full product label (ingredients, allergens, scores, nutrition). Complements `usda-mcp-server` (US FoodData Central: generic, US-centric foods). Open Food Facts is the global, barcode-addressable, branded-product side.

Target audience: diet and allergen tracking, grocery and meal-planning tools, health-conscious shoppers, agents turning a barcode or product name into structured nutrition and ingredient data.

Attribution: data under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1.0/) — cite Open Food Facts in downstream use.

---

## Requirements

- No API key. Mandatory identifying `User-Agent` header: `openfoodfacts-mcp-server/<version> (casey@caseyjhand.com)` — baked into the service layer, not per-call.
- Read-only — no write-back of product edits.
- Per-endpoint rate limits: product reads ~15/min, search ~10/min, taxonomy resolution ~10/min. Rate limiting enforced in service layer, one token bucket per class, counted in upstream HTTP requests rather than tool calls — the slot is charged per attempt inside the retry boundary, so a retried request spends its own. The product and search figures are the per-IP ceilings Open Food Facts publishes; exceeding them is answered with an IP ban rather than a throttle, so the defaults sit at the published number and go lower — never higher — on a shared outbound IP.
- Field selection mandatory on every request — the product object is ~200 keys; always scope `fields=`.
- Tag vocabulary, not free text — search filters use canonical tag IDs (`en:organic`, `en:no-gluten`).
- Missing fields signal incomplete crowd-sourced data, not product attribute absence — surface this distinction explicitly in tool descriptions and output. The exception is nutrition read in a prepared state, which omits as-sold figures the record can still hold; the output says what the read returned, never that the record lacks them.
- Computed scores (Nutri-Score, NOVA, Green-Score) carry regional formula and missing-data caveats — return grade letters as-is, never infer absolute health claims.
- Data is under ODbL; tool descriptions note attribution requirement.

---

## Confirmed API Shapes (live-probed 2026-05-30)

### Product lookup (`/api/v2/product/{barcode}.json`)

**Hit:** `GET /api/v2/product/3017620422003.json?fields=product_name,brands,nutriscore_grade,nutriments`

```json
{
  "code": "3017620422003",
  "status": 1,
  "status_verbose": "product found",
  "product": {
    "brands": "Nutella",
    "nutriscore_grade": "e",
    "product_name": "Nutella",
    "nutriments": {
      "energy-kcal": 539,
      "energy-kcal_100g": 539,
      "energy-kcal_unit": "kcal",
      "energy-kcal_value": 539,
      "fat": 30.9,
      "fat_100g": 30.9,
      "fat_unit": "g",
      "sugars": 56.3,
      "sugars_100g": 56.3,
      "salt_100g": 0.107,
      "proteins_100g": 6.3,
      "nova-group": 4,
      "nova-group_100g": 4
    }
  }
}
```

**Nutriments shape:** flat key-value map. Each nutrient has up to six variants: `{key}`, `{key}_100g`, `{key}_unit`, `{key}_value`, `{key}_serving` (when serving data present), `{key}_modifier` (e.g. `~` for approximate). The `_100g` variant is the normalized figure per 100 g, or per 100 ml for liquids, and `_unit` is, on legacy records, the unit the contributor entered rather than the unit `_100g` and `_serving` are in. Keys use hyphens: `energy-kcal`, `saturated-fat`, `added-sugars`.

**Fields confirmed in full product object:** `product_name`, `brands`, `quantity`, `ingredients_text`, `allergens_tags` (array, `en:milk` format), `traces_tags` (array, same format — `["en:none"]` declares no traces, `[]` is not-yet-entered), `additives_tags` (array, `en:e322` format), `ingredients_analysis_tags` (array, `en:vegan` / `en:maybe-vegan` / `en:palm-oil-free` format), `nutriscore_grade` (`a`–`e`, `unknown`, `not-applicable`, or absent), `nova_group` (1–4 integer or absent), `ecoscore_grade` (the Green-Score scale `a-plus`, `a`–`f`, plus `unknown` and `not-applicable` — seen live: `not-applicable` on 5449000000996, `f` on 5034660516170), `categories_tags` (array), `labels_tags` (array), `packaging_tags` (array), `origins_tags` (array, often empty), `countries_tags` (array, the values `off_search_products` filters on as `countries_tag`), `image_url`, `completeness` (0–1 float), `data_quality_tags` (crowd-sourced QA flags).

**Field subsets are expanded to their dependencies.** The API returns exactly the `fields=` list it is given, so `off_get_product` adds what a requested field needs to be readable before sending: `nutriments` brings `serving_size`, `serving_quantity`, and `serving_quantity_unit` — the combined request is honored, verified on barcode 0028400157827 — and `serving_quantity` and `serving_quantity_unit` each bring the other plus `serving_size`, while `serving_size` expands to nothing (see "The serving fields expand as a closed group"). `requested_fields` echoes the expanded set, so a field present in `product` is always one the response says it asked for and the "not requested" wording can never contradict the payload.

**Missing barcode response (status:0):** HTTP 404 with `{"code":"2961836540127","status":0,"status_verbose":"product not found"}` (live 2026-10-13). An HTTP 200 carrying `status: 0` (`"no code or invalid code"`, live 2026-10-13 for `00000636`) is the same answer and is still read as not found.

**A 2xx body is a product answer only in one of two shapes:** `status: 0`, or `status: 1` with a `product` object. A field subset none of whose fields is entered comes back as `"product": {}` with `status: 1` (live 2026-10-13, `fields=zz_no_such_field`) — a found product with nothing recorded, not a miss. Any other 2xx body (`{}`, `{"status":1}` with no product, a non-numeric `status`) is a malformed envelope and raises the retryable `upstream_error`; read as an answer, it would turn a broken response into a confident "not found".

### Search (`/api/v2/search`)

**Hit:** `GET /api/v2/search?categories_tags_en=breakfast-cereals&fields=code,product_name,nutriscore_grade&page_size=5`

```json
{
  "count": 25894,
  "page": 1,
  "page_count": 5,
  "page_size": 5,
  "skip": 0,
  "products": [...]
}
```

**Pagination:** uses `page` (1-based) and `page_size` params. Response includes `count` (total matching products), `page_count` (number of products returned on this page — mirrors `page_size` for full pages, less for the last page), `skip` (row offset). **There is no total-pages field** — compute it as `Math.ceil(count / page_size)` in the service layer if needed. **Page 10 is the deepest page served to a client that is not logged in**: `search_and_display_products` in Product Opener's `lib/ProductOpener/Display.pm` answers any `page > 10` with HTTP 401 and a rendered `robots_not_served_here` page before it runs the query. The bound is on the page number, not on results — live 2026-09-23, page 11 was refused at `page_size` 1 and on a brand filter matching nothing, while page 10 at `page_size` 50 was served.

**`count` is present only when the query ran.** `search_and_display_products` starts its response as `{page, page_size, skip, products: []}` and adds `count` and `page_count` only after the MongoDB query succeeds; a failed query is logged and that skeleton answered with HTTP 200, and a failed count query can leave `count: null`. A zero-match answer carries `count: 0` (live 2026-10-13). So the service accepts a body only with a `products` list and a numeric `count`, and raises anything else as the retryable `upstream_error` rather than reporting zero matches.

**Filter params confirmed working:**
- `categories_tags_en=breakfast-cereals` — English label (no `en:` prefix needed for `_en` params)
- `brands_tags=nutella` — brand slug
- `nutrition_grades_tags=e` — single letter a–e (the bare `nutrition_grades` key is silently ignored)
- Multiple filters compose as AND

**Tag filter params in search:** `categories_tags`, `labels_tags`, `allergens_tags`, `traces_tags`, `ingredients_analysis_tags`, `additives_tags`, `brands_tags`, `countries_tags` — use canonical `en:X` format. Any `*_tags` value is a comma-separated AND list in which a `-` prefix negates (`add_params_to_query` in `Display.pm`), and every value, negated ones included, is canonicalized. Live 2026-09-22/23 on `en:chocolates` (32,687): `allergens_tags=en:nuts` 6,603 and `-en:nuts` 26,084 (15,936 of those with no allergen data at all, `allergens_tags=unknown`); `allergens_tags=en:nuts,-en:milk` 1,302; `traces_tags=en:nuts` 12,450 (so is `en:nut`, canonicalized through the allergen taxonomy), `-en:nuts` 20,237, `en:nuts,-en:milk` 8,222; `ingredients_analysis_tags=en:vegan` 2,553; `labels_tags=en:organic,en:fair-trade` 2,183 against 4,653 and 3,989 alone. The `_en` suffix variants accept plain English slugs. Tag values match exactly against the normalized slug: `brands_tags=nutella` matches while `brands_tags=nutell` returns zero, on this endpoint and on the text backend alike.

### Text search (`https://search.openfoodfacts.org/search`)

Separate backend (search-a-licious over Elasticsearch), reached whenever a request carries free text or a nutrient constraint. The service calls it as `POST /search` with the parameters in a JSON body — `{q, langs, fields, page, page_size, sort_by?}`, the same parameters the GET form takes (live-verified identical for `sort_by`, `page`, `page_size`, and `fields`). Its envelope differs from `/api/v2/search` in three ways that the service normalizes or surfaces:

```json
{
  "count": 10000,
  "is_count_exact": false,
  "page": 1,
  "page_size": 2,
  "page_count": 5000,
  "hits": []
}
```

- **`count` is a floor, not a total, when `is_count_exact` is false.** The backend stops counting hits at 10,000 and reports which side of that it landed on. Live-probed: `chocolate`, `water`, `milk` all report `count: 10000, is_count_exact: false`; `kombucha` reports `count: 3464, is_count_exact: true`. `/api/v2/search` has no such ceiling — the same `en:beverages` filter that clips to 10,000 here counts 230,860 there. `is_count_exact` is a required property of the endpoint's documented success schema, so it is read directly rather than inferred by comparing `count` to a local constant.
- **A success envelope must carry `hits`, a numeric `count`, and a boolean `is_count_exact`.** search-a-licious's `SuccessSearchResponse` requires all three, and every live answer carries them, zero-hit pages included (`count: 0, hits: [], is_count_exact: true`). A 2xx body without them, and not the `errors` envelope below, is malformed: the service raises it as the retryable `upstream_error` instead of defaulting to zero matches and an exact count.
- **`page_count` means total pages**, not products on this page. Normalized to products-on-page in the service so both paths return one shape.
- **The index is a snapshot that lags the live database.** Live-probed 2026-09-17: the newest record this backend holds for `hummus` carries `last_modified_t` 1734420067 (2024-12-17), while `/api/v2/search` returns a record for the same category created 2026-09-15. The same `en:hummus` filter counts 3,391 here against 4,554 there, and the 2026 barcode `8719587264270` is absent from this index while the control barcode `3017620422003` resolves. So text search answers from a stale corpus and tag-only search does not. The cutoff date is recorded here, not in any runtime string: `/health` reports Redis and Elasticsearch connectivity only, publishing no index timestamp, and deriving one would cost an extra search request per call. The tool discloses the property through an enrichment field instead, on every response this backend answered.
- **Nutrient values are queryable here and nowhere else.** `nutriments.<name>_100g` accepts Lucene range clauses: square brackets are inclusive (`[* TO 2]` → `lte`), curly braces exclusive (`{* TO 2}` → `lt`), `*` is an open bound, and hyphenated names need no escaping. Live-probed 2026-09-17 against `q=categories_tags:"en:hummus"` (baseline `count: 3391`): `nutriments.sugars_100g:[* TO 2]` → 2,291, `{* TO 2}` → 1,939, `nutriments.saturated-fat_100g:[* TO 2]` → 2,483. Those counts read as whole numbers, because `sugars` is one of five nutrients the index stores truncated (next bullet): `[* TO 2]` counted the products below 3 and `{* TO 2}` those below 2, not the products at or below 2 and below 2. The `nutriments.` prefix is mandatory — a bare `sugars_100g:[* TO 2]` answers HTTP 200 with zero hits and no error, the same silent-empty trap as `additives_tags`. Nine fields are indexed per 100 g, or per 100 ml for liquids (`energy-kcal`, `fat`, `saturated-fat`, `carbohydrates`, `sugars`, `fiber`, `proteins`, `salt`, `sodium` — all nine ANDed return 1,659 hits); the per-serving variants are not (`nutriments.sugars_serving:[0 TO 1000]` returns zero, the unindexed signature), so only the per-100 basis is offered. `/api/v2/search` documents the same comparisons (`docs/api/ref/api.yaml`, "Conditions on nutriments") but ignores them: `sugars_100g<2`, `>9999`, and `<0.0001` each returned the identical unfiltered `count: 4554`, percent-encoded and raw alike.
- **Five of the nine nutrients compare as whole numbers.** `energy-kcal`, `fat`, `saturated-fat`, `carbohydrates`, and `sugars` are dynamically mapped as `long`, so the index stores 3.53 as 3 and compares the truncated value: `sugars lte 3` returns a row at 3.53, while a lower bound with a fraction rounds up and `gte 3.5` and `gt 3` both exclude real matches (`sugars gt 3` lost 290 of 938 `en:skyrs` rows). `fiber`, `proteins`, `salt`, and `sodium` compare as 32-bit floats; their values reach JSON widened to double, so `salt_100g: 0.10000000149012` is the index's `0.1`. The set is fitted against the whole `en:skyrs` corpus with 94 exact-count probes (live 2026-10-30). No indexed field holds the fraction and `sort_by` on a nutrient answers HTTP 422, so the index cannot be made to answer exactly, and a range inside one whole number (`sugars gt 3.9` and `lt 4`) is a walk: 0 of 150 rows passed across pages 1, 50, and 150, and only the first 10,000 rows of the band are reachable. A re-import can change the set, and upstream `main` maps all nine as `float` (openfoodfacts/search-a-licious#301); once that is deployed the widening and the set come out.
- **The values a nutrient filter matched come back from the same request.** A constrained search adds `nutriments` to `fields`, and each hit carries the index's own per-100 map (live 2026-10-13: ten keys at most, `energy-kj_100g` beside the nine filterable ones, every value a JSON number); the service keeps only the constrained keys as `indexed_nutriments`, keyed as `off_get_product` keys them (`sugars_100g`, `energy_kcal_100g`). A dotted field such as `nutriments.sugars_100g` is silently ignored, so the whole map is requested. The index's values can differ from the live record's: `dark chocolate` with sugars below 8 matched `7771711000483` on an indexed 3.85 g, which `off_get_product` reports as 17.5 g. Cost, measured on that search: +3.7 KB on a 20-row page (24.5 → 28.2 KB) and +9.1 KB on a 50-row page (33.7 → 42.8 KB), no added latency and no extra request. A search with no nutrient filter sends the summary field list unchanged.
- **Indexed facets differ.** `allergens_tags` is a keyword field and filters correctly. `additives_tags` **is not in the index** — a clause naming it is compiled to a phrase match against a missing field and returns zero hits with no error (live-probed for `en:e322`, `en:e330`, `en:e100`, all of which match hundreds of thousands of products on the tag path). The tool refuses `additives_tag` alongside a query rather than sending that clause.
- **Tag fields match exactly, with no canonicalization.** `brands_tags`, `categories_tags`, `labels_tags`, `allergens_tags`, and `countries_tags` are `keyword` fields compiled to `term` queries, so the value must be the stored ID byte for byte. `/api/v2/search` canonicalizes the same parameters (case, synonyms, plurals, a missing language prefix) and the text backend does not — live 2026-09-22: `brands_tags:"Nutella"` + `hazelnut` 0 against 135 for `nutella`, `allergens_tags:"en:peanut"` 0 against 617 for `en:peanuts`, `countries_tags:"US"` 0 against 5,180 for `en:united-states`, while the tag path counts both spellings identically. The tool therefore canonicalizes every tag value before it reaches this backend.
- **Exclusions are negated clauses, and a wrong value excludes nothing.** `traces_tags` and `ingredients_analysis_tags` are `keyword` fields like the other tag fields. A top-level `-field:"value"` compiles to `must_not`, and a second clause on one field is a second `term` under `must` — live 2026-09-22 in Mongolia (203): `allergens_tags:"en:milk"` 7 and `-allergens_tags:"en:milk"` 196; `traces_tags:"en:nuts"` 2 and its negation 201; `ingredients_analysis_tags:"en:vegan"` 4; and on `en:chocolates`, `labels_tags:"en:organic" labels_tags:"en:fair-trade"` 1,926 against 4,128 and 3,126 alone. A non-canonical exclusion is not a zero but a no-op: `-allergens_tags:"en:Milk"` → 203, every product. Inclusions degrade toward an honest empty result; an exclusion degrades toward a result that looks filtered and is not.
- **Free text matches only the fields and languages it is sent.** The deployed service runs search-a-licious v1.4.0, which joins top-level bare words into one `multi_match` over `product_name.<lang>`, `generic_name.<lang>`, `categories.<lang>`, `labels.<lang>`, and `brands` — no ingredients field. Name fields exist for 31 analyzed languages (`en fr it es de nl ar hy eu bn bg ca da et fi gl el hi hu id ga lv lt fa pt ro ru sv tr th no`), the taxonomy fields for six (`en fr it es de nl`), and only those named in `langs` are searched; with no `langs` the default is English alone (`шоколад` 359 hits, against 870 with the first 30; `confiture abricot` 805, against 10,000+). The 31 are v1.4.0's `ANALYZER_LANG_MAPPING` intersected with the Open Food Facts language list, which drops the mapping's `cz` and `pt-BR` entries: live 2026-09-23, offered 60 codes, the backend compiled name fields for these 31 and no others. A code outside the 31 drops every name field and searches `brands` only (`langs=pl` → `chocolate` 1,749). The compiled `multi_match` spans 75 fields at 31 languages, confirmed from the response's own `debug.query`.
- **Bare words are ORed.** That `multi_match` carries no `operator`, so `milk chocolate` counts products matching either word (Mongolia: `milk` 6, `chocolate` 4, `milk chocolate` 9, the union) and a word matching nothing is ignored (`xyzzyqq milk` 6). An explicit `AND`, a quoted phrase, or `+word` beside the bare words moves them into a filter on field `*` that matches nothing (all three → 0). What does AND them is a parenthesized OR group per word over the same fields, which v1.4.0 treats as a filter: `milk chocolate` plus one group per word → 1, the intersection; `xyzzyqq milk` → 0; `milk` plus its group → 6, unchanged. Uppercase `AND`/`OR`/`NOT`/`TO` are operators to its parser and lowercase ones are words. A group is analyzed like the text it holds, so a group for a joined token is split into its words and ORs them: live 2026-10-13 in Mongolia, one group for `milk<sep>xyzzyqq` matched the 6 `milk` products when `<sep>` was `-`, `/`, `+`, `&`, `,`, or `:`, and 0 when it was `'`, `’`, `.`, or `_`, which stay inside one token. So the analyzer's word is a run of letters, marks, digits, and `_`, continuing across a single `'`, `’`, or `.` between two such characters or a single `,` between two digits, and every other character separates words (a group for `1,5` matched the 324 `lait 1,5%` products that groups for `1` and `5` cut to 27); with a group per word, `milk-chocolate` counts 1 (the intersection, like `milk chocolate`) against 9 with none, and `milk-xyzzyqq` 0 against 6. A group for a token with no letter or digit matches nothing (`milk -` with a group for `-` → 0), and a group for a stop word matches only outside the fields whose analyzer drops it. Every language subfield (`product_name.<lang>`, `generic_name.<lang>`, `categories.<lang>`, `labels.<lang>`) is indexed with that language's Elasticsearch built-in analyzer (`ANALYZER_LANG_MAPPING` in v1.4.0 `app/config.py`), which removes the language's default stop words; `brands` uses the standard analyzer and removes none. Live, 2026-09-23, each group paired with a never-matching `brands` term: `product_name.fr:de`, `categories.fr:de`, `product_name.de:mit`, `generic_name.es:con`, and `product_name.pt:de` each matched 0, while `product_name.en:de` and `product_name.fr:fraise` matched 10,000+. So `chocolate with hazelnuts` counts 84 with a `with` group against 5,840 without, and `confiture de fraise` 237 with a `de` group against 3,251 without. (A group naming a single field compiles with `zero_terms_query: "all"` instead and matches everything, so probe with two fields.)
- **A query that exceeds the clause ceiling fails inside a 200.** Each word costs a clause per searched field in the `multi_match` and again in its group. Past Elasticsearch's `maxClauseCount` of 4,228, the backend answers HTTP 200 with `{"errors": [{"title": "es_api_error", "description": "…too_many_nested_clauses…"}]}` and no `hits` or `count` (live: 45 and 60 words; 24 words answered normally). The service raises any `errors` envelope as `upstream_error` rather than reading it as zero matches, and the tool bounds `query` at 24 words.
- **A POST that fails validation answers 422**, with `detail` as a list of `{type, loc, msg, input, ctx}` objects whose `input` echoes the whole request body, where a GET answers 400 with a `detail` string. An unknown `sort_by` is one such failure. The service surfaces the `msg` strings.
- **An answer flagged `timed_out: true` is not an answer.** Elasticsearch stops collecting when its own budget runs out and the backend still answers HTTP 200 with the whole success shape over a partial or empty result, so `hits`, `count`, and `is_count_exact` describe only what was collected. The service raises it as the retryable `upstream_timeout` inside the retry boundary, before the envelope check, on both `/search` and `/autocomplete`; read as an answer, an empty `options` list would cache `no_match` for a tag that exists.

### Taxonomy endpoints

`/labels.json`, `/categories.json`, `/facets/categories.json` on `world.openfoodfacts.org` return HTTP 503 for anonymous bot requests (rate-limited, requires registered session) — **not usable**. Two other surfaces are, both live-probed with this server's identifying User-Agent:

**Autocomplete (`https://search.openfoodfacts.org/autocomplete`)** — the resolver `off_browse_taxonomy` uses.

```
GET /autocomplete?q=hummus&taxonomy_names=category&size=10
{"took":1,"timed_out":false,"options":[{"id":"en:hummus","text":"Hummus","taxonomy_name":"category"}]}
```

- `taxonomy_names` accepts `category`, `label`, `allergen`, `additive`, `country`, `brand`, comma-separated. There is no `nova_group` or `nutrition_grade` taxonomy; naming one answers HTTP 200 with an empty `options` list, as does an unknown name or an empty `q`.
- `size` caps the option count and the endpoint honors any value: `size=201` answers 201, and `a` on categories answers 249 at every size from 500 to 20,000, so 249 is everything that term matched. The largest answer measured is 1,313 (`c` on categories, live 2026-10-30), and a lookup asks for 2,000. `size` is the **only** paging knob — `offset`, `from`, and `page` are accepted and silently ignored, all returning the same first page — so a `size` above a term's whole answer is the only way to read all of it.
- No match total is reported. The endpoint is a suggester, not an enumerator: it cannot list a facet and cannot say how many tags matched, though an answer shorter than `size` is the term's whole answer and its length is the count.
- An answer always carries an `options` list, empty when nothing matched. A 2xx body without one is malformed and raises the retryable `upstream_error`: `off_browse_taxonomy` then takes its offline fallback, and tag canonicalization reports `lookup_failed` and caches nothing, so the next call asks again. Read as "no suggestions", it would cache `no_match` and refuse an exclusion as unrecognized on every later call.
- Matching is against **display names**, not tag IDs, and falls back to loosely-related suggestions when nothing matches well. Ordinary words resolve cleanly (`hummus`→`en:hummus`, `tofu`→`en:tofu`, `gluten`→`en:no-gluten`), and note that category tags are frequently plural upstream: `kombucha` resolves to `en:kombuchas`, not `en:kombucha`. An E-number term answers the whole additive vocabulary (650 tags, live 2026-10-30), not the tag: `e314` returns all of them with `en:e314` 229th, so a request that stops short of the vocabulary misses a tag that exists, and the substring gate (see `taxonomy-service`) is what picks the match out.
- Upstream `took` is 1–3 ms; wall-clock round trip from a US client is ~0.5–0.8 s.

**Static dumps (`https://static.openfoodfacts.org/data/taxonomies/{categories,labels,allergens,additives,countries}.json`)** — HTTP 200, ~7.4 MB combined (4.6 MB / 1.2 MB / 10 KB / 906 KB / 722 KB). Not used: the payload would ship inside the npm package and the `.mcpb` bundle, needs build-time refresh tooling, and goes stale between releases. Entry counts, for scale against the in-process sample: categories 14,552 (sample 73), labels 3,037 (25), additives 683 (44), countries 268 (30), allergens 27 (14). They are still the authority on which IDs are canonical — every embedded ID is checked against them, pinned by `tests/fixtures/canonical-tag-ids.ts`. Entries carry parent/child hierarchy and per-language names but no product count, and neither does the autocomplete endpoint, so the tool reports no per-tag count.

---

## Tools — Full Specification

### `off_get_product`

**Description:** Fetch a packaged food product by barcode (4–40 digits: EAN-13, EAN-8, UPC, and the shorter and longer codes Open Food Facts also holds). Returns the product's name, brand, quantity, ingredients (raw text and parsed list), declared and trace allergens, additives, the vegan/vegetarian/palm-oil analysis, countries of sale, computed scores (Nutri-Score a–e, NOVA 1–4, Green-Score), nutrition per serving and per 100 g, or per 100 ml for liquids, categories, labels, packaging, origins, image URL, and data completeness. Open Food Facts is crowd-sourced — a missing field means "not yet entered by contributors," not that the attribute is absent from the actual product. Nutrition is the exception: Open Food Facts returns one preparation state per read, so a read of prepared figures (`_prepared` keys under `nutriments`) omits as-sold figures the record can still hold. Computed scores carry regional formula caveats and are indicators, not absolute rankings.

**Input schema:**

```ts
z.object({
  barcode: z.string()
    .regex(BARCODE_PATTERN, BARCODE_PATTERN_MESSAGE) // /^0*[1-9]\d{3,39}$/, shared with off_compare_products
    .describe('Product barcode, digits only: 4–40 digits after any leading zeros. The primary key for Open Food Facts — the barcode of an off_search_products row works as is. Example: "3017620422003" (Nutella FR).'),
  fields: z.array(z.enum([
    'product_name', 'brands', 'quantity', 'ingredients_text', 'ingredients',
    'allergens_tags', 'traces_tags', 'additives_tags', 'ingredients_analysis_tags',
    'nutriscore_grade', 'nova_group', 'ecoscore_grade', 'nutriments',
    'serving_size', 'serving_quantity', 'serving_quantity_unit',
    'categories_tags', 'labels_tags', 'packaging_tags', 'origins_tags',
    'countries_tags', 'image_url', 'completeness', 'data_quality_tags',
  ])).optional()
    .describe('Subset of fields to return. Omitting returns all standard fields. A field that cannot be read on its own arrives with what it depends on: nutriments brings serving_size, serving_quantity, and serving_quantity_unit, and serving_quantity and serving_quantity_unit each bring the other plus serving_size. requested_fields echoes the expanded set.'),
})
```

**Output schema:**

```ts
z.object({
  barcode: z.string().describe('The input barcode, echoed back unchanged. Open Food Facts can hold the record under another form of the same code (030000010402 resolves to the record stored as 0030000010402); that stored form is not reported.'),
  product: z.object({
    product_name: z.string().optional().describe('Product name. May be absent if not yet entered.'),
    brands: z.string().optional().describe('Brand name(s), comma-separated.'),
    quantity: z.string().optional().describe('Net quantity as printed on packaging (e.g. "400g").'),
    ingredients_text: z.string().optional().describe('Raw ingredients text from the label, in the source language.'),
    // Every level carries the same entry fields; the tree is written out three levels deep.
    ingredients: z.array(z.object({
      id: z.string().optional().describe('Canonical ingredient ID.'),
      text: z.string().describe('Ingredient name.'),
      percent_estimate: z.number().optional().describe('Estimated share of the whole product, in percent — on a sub-ingredient still a share of the whole product, not of its parent.'),
      vegan: z.string().optional().describe('"yes", "no", or "maybe".'),
      vegetarian: z.string().optional().describe('"yes", "no", or "maybe".'),
      ingredients: z.array(/* level 2: same fields, plus */ z.object({
        /* …entry fields… */
        ingredients: z.array(/* level 3: same fields, no ingredients */).optional()
          .describe('Sub-ingredients; anything nested deeper upstream is listed here too, right after the entry it belongs under.'),
      })).optional().describe('Sub-ingredients of this entry, nested up to two more levels.'),
    })).optional().describe('Parsed ingredient list, top level in label order, each entry carrying its sub-ingredients. Absent when not yet parsed by contributors.'),
    allergens_tags: z.array(z.string()).optional().describe('Canonical allergen tag IDs (e.g. "en:milk", "en:gluten"). Absence means not yet entered, not allergen-free.'),
    traces_tags: z.array(z.string()).optional().describe('Allergens the label warns the product may contain as traces. ["en:none"] declares no traces; an empty or absent array means not yet entered, not trace-free.'),
    additives_tags: z.array(z.string()).optional().describe('E-number additive tag IDs (e.g. "en:e322", "en:e322i"). Absence means not yet entered.'),
    ingredients_analysis_tags: z.array(z.string()).optional().describe('Product-level vegan, vegetarian, and palm-oil verdicts Open Food Facts computes from the parsed ingredients (e.g. "en:maybe-vegan", "en:palm-oil-free").'),
    nutriscore_grade: z.string().optional().describe('Nutri-Score grade, lowercase: "a" (highest nutritional quality) through "e", "unknown" when the nutrition data entered is not enough to compute it, or "not-applicable" for product categories the score does not cover. Absent when Open Food Facts sent none. Regional formula variants exist.'),
    nova_group: z.number().optional().describe('NOVA food processing class (1=unprocessed, 2=culinary ingredients, 3=processed, 4=ultra-processed). Absent when not enough data.'),
    ecoscore_grade: z.string().optional().describe('Green-Score (formerly Eco-Score) environmental impact grade: "a-plus" (lowest impact), then "a" through "f"; "unknown" when the data it needs is missing, or "not-applicable" for product categories the score does not cover. Highly variable — depends on packaging, origins, and transport data completeness.'),
    nutriments: z.object({
      energy_kcal_100g: z.number().optional().describe('Energy in kcal per 100 g, or per 100 ml for liquids.'),
      fat_100g: z.number().optional().describe('Total fat in grams per 100 g, or per 100 ml for liquids.'),
      saturated_fat_100g: z.number().optional().describe('Saturated fat in grams per 100 g, or per 100 ml for liquids.'),
      carbohydrates_100g: z.number().optional().describe('Total carbohydrates in grams per 100 g, or per 100 ml for liquids.'),
      sugars_100g: z.number().optional().describe('Total sugars in grams per 100 g, or per 100 ml for liquids.'),
      fiber_100g: z.number().optional().describe('Dietary fiber in grams per 100 g, or per 100 ml for liquids. Often absent.'),
      proteins_100g: z.number().optional().describe('Protein in grams per 100 g, or per 100 ml for liquids.'),
      salt_100g: z.number().optional().describe('Salt in grams per 100 g, or per 100 ml for liquids.'),
      sodium_100g: z.number().optional().describe('Sodium in grams per 100 g, or per 100 ml for liquids.'),
      energy_kcal_serving: z.number().optional().describe('Energy per serving in kcal. Absent when serving size not defined.'),
      fat_serving: z.number().optional().describe('Total fat per serving in grams.'),
      sugars_serving: z.number().optional().describe('Sugars per serving in grams.'),
      additional_100g: z.record(z.string(), z.object({ value: z.number(), unit: z.string().optional() })).optional().describe('Every other nutrient this read returned per 100 g, or per 100 ml for liquids (calcium, iron, trans_fat, added_sugars, energy in kJ, …), each with the unit Open Food Facts normalizes it to: g for most, kJ, kcal, % vol, %, mmol/l, or none for pH and glycemic index. A key ending in _prepared (energy_kcal_prepared, carbohydrates_prepared, …) is a figure for the prepared product, not the product as sold.'),
      additional_serving: z.record(z.string(), z.object({ value: z.number(), unit: z.string().optional() })).optional().describe('The same nutrients per serving, plus per-serving macros that have no named field. Percent, % vol, and unitless figures are concentrations, equal to the per-100 figure. A key ending in _prepared is a prepared-product figure that Open Food Facts scales from the per-100 figure by serving_quantity, which is often a powder\'s dry portion rather than the prepared serving, so it can describe a fraction of what is consumed.'),
    }).optional().describe('Nutrition figures normalized to underscore keys. The named fields hold as-sold figures, and keys ending in _prepared under additional_100g and additional_serving hold prepared-product figures. Open Food Facts returns one preparation state per read, so a read of prepared figures leaves every named field absent even when the record holds as-sold figures. All values may be absent when nutrition data not yet entered.'),
    serving_size: z.string().optional().describe('Serving size as printed on the label (e.g. "28 g", "1 can (12 fl oz)") — the denominator for every per-serving figure.'),
    serving_quantity: z.number().optional().describe('Serving size parsed to a number, in serving_quantity_unit.'),
    serving_quantity_unit: z.string().optional().describe('Unit of serving_quantity — "g" for most products, "ml" for liquids.'),
    categories_tags: z.array(z.string()).optional().describe('Category tag IDs in canonical form (e.g. "en:spreads"). Useful as filter values for off_search_products.'),
    labels_tags: z.array(z.string()).optional().describe('Label/certification tag IDs (e.g. "en:organic", "en:no-gluten").'),
    packaging_tags: z.array(z.string()).optional().describe('Packaging material tag IDs.'),
    origins_tags: z.array(z.string()).optional().describe('Ingredient origin tag IDs. Frequently empty.'),
    countries_tags: z.array(z.string()).optional().describe('Countries the product is sold in — the values off_search_products accepts as countries_tag. Distinct from origins_tags.'),
    image_url: z.string().optional().describe('Front image URL (CDN-hosted JPEG).'),
    completeness: z.number().optional().describe('Data completeness score from 0–1. Below 0.5 indicates many fields are missing.'),
    data_quality_tags: z.array(z.string()).optional().describe('Crowd-sourced data quality flags (e.g. "en:nutrition-completed", "en:ingredients-completed-at-least-for-one-language").'),
  }).describe('Product data. Always present on a successful call — a barcode with no contributor record raises the not_found error instead.'),
})
```

**Errors:**

```ts
errors: [
  {
    reason: 'not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'Barcode status:0 — not present in any contributor record',
    recovery: 'Try off_search_products with the product name or brand to find the correct barcode, or check that the barcode digits are correct.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Open Food Facts returns a 5xx other than 501 or 504, serves an HTML error page with a 2xx or 5xx status, answers 2xx with a malformed envelope, closes the connection before finishing its answer, or is unreachable',
    retryable: true,
    recovery: 'Retry after a brief pause. If it keeps failing, Open Food Facts is degraded — check the barcode again later.',
  },
  {
    reason: 'upstream_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'Open Food Facts did not answer within the request or retry deadline, or answered 408, 425, or 504',
    retryable: true,
    recovery: 'Retry once. If it times out again, pass a narrower fields subset so Open Food Facts assembles less per request.',
  },
  {
    reason: 'upstream_rejected',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Open Food Facts answers 4xx for something other than a missing barcode, or 501 Not Implemented',
    retryable: false,
    recovery: 'Do not retry — the request will be refused again. Read data.status and the upstream explanation in the message, then correct the request.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: "This server's own per-minute request budget is spent, or Open Food Facts answers 429",
    retryable: true,
    recovery: 'Wait the seconds given in data.retryAfter, then retry. Spread lookups out rather than issuing them in a burst.',
  },
]
```

---

### `off_search_products`

**Description:** Search Open Food Facts by full-text query, structured tag filters, numeric nutrient thresholds, or any combination. Returns a summary list with barcodes, product names, brands, Nutri-Score, NOVA group, and categories — enough for triage and selection, not full label data. Use `off_get_product` on the returned barcodes for complete details. A text query, tag filters, and nutrient constraints combine: every word of the query must match the product name, generic name, categories, labels, or brand, and every provided filter must hold; `additives_tag` is the one exception, filtering only on searches carrying neither `query` nor `nutrient_filters`. Filter values are canonical tag IDs (e.g. `en:organic`, `en:no-gluten`) — use `off_browse_taxonomy` to resolve human terms to tag IDs; a case variant, synonym, or singular is resolved to its canonical ID where Open Food Facts recognizes it, and anything else is matched exactly. `exclude_allergens` and `exclude_traces` drop products that declare an allergen or a "may contain" trace, but a product with no allergen or trace data entered passes them, so confirm a candidate with `off_get_product` before relying on it. Data is crowd-sourced; result count reflects contributed products, not all products in the market.

**Input schema:**

```ts
z.object({
  query: z.string().optional()
    .describe('Words to find. Every word must match the product name, generic name, categories, labels, or brand — ingredients and quantity are not searched; punctuation separates words — except an underscore, an apostrophe or period inside a word, and a decimal comma inside a number — so each part of "milk-chocolate" or "salt/pepper" must match, while "l\'eau" and "1,5" stay one word; stop words of English, French, Spanish, German, and Italian ("with", "the", "de", "mit", …) are not required. Names are matched in the 31 languages the text index analyzes. At most 24 words, counted as runs of letters and digits, so each part of a hyphenated or apostrophe-joined word counts. Example: "dark chocolate 70%".'),
  categories_tag: z.string().optional()
    .describe('Canonical category tag ID. Example: "en:breakfast-cereals", "en:cheeses". Use off_browse_taxonomy with facet="categories" to discover valid values.'),
  brands_tag: z.string().optional()
    .describe('Brand slug (lowercased, hyphenated). Example: "nutella", "kelloggs". A brand name is slugged the way Open Food Facts slugs it ("Ben & Jerry\'s" → "ben-jerry-s") and then matched exactly — a partial or misspelled slug matches nothing rather than falling back to a near match, so put open-ended brand wording in query instead.'),
  labels_tag: z.union([z.string(), z.array(z.string()).max(10)]).optional()
    .describe('Canonical label/certification tag ID, or an array of up to 10 that must all apply. Example: "en:organic", or ["en:organic", "en:fair-trade"] for products carrying both. Use off_browse_taxonomy with facet="labels".'),
  allergens_tag: z.string().optional()
    .describe('Canonical allergen tag ID. Example: "en:milk", "en:gluten". Use off_browse_taxonomy with facet="allergens". Selects products that declare this allergen; it cannot select allergen-free products, because a product with no allergen tags may simply have none entered yet. To leave an allergen out, use exclude_allergens.'),
  traces_tag: z.string().optional()
    .describe('Canonical allergen tag ID the label warns the product may contain as a trace ("may contain nuts"). Example: "en:nuts". Trace tags are allergen tags, so off_browse_taxonomy with facet="allergens" resolves them. Selects products carrying the warning; to leave them out, use exclude_traces.'),
  exclude_allergens: z.array(z.string()).max(14).optional()
    .describe('Allergen tag IDs a product must not declare, all applied. Example: ["en:nuts", "en:peanuts"]. Each value must be an allergen tag Open Food Facts recognizes — resolve it with off_browse_taxonomy facet="allergens" — and one it does not recognize is rejected rather than sent, because it would exclude nothing. A product with no allergen data entered passes an exclusion, so check a candidate with off_get_product before relying on it.'),
  exclude_traces: z.array(z.string()).max(14).optional()
    .describe('Allergen tag IDs a product\'s label must not warn it may contain as traces, all applied. Example: ["en:nuts"]. Values are validated like exclude_allergens. A product with no trace data entered passes, so check a candidate with off_get_product before relying on it.'),
  ingredients_analysis_tag: z.enum(INGREDIENTS_ANALYSIS_TAGS).optional() // the 12 verdicts of the ingredients_analysis taxonomy
    .describe('Vegan, vegetarian, or palm-oil verdict Open Food Facts computes from the parsed ingredients. Example: "en:vegan", "en:palm-oil-free". "en:maybe-vegan" and "en:may-contain-palm-oil" mean the ingredients could not settle it, and the "-unknown" values mean no verdict could be computed.'),
  additives_tag: z.string().optional()
    .describe('Canonical additive (E-number) tag ID. Example: "en:e322", "en:e330". Use off_browse_taxonomy with facet="additives". Available only on searches carrying neither query nor nutrient_filters — both route to a backend with no additives field, so combining them is rejected instead of silently returning nothing.'),
  nutrition_grade: z.enum(['a', 'b', 'c', 'd', 'e']).optional()
    .describe('Filter by Nutri-Score grade. "a" is highest nutritional quality, "e" is lowest. Products without a score are excluded.'),
  nova_group: z.enum(['1', '2', '3', '4']).optional()
    .describe('Filter by NOVA food processing class. 1=unprocessed/minimally processed, 4=ultra-processed. Products without a NOVA score are excluded.'),
  countries_tag: z.string().optional()
    .describe('Canonical country tag ID. Example: "en:france", "en:united-states". Filters to products sold in that country.'),
  nutrient_filters: z.array(z.object({
    nutrient: z.enum(['energy-kcal', 'fat', 'saturated-fat', 'carbohydrates', 'sugars', 'fiber', 'proteins', 'salt', 'sodium'])
      .describe('Nutrient to constrain, measured per 100 g, or per 100 ml for liquids. Energy is kilocalories; every other value is grams.'),
    operator: z.enum(['lt', 'lte', 'gt', 'gte'])
      .describe('Comparison against value: "lt" below, "lte" at or below, "gt" above, "gte" at or above.'),
    value: z.number().min(0).describe('Threshold to compare against: kilocalories for energy, grams for every other nutrient, per 100 g, or per 100 ml for liquids.'),
  })).max(18).optional()
    .describe('Numeric constraints on nutrient values per 100 g, or per 100 ml for liquids, combined as AND with each other and with every other filter. Pair two entries on the same nutrient to express a range (e.g. sugars gte 2 and sugars lte 8). Served only by the text backend, so supplying one routes the search there even without query — it then reads the lagging text index and is subject to the 10,000-result page window, and additives_tag cannot be combined with it. The text index compares energy-kcal, fat, saturated-fat, carbohydrates, sugars as whole numbers, so every returned row is checked against these constraints: a row outside them leaves the page and counts in outside_constraints, and a nutrient the index holds no value for does not count against a row. A page can come back short or empty while later pages hold matches, and a range inside one whole number (sugars gt 3.9 and lt 4) can pass few rows of the 10,000 reachable, so add query or tag filters to narrow it. Per-serving and prepared-product values are not searchable.'),
  sort_by: z.enum(['last_modified_t', 'unique_scans_n', 'created_t', 'popularity_key']).optional()
    .describe('Sort order, applied on every search. Each value orders newest or highest first: "unique_scans_n" surfaces the most-scanned products, "last_modified_t" and "created_t" the most recently updated and newest records, "popularity_key" the most popular. Omitting it leaves text searches relevance-ranked and tag-only searches in the default order.'),
  page: z.number().int().min(1).default(1)
    .describe('Page number (1-based). Use with page_size to paginate results. Pages are counted at the page_size served, which is at most 50, so repeating one larger page_size pages contiguously (page 2 at page_size 80 is results 51–100). A search by tag filters alone is served through page 10 only, so at page_size 50 it reaches the first 500 matches. A search carrying query or nutrient_filters serves only the first 10000 results, so page * page_size (as served) must stay at or below 10000. A request past either bound is rejected rather than sent; narrow the filters or change sort_by to bring other products forward.'),
  page_size: z.number().multipleOf(1).refine(Number.isInteger).min(1).default(20) // `.int()` would advertise a `maximum` of 2^53 - 1
    .describe('Results per page (default 20). One call returns at most 50: a larger value is served at 50, reported in page_size and page_size_capped, and page then counts pages of 50. Keep low for initial exploration; increase for comparison workflows.'),
})
```

At least one of `query`, `categories_tag`, `brands_tag`, `labels_tag`, `allergens_tag`, `traces_tag`, `exclude_allergens`, `exclude_traces`, `ingredients_analysis_tag`, `additives_tag`, `nutrient_filters`, `nutrition_grade`, `nova_group`, or `countries_tag` must be provided (validated in handler; a blank string or an array of blanks counts as absent).

**Output schema:**

```ts
z.object({
  total: z.number().describe('Matching products in the database for this search. Exact unless total_is_lower_bound is true, in which case at least this many match and the real figure is unknown. On a search constraining a nutrient the text index compares as a whole number (see nutrient_filters) this is its whole-number answer, which can include rows those constraints rule out.'),
  total_is_lower_bound: z.boolean().describe('True when the backend stopped counting at its ceiling and total is a floor, not the match total. Only text searches can hit it; add filters to bring the result set under the ceiling and get an exact count. On a search constraining a whole-number nutrient the floor is on the whole-number answer, not on the products that meet the constraints.'),
  page: z.number().describe('Current page number (1-based).'),
  page_size: z.number().describe('The page_size served: the one requested, or 50 when a larger one was requested. page and last_page count pages of this size.'),
  page_count: z.number().describe('Products returned on this page — page_size except on the last page, or when a match stored under a code Open Food Facts cannot serve or a row outside nutrient_filters was left off. Not the total number of pages.'),
  last_page: z.number().optional().describe('Deepest page of this result set that holds products and can be requested, at the page_size served — capped at page 10 on a search by tag filters alone and by the 10000-result window on a search the text index answers. Absent when total_is_lower_bound is true — the total it would divide is the ceiling the backend stopped counting at, so no exact last page exists — and when nothing matched at all. On a search constraining a whole-number nutrient it counts pages of the whole-number answer, so a page up to it can list few products or none.'),
  omitted: z.number().optional().describe('Matches on this page left off because Open Food Facts stores them under a code it cannot serve (not 4–40 digits once leading zeros are stripped), so off_get_product could not look them up either. Absent when none was. total still counts them.'),
  outside_constraints: z.number().optional().describe('Rows the text index returned on this page that fail nutrient_filters on their indexed values, compared at the 32-bit precision the index uses, and so left off. The index returns them because it compares some nutrients as whole numbers. Separate from omitted, whose rows are matches; a row both unservable and outside counts only in omitted. total, total_is_lower_bound, and last_page still count these rows, and each page keeps its place in the result set. Absent when none was.'),
  products: z.array(z.object({
    barcode: z.string().describe('Product barcode, 4–40 digits after any leading zeros — a code off_get_product accepts as is, so pass it there for full details. A match stored under a code Open Food Facts cannot serve is left off the page.'),
    product_name: z.string().optional().describe('Product name. May be absent for incompletely entered products.'),
    brands: z.string().optional().describe('Brand name(s).'),
    nutriscore_grade: z.string().optional().describe('Nutri-Score grade: "a" through "e", "unknown" when the nutrition data entered is not enough to compute it, or "not-applicable" for product categories the score does not cover. Absent when Open Food Facts sent none.'),
    nova_group: z.number().optional().describe('NOVA processing class (1–4). Absent when not assigned.'),
    ecoscore_grade: z.string().optional().describe('Green-Score environmental impact grade: "a-plus" (lowest impact), then "a" through "f"; "unknown" when the data it needs is missing, or "not-applicable" for product categories the score does not cover. Absent when Open Food Facts sent none.'),
    categories_tags: z.array(z.string()).optional().describe('Category tag IDs.'),
    indexed_nutriments: z.object({ /* energy_kcal_100g, fat_100g, saturated_fat_100g, carbohydrates_100g, sugars_100g, fiber_100g, proteins_100g, salt_100g, sodium_100g — each z.number().optional() */ }).optional()
      .describe('Present on every row of a search carrying nutrient_filters, and only there: the values the text index holds for the constrained nutrients, per 100 g, or per 100 ml for liquids — the values the filters were checked against. Keyed as off_get_product keys them. A nutrient the index holds no value for is left out, never zero-filled, and does not count against the row. off_get_product returns the current record, whose values can differ.'),
  })).describe('Matching products. Use barcodes with off_get_product for full label data.'),
})
```

**Errors:**

```ts
errors: [
  {
    reason: 'no_filters',
    code: JsonRpcErrorCode.ValidationError,
    when: 'No search query or filter was provided',
    recovery: 'Provide at least one of: query, categories_tag, brands_tag, labels_tag, allergens_tag, traces_tag, exclude_allergens, exclude_traces, ingredients_analysis_tag, additives_tag, nutrient_filters, nutrition_grade, nova_group, or countries_tag.',
  },
  {
    reason: 'unrecognized_exclusion',
    code: JsonRpcErrorCode.ValidationError,
    when: 'An exclude_allergens or exclude_traces value is not an allergen tag the Open Food Facts vocabulary confirms, or the vocabulary could not be reached or gave no usable answer when checking it — an unrecognized exclusion would exclude nothing',
    retryable: false, // overridden to true on a throw whose every refused value was a failed lookup
    recovery: 'Resolve each excluded value to its canonical allergen tag ID with off_browse_taxonomy (facet "allergens"), such as "en:nuts" or "en:milk", and search again.',
  },
  {
    reason: 'additives_filter_needs_tag_search',
    code: JsonRpcErrorCode.ValidationError,
    when: 'additives_tag was combined with a query or nutrient_filters, which route to a backend that cannot filter by additive',
    retryable: false,
    recovery: 'Drop query and search by tags alone to keep the additive filter, or drop additives_tag to keep the text query. Every other filter combines with a text query.',
  },
  {
    reason: 'query_too_long',
    code: JsonRpcErrorCode.ValidationError,
    when: 'query carries more than 24 words, more than the text backend can require at once',
    retryable: false,
    recovery: 'Shorten query to at most 24 distinctive words, and move brand, category, label, allergen, or country wording into the matching tag filter.',
  },
  {
    reason: 'page_out_of_range',
    code: JsonRpcErrorCode.ValidationError,
    when: 'A search by tag filters alone asks for a page past 10, or a search the text backend serves asks for page * page_size beyond its 10000-result window, counting page_size at the 50 served when a larger one was requested',
    retryable: false,
    recovery: 'Request an earlier page, or add filters so the products you need fall inside the first results rather than deep in the ranking.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Open Food Facts returns a 5xx other than 501 or 504, serves an HTML error page with a 2xx or 5xx status, reports a search-engine failure inside an HTTP 200, answers 2xx with a malformed envelope, closes the connection before finishing its answer, or is unreachable',
    retryable: true,
    recovery: 'Retry after a brief pause — the Open Food Facts service may be shedding load. If it keeps failing, narrow the filters or try again later.',
  },
  {
    reason: 'upstream_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'Open Food Facts did not answer within the request or retry deadline, flagged its text search as timed out, or answered 408, 425, or 504',
    retryable: true,
    recovery: 'Retry once with a smaller page_size. Broad unfiltered searches are the slowest for Open Food Facts to assemble.',
  },
  {
    reason: 'upstream_rejected',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Open Food Facts answers 4xx or 501 Not Implemented — the request as formed will be refused again',
    retryable: false,
    recovery: 'Do not retry. Read data.status and the upstream explanation in the message, then correct the filter values.',
  },
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: "This server's own per-minute search budget is spent, or Open Food Facts answers 429",
    retryable: true,
    recovery: 'Wait the seconds given in data.retryAfter, then retry. Searches carry a much smaller budget than product lookups.',
  },
]
```

The `page_out_of_range` and `additives_filter_needs_tag_search` checks run in the handler before the service is called, mirroring the `no_filters` pre-check. Both key on which backend will answer, not on `query` alone, so a nutrient-filtered search with no free text is subject to the text path's checks. `page_out_of_range` applies each backend's own bound: past page 10 on the tag path, whatever the `page_size`, and `page * page_size` beyond 10000 on the text path; its recovery hint names the deepest page that can be requested. Every page computation uses the `page_size` served — `min(page_size, 50)` — so `{query: "chocolate", page: 201, page_size: 80}` is refused with `max_page: 200` and a hint at `page_size` 50, while page 200 is sent at 50; the served size is echoed as `page_size` and, when it differs from the one requested, disclosed in the `page_size_capped` enrichment with the next page to request when one holds matches and can be requested. `additives_filter_needs_tag_search` applies to the text path only — `/api/v2/search` does filter on `additives_tags`. `query_too_long` runs there too, counting runs of letters and digits in `query`.

A page whose every row left, for an unservable code or a failed nutrient constraint, reads "lists no products", never "No products found" or "past the end of this result set", because the search is matching rows. One function, `emptyPageNextStep`, writes its ending for the notice and for `format()`: a next page exists, so request it and, with rows outside the constraints, add `query` or tag filters; the page is the last the 10,000-result window serves, so say no further page can be requested and, with rows outside the constraints and matches beyond, add `query` or tag filters to bring other rows into the window; or it is the last page of a counted answer, so say only that no further page can be requested.
On the text path the handler then runs every string tag filter value (`categories_tag`, `brands_tag`, each `labels_tag` value, `allergens_tag`, `traces_tag`, `countries_tag`) through the taxonomy service's `canonicalizeTag` before the service quotes it (see "Text search" and the taxonomy service); `traces_tag` resolves against the allergen vocabulary, since trace tags are allergen tags. On both paths it runs every `exclude_allergens` and `exclude_traces` value through `canonicalizeTag` against the allergen vocabulary and refuses the search with `unrecognized_exclusion`, before any search request, unless each value resolves to `vocabulary`; the refused values travel in `data.unrecognized`. A response carrying an exclusion gets the `exclusion_coverage` enrichment on both surfaces: products with no allergen or trace data entered pass an exclusion, so check a candidate with `off_get_product`. The tag path sends an allergen or trace inclusion and its exclusions as one parameter (`allergens_tags=en:nuts,-en:milk`) and several labels as one comma-joined `labels_tags`; the text path sends one clause per value, exclusions as `-field:"value"` after the inclusions. A text-path search that matches nothing gets a notice naming the causes that apply to it: a query word no product carries (when `query` was sent), the field name of a `field:value`-shaped word, which had to match as a word too (`brands: nutella` → 0, live 2026-09-23), exact tag matching with each value no vocabulary confirmed and what was sent for it (when tag filters were sent), and index lag. The index-lag advice names what still reaches the live database: the same tag filters without `query`, tag filters in place of a `query`-only search, or — when `nutrient_filters` is set — nothing, since only the text index serves those. The freshness disclosure on every text-path response uses the same three-way wording. A tag-only empty result keeps its original notice.

---

### `off_compare_products`

**Description:** Side-by-side nutrition and scoring comparison for 2–10 products per call by barcode; a repeated barcode is compared once, so two identical barcodes yield one row, and barcodes past the 10th distinct one are listed in `unprocessed` rather than fetched. Returns a normalized table of energy (kcal), fat, saturated fat, carbohydrates, sugars, salt, protein, and fiber per 100 g, or per 100 ml for liquids, plus Nutri-Score, NOVA group, and Green-Score. Open Food Facts returns one preparation state per read, so figures for the prepared product arrive in a `prepared` object on the row, with the same columns and basis, and never fill an as-sold field. Designed for "which of these three cereals is healthiest?" or "compare these pasta brands" workflows. Missing nutrition data for any product is preserved as absent — comparisons are not imputed. Scores carry regional caveats.

**Input schema:**

```ts
z.object({
  barcodes: z.array(
    z.string().regex(BARCODE_PATTERN, BARCODE_PATTERN_MESSAGE).describe('Product barcode, digits only: 4–40 digits after any leading zeros.')
  ).min(2).max(100)
    .describe('Barcodes to compare, returned as one row each in input order; a repeated barcode is compared once, so two identical barcodes yield one row. One call compares at most 10 distinct barcodes: up to 100 are accepted, and those past the 10th distinct one are returned in unprocessed without being fetched. Example: ["3017620422003", "7622210100146"].'),
})
```

**Output schema:**

```ts
z.object({
  products: z.array(z.object({
    barcode: z.string().describe('Barcode, echoed exactly as provided in input.'),
    product_name: z.string().optional().describe('Product name.'),
    brands: z.string().optional().describe('Brand name(s).'),
    found: z.boolean().describe('False if the barcode has no contributor record.'),
    nutriscore_grade: z.string().optional().describe('Nutri-Score grade: "a" through "e", "unknown", or "not-applicable".'),
    nova_group: z.number().optional().describe('NOVA class (1–4).'),
    ecoscore_grade: z.string().optional().describe('Green-Score grade: "a-plus", then "a" through "f"; "unknown" or "not-applicable".'),
    // One NUTRITION_COLUMNS list generates the as-sold fields and the same fields under `prepared`, so the two shapes cannot drift.
    energy_kcal_100g: z.number().optional().describe('Energy in kcal per 100 g, or per 100 ml for liquids, as sold. Absent when not entered, or when this read returned only prepared figures (see prepared).'),
    fat_100g: z.number().optional().describe('Total fat in grams per 100 g, or per 100 ml for liquids, as sold. Absent when not entered, or when this read returned only prepared figures (see prepared).'),
    saturated_fat_100g: z.number().optional().describe('Saturated fat in grams per 100 g, or per 100 ml for liquids, as sold. Same absence wording.'),
    carbohydrates_100g: z.number().optional().describe('Total carbohydrates in grams per 100 g, or per 100 ml for liquids, as sold. Same absence wording.'),
    sugars_100g: z.number().optional().describe('Total sugars in grams per 100 g, or per 100 ml for liquids, as sold. Same absence wording.'),
    salt_100g: z.number().optional().describe('Salt in grams per 100 g, or per 100 ml for liquids, as sold. Same absence wording.'),
    proteins_100g: z.number().optional().describe('Protein in grams per 100 g, or per 100 ml for liquids, as sold. Same absence wording.'),
    fiber_100g: z.number().optional().describe('Dietary fiber in grams per 100 g, or per 100 ml for liquids, as sold. Same absence wording.'),
    prepared: z.object({ /* the same eight columns, each described as "… as prepared. Absent when this read returned no such figure." */ }).optional()
      .describe("Figures for the prepared product, on the same columns and basis as the as-sold fields, read from Open Food Facts' *_prepared_100g keys and never derived or substituted for an as-sold figure. Open Food Facts returns one preparation state per read, so as-sold fields absent beside this object mean this read returned none, not that the record holds none. Absent when the read carried none of these figures."),
    completeness: z.number().optional().describe('Data completeness 0–1. Low values mean many fields are missing.'),
  })).describe('Comparison rows in input order — one per distinct barcode whose fetch completed, whether or not a record exists. Barcodes whose fetch failed have no row here; they appear in failed. Barcodes past the cap appear in unprocessed.'),
  succeeded: z.number().describe('Number of barcodes that resolved to a found product.'),
  not_found: z.array(z.string()).describe('Barcodes Open Food Facts answered for, confirming no contributor record exists. Not an error — the product may exist but not yet be entered. Never used for a fetch that failed.'),
  failed: z.array(z.object({
    barcode: z.string().describe('Barcode whose fetch failed, as provided in input.'),
    reason: z.string().describe('Declared failure reason — one of upstream_error, upstream_timeout, upstream_rejected, rate_limited.'),
    error: z.string().describe('What went wrong for this barcode and what to do about it.'),
  })).optional().describe('Barcodes whose fetch failed, with the per-barcode reason. Absent when every fetch completed. A barcode listed here is unknown, not absent from Open Food Facts.'),
  unprocessed: z.array(z.string()).optional().describe('Distinct barcodes past the 10th, in input order — never fetched. Absent when the batch held 10 or fewer distinct barcodes. Compare them in another call, or look a single one up with off_get_product.'),
})
```

No DataCanvas spill: a batch caps at 10 products, which is too small to warrant a canvas/SQL layer.

**Over-cap batches are served, not refused.** A batch of 11–100 barcodes has one obvious reading, so it compares the first 10 distinct barcodes and lists the rest in `unprocessed` (and a `format()` line, "Not compared (over the 10-barcode cap)") instead of failing with `invalid_arguments`; 100 stays the hard ceiling. The four buckets are disjoint: `products` holds completed fetches (`not_found` names the 404 / `status: 0` ones among them), `failed` errored or malformed fetches, `unprocessed` the barcodes never fetched. A repeated barcode takes one slot and one fetch. The header count and the zero-found summary cover the compared barcodes only. Raising the cap instead was rejected: one compare would spend more of the default 15 product requests/min and grow the response.

**Errors:** Declares `upstream_error`, `upstream_timeout`, `upstream_rejected`, and `rate_limited` — the same four reasons the service raises, with recovery text scoped to a batch ("retry the barcodes listed in failed"). None of them aborts the call: a batch is not all-or-nothing, so each is surfaced per barcode in `failed[]` while the rows that resolved are kept. Confirmed-missing barcodes stay in `not_found`, which claims the opposite of a failed fetch.

---

### `off_browse_taxonomy`

**Description:** Resolve a human term to the canonical Open Food Facts tag ID that `off_search_products` filters on. Covers categories, labels/certifications, allergens, additives, countries, NOVA groups, and Nutri-Score grades. A search term resolves against the live Open Food Facts taxonomy; omitting it lists only the in-process sample. Most tag IDs use the `en:` prefix (`en:organic`, `en:no-gluten`, `en:crustaceans`); NOVA groups return bare `1`–`4` and Nutri-Score grades bare `a`–`e`.

**Input schema:**

```ts
z.object({
  facet: z.enum([
    'categories', 'labels', 'allergens', 'additives', 'countries',
    'nova_groups', 'nutrition_grades',
  ]).describe('Which vocabulary to resolve against. "categories" covers food categories (en:cheeses, en:breakfast-cereals). "labels" covers certifications (en:organic, en:fair-trade). "allergens" covers declared allergens (en:milk, en:gluten). "additives" covers E-numbers (en:e322). "countries" covers country-of-sale tags (en:france). "nova_groups" and "nutrition_grades" are closed vocabularies answered offline and returned complete; the other five resolve against the live taxonomy.'),
  search: z.string().optional()
    .describe('Term to resolve. Matched case-insensitively as a substring of the tag ID, the display name, or a common synonym of either, against both the live vocabulary and the offline sample. A single word works best ("hummus", not "hummus dip"). Omit only to see the offline sample.'),
  limit: z.number().multipleOf(1).refine(Number.isInteger).min(1).default(20) // `.int()` would advertise a `maximum` of 2^53 - 1
    .describe('Maximum entries to return (default 20). One call returns at most 200: a larger value returns the first 200 and, when more matched, says how many did. There is no offset or page input: Open Food Facts offers no cursor for this lookup, so narrow the search term rather than paging.'),
})
```

**Output schema:**

```ts
z.object({
  facet: z.string().describe('The facet that was queried.'),
  tags: z.array(z.object({
    id: z.string().describe('Canonical tag ID (e.g. "en:organic"; bare "1"–"4" for NOVA groups, bare "a"–"e" for Nutri-Score grades). Pass through to off_search_products unchanged.'),
    name: z.string().describe('Human-readable display name (e.g. "Organic").'),
  })).describe('Matching tag entries.'),
  total_in_facet: z.number().optional().describe('Total entries in this facet. Present only for nova_groups and nutrition_grades; the live facets have no knowable total.'),
})

enrichment: {
  notice: z.string().optional().describe('Caveat about how the answer was produced — offline sample, a live vocabulary that could not be reached or gave no usable answer, no match, or the limit cutting matches (naming the match count and the next call: a larger limit while one would list more, otherwise a narrower term, plus the limit asked for when above 200).'),
  truncated: z.boolean().optional(),
  shown: z.number().optional(),
  cap: z.number().optional(),
}
```

**Errors:** No domain failures. Invalid `facet` is caught by Zod enum validation, and a live-resolution failure degrades to the offline sample with a `notice` naming the cause instead of aborting the call — see the design decision below for why no reason is declared.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `openfoodfacts-service` | Open Food Facts API v2 (`world.openfoodfacts.org`) | `off_get_product`, `off_search_products`, `off_compare_products` |
| `taxonomy-service` | Live taxonomy autocomplete (via `openfoodfacts-service`) merged with an embedded sample | `off_browse_taxonomy`, `off_search_products` (tag canonicalization) |

### `openfoodfacts-service`

- **Base URL:** `https://world.openfoodfacts.org`
- **User-Agent:** `openfoodfacts-mcp-server/<version> (casey@caseyjhand.com)` — sent on every request. Required by OFF terms.
- **Field selection:** every call includes `fields=` to scope the product object.
- **Methods:**
  - `getProduct(barcode, fields)` → raw product object or `null` (status:0)
  - `searchProducts(params)` → `{count, count_is_exact, page, page_count, page_size, products[], dropped, outside_constraints?}` (the `SearchResult` type — one shape from both backends; `outside_constraints` exists only on the text path). Every row carries a `code` matching `BARCODE_PATTERN`, the rule the product tools enforce: a row without one is dropped on either path before `page_count` is set, so `page_count` always equals the rows returned and every `barcode` passes `off_get_product`'s schema. No row without any `code` has been observed, but the text index holds 664 codes Product Opener refuses (`00000###`, `0000000000###`); the drop is logged with the codes.
  - The text path builds its Lucene `q` as tag clauses (one per value), exclusion clauses (`-field:"value"`), nutrient range clauses, one required group per query word, then the lowercased, escaped query as bare words, and sends it with `langs` set to all 31 analyzed languages (`TEXT_SEARCH_LANGS`). The group fields are derived from that constant, never listed by hand. Words are extracted with the analyzer's grammar (`ANALYZER_WORD`: runs of letters, marks, digits, and `_`, joined across a single `'`, `’`, or `.`, or a `,` between two digits; every other character separates), so `milk-chocolate` is two words. A word gets a group when the query has more than one word, and the word holds a letter or digit and is not a stop word of a language holding at least 1% of named products (`STOP_WORD_LANGS`: English, French, Spanish, German, Italian — 949 words, selected from `ANALYZER_STOP_WORDS`, the Lucene 9.2.0 default lists for all 31 analyzers).
- **Rate limiting:** token bucket per endpoint class — product reads (15/min), search (10/min), taxonomy resolution (10/min). A refusal is local, so it raises `rate_limited` (`RateLimited`) naming this server, not Open Food Facts, and carries the seconds until a slot frees.
- **Transport:** `fetchWithTimeout` at every call site, so HTTP status → error code, canonical `status`/`body` on the framework's fetch error (the public contract republishes a selected subset of it — see the error-contract allowlist below), `Retry-After` honoring, and distinct `Timeout` classification all come from the framework rather than a hand-rolled status ladder.
- **Retry:** `withRetry` on the full fetch+parse pipeline. Up to 4 attempts, 500ms base delay on product and autocomplete reads and 1s on searches (upstream is stateless; 5xx is transient). Classification runs *inside* the retry boundary so the mapped reason decides: a 5xx other than 501, timeouts, and 429 retry; a 4xx or a 501 fails immediately.
- **Deadline:** every read passes `deadlineMs` to `withRetry` through one wrapper, `retryRead`, and threads the attempt's `signal` into its request, so an expiry cuts off the request in flight. A product or search read has 35 s across all attempts and backoffs (`READ_RETRY_DEADLINE_MS`) and an autocomplete lookup 20 s (`TAXONOMY_RETRY_DEADLINE_MS`). A search runs its tag lookups in parallel and then one search read, so one caller's longest chain is 20 s + 35 s = 55 s, and a batch comparison is one 35 s ladder wide, not N long. Against an upstream that never answers, a product or search read makes 3 attempts and a lookup 2 (15 s per attempt plus backoff), so "up to 4 attempts" is a ceiling the deadline usually cuts short. Expiry leaves the service as `upstream_timeout`, carrying the call's own fields (`barcode`, or `page`/`page_size`, or `taxonomy_name`/`term`) and `operation`; the framework's `retry_deadline_exceeded` is declared by no tool and never reaches a caller. A read whose last finished attempt answered 429 reports that 429 as `rate_limited` with its `retryAfter` instead, because it is a limit to wait out, not an outage; an attempt the expiry cut off finished nothing and leaves the 429 standing, and any attempt that did finish replaces it, a 15 s timeout included. A caller abort is ranked above the deadline and ends as cancelled.
- **Parse failure:** HTML error pages (503 during high load) detected by content-type check, and any 2xx body that does not parse as JSON, → `upstream_error` (`ServiceUnavailable`, not `SerializationError` or a reason-less `ValidationError`).
- **Malformed envelope:** a 2xx JSON body that fails its read's rule — product: `status: 0`, or `status: 1` with a `product` object; tag search: a `products` list and a numeric `count`; text search: `hits`, a numeric `count`, and a boolean `is_count_exact`; autocomplete: an `options` list — raises `upstream_error` inside the retry boundary, like an HTML page served with a 200. No `?? 0` / `?? []` default turns it into an answer. A text search or autocomplete body flagged `timed_out: true` raises `upstream_timeout` first, however complete its shape.
- **Stalled body:** `fetchWithTimeout` returns at the response headers and hands its deadline to the body, so a body that stalls fails inside `parseJsonBody`, outside the contract mapping around the fetch. `parseJsonBody` maps it there, so it leaves as the same typed failure rather than a raw framework timeout.
- **Missing barcode:** `status:0` in a 200 response, or an HTTP 404, → `null` from the service; the handler calls `ctx.fail('not_found', ...)`. `null` is reserved for this case alone.

### `taxonomy-service`

Owns resolution policy for `off_browse_taxonomy`; transport lives in `openfoodfacts-service.suggestTaxonomy()`, which carries the same `fetchWithTimeout` / `withRetry` / contract-error plumbing as the product and search paths plus its own rate-limit tier.

- **Facet routing.** `categories`, `labels`, `allergens`, `additives`, `countries` map to the upstream `category`/`label`/`allergen`/`additive`/`country` taxonomies. `nova_groups` and `nutrition_grades` have no upstream counterpart and are closed vocabularies, so they are answered entirely from the embedded map and are the only facets that report `total_in_facet`.
- **Embedded sample.** A static `facet → [{id, name, aliases?}]` map: 73 categories, 25 labels, 14 allergens, 44 additives, 30 countries, 4 NOVA groups, 5 Nutri-Score grades. For the five live facets this is a small slice (categories is 73 against 14,552 upstream), used for unfiltered listing, offline fallback, and as the first-ranked half of a merge. Every ID is a canonical key in the static dumps, because a synonym or singular form is not rejected anywhere downstream — it filters nothing and reports the zero as exact. A human term with no canonical key of its own (shellfish, cookies, gluten free) rides on `aliases`, which widen what a search resolves and never reach the caller; a term with no canonical key at all (mixed salads, chocolate bars, the per-nut allergens) is left out rather than approximated, and the live merge still resolves it.
- **With a search term.** The embedded matches and the live suggestions are merged, embedded first, deduplicated by tag ID, then capped at `limit`, which the tool holds to 200 and which has no input maximum: a larger `limit` returns the first 200. Whenever the limit cuts matches, the truncation guidance names the match count and a call that can bring more forward: a larger `limit` below the cap (or a narrower term), and at the cap — a `limit` of 200 included — only a narrower term, plus the limit asked for when it was above 200. Upstream is asked for 2,000 suggestions, not `limit + 1`, so the lookup reads the term's whole answer and the match count is exact below that size (see "The live suggestion pool is requested in full").
- **The exact-term tag ranks first among the live suggestions.** After the substring gate, live entries whose ID is `en:<slug>`, `en:<slug>s`, or `en:<slug>es` (`<slug>` = the lowercased term, whitespace runs hyphenated) are stable-sorted ahead of the rest, which keep upstream order. Only an equal ID moves, so `en:red-lentils` is never promoted for "lentil"; the embedded block keeps its own order ahead of the live one.
- **Live suggestions are held to the facet's documented substring rule.** Upstream matches display names and degrades to loosely-related suggestions rather than returning nothing, so unfiltered pass-through would answer `e330` with E-numbers that do not contain it. Applying the same `id`/`name` substring predicate used for the embedded half drops that noise; measured across ordinary terms (cheese, kombucha, olive oil, organic, tofu, yoghurt, …) it drops nothing else.
- **Without a search term.** The embedded sample only, plus a `notice` saying so. The upstream endpoint suggests against a term and answers an empty list for an empty query — it cannot enumerate a facet.
- **On failure.** The throw is absorbed and the offline matches returned with a `notice` naming the cause. A caller cancellation is not absorbed: with `ctx.signal` aborted the error is rethrown and the call ends as cancelled (`RequestCancelled`), never as the offline fallback. `openWorldHint: true`.
- **Tag-value canonicalization (`canonicalizeTag(facet, value, ctx)`).** Used by `off_search_products` for every tag value on the text path, where tag fields match exactly, and for every exclusion value on both paths. Returns `{value, resolution: 'vocabulary'}` when a tag with that ID is confirmed, or `{value, resolution: 'normalized', reason}` otherwise, with `reason` `no_vocabulary` (brands), `no_match`, or `lookup_failed`. Brands are slugged the way Product Opener's `get_string_id_for_lang` slugs text under its default normalization (NFC, lowercase, `.` and punctuation/whitespace to `-`, dash runs collapsed and trimmed; accents kept). A taxonomy value is checked against the offline sample, then the live autocomplete (taxonomy budget, the term's whole answer), accepting only an entry whose ID equals the normalized value or whose name equals the value with its `xx:` prefix stripped, compared case-insensitively with hyphens read as spaces — the embedded `aliases` are not used, since they are wider than upstream synonyms — or, from the live pool only, an entry whose ID is the value's plural: the value plus `s`, or plus `es` after `ss`, `x`, `z`, `ch`, `sh`, or `o`. The autocomplete answers `nut` with `{id: en:nuts, text: Nuts}`, so the name rule alone cannot confirm `en:nut`, which Product Opener canonicalizes to `en:nuts` (and it counts `en:chocolate` exactly as `en:chocolates`, 32,689, live 2026-09-23). `es` is narrower than `rankExactTagFirst`'s ranking rule because after any other stem it resolves a truncated word: `ric` would become `en:rices` and `chees` `en:cheeses`, while Product Opener counts `en:ric` as 0. Unmatched values are normalized the way Product Opener stores an unknown tag: the language prefix (English when absent) plus the slug of the rest (`US` → `en:us`). It throws only on a caller cancellation, which ends the call rather than returning `lookup_failed`; settled answers are cached per facet and value in process, up to 500 entries, oldest evicted first, and a failed or cancelled lookup is not cached. Concurrent calls for the same facet and value share the lookup in flight, which leaves the map once it settles, so a failure is still retried by the next call. A shared lookup rejects only when the caller that started it was cancelled, so a joined caller whose own signal is live starts over instead of inheriting that cancellation: the first one back starts the replacement lookup and the others join it. A caller that must never send an unconfirmed value, such as an exclusion (which a wrong value turns into a silent no-op), refuses anything but `vocabulary`.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OFF_BASE_URL` | No | Base URL override. Default: `https://world.openfoodfacts.org`. Useful for testing against a mock server. |
| `OFF_RATE_LIMIT_PRODUCT` | No | Product read rate limit (requests/min). Default: `15`, the per-IP ceiling Open Food Facts documents for product reads. |
| `OFF_RATE_LIMIT_SEARCH` | No | Search rate limit (requests/min). Default: `10`. |
| `OFF_RATE_LIMIT_TAXONOMY` | No | Taxonomy resolution rate limit (requests/min). Default: `10`. Spent by `off_browse_taxonomy`, by tag-value canonicalization on text searches, and by the exclusion check on every search. A spent budget falls back to the offline sample, or to the normalized tag value, rather than failing — except that an exclusion it could not check is refused as retryable. |

No API key. The identifying User-Agent is derived in the service layer from `package.json` name/version and a static contact address.

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with `OFF_BASE_URL`, `OFF_RATE_LIMIT_PRODUCT`, `OFF_RATE_LIMIT_SEARCH`, `OFF_RATE_LIMIT_TAXONOMY`.
2. **OpenFoodFacts service** — `src/services/openfoodfacts/openfoodfacts-service.ts` with `getProduct()`, `searchProducts()`, and `suggestTaxonomy()`. Validate against real API. Implement before the taxonomy service, which depends on it for transport.
3. **Taxonomy service** — `src/services/taxonomy/taxonomy-service.ts` + the embedded sample. Merge, fallback, and facet-routing policy over `suggestTaxonomy()`.
4. **`off_get_product`** — primary tool, single-product lookup with field normalization.
5. **`off_search_products`** — search with composed tag filters.
6. **`off_compare_products`** — parallel fetch + normalization + per-barcode failure reporting.
7. **`off_browse_taxonomy`** — thin wrapper over taxonomy service.
8. **`createApp()` wiring** — register all tools, set `instructions`.

Each step is independently testable via `bun run devcheck` + `bun run rebuild`.

---

## Design Decisions

**No resources.** Product data is mutable (crowd-sourced) and not suitable for stable URI caching. Tool-only clients are the primary target.

**No prompts.** The domain is data retrieval; no recurring analysis frameworks benefit from a prompt template.

**Taxonomy resolution is live, with the embedded sample kept as a merge partner rather than replaced.** The `world.openfoodfacts.org` taxonomy endpoints do return 503 to anonymous bots, but `search.openfoodfacts.org/autocomplete` does not, and the embedded-only design it justified had made the tool's advertised purpose unreachable: the sample holds 73 categories against 14,552 upstream, so ordinary foods (hummus, tofu, kombucha, pizzas) answered "no matching tags" for tags that filter thousands of products. Live resolution over a static mirror because a mirror puts ~7.4 MB into the npm package and `.mcpb` bundle, needs build-time refresh tooling, and goes stale between releases, while a suggestion costs about a kilobyte and always reflects the current vocabulary.

The sample stays because live-only would regress two cases it answers correctly. The upstream suggester matches display names and returns loosely-related suggestions instead of nothing, so an E-number term comes back as the whole additive vocabulary while the sample resolves the E-numbers it holds exactly; and an Open Food Facts outage would turn a working `en:organic` lookup into a failure. Merging embedded-first, deduplicated, keeps both, and holding live suggestions to the same substring rule the facet documents drops the suggester's noise without dropping real matches.

**A failed live lookup degrades with a notice instead of raising a declared failure.** No `errors[]` contract is declared for this tool, because none of its reasons could fire: the throw from `suggestTaxonomy()` is absorbed in the taxonomy service and reported through `enrichment.notice`. Declaring a reason the handler cannot return advertises a state callers would branch on and never reach — the same argument that removed the `found` flag from `off_get_product`. The degradation is not silent: the notice reaches `structuredContent` and `content[]` alike, names the cause, and says the offline sample may not cover a tag that exists upstream, so an empty result is never read as an authoritative "no such tag". This is the specific failure the tool had, and returning nothing with a raised error would reintroduce it for the callers the sample can still serve.

**`total_in_facet` is reported only for the closed vocabularies.** The autocomplete endpoint reports no match total and cannot be enumerated, so the live facets have no knowable total; the field is omitted rather than filled with the sample size. Returning `79` for categories is what presented a local sample as the size of the Open Food Facts category vocabulary.

**No offset or page input.** The endpoint's `size` caps the option count and is its only paging knob — `offset`, `from`, and `page` are accepted and silently ignored, all returning the same first page. An offset input would therefore have to be a lie or a client-side slice of one fetch; a cursor over one lookup's suggestions would add state to save a call that a larger `limit` already covers. Narrowing the term is the honest instruction, and the lookup reads the term's whole answer so genuine truncation is still disclosed.

**The cap is 200 and `limit` has no input maximum.** A `limit` above the cap has one reading, so it is served at 200 and the guidance names the limit asked for when matches were cut, instead of an `invalid_arguments` rejection. The schema uses `multipleOf(1)` where `.int()` would advertise a `maximum` of 2^53 - 1 for a value the handler clamps. 200 tags cost 13.9 KB of `structuredContent` and 12.1 KB of text (`frozen`, 209 matches), against 7.0 KB and 6.1 KB at 100 and 17.7 KB and 16.5 KB for a 50-row `pasta` search. Reporting "at least N" whenever a lookup returns a full pool was rejected: `e330` fills a 200-suggestion pool with entries that all fail the substring gate, so a one-tag answer would read as truncated. Reading the whole answer makes the count exact instead, below the 2,000 a lookup asks for.

**The live suggestion pool is requested in full, and the exact-term tag ranked first.** Upstream orders a term's suggestions compounds-first: `lentil` answers eight `en:lentil-*` tags with `en:lentils` last, `chickpea` puts `en:chickpeas` fourth of four, and `cheese` puts `en:cheeses` 37th of 69. An E-number term answers the whole 650-tag additive vocabulary, where `en:e314` is 229th. A request sized to `limit + 1` misses the plain tag at small limits, and one sized to 200 misses `en:e314`, so reordering alone cannot reach it; asking for 2,000, above the largest answer measured (1,313, `c` on categories), reads everything a term matches in one request that costs at most about 119 KB, so the substring gate, the ranking, and the match count all see the complete answer. An answer that reached 2,000 would be cut there with nothing flagging it, and its count would be a floor; none has come close. The ranking is an exact equality on the hyphenated slug and its `s`/`es` plurals, stable and live-portion only, so no entry is added or dropped, a compound sharing a word keeps its place, and the hand-maintained embedded block is untouched. Terms whose plain tag upstream never suggests (`berry`, `tomato`) are unaffected.

**NOVA group and Nutri-Score tag IDs are bare, not `en:`-prefixed.** `off_browse_taxonomy` emitted `en:1`–`en:4` while `off_search_products.nova_group` accepts `"1"`–`"4"`, so passing the advertised ID back was a hard validation failure. Fixing it at the source rather than relaxing the enum: upstream tolerance is not uniform, and normalizing on input would have to land before `buildTextSearchQuery`. On the tag backend both forms return the same 136,019 matches, but on the text backend `nova_group:en:1` is live-verified answering zero hits flagged `is_count_exact: true` — a confident false "no products" rather than an error. Bare digits also match the bare grade letters `nutrition_grades` already emitted.

**`off_compare_products` keeps partial results in output, not errors.** When 3 of 5 barcodes resolve and 2 are not found, the caller gets a comparison table for the 3 found products plus a `not_found` list. Throwing when any product is missing would break "compare this grocery basket" workflows where some products are regional or recent.

**A barcode whose fetch failed goes in `failed`, never in `not_found`.** The two are opposite claims: `not_found` asserts Open Food Facts answered and holds no record, while a failed fetch means the barcode was never checked. Classification is by how the promise settled, never by error text — the service resolves `null` only for a genuine not-found, so any rejection is a failure. Failures stay per-barcode instead of aborting the call, so a mixed batch keeps the rows that resolved; the framework reads a non-empty `failed` array as partial success and records it on the tool span.

**Failures leave the service already carrying their contract `reason` and recovery hint.** Handlers stay pure — the service passes `{ reason, ...ctx.recoveryFor(reason) }` on every throw, so `data.reason` and `data.recovery.hint` reach both client surfaces with no handler-side try/catch. Reasons resolve from the error's `JsonRpcErrorCode` and the framework's `data.retryable` flag, never from message text.

**The HTTP status decides retryability; the body only shapes the message.** Every upstream 4xx except 429 (`rate_limited`) and 408/425 (`upstream_timeout`), and any status the framework flags `data.retryable: false` — today only 501 Not Implemented — is `upstream_rejected`: non-retryable and sent once. A request the upstream refuses will be refused again, so retrying only aims more traffic at a backend already saying no. Every other 5xx, and an HTML page served with a 2xx, stays `upstream_error` and is retried. `data.status` disambiguates which status it was, and the upstream's own `detail` is surfaced in the message. A rendered error page is summarized according to the reason the status already settled: served with a refusal it reads as a refusal, and only with a retryable failure is it attributed to load. Product Opener answers every anonymous search page past 10 with a 401 and a rendered page, and blaming load there told the caller to wait out a refusal that cannot change. The 501 needs the flag read explicitly: it keeps the transient `ServiceUnavailable` code, and the published-field allowlist dropped the flag, so it was re-flagged retryable and sent four times.

**`content[]` is escaped per context; `structuredContent` stays raw.** Open Food Facts is contributor-edited, so every product name, ingredient string, brand, grade, and tag ID rendered into the text surface sits outside this server's trust boundary — and the metacharacters are already in real records (`lécithines [SOJA)` on barcode 3017620422003). Interpolated straight into Markdown, such a value changes the structure of the document rather than being displayed in it, so text the server presents as data can present itself as instructions to the reading agent. `src/utils/markdown.ts` holds one escaper per context — inline value, table cell, code fence, inline code span, bare URL — and every formatter routes untrusted values through the one for the site they land on. Line-break handling is the load-bearing part everywhere, since it is the only character that opens a new block, which is why it applies even to values that look harmless. Raw values belong in `structuredContent` and are never escaped there: a parity test asserts the escaped rendering and the raw structured value together. `ctx.enrich` notices are out of scope in the opposite direction — an enrichment string reaches both surfaces as the same value, so escaping one would break that parity, and the fix there is to keep untrusted text out of notice prose.

**Budgets count upstream requests, not logical operations.** Each limiter charges a slot per attempt from inside the retry boundary, so the configured per-minute number is the number of requests Open Food Facts can see from this server. Charging once per call let the framework's four-attempt default fund four requests per slot — a ten-barcode comparison against a failing upstream sent 40 product reads against a published ceiling of 15/min, and the limiter recorded ten. When a budget runs out mid-sequence the retries stop and the caller gets the declared `rate_limited` failure with a `retryAfter` computed from the oldest timestamp still in the window. That refusal stays `retryable: true` on the wire — waiting and retrying is the right move for the caller — so it opts out of `withRetry` by type instead: it is its own error class, and the retry predicate fails fast on it. Reading `data.retryable` there instead would have flipped the flag the caller depends on, and leaving it in the transient set would have made the handler sleep the whole window and try again rather than returning.

**The public error contract publishes an allowlist, never the fetch error's whole `data`.** `error.data` carries `status`, `retryAfter` when the upstream sent one, `retryAttempts`, `operation`, the per-call context of the tool that failed (`barcode`, or `page`/`page_size`, or `taxonomy_name`/`term`), plus the `reason`, `retryable`, and `recovery.hint` added at the throw site. The framework's fetch helper attaches more than that — it captures the response body as both `body` and its legacy alias `responseBody`, and adds `statusCode`, `statusText`, and `errorSource` — and spreading it put two copies of a rendered Open Food Facts error page into `structuredContent.error.data`, more than half the bytes of the failure, while `content[]` carried one summary sentence. Selecting here keeps the two surfaces saying the same thing and keeps provider markup off both: the upstream's own explanation still reaches the message, as a fixed summary when the body is a rendered page and otherwise as the body's own text — search-a-licious's `detail` string, or a snippet of anything else — each bounded to 200 characters with its markup stripped.

**Each backend's page bound is enforced before the request.** `search.openfoodfacts.org` rejects `page * page_size > 10000` with an HTTP 422, and `/api/v2/search` answers any page past 10 from a client that is not logged in with an HTTP 401 and a rendered page, whatever the `page_size` and however few products match (see "Search"). Checking both in the handler turns a request that cannot succeed into a `page_out_of_range` failure naming the highest reachable page, with no upstream call. `last_page`, the exhausted-page notice, and the truncation guidance all use the same reachable bound — `min(10, page count)` on the tag path — so none of them names a page the pre-check would refuse. Logging in to lift the tag-path bound was not considered: the server is keyless by design, and the text path already serves deep result sets.

**An over-cap `page_size` is served at 50, not refused.** A `page_size` above 50 has one obvious reading, so it is sent as 50 and every page computation — the bounds, `last_page`, the truncation `cap` — runs at that served size, echoed as `page_size`. `page` counts pages of 50, so repeating one over-cap value pages contiguously (page 2 at `page_size` 80 is results 51–100), and the `page_size_capped` enrichment names the next page and the results it holds whenever that page can be requested. `page_size` has no upper bound, because a larger value has the same one reading at any size; the schema uses `multipleOf(1)` where `.int()` would advertise a `maximum` of 2^53 - 1 for a value the handler clamps. `multipleOf` tolerates float noise, so `20.000000000000004` passes it, and a `Number.isInteger` refine, invisible to tools/list, refuses that; it runs only where `multipleOf` passed, so a plain fraction reports one issue. The result window still bounds `page`, since no backend serves past result 10,000. Predicate inputs — `labels_tag`, the exclusion lists, `nutrient_filters`, `query` words, a page past the reachable depth — keep rejecting, because dropping entries would change the query rather than shorten the answer.

**`truncated` means matches exist beyond this page.** It is set when the total is a lower bound or when `page × page_size` (served) is below the total, keyed on the page's offset rather than on the rows it delivered: a row left off for an unservable code shortens a page without leaving anything beyond it, and a page whose every row was left off is still truncated when matches lie beyond it. Comparing the total with the current page's row count instead would mark the final page of every multi-page result as truncated. A genuine final page carries no truncation fields and no paging notice, like a single-page result, and `last_page` equals `page` there. The last reachable page of a bound-cut result set keeps its truncation and its "that is as deep as … paginates" guidance.

**`format()` renders what `structuredContent` carries — no formatter-local slicing.** The text surface previously capped parsed ingredients at 20 and category tags at 5 (3 in search), rendered completeness only as a rounded percentage, and dropped `vegan`/`vegetarian` when the value was `maybe`. None of it reduced the payload — the full arrays and exact scalars were already in `structuredContent` — so the caps bought nothing and left text-only clients (Claude Desktop) with a quietly incomplete record that no follow-up call could complete, since re-calling returns the same trimmed text. Two of the losses were silent misreadings rather than omissions: `79%` is indistinguishable from an exact `0.79` when the value is `0.7875`, and `maybe` is a real OFF verdict ("depends on sourcing") that rendered identically to no verdict at all. These are capped-*list* cases in name only; the honest fix is full parity, and the `fields` input already exists for callers who want a smaller response. Outline-on-overflow does not apply — it addresses one document-shaped record too large to inline, and a product record is neither document-shaped nor near the budget: the heaviest parsed-ingredient tree in a 616-product survey (5000159541374, 120 top-level and 179 total entries) measures 14.0 KB of `structuredContent` and 9.2 KB of text for the name and ingredients alone — roughly 18 KB and 13 KB with the rest of a full record — against a 24 KB outline budget, and the `fields` input already gives a caller who wants less a way to ask for it.

**Sub-ingredients nest under their parent, written out three levels deep.** Open Food Facts nests them in `ingredients[].ingredients` (wheat flour under "cereal", palm oil under "vegetable oils", milk under cheddar under a seasoning), and a diet or allergy check often needs exactly those. Each entry carries its children as an `ingredients` array of the same entry shape, rendered indented under the parent in `content[]`; the top-level list keeps its length, order, and values. A nested `percent_estimate` is a share of the whole product, not of its parent — a parent's estimate equals the sum of its children's in 1,027 of 1,060 surveyed parents — so the schema says so, and a flattened list would double-count. The schema is inlined rather than self-referential, because a recursive Zod schema overflows the definition linter's stack and emits `$defs`/`$ref`; three levels is the deepest nesting observed (616 products: 228 flat, 321 two levels, 67 three, none deeper). Upstream permits more, so an entry below the third level is listed at the third, directly after its ancestor, in pre-order — only parentage is flattened and nothing is dropped. A flat list with parent references was rejected: it changes the meaning of the existing array, needs index paths because IDs repeat within a tree (`en:salt` under two cheeses), and runs 20–45% larger.

**A clipped hit count is labelled, never rounded off or hidden.** The text backend stops counting at 10,000 and reports `is_count_exact: false` when it does; `total_is_lower_bound` carries that straight through to the caller, and `format()` renders the figure as `10000+`. The alternative — presenting the ceiling as an exact total — makes every broad query report the same fabricated number, and made the pagination guidance derive a precise page count from it. Detection reads the upstream flag rather than comparing the count against `TEXT_SEARCH_RESULT_WINDOW`: the page-depth limit and the hit-counting limit are separate limits that sit at the same number today, and only the backend knows when it stopped counting.

**Nutrient constraints are a structured input served by one backend, not a raw query string.** The caller supplies `{ nutrient, operator, value }` from two closed enums and a validated number, so no caller-authored text can enter the Lucene `q` as syntax and the supported set cannot drift past the nine fields verified indexed. A separate nutrient-search tool would have duplicated the search, pagination, and result schemas. Client-side filtering as the means of serving a constraint was rejected, because it produces false totals and incomplete pages, since it can only inspect the rows already returned; the nutrient clause stays the filter, and a row check refines it for the five whole-number nutrients (see the next two decisions). Because only the text backend applies the comparisons, a request carrying one routes there with or without `query` and inherits that path's properties — the result window, the counting ceiling, the lagging index, and the absent additives facet — which is why the `additives_filter_needs_tag_search` and `page_out_of_range` pre-checks key on the routing decision rather than on `query`. Sending `/api/v2/search` its own documented comparison parameters and keeping tag-only routing was rejected on measurement: they are ignored, so the tool would return unfiltered rows under an unfiltered total while appearing to filter.

**A nutrient-filtered row shows the index's value, not the live one.** The filter runs against the lagging index, so a row can match on a value the current record no longer holds (`7771711000483`: 3.85 g indexed, 17.5 g live). Each row carries `indexed_nutriments` — the constrained keys only, keyed as `off_get_product` keys them — and the `text_index_snapshot` note echoes the constraints and names that field, so the caller can see why a product matched and compare it against `off_get_product`. Fetching every candidate's live record was rejected: it spends the product budget per row and returns values that cannot explain a snapshot match. Replacing the indexed values with live ones would hide the mismatch and leave totals counting products the live values exclude. Unconstrained nutrients stay off the rows; the summary row is for triage.

**Only `gt` and `gte` on the five whole-number nutrients are widened, to `[floor(value) TO *]`.** The index drops matches there that a caller's bound includes (`sugars gt 3` loses the rows at 3.x), and widening to the floor loses none. `lt` and `lte` already return a superset, and the other four nutrients compare exactly, so those clauses are sent as written. The widening admits rows at the floor that the bound excludes, which the row check removes. The widening comes out when upstream maps all nine as `float`.

**Every returned row is checked against every constraint, on its own `indexed_nutriments`, and a failing row leaves the page.** The check runs after the row map, so the values a caller sees and the values checked are the same object. It covers all nine nutrients, not only the five, since a re-import can change which are whole numbers, and compares with `Math.fround` on both sides, the index's 32-bit precision: as doubles, a stored `0.10000000149012` exceeds a caller's `0.1` (`salt lte 0.1` is 577 on the index, 569 as doubles, 577 with `fround`). A nutrient the index holds no value for is no evidence against a row, so it stays. This refines the decision against client-side filtering rather than reversing it: the server-side clause stays the filter, so the result set and its paging are the index's, and the check removes only rows the index admitted by comparing whole numbers. The cost is disclosed, not hidden: a page can be short or empty while later pages hold matches, and `total` counts rows the check removes. Nothing upstream can do this instead, since no indexed field holds the fraction and `sort_by` on a nutrient answers HTTP 422.

**Rows that fail a constraint count in `outside_constraints`, apart from `omitted`.** `omitted` rows are matches stored under a code no lookup can serve, and `omittedSentence` says so; rows outside the constraints are not matches, so folding them in would make that sentence false. A row that is both unservable and failing counts once, in `omitted` (the barcode filter runs first). `outside_constraints` is optional on the service's `SearchResult` because the tag path has none, and the handler branches on its presence.

**`total`, `total_is_lower_bound`, `last_page`, and paging stay the backend's whole-number answer, and the page says so.** Each page keeps its place in the result set, and `moreBeyond` stays keyed on the page's offset, so no page overlaps or skips rows. Recomputing a total from the checked rows would need every page read. Instead, `format()` labels the total "whole-number matches" and replaces the clipped-count "At least N products match" caveat with one that names the whole-number answer, since "N total products" and "at least N" both claim a product count the page cannot back, and `text_index_snapshot` names the whole-number nutrients the constraints fall on. `format()` has no input, so it reads this from the output: a page with `outside_constraints`, or one with a row whose `indexed_nutriments`, which hold constrained nutrients only, name a whole-number nutrient. That reaches clean pages without a new output field, so adjacent pages of one search read alike, and a constraint only on one of the four float nutrients keeps the plain wording. A page past the end has no rows to read, so its `format()` line keeps "N total products"; the handler has the input, so the notice beside that line says "N whole-number matches exist".

**Every read is bounded by one total deadline, and an expiry is `upstream_timeout`.** The 15 s per-attempt timeout bounds one attempt only, so against a hung upstream a product read would hold for about 64 s and a search for about 67 s, past the 60 s default request timeout of MCP SDK clients, and the caller would give up before a typed failure reached it. A search that canonicalizes a tag runs a lookup ladder and then the search ladder, doubling that. The budgets are 35 s for a product or search read and 20 s for a lookup, so one caller's longest chain (parallel lookups, then one search) settles at 55 s, under 60 s. Expiry is mapped to the declared `upstream_timeout` in one wrapper rather than declaring the framework's `retry_deadline_exceeded` on four tools, and a read whose last finished attempt answered 429 reports the 429, because a limit is waited out and an outage is not. A caller abort stays a cancellation.

**A `timed_out` answer is refused, not read.** Elasticsearch returns it as an HTTP 200 with a complete envelope, so no shape check catches it, and a page or count read from it is wrong. It is raised inside the retry boundary as the retryable `upstream_timeout`, like an `errors` envelope.

**A connection dropped mid-body is the retryable `upstream_error`, mapped in `parseJsonBody`.** The framework classifies a stalled or cancelled body as an `McpError`, so anything else a body read rejects with is the connection closing. The mapping sits at the two body reads rather than at `toContractError`'s first line, because that line also passes programming errors from building a request, which must not read as a dropped connection. The runtime's text stays in `cause`, since it names options a caller cannot use.

**An empty page inside a positive result set is an exhausted page, not a zero-match search.** Both backends answer a page past the end with an ordinary HTTP 200 — the text path with `hits: []` beside a positive `count`, the tag path with `products: []` and `page_count: 0` — so nothing upstream separates the two, and keying the empty branch on `products.length` alone reported "no products found" beside a positive total and told the caller to broaden filters that were matching products. The handler and `format()` both split on `total === 0`: zero keeps the broaden / check-tag-IDs guidance, a positive total names the requested page and the deepest page that holds results. That bound is the same `reachablePages` the truncation branch computes, so it can never name a page the `page_out_of_range` pre-check would refuse, and it is withheld entirely when the total is a lower bound, since dividing a count the backend stopped incrementing would present its ceiling as a measurement. `last_page` exists in `output` because `format()` sees only the fields it is handed and cannot otherwise name a page number that agrees with `structuredContent`.

**Text-search freshness is disclosed at runtime and dated only here.** The text index lags the live database, so the same filters answer differently depending on whether free text is present. The disclosure rides an `enrichment` field, which reaches `structuredContent` and the `content[]` trailer on every response the text backend answered, and the empty-result notice adds that an empty text result does not settle whether a matching product has been contributed — naming what does reach one: `off_get_product` by barcode, and the same tag filters without `query` (or tag filters in place of a `query`-only search). Neither text advises dropping `query` when none was sent: a nutrient-only search stays on the text index whatever is dropped, so both say that instead. No runtime string carries an index date: `/health` publishes no index timestamp and deriving one would cost an extra search request per call, so a literal date would be a claim nothing re-checks. `total_is_lower_bound` keeps its one meaning from the clipped-count note above and is not overloaded to signal staleness. Routing text queries to `/cgi/search.pl` was rejected: it returns current data but answered the majority of probes with HTML error pages, refused deep pages with HTTP 401, and took 5–22 s per query — trading a disclosed lag for an undisclosed failure rate.

**`sort_by` applies on both paths, in each backend's spelling.** search-a-licious sorts descending on a `-` prefix and ascending on the bare field name, while `/api/v2/search` reads the bare value as descending. The service adds the prefix on the text path so one enum value means one thing to the caller, and every value stays "newest or highest first". Ascending order is not exposed: all four fields answer "most" or "newest" questions, so the reverse would double the enum to serve no asked-for question.

**Text search sends all 31 analyzed languages, by POST.** With no `langs` the backend searches English subfields only, so a product named only in French, Russian, or Portuguese was invisible to `query` (`шоколад` 359 hits against 870, `bolacha` 222 at six languages against 660 at 30, `confiture abricot` 805 against 10,000+). The 31 are every language the index has name fields for, read off the fields the backend compiles rather than off its configuration, which also lists `cz` and `pt-BR` and compiles neither; Norwegian reaches the fewest products of them (`melkesjokolade` 42 without `no`, 52 with it). The six taxonomy languages alone lose more than half the Russian hits, and a caller input was rejected because callers rarely know which language a record was entered in and a code outside the 31 silently narrows the search to `brands`. Cost, measured 2026-09-23 at the first 30 languages over a kept-alive connection: a one-word search goes from about 210 ms to 250–300 ms (Elasticsearch time 17 ms → 50–95 ms), and a full 50-row page of tool output grows 12–32% because more of the matched products carry long names and category lists (`chocolate` 29.5 → 33.0 KB, `milk` 22.7 → 30.0 KB). Ranking changes: of the top 50 for `chocolate` and `milk`, 9 and 8 stay. For `chocolate` the English-only top five were one brand's keyword-stuffed names ("Chocolate chocolate chocolate, …") and the 30-language top five are plain chocolate bars, one named in French; for `milk` the top five shift from drinking milks toward milk-chocolate and flavored products. The per-word groups repeat all 75 fields for every word, so a 12-word query was already a 23.6 KB URL at 30 languages, which the host answers with HTTP 414; `POST /search` takes the same `SearchParameters` as a JSON body and returned the same hits for the same `q`, `sort_by`, `page`, `page_size`, and `fields`, and succeeded at 12, 16, and 24 words.

**Every word of a text query is required, through one group per word.** The deployed backend ORs bare words, so `total` counted products matching any word and an unmatched word was dropped silently. Its own operators cannot fix that — `AND`, a phrase, or `+word` beside bare words compiles to a filter on field `*` that matches nothing — so each word also gets a parenthesized OR group over exactly the fields the relevance match searches, which the backend applies as a filter, and the bare words stay for ranking. The query is lowercased so a caller's `AND`/`OR`/`NOT` reads as a word, and escaped so it cannot inject a field clause. A word is what the analyzer calls one, not a whitespace token: the analyzer splits a group's text the same way it splits the bare words, so a group built from `milk-chocolate` ORed its parts and left both optional (Mongolia: 9 products against 1 for `milk chocolate`), and the same held for `/`, `+`, `&`, `,`, and `:`. The words are extracted with the grammar probed live — runs of letters, marks, digits, and `_`, joined across a single `'`, `’`, or `.`, or a `,` between two digits — so `l'eau`, `u.s.`, `a_b`, and `1,5` stay one word each; the bare query is unchanged. A query of fewer than two such words forms no group, because the relevance match already requires its word (`minimum_should_match: 1` beside filters, and a should-only query needs one match anyway) — `milk` selects the same 6 products either way, and the group cost about 200 ms. A word with no letter or digit forms no group (its group matches nothing), and neither does a stop word of a language most products are named in: each analyzer drops its own stop words from its fields, so a group requiring one keeps only products carrying it in some other language's field. The Elasticsearch built-in `_<lang>_` lists for all 31 analyzers are copied from Lucene 9.2.0 (the Lucene Elasticsearch 8.3.3 ships) into `analyzer-stop-words.ts` (5,928 words), but only the lists of languages holding at least 1% of named products are exempt: English, French, Spanish, German, and Italian, 949 words. A small language's list would otherwise make a word optional for every caller — Estonian alone lists 1,470 words, including `just`, `need`, `see`, and `too`, for 0.04% of named products. Share of the 3,400,847 products carrying a name that carry one in each language, live 2026-09-23:

| Language | Share | Language | Share | Language | Share |
|:--|--:|:--|--:|:--|--:|
| en | 38.29% | nl | 0.83% | da | 0.12% |
| fr | 37.91% | pt | 0.75% | hu, lt | 0.09% |
| es | 9.77% | ru | 0.38% | id, tr | 0.06% |
| de | 8.13% | sv | 0.26% | el, ca, no | 0.05% |
| it | 7.13% | ro | 0.20% | et | 0.04% |
| | | fi | 0.18% | lv | 0.02% |
| | | bg | 0.16% | fa | 0.01% |
| | | ar, th | 0.15%, 0.14% | gl, hi, eu, bn, ga, hy | < 0.01% |

The 1% cut falls in the distribution's one sharp gap (Italian to Dutch is an 8.5× drop). Before and after, live 2026-09-23: `confiture de fraise` 237 → 3,251, `galletas con chocolate` 142 → 10,000+, `schokolade mit nüssen` 7 → 1,215, `doce de leite` 179 → 354 (Portuguese `de` is also a French and Spanish stop word); `chocolate with hazelnuts` stays 5,840 and `milk chocolate` in Mongolia stays 1. The exemption applies whatever language the caller meant, because a word required when it should not be fails toward zero while an optional one only falls back to ranking. The cost is that a content word that is a stop word in one of the five no longer filters: `soy` and `sea` (Spanish), `die`, `hat`, and `war` (German). `soy milk` counts 10,000+ against 3,322 before, with the same top five soy milks, since the word still ranks. Stop words of the other 26 languages still form groups, so a query in one of them that carries its own function words can undercount. `query` is capped at 24 words because each word costs 150 clauses at 31 languages and the backend's ceiling is 4,228 (a 24-word query answered normally at 31, live 2026-09-23), past which it answers an error inside an HTTP 200 — which the service now raises instead of reading as zero matches.

**Tag inclusions are canonicalized on the text path only, best-effort.** The text backend's tag fields are exact-match keywords while `/api/v2/search` canonicalizes the same values, so a value that worked on a tag-only search returned an exact zero once `query` or `nutrient_filters` was added. Each value is resolved before it is quoted, through the taxonomy service (see its canonicalization entry): confirmed IDs only, never a prefix or partial match, so `brands_tag: "nutell"` still matches nothing (#13). The tag path is left untouched because Product Opener already canonicalizes there. A failed lookup or spent taxonomy budget sends the value normalized instead of failing the search, and the empty-result notice names each value nothing confirmed. Loud rejection of unconfirmed values was rejected for inclusions: it needs the same lookup, turns an outage of the vocabulary into an outage of search, and would refuse values the index does hold under an ID the autocomplete cannot find by name. Exclusions take the opposite trade (see the exclusion entry), because an unconfirmed exclusion fails silently toward a wrong answer rather than toward an empty one.

**Exclusions are sent only as confirmed allergen tags, on both paths.** `exclude_allergens` and `exclude_traces` exist because both backends negate a tag filter natively (`-c` in a Product Opener `*_tags` value, a top-level `-field:"value"` clause on the text path), and screening candidates one `off_get_product` call at a time costs a product read per row and yields no total. A negated value that matches no stored tag does not empty the result the way a wrong inclusion does; it excludes nothing, and the response looks filtered. So each exclusion value runs through `canonicalizeTag` against the allergen vocabulary on both paths, including the tag path, where Product Opener would otherwise canonicalize a typo to a tag nothing carries, and anything short of `vocabulary` is refused as `unrecognized_exclusion` before a search is sent. A singular resolves to its plural tag where the live pool holds one (`en:nut` → `en:nuts`), so the refusal falls on values neither vocabulary confirms. A refusal caused only by an unreachable vocabulary is flagged retryable; the 14 major allergens resolve from the offline sample without a lookup. Trace tags are allergen tags upstream (`traces_tags=en:nut` counts the same 12,450 chocolates as `en:nuts`), so traces share the allergen vocabulary.

**An exclusion's coverage gap is disclosed on the response, not only in the description.** Open Food Facts cannot tell a product free of an allergen from one whose allergens were never entered, and an exclusion passes both: of the 26,084 chocolates without nuts on the tag path, 15,936 have no allergen data at all. Every response carrying an exclusion gets an `exclusion_coverage` enrichment on both surfaces naming the gap and the `off_get_product` fields to check, because a caveat that lives only in an input description is easy to miss at the point the results are used.

**`labels_tag` takes a string or an array; the verdict filter is a closed enum.** A single-string `labels_tag` sends exactly the request it always did; an array ANDs its values, as one comma-joined `labels_tags` on the tag path and one clause per value on the text path. OR within a facet is not offered. `ingredients_analysis_tag` is a `z.enum` of the 12 verdicts in the Open Food Facts `ingredients_analysis` taxonomy, so it needs no canonicalization and a caller cannot send a value that filters nothing.

**The barcode pattern is Product Opener's, restricted to digits.** `off_get_product` and `off_compare_products` share `BARCODE_PATTERN` (`^0*[1-9]\d{3,39}$`), which is `is_valid_code` in `lib/ProductOpener/Products.pm` — strip leading zeros, then 4–40 digits — for digit-only input. The earlier `^\d{8,14}$` rejected codes Open Food Facts serves and `off_search_products` returns (`6035215`, stored as `06035215`; `1212`; 15- and 22-digit codes), and accepted 8–14-digit strings with fewer than four significant digits, which upstream answers "no code or invalid code". Non-digits stay rejected although upstream strips them: `3017620422003a` resolves to Nutella there, so accepting it would let a typo return a different product.

**A search row without a servable barcode is dropped in the service.** The row type declares `code: string`, replacing two `as unknown as` casts that let a missing code reach the output as `barcode: ""`, which `off_get_product` rejects. The same holds for a code that fails `BARCODE_PATTERN`: the text index carries 657 eight-character `00000###` codes and 7 thirteen-character `0000000000###` ones, which Product Opener answers "no code or invalid code" (live 2026-09-23), so a row keyed by one has nothing to chain on either. Dropping it before `page_count` is set keeps `page_count` equal to the rows returned on both paths, and every emitted `barcode` passes `off_get_product`'s schema; carrying the row with `barcode` optional was rejected because it widens the advertised output schema and still leaves a row no follow-up call can reach. `total` still counts the dropped rows — it is the upstream's match count, and no local count of refusable codes exists to subtract.

**A redeploy of search-a-licious `main` would change these semantics.** The live service runs v1.4.0. Upstream `main` ANDs bare words by default and its config (openfoodfacts/search-a-licious#301) replaces the `*_tags` keyword fields with taxonomy fields (`categories`, `labels`, `brands`, `countries`, `allergens`), so after such a redeploy the tag clauses this server builds would name fields that no longer exist — the silent-zero signature — and the per-word groups would become redundant. A text search that starts answering exact zeros for tag values known to match is the sign to re-probe `debug.query` and rebuild the clause shapes.

**`additives_tag` is refused alongside a text query instead of being sent.** The search-a-licious index has no `additives_tags` field, so the clause compiles to a phrase match on a missing field and returns zero hits — an answer indistinguishable from "no product contains this additive". A declared `additives_filter_needs_tag_search` failure naming the working combination beats a silent empty result. Every other filter is indexed on both backends and combines with a query freely.

**`off_browse_taxonomy` is a separate tool, not bundled into `off_search_products`.** Tag vocabulary lookup is an independent need — it's used to build search filters, not as part of executing a search. Keeping it separate maintains clean tool boundaries and allows tag exploration without triggering a search call.

**Field selection via input enum, not open string array.** Restricts to the fields the server actually handles and normalizes, preventing callers from requesting raw OFF fields that the output schema doesn't cover. The enum doubles as documentation of what's available.

**NOVA group as `number` in output, `enum(['1','2','3','4'])` in search input.** Zod coercion converts the input string to the parameter value. The raw nutriments object also embeds `nova-group` as a number, but the typed `nova_group` field is its only home in the output — see the nutrient-coverage note below for why it is excluded from the open nutrient maps.

**Nutriments normalized in the output schema.** The raw OFF nutriments object uses hyphenated keys (`energy-kcal_100g`) that are not valid TypeScript identifiers. Normalization maps to underscore form (`energy_kcal_100g`) and takes the `_100g` and `_serving` variants; `_value` and `_modifier` are dropped as redundant with `_100g`.

**Per-100 figures are stated as per 100 g, or per 100 ml for liquids.** OFF writes a liquid's per-100 ml figures to the same `_100g` keys without density conversion (Coca-Cola Zero Sugar, 0049000042566: `sodium_100g` 0.00986 is 0.035 g per 354.882 ml serving). No field states a row's basis reliably — on 2026-10-13, `nutrition_data_per` read `100ml` on 70 of 121 sampled liquids and `100g` on 50, this drink included, and serving and package units disagreed on 31 of 240 — so every description and heading names both bases (`Nutrition per 100 g / 100 ml`) and no row asserts one. The `*_100g` field names stay: renaming them would break the contract for no gain. Passing `nutrition_data_per` through was rejected because its `100g` on a liquid restates the defect.

**Nutrient coverage is open, not an allowlist.** The macros keep named schema fields, and every other nutrient a read returns lands in `additional_100g` / `additional_serving` keyed by normalized name, `_prepared` keys included. A fixed map silently narrowed a nutrition database to a dozen macronutrients — calcium, iron, cholesterol, trans fat, added sugars, and the vitamins were all present upstream and dropped, so questions the record could answer came back empty with no field subset or follow-up call that would retrieve them. Two constraints make the open map safe:

- **Exclusion is per exact raw key, not per base nutrient**, derived from the named map so the two cannot drift. The named set is asymmetric across suffixes — `saturated-fat_100g` is named while `saturated-fat_serving` is not — so excluding by base name would drop per-serving macros from both surfaces. Each nutrient therefore appears in exactly one place.
- **The unit comes from the nutrient, never from `_unit`.** On legacy records `{nutrient}_unit` is the unit the contributor entered (current records carry the normalized unit there), while `_100g` and `_serving` are normalized, so calcium entered as 120 mg reads `calcium_100g` 0.12 beside `calcium_unit` "mg" — 0.12 g. And no `_prepared` key has a `_unit` sibling at all. The unit therefore mirrors OFF's normalizer: kJ for `energy`, `energy-kj`, and `energy-from-fat` (OFF files the last under g, but its conversion stores kJ), kcal for `energy-kcal`, % vol for `alcohol`, % for `fruits-*`, `collagen-*`, `cocoa`, `whole-grain`, `moisture`, and the `crude-*` constituents, mmol/l for `water-hardness`, none for `ph` and `glycemic-index`, g for everything else, with a `_prepared` key taking its base nutrient's unit. Values are passed through unscaled; converting value and unit together was rejected as a second source of error on a figure already in a known unit. Percent, % vol, and unitless figures are concentrations, so their `_serving` equals `_100g`.

`nova-group` is excluded outright: OFF stores the NOVA processing class inside the nutriments map with an empty unit, and it is already surfaced as the typed `nova_group` field, so passing it through would report the same classification twice.

**Per-serving figures always carry their denominator.** `serving_size` (as printed), `serving_quantity` (parsed), and `serving_quantity_unit` are requested and returned alongside the `_serving` nutriments; `format()` restates the serving size on the per-serving heading and says outright when OFF has recorded none. Per-serving numbers without a serving size cannot be compared across products or converted to or from the per-100 figures. `serving_quantity` is coerced rather than type-tested — OFF returns it as a JSON number for most products and a numeric string for others, so a `typeof === 'number'` guard would drop it for a whole class of records. Its unit is not assumed to be grams: it is millilitres for liquids.

**The serving fields expand as a closed group.** A quantity reads only with its unit and a unit says nothing without its quantity, so `serving_quantity` brings `serving_quantity_unit` and `serving_size`, `serving_quantity_unit` brings `serving_quantity` and `serving_size`, and `nutriments` brings all three. `serving_size` alone expands to nothing: the line it renders claims nothing about a parsed quantity it was not asked for. The expansion is not transitive, so each entry lists its whole set.

**A read speaks for itself about preparation state, and says nothing about the record.** Open Food Facts returns one preparation state of the nutrition per read: a read of prepared figures carries `_prepared` keys and none of the as-sold ones. In 7 of 7 sampled prepared records the as-sold figures were stored, so a statement that the record lacks them is false. Every string that would say so says what the read returned instead: `off_get_product` prints "This read returned only prepared figures" and the descriptions of `nutriments`, `additional_100g`, and the as-sold compare fields scope their absence wording to the read. Reading the stored as-sold figures is tracked in #73. The server `instructions` carry the same exception to "a missing one means not yet recorded".

**`off_get_product` keeps prepared figures in the open maps and splits them only when rendering.** The structured values are unchanged: `normalizeNutriments` still files every `_prepared` key under `additional_100g` / `additional_serving`, so "nutrient coverage is open" holds and callers parsing `structuredContent` see no change. `format()` partitions those maps by the `_prepared` suffix, so the as-sold sections keep their keys and order and the prepared figures print under "as prepared" headings, per 100 g / 100 ml and per serving. The per-serving as-sold heading prints only when an as-sold per-serving figure exists, so a prepared-only read has no empty heading. The text prints the structured key (`energy_kcal_prepared`) rather than remapping it to a macro label, which keeps the two surfaces matched. The per-serving prepared section carries a note that Open Food Facts scales those figures from the per-100 figures by `serving_quantity`, often a powder's dry portion rather than the prepared serving, because that figure misleads a reader who sees only the text. The footer reads "Other missing fields" on a prepared-only read, since the as-sold fields are missing because of the read.

**`off_compare_products` reads prepared figures into a `prepared` object, from `*_prepared_100g` keys only.** One `NUTRITION_COLUMNS` list drives the row type, the reads, the output schema, and both tables, so the as-sold and prepared shapes cannot drift, and a ninth column such as carbohydrates is one entry. Nothing is derived: a prepared kcal is never computed from kJ, and a prepared figure never fills an as-sold field. `prepared` exists only when a read carries a column figure, so `_prepared_serving` alone, or kJ alone, yields no object. A mixed read, with both states, is 0 of 21 sampled live records.

**Table membership: as sold lists rows with no `prepared` or with any as-sold figure, and as prepared lists rows with `prepared`.** A row carrying both appears in both, or `content[]` would drop figures `structuredContent` carries. A prepared-only row leaves the as-sold table, since its N/A cells would sit under a footer reading "not yet entered" for a record that holds those figures on a state this read did not return; a line names such rows and says the read returned no as-sold figures. Each table is omitted when it has no rows. The footer is scoped, not removed, when an as-prepared table prints: `"N/A" outside the "as prepared" table = not yet entered`, since Scores keeps its N/A even where no as-sold table prints; with no as-prepared table it is unchanged. The as-prepared table has its own N/A wording ("no prepared figure in this read"). A read whose prepared keys miss all eight columns has no `prepared` object, so it stays in the as-sold table under "not yet entered"; no sampled record does this, and fixing it needs a new output signal.

---

## Known Limitations

- **Crowd-sourced completeness varies widely by region.** French and Western European products are well-covered; products from other regions may be sparse or missing entirely.
- **The live taxonomy cannot be listed or paged.** `search.openfoodfacts.org/autocomplete` suggests against a term: it reports no match total, has no offset or cursor, and answers an empty list for an empty query. So `off_browse_taxonomy` reports no `total_in_facet` for the five live facets, exposes no offset input, and answers an unfiltered call from the in-process sample rather than the full vocabulary. The `world.openfoodfacts.org` taxonomy endpoints (`/labels.json`, `/categories.json`) remain 503 for anonymous bots and are unused.
- **E-number terms answer the whole additive vocabulary.** The autocomplete suggester matches display names, so `e322`, `e100`, and `e330` each return all 650 additive tags (live 2026-10-30) rather than the one named. The lookup reads that whole answer and the substring gate picks the tag out (`e314` resolves to `en:e314`, 229th upstream); the chemical name (`lecithin`, `aspartame`, `curcumin`) resolves too.
- **A nutrient-filtered search can return short or empty pages.** The text index compares five nutrients as whole numbers, so rows outside a constraint leave each page and count in `outside_constraints`, while `total` and `last_page` describe the index's whole-number answer. A range inside one whole number (`sugars gt 3.9` and `lt 4`) can pass few of the 10,000 reachable rows; `query` or tag filters narrow it. A page past the end, or one whose rows hold no numeric value for the constrained nutrient, gives `format()` nothing to read, so its line keeps "N total products"; the `text_index_snapshot` note still says how to read `total`.
- **A search that joined a cancelled lookup can pass 60 s.** When the first caller of a shared taxonomy lookup cancels, a joiner restarts it with a fresh 20 s deadline, so against a hung upstream the joiner settles at the cancel time plus 55 s, 75 s at worst for one cancel (#75).
- **A read of prepared nutrition carries no as-sold figures.** Open Food Facts returns one preparation state per read, so the as-sold fields are absent from such a read although the record can hold them. A read whose prepared keys miss every compared column stays in the as-sold compare table under "not yet entered". Reading the stored as-sold figures is tracked in #73.
- **Free text reaches names in 31 languages only.** The text index keeps a product name entered in any other language (Polish, Czech, Japanese, Chinese, Mongolian, …) in fields its query cannot search at any `langs`, so such a product is found only through its brand, categories, or labels, or by tag filters.
- **A stop word of English, French, Spanish, German, or Italian only ranks.** The per-word groups skip those five languages' 949 stop words, so a content word that is a stop word in one of them (`soy`, `sea`, `die`, `war`) no longer narrows the result — `soy milk` counts every milk product, with soy milks ranked first. A tag filter is the way to make such a constraint hard (`categories_tag: "en:soy-based-drinks"`). The other 26 languages' stop words stay required, so a query written in one of them with its own function words (Dutch `van`, Portuguese `com`) can undercount.
- **Tag canonicalization resolves English names.** The autocomplete suggests against English display names, so a synonym or singular resolves on the text path only when its English form is a name of the tag; the tag path, served by Product Opener's own canonicalizer, resolves more.
- **A search by tag filters alone reaches page 10 at most.** Product Opener serves no deeper page to a client that is not logged in, so at `page_size` 50 a tag-only search reaches its first 500 matches; narrowing the filters or changing `sort_by` reaches others, and a search carrying `query` or `nutrient_filters` pages through the text index's first 10,000.
- **An exclusion cannot see missing data.** A product with no allergen or trace data entered passes `exclude_allergens` and `exclude_traces`, so an excluded result set is a shortlist to check with `off_get_product`, not a guarantee.
- **Search rate limit is strict (10/min).** Agents running rapid multi-search workflows will hit this. Surface the rate limit in service-layer error messaging and backoff.
- **Barcode collisions exist.** A small number of barcodes map to multiple regional product variants. OFF returns the most-contributed variant; the tool doesn't attempt disambiguation.
- **Eco-Score/Green-Score is often "unknown".** Requires packaging material data, origins, and transport data — typically incomplete. The tool returns the value as-is.
- **NOVA group 2 (culinary ingredients) is rarely tagged.** Most products without a NOVA tag are either unprocessed (1) or ultra-processed (4); the middle categories are underrepresented in crowd-sourced data.

---

## API Reference

### Endpoints used

| Endpoint | Method | Local budget |
|:---------|:-------|:-------------|
| `/api/v2/product/{barcode}.json?fields=…` | GET | ~15/min |
| `/api/v2/search?fields=…&page=…&page_size=…&{filters}` | GET | ~10/min |
| `search.openfoodfacts.org/search` (JSON body: `q`, `langs`, `fields`, `page`, `page_size`, `sort_by`) | POST | ~10/min (search budget) |
| `search.openfoodfacts.org/autocomplete?q=…&taxonomy_names=…&size=…` | GET | ~10/min (taxonomy budget) |

Only the first two rows are governed by a published upstream limit. Open Food Facts documents 15 req/min/IP for `GET /api/v*/product` and 10 req/min/IP for `GET /api/v*/search`, both on `world.openfoodfacts.org`; the local budgets match. A text search with tag filters, and a search on either path with exclusions, can also spend taxonomy-budget requests: one per tag or exclusion value the offline sample does not confirm and no earlier search has resolved. `search.openfoodfacts.org` is a separate deployment (search-a-licious) that the published limits do not name and for which no limit is documented, so its two rows are conservative local choices, not mirrors of an upstream figure. The text and tag search paths share one budget, so requests reaching the endpoint the documented 10/min covers stay within it regardless of how a query routes.

### Field selection

All requests must include `fields=`. Without it, the response is ~200 keys and 50–200KB per product. Minimal field sets:

- Product summary: `product_name,brands,nutriscore_grade,nova_group`
- Full label: `product_name,brands,quantity,ingredients_text,ingredients,allergens_tags,additives_tags,nutriscore_grade,nova_group,ecoscore_grade,nutriments,categories_tags,labels_tags,packaging_tags,origins_tags,image_url,completeness`

### Search filter parameter names

| Filter | Parameter name | Format |
|:-------|:---------------|:-------|
| Category | `categories_tags` | `en:breakfast-cereals` |
| Category (English slug) | `categories_tags_en` | `breakfast-cereals` |
| Brand | `brands_tags` | `nutella` |
| Label | `labels_tags` | `en:organic`, or `en:organic,en:fair-trade` for both |
| Nutrition grade | `nutrition_grades_tags` | `a` |
| NOVA group | `nova_groups_tags` | `4` |
| Country | `countries_tags` | `en:france` |
| Allergen | `allergens_tags` | `en:milk`; `-en:milk` excludes; `en:nuts,-en:milk` combines |
| Trace ("may contain") | `traces_tags` | `en:nuts`; `-en:nuts` excludes |
| Ingredient analysis verdict | `ingredients_analysis_tags` | `en:vegan` |
| Additive | `additives_tags` | `en:e322` |

A `*_tags` value is a comma-separated AND list, and a `-` prefix negates an entry.

### Response envelope

```json
{
  "count": 25894,
  "page": 1,
  "page_count": 5,
  "page_size": 5,
  "skip": 0,
  "products": []
}
```

`page_count` = products on this page (equals `page_size` on full pages, less on the last). Total pages = `Math.ceil(count / page_size)`. Pagination uses `page` (1-based) + `page_size`. No cursor tokens.
