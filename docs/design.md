# openfoodfacts-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `off_get_product` | Fetch a product by barcode (EAN-13/UPC). Returns name, brands, quantity, ingredients (raw text + parsed list), allergens, additives, Nutri-Score, NOVA group, Green-Score, nutriments per 100g and per serving, categories, labels, packaging, origins, image URL, and completeness signal. Missing fields mean "not yet entered in the database" — not that the attribute is absent from the real product. | `barcode` (string, required), `fields` (optional field subset) | `readOnlyHint: true` |
| `off_search_products` | Search by keyword and/or structured tag filters. Returns summary rows with barcodes for follow-up lookups. Use when the barcode is unknown or to explore a category. Filters use canonical tag IDs (e.g. `en:organic`, `en:gluten-free`) — use `off_browse_taxonomy` to resolve human terms to tag IDs. | `query` (text search), `categories_tag`, `brands_tag`, `labels_tag`, `allergens_tag`, `additives_tag`, `nutrition_grade`, `nova_group`, `countries_tag`, `sort_by`, `page`, `page_size` | `readOnlyHint: true` |
| `off_compare_products` | Side-by-side nutrition and scoring comparison for 2–10 barcodes. Returns a normalized table of calories, fat, saturated fat, sugars, salt, protein, fiber, Nutri-Score, NOVA, and Green-Score. Designed for "which of these cereals is healthiest?" workflows. | `barcodes` (array of 2–10 EAN/UPC strings) | `readOnlyHint: true` |
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
- Per-endpoint rate limits: product reads ~15/min, search ~10/min, taxonomy resolution ~10/min. Rate limiting enforced in service layer, one token bucket per class. The product and search figures are the per-IP ceilings Open Food Facts publishes; exceeding them is answered with an IP ban rather than a throttle, so the defaults sit at the published number and go lower — never higher — on a shared outbound IP.
- Field selection mandatory on every request — the product object is ~200 keys; always scope `fields=`.
- Tag vocabulary, not free text — search filters use canonical tag IDs (`en:organic`, `en:gluten-free`).
- Missing fields signal incomplete crowd-sourced data, not product attribute absence — surface this distinction explicitly in tool descriptions and output.
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

**Nutriments shape:** flat key-value map. Each nutrient has up to four variants: `{key}`, `{key}_100g`, `{key}_unit`, `{key}_value`, `{key}_serving` (when serving data present), `{key}_modifier` (e.g. `~` for approximate). The `_100g` variant is the canonical per-100g figure. Keys use hyphens: `energy-kcal`, `saturated-fat`, `added-sugars`.

**Fields confirmed in full product object:** `product_name`, `brands`, `quantity`, `ingredients_text`, `allergens_tags` (array, `en:milk` format), `additives_tags` (array, `en:e322` format), `nutriscore_grade` (a–e or absent), `nova_group` (1–4 integer or absent), `ecoscore_grade` (a–e or `unknown`), `categories_tags` (array), `labels_tags` (array), `packaging_tags` (array), `origins_tags` (array, often empty), `image_url`, `completeness` (0–1 float), `data_quality_tags` (crowd-sourced QA flags).

**Missing barcode response (status:0):** Returns HTTP 200, JSON `{"code":"00000001","status":0,"status_verbose":"no code or invalid code"}`. NOT a 404. Must check `status` field, not HTTP status.

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

**Pagination:** uses `page` (1-based) and `page_size` params. Response includes `count` (total matching products), `page_count` (number of products returned on this page — mirrors `page_size` for full pages, less for the last page), `skip` (row offset). **There is no total-pages field** — compute it as `Math.ceil(count / page_size)` in the service layer if needed.

**Filter params confirmed working:**
- `categories_tags_en=breakfast-cereals` — English label (no `en:` prefix needed for `_en` params)
- `brands_tags=nutella` — brand slug
- `nutrition_grades_tags=e` — single letter a–e (the bare `nutrition_grades` key is silently ignored)
- Multiple filters compose as AND

**Tag filter params in search:** `categories_tags`, `labels_tags`, `allergens_tags`, `additives_tags`, `brands_tags`, `countries_tags` — use canonical `en:X` format. The `_en` suffix variants accept plain English slugs. Tag values match exactly against the normalized slug: `brands_tags=nutella` matches while `brands_tags=nutell` returns zero, on this endpoint and on the text backend alike.

### Text search (`https://search.openfoodfacts.org/search`)

Separate backend (search-a-licious over Elasticsearch), reached whenever a request carries free text. Its envelope differs from `/api/v2/search` in three ways that the service normalizes or surfaces:

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
- **`page_count` means total pages**, not products on this page. Normalized to products-on-page in the service so both paths return one shape.
- **Indexed facets differ.** `allergens_tags` is a keyword field and filters correctly. `additives_tags` **is not in the index** — a clause naming it is compiled to a phrase match against a missing field and returns zero hits with no error (live-probed for `en:e322`, `en:e330`, `en:e100`, all of which match hundreds of thousands of products on the tag path). The tool refuses `additives_tag` alongside a query rather than sending that clause.

### Taxonomy endpoints

`/labels.json`, `/categories.json`, `/facets/categories.json` on `world.openfoodfacts.org` return HTTP 503 for anonymous bot requests (rate-limited, requires registered session) — **not usable**. Two other surfaces are, both live-probed with this server's identifying User-Agent:

**Autocomplete (`https://search.openfoodfacts.org/autocomplete`)** — the resolver `off_browse_taxonomy` uses.

```
GET /autocomplete?q=hummus&taxonomy_names=category&size=10
{"took":1,"timed_out":false,"options":[{"id":"en:hummus","text":"Hummus","taxonomy_name":"category"}]}
```

- `taxonomy_names` accepts `category`, `label`, `allergen`, `additive`, `country`, `brand`, comma-separated. There is no `nova_group` or `nutrition_grade` taxonomy; naming one answers HTTP 200 with an empty `options` list, as does an unknown name or an empty `q`.
- `size` caps the option count. Live-verified honored exactly up to 200; 500 answered 249. It is the **only** paging knob — `offset`, `from`, and `page` are accepted and silently ignored, all returning the same first page, so there is no way to reach past the first `size` suggestions.
- No match total is reported. The endpoint is a suggester, not an enumerator: it cannot list a facet and cannot say how many tags matched.
- Matching is against **display names**, not tag IDs, and falls back to loosely-related suggestions when nothing matches well. Ordinary words resolve cleanly (`hummus`→`en:hummus`, `tofu`→`en:tofu`, `gluten`→`en:no-gluten`), and note that category tags are frequently plural upstream: `kombucha` resolves to `en:kombuchas`, not `en:kombucha`. E-numbers do **not** resolve — `e322`, `e100`, and `e330` each return a page of unrelated E-numbers not containing the queried one.
- Upstream `took` is 1–3 ms; wall-clock round trip from a US client is ~0.5–0.8 s.

**Static dumps (`https://static.openfoodfacts.org/data/taxonomies/{categories,labels,allergens,additives,countries}.json`)** — HTTP 200, ~7.4 MB combined (4.6 MB / 1.2 MB / 10 KB / 906 KB / 722 KB). Not used: the payload would ship inside the npm package and the `.mcpb` bundle, needs build-time refresh tooling, and goes stale between releases. Entry counts, for scale against the in-process sample: categories 14,552 (sample 79), labels 3,037 (30), additives 683 (44), countries 268 (30), allergens 27 (27, at parity). Entries carry parent/child hierarchy and per-language names but no product count, so the tool's `products` output field stays empty under either backend.

---

## Tools — Full Specification

### `off_get_product`

**Description:** Fetch a packaged food product by barcode (EAN-13 or UPC). Returns the product's name, brand, quantity, ingredients (raw text and parsed list), allergens, additives, computed scores (Nutri-Score a–e, NOVA 1–4, Green-Score), nutrition per 100g and per serving, categories, labels, packaging, origins, image URL, and data completeness. Open Food Facts is crowd-sourced — a missing field means "not yet entered by contributors," not that the attribute is absent from the actual product. Computed scores carry regional formula caveats and are indicators, not absolute rankings.

**Input schema:**

```ts
z.object({
  barcode: z.string()
    .regex(/^\d{8,14}$/)
    .describe('EAN-13 or UPC barcode (8–14 digits). The primary key for Open Food Facts. Example: "3017620422003" (Nutella FR).'),
  fields: z.array(z.enum([
    'product_name', 'brands', 'quantity', 'ingredients_text', 'ingredients',
    'allergens_tags', 'additives_tags', 'nutriscore_grade', 'nova_group',
    'ecoscore_grade', 'nutriments', 'categories_tags', 'labels_tags',
    'packaging_tags', 'origins_tags', 'image_url', 'completeness', 'data_quality_tags',
  ])).optional()
    .describe('Subset of fields to return. Omitting returns all standard fields. Use to reduce payload when only scores or ingredients are needed.'),
})
```

**Output schema:**

```ts
z.object({
  barcode: z.string().describe('Barcode as returned by the API.'),
  product: z.object({
    product_name: z.string().optional().describe('Product name. May be absent if not yet entered.'),
    brands: z.string().optional().describe('Brand name(s), comma-separated.'),
    quantity: z.string().optional().describe('Net quantity as printed on packaging (e.g. "400g").'),
    ingredients_text: z.string().optional().describe('Raw ingredients text from the label, in the source language.'),
    ingredients: z.array(z.object({
      id: z.string().optional().describe('Canonical ingredient ID.'),
      text: z.string().describe('Ingredient name.'),
      percent_estimate: z.number().optional().describe('Estimated percentage of this ingredient.'),
      vegan: z.string().optional().describe('"yes", "no", or "maybe".'),
      vegetarian: z.string().optional().describe('"yes", "no", or "maybe".'),
    })).optional().describe('Parsed ingredient list. Absent when not yet parsed by contributors.'),
    allergens_tags: z.array(z.string()).optional().describe('Canonical allergen tag IDs (e.g. "en:milk", "en:gluten"). Absence means not yet entered, not allergen-free.'),
    additives_tags: z.array(z.string()).optional().describe('E-number additive tag IDs (e.g. "en:e322", "en:e322i"). Absence means not yet entered.'),
    nutriscore_grade: z.string().optional().describe('Nutri-Score letter (a–e, lowercase). Regional formula variants exist; "a" is highest quality. Absent when not enough nutrition data to compute.'),
    nova_group: z.number().optional().describe('NOVA food processing class (1=unprocessed, 2=culinary ingredients, 3=processed, 4=ultra-processed). Absent when not enough data.'),
    ecoscore_grade: z.string().optional().describe('Green-Score/Eco-Score environmental impact letter (a–e, or "unknown"). Highly variable — depends on packaging, origins, and transport data completeness.'),
    nutriments: z.object({
      energy_kcal_100g: z.number().optional().describe('Energy per 100g in kcal.'),
      fat_100g: z.number().optional().describe('Total fat per 100g in grams.'),
      saturated_fat_100g: z.number().optional().describe('Saturated fat per 100g in grams.'),
      carbohydrates_100g: z.number().optional().describe('Total carbohydrates per 100g in grams.'),
      sugars_100g: z.number().optional().describe('Total sugars per 100g in grams.'),
      fiber_100g: z.number().optional().describe('Dietary fiber per 100g in grams. Often absent.'),
      proteins_100g: z.number().optional().describe('Protein per 100g in grams.'),
      salt_100g: z.number().optional().describe('Salt per 100g in grams.'),
      sodium_100g: z.number().optional().describe('Sodium per 100g in grams.'),
      energy_kcal_serving: z.number().optional().describe('Energy per serving in kcal. Absent when serving size not defined.'),
      fat_serving: z.number().optional().describe('Total fat per serving in grams.'),
      sugars_serving: z.number().optional().describe('Sugars per serving in grams.'),
      additional_100g: z.record(z.string(), z.object({ value: z.number(), unit: z.string().optional() })).optional().describe('Every other per-100g nutrient on the record (calcium, iron, trans_fat, added_sugars, energy in kJ, …), each with the unit Open Food Facts reported it in.'),
      additional_serving: z.record(z.string(), z.object({ value: z.number(), unit: z.string().optional() })).optional().describe('The same nutrients per serving, plus per-serving macros that have no named field.'),
    }).optional().describe('Nutrition figures. All values may be absent if nutrition data not yet entered.'),
    serving_size: z.string().optional().describe('Serving size as printed on the label (e.g. "28 g", "1 can (12 fl oz)") — the denominator for every per-serving figure.'),
    serving_quantity: z.number().optional().describe('Serving size parsed to a number, in serving_quantity_unit.'),
    serving_quantity_unit: z.string().optional().describe('Unit of serving_quantity — "g" for most products, "ml" for liquids.'),
    categories_tags: z.array(z.string()).optional().describe('Category tag IDs in canonical form (e.g. "en:spreads"). Useful as filter values for off_search_products.'),
    labels_tags: z.array(z.string()).optional().describe('Label/certification tag IDs (e.g. "en:organic", "en:no-gluten").'),
    packaging_tags: z.array(z.string()).optional().describe('Packaging material tag IDs.'),
    origins_tags: z.array(z.string()).optional().describe('Ingredient origin tag IDs. Frequently empty.'),
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
    when: 'Open Food Facts returns 5xx, serves an HTML error page, or is unreachable',
    retryable: true,
    recovery: 'Retry after a brief pause. If it keeps failing, Open Food Facts is degraded — check the barcode again later.',
  },
  {
    reason: 'upstream_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'Open Food Facts did not answer within the request deadline',
    retryable: true,
    recovery: 'Retry once. If it times out again, pass a narrower fields subset so Open Food Facts assembles less per request.',
  },
  {
    reason: 'upstream_rejected',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Open Food Facts answers 4xx for something other than a missing barcode',
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

**Description:** Search Open Food Facts by full-text query, structured tag filters, or both together. Returns a summary list with barcodes, product names, brands, Nutri-Score, NOVA group, and categories — enough for triage and selection, not full label data. Use `off_get_product` on the returned barcodes for complete details. A text query and tag filters combine: results match the query text and satisfy every provided filter; `additives_tag` is the one exception, filtering only on searches with no text query. Filter values must be canonical tag IDs (e.g. `en:organic`, `en:gluten-free`) — use `off_browse_taxonomy` to resolve human terms to tag IDs. Data is crowd-sourced; result count reflects contributed products, not all products in the market.

**Input schema:**

```ts
z.object({
  query: z.string().optional()
    .describe('Full-text search term across product names, brands, and ingredients. Combine with tag filters for precision. Example: "dark chocolate 70%".'),
  categories_tag: z.string().optional()
    .describe('Canonical category tag ID. Example: "en:breakfast-cereals", "en:cheeses". Use off_browse_taxonomy with facet="categories" to discover valid values.'),
  brands_tag: z.string().optional()
    .describe('Brand slug (lowercased, hyphenated). Example: "nutella", "kelloggs". Matched exactly against the normalized slug — a partial or misspelled slug matches nothing rather than falling back to a near match, so put open-ended brand wording in query instead.'),
  labels_tag: z.string().optional()
    .describe('Canonical label/certification tag ID. Example: "en:organic", "en:fair-trade", "en:no-gluten". Use off_browse_taxonomy with facet="labels".'),
  allergens_tag: z.string().optional()
    .describe('Canonical allergen tag ID. Example: "en:milk", "en:gluten". Use off_browse_taxonomy with facet="allergens". Selects products that declare this allergen; it cannot select allergen-free products, because a product with no allergen tags may simply have none entered yet.'),
  additives_tag: z.string().optional()
    .describe('Canonical additive (E-number) tag ID. Example: "en:e322", "en:e330". Use off_browse_taxonomy with facet="additives". Available only on searches with no query — the text backend does not index additives, so combining the two is rejected instead of silently returning nothing.'),
  nutrition_grade: z.enum(['a', 'b', 'c', 'd', 'e']).optional()
    .describe('Filter by Nutri-Score grade. "a" is highest nutritional quality, "e" is lowest. Products without a score are excluded.'),
  nova_group: z.enum(['1', '2', '3', '4']).optional()
    .describe('Filter by NOVA food processing class. 1=unprocessed/minimally processed, 4=ultra-processed. Products without a NOVA score are excluded.'),
  countries_tag: z.string().optional()
    .describe('Canonical country tag ID. Example: "en:france", "en:united-states". Filters to products sold in that country.'),
  sort_by: z.enum(['last_modified_t', 'unique_scans_n', 'created_t', 'popularity_key']).optional()
    .describe('Sort order for searches without a text query. "unique_scans_n" surfaces the most-scanned products; omitting returns results in default order. Searches that include a text query are relevance-ranked and ignore this option.'),
  page: z.number().int().min(1).default(1)
    .describe('Page number (1-based). Use with page_size to paginate results. Searches that include a text query serve only the first 10,000 results, so page * page_size must stay at or below 10,000 — a deeper request is rejected rather than sent. Tag-only searches have no published window, but Open Food Facts refuses deep pages unpredictably; narrowing the filters is more reliable than paging far in.'),
  page_size: z.number().int().min(1).max(50).default(20)
    .describe('Results per page (1–50, default 20). Keep low for initial exploration; increase for comparison workflows.'),
})
```

At least one of `query`, `categories_tag`, `brands_tag`, `labels_tag`, `allergens_tag`, `additives_tag`, `nutrition_grade`, `nova_group`, or `countries_tag` must be provided (validated in handler).

**Output schema:**

```ts
z.object({
  total: z.number().describe('Matching products in the database for this search. Exact unless total_is_lower_bound is true, in which case at least this many match and the real figure is unknown.'),
  total_is_lower_bound: z.boolean().describe('True when the backend stopped counting at its ceiling and total is a floor, not the match total. Only text searches can hit it; add filters to bring the result set under the ceiling and get an exact count.'),
  page: z.number().describe('Current page number (1-based).'),
  page_count: z.number().describe('Products returned on this page (mirrors page_size except on the last page). Not the total number of pages.'),
  products: z.array(z.object({
    barcode: z.string().describe('EAN/UPC barcode. Pass to off_get_product for full details.'),
    product_name: z.string().optional().describe('Product name. May be absent for incompletely entered products.'),
    brands: z.string().optional().describe('Brand name(s).'),
    nutriscore_grade: z.string().optional().describe('Nutri-Score letter (a–e). Absent when not computed.'),
    nova_group: z.number().optional().describe('NOVA processing class (1–4). Absent when not assigned.'),
    ecoscore_grade: z.string().optional().describe('Green-Score letter (a–e). Environmental impact indicator. Absent when not computed.'),
    categories_tags: z.array(z.string()).optional().describe('Category tag IDs.'),
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
    recovery: 'Provide at least one of: query, categories_tag, brands_tag, labels_tag, allergens_tag, additives_tag, nutrition_grade, nova_group, or countries_tag.',
  },
  {
    reason: 'additives_filter_needs_tag_search',
    code: JsonRpcErrorCode.ValidationError,
    when: 'additives_tag was combined with a text query, which the text backend cannot filter on',
    retryable: false,
    recovery: 'Drop query and search by tags alone to keep the additive filter, or drop additives_tag to keep the text query. Every other filter combines with a text query.',
  },
  {
    reason: 'page_out_of_range',
    code: JsonRpcErrorCode.ValidationError,
    when: 'A text search asks for page * page_size beyond the 10,000-result window the text backend serves',
    retryable: false,
    recovery: 'Request an earlier page, or add filters so the products you need fall inside the first results rather than deep in the ranking.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Open Food Facts returns 5xx, serves an HTML error page, or is unreachable',
    retryable: true,
    recovery: 'Retry after a brief pause. The Open Food Facts service may be shedding load — narrow the filters if deep pages keep failing.',
  },
  {
    reason: 'upstream_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'Open Food Facts did not answer within the request deadline',
    retryable: true,
    recovery: 'Retry once with a smaller page_size. Broad unfiltered searches are the slowest for Open Food Facts to assemble.',
  },
  {
    reason: 'upstream_rejected',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'Open Food Facts answers 4xx — the request as formed will be refused again',
    retryable: false,
    recovery: 'Do not retry. Read data.status and the upstream explanation in the message; reduce the page depth or correct the filter values.',
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

The `page_out_of_range` and `additives_filter_needs_tag_search` checks run in the handler before the service is called, mirroring the `no_filters` pre-check. Both are scoped to the text path — `/api/v2/search` publishes no result-window ceiling and does filter on `additives_tags`.

---

### `off_compare_products`

**Description:** Side-by-side nutrition and scoring comparison for 2–10 products by barcode. Returns a normalized table of energy (kcal/100g), fat, saturated fat, sugars, salt, protein, fiber, Nutri-Score, NOVA group, and Green-Score. Designed for "which of these three cereals is healthiest?" or "compare these pasta brands" workflows. Missing nutrition data for any product is preserved as null — comparisons are not imputed. Scores carry regional caveats.

**Input schema:**

```ts
z.object({
  barcodes: z.array(
    z.string().regex(/^\d{8,14}$/).describe('EAN-13 or UPC barcode.')
  ).min(2).max(10)
    .describe('2–10 barcodes to compare, returned as one row each in input order. Example: ["3017620422003", "7622210100146"].'),
})
```

**Output schema:**

```ts
z.object({
  products: z.array(z.object({
    barcode: z.string().describe('Barcode.'),
    product_name: z.string().optional().describe('Product name.'),
    brands: z.string().optional().describe('Brand name(s).'),
    found: z.boolean().describe('False if the barcode has no contributor record.'),
    nutriscore_grade: z.string().optional().describe('Nutri-Score (a–e).'),
    nova_group: z.number().optional().describe('NOVA class (1–4).'),
    ecoscore_grade: z.string().optional().describe('Green-Score/Eco-Score (a–e or "unknown").'),
    energy_kcal_100g: z.number().optional().describe('Calories per 100g.'),
    fat_100g: z.number().optional().describe('Total fat per 100g (g).'),
    saturated_fat_100g: z.number().optional().describe('Saturated fat per 100g (g).'),
    sugars_100g: z.number().optional().describe('Total sugars per 100g (g).'),
    salt_100g: z.number().optional().describe('Salt per 100g (g).'),
    proteins_100g: z.number().optional().describe('Protein per 100g (g).'),
    fiber_100g: z.number().optional().describe('Dietary fiber per 100g (g). Often absent.'),
    completeness: z.number().optional().describe('Data completeness 0–1. Low values mean many fields are missing.'),
  })).describe('Comparison rows in input order — one per barcode whose fetch completed, whether or not a record exists. Barcodes whose fetch failed have no row here; they appear in failed.'),
  succeeded: z.number().describe('Number of barcodes that resolved to a found product.'),
  not_found: z.array(z.string()).describe('Barcodes Open Food Facts answered for, confirming no contributor record exists. Not an error — the product may exist but not yet be entered. Never used for a fetch that failed.'),
  failed: z.array(z.object({
    barcode: z.string().describe('EAN-13 or UPC barcode whose fetch failed.'),
    reason: z.string().describe('Declared failure reason — one of upstream_error, upstream_timeout, upstream_rejected, rate_limited.'),
    error: z.string().describe('What went wrong for this barcode and what to do about it.'),
  })).optional().describe('Barcodes whose fetch failed, with the per-barcode reason. Absent when every fetch completed. A barcode listed here is unknown, not absent from Open Food Facts.'),
})
```

No DataCanvas spill: a batch caps at 10 products, which is too small to warrant a canvas/SQL layer.

**Errors:** Declares `upstream_error`, `upstream_timeout`, `upstream_rejected`, and `rate_limited` — the same four reasons the service raises, with recovery text scoped to a batch ("retry the barcodes listed in failed"). None of them aborts the call: a batch is not all-or-nothing, so each is surfaced per barcode in `failed[]` while the rows that resolved are kept. Confirmed-missing barcodes stay in `not_found`, which claims the opposite of a failed fetch.

---

### `off_browse_taxonomy`

**Description:** Resolve a human term to the canonical Open Food Facts tag ID that `off_search_products` filters on. Covers categories, labels/certifications, allergens, additives, countries, NOVA groups, and Nutri-Score grades. A search term resolves against the live Open Food Facts taxonomy; omitting it lists only the in-process sample. Most tag IDs use the `en:` prefix (`en:organic`, `en:gluten-free`, `en:milk`); NOVA groups return bare `1`–`4` and Nutri-Score grades bare `a`–`e`.

**Input schema:**

```ts
z.object({
  facet: z.enum([
    'categories', 'labels', 'allergens', 'additives', 'countries',
    'nova_groups', 'nutrition_grades',
  ]).describe('Which vocabulary to resolve against. "categories" covers food categories (en:cheeses, en:breakfast-cereals). "labels" covers certifications (en:organic, en:fair-trade). "allergens" covers declared allergens (en:milk, en:gluten). "additives" covers E-numbers (en:e322). "countries" covers country-of-sale tags (en:france). "nova_groups" and "nutrition_grades" are closed vocabularies answered offline and returned complete; the other five resolve against the live taxonomy.'),
  search: z.string().optional()
    .describe('Term to resolve. Matched case-insensitively as a substring of the tag ID or display name, against both the live vocabulary and the offline sample. A single word works best ("hummus", not "hummus dip"). Omit only to see the offline sample.'),
  limit: z.number().int().min(1).max(100).default(20)
    .describe('Maximum entries to return (1–100, default 20). No offset or page input — the upstream endpoint offers no cursor.'),
})
```

**Output schema:**

```ts
z.object({
  facet: z.string().describe('The facet that was queried.'),
  tags: z.array(z.object({
    id: z.string().describe('Canonical tag ID (e.g. "en:organic"; bare "1"–"4" for NOVA groups, bare "a"–"e" for Nutri-Score grades). Pass through to off_search_products unchanged.'),
    name: z.string().describe('Human-readable display name (e.g. "Organic").'),
    products: z.number().optional().describe('Approximate count of products with this tag. Not available for all facets.'),
  })).describe('Matching tag entries.'),
  total_in_facet: z.number().optional().describe('Total entries in this facet. Present only for nova_groups and nutrition_grades; the live facets have no knowable total.'),
})

enrichment: {
  notice: z.string().optional().describe('Caveat about how the answer was produced — offline sample, unreachable live vocabulary, or no match.'),
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
| `taxonomy-service` | Live taxonomy autocomplete (via `openfoodfacts-service`) merged with an embedded sample | `off_browse_taxonomy` |

### `openfoodfacts-service`

- **Base URL:** `https://world.openfoodfacts.org`
- **User-Agent:** `openfoodfacts-mcp-server/<version> (casey@caseyjhand.com)` — sent on every request. Required by OFF terms.
- **Field selection:** every call includes `fields=` to scope the product object.
- **Methods:**
  - `getProduct(barcode, fields)` → raw product object or `null` (status:0)
  - `searchProducts(params)` → `{count, count_is_exact, page, page_count, page_size, products[]}` (the `SearchResult` type — one shape from both backends)
- **Rate limiting:** token bucket per endpoint class — product reads (15/min), search (10/min), taxonomy resolution (10/min). A refusal is local, so it raises `rate_limited` (`RateLimited`) naming this server, not Open Food Facts, and carries the seconds until a slot frees.
- **Transport:** `fetchWithTimeout` at every call site, so HTTP status → error code, canonical `status`/`body` on `error.data`, `Retry-After` honoring, and distinct `Timeout` classification all come from the framework rather than a hand-rolled status ladder.
- **Retry:** `withRetry` on the full fetch+parse pipeline. 3 attempts, 500ms base delay (upstream is stateless; 5xx is transient). Classification runs *inside* the retry boundary so the mapped code decides: 5xx, timeouts, and 429 retry; 4xx fails immediately.
- **Parse failure:** HTML error pages (503 during high load) detected by content-type check → `upstream_error` (`ServiceUnavailable`, not `SerializationError`).
- **Missing barcode:** `status:0` in a 200 response, or an HTTP 404, → `null` from the service; the handler calls `ctx.fail('not_found', ...)`. `null` is reserved for this case alone.

### `taxonomy-service`

Owns resolution policy for `off_browse_taxonomy`; transport lives in `openfoodfacts-service.suggestTaxonomy()`, which carries the same `fetchWithTimeout` / `withRetry` / contract-error plumbing as the product and search paths plus its own rate-limit tier.

- **Facet routing.** `categories`, `labels`, `allergens`, `additives`, `countries` map to the upstream `category`/`label`/`allergen`/`additive`/`country` taxonomies. `nova_groups` and `nutrition_grades` have no upstream counterpart and are closed vocabularies, so they are answered entirely from the embedded map and are the only facets that report `total_in_facet`.
- **Embedded sample.** A static `facet → [{id, name}]` map: 79 categories, 30 labels, 27 allergens, 44 additives, 30 countries, 4 NOVA groups, 5 Nutri-Score grades. For the five live facets this is a small slice (categories is 79 against 14,552 upstream), used for unfiltered listing, offline fallback, and as the first-ranked half of a merge.
- **With a search term.** The embedded matches and the live suggestions are merged, embedded first, deduplicated by tag ID, then capped at `limit`. Upstream is asked for `limit + 1` so a full page can be distinguished from an exactly-full one and reported as truncated — the endpoint has no offset, so that is the only available signal that more exist.
- **Live suggestions are held to the facet's documented substring rule.** Upstream matches display names and degrades to loosely-related suggestions rather than returning nothing, so unfiltered pass-through would answer `e330` with E-numbers that do not contain it. Applying the same `id`/`name` substring predicate used for the embedded half drops that noise; measured across ordinary terms (cheese, kombucha, olive oil, organic, tofu, yoghurt, …) it drops nothing else.
- **Without a search term.** The embedded sample only, plus a `notice` saying so. The upstream endpoint suggests against a term and answers an empty list for an empty query — it cannot enumerate a facet.
- **On failure.** The throw is absorbed and the offline matches returned with a `notice` naming the cause. `openWorldHint: true`.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OFF_BASE_URL` | No | Base URL override. Default: `https://world.openfoodfacts.org`. Useful for testing against a mock server. |
| `OFF_RATE_LIMIT_PRODUCT` | No | Product read rate limit (requests/min). Default: `15`, the per-IP ceiling Open Food Facts documents for product reads. |
| `OFF_RATE_LIMIT_SEARCH` | No | Search rate limit (requests/min). Default: `10`. |
| `OFF_RATE_LIMIT_TAXONOMY` | No | Taxonomy resolution rate limit (requests/min). Default: `10`. A spent budget falls back to the offline sample rather than failing. |

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

**Taxonomy resolution is live, with the embedded sample kept as a merge partner rather than replaced.** The `world.openfoodfacts.org` taxonomy endpoints do return 503 to anonymous bots, but `search.openfoodfacts.org/autocomplete` does not, and the embedded-only design it justified had made the tool's advertised purpose unreachable: the sample holds 79 categories against 14,552 upstream, so ordinary foods (hummus, tofu, kombucha, pizzas) answered "no matching tags" for tags that filter thousands of products. Live resolution over a static mirror because a mirror puts ~7.4 MB into the npm package and `.mcpb` bundle, needs build-time refresh tooling, and goes stale between releases, while a suggestion costs about a kilobyte and always reflects the current vocabulary.

The sample stays because live-only would regress two cases it answers correctly. The upstream suggester matches display names and returns loosely-related suggestions instead of nothing, so `e322` comes back as a page of unrelated E-numbers while the sample resolves it exactly; and an Open Food Facts outage would turn a working `en:organic` lookup into a failure. Merging embedded-first, deduplicated, keeps both, and holding live suggestions to the same substring rule the facet documents drops the suggester's noise without dropping real matches.

**A failed live lookup degrades with a notice instead of raising a declared failure.** No `errors[]` contract is declared for this tool, because none of its reasons could fire: the throw from `suggestTaxonomy()` is absorbed in the taxonomy service and reported through `enrichment.notice`. Declaring a reason the handler cannot return advertises a state callers would branch on and never reach — the same argument that removed the `found` flag from `off_get_product`. The degradation is not silent: the notice reaches `structuredContent` and `content[]` alike, names the cause, and says the offline sample may not cover a tag that exists upstream, so an empty result is never read as an authoritative "no such tag". This is the specific failure the tool had, and returning nothing with a raised error would reintroduce it for the callers the sample can still serve.

**`total_in_facet` is reported only for the closed vocabularies.** The autocomplete endpoint reports no match total and cannot be enumerated, so the live facets have no knowable total; the field is omitted rather than filled with the sample size. Returning `79` for categories is what presented a local sample as the size of the Open Food Facts category vocabulary.

**No offset or page input.** The endpoint's `size` caps the option count and is its only paging knob — `offset`, `from`, and `page` are accepted and silently ignored, all returning the same first page. An offset input would therefore have to be a lie or a client-side slice of one fetch; narrowing the term is the honest instruction, and `limit + 1` is requested so genuine truncation is still disclosed.

**NOVA group and Nutri-Score tag IDs are bare, not `en:`-prefixed.** `off_browse_taxonomy` emitted `en:1`–`en:4` while `off_search_products.nova_group` accepts `"1"`–`"4"`, so passing the advertised ID back was a hard validation failure. Fixing it at the source rather than relaxing the enum: upstream tolerance is not uniform, and normalizing on input would have to land before `buildTextSearchQuery`. On the tag backend both forms return the same 136,019 matches, but on the text backend `nova_group:en:1` is live-verified answering zero hits flagged `is_count_exact: true` — a confident false "no products" rather than an error. Bare digits also match the bare grade letters `nutrition_grades` already emitted.

**`off_compare_products` keeps partial results in output, not errors.** When 3 of 5 barcodes resolve and 2 are not found, the caller gets a comparison table for the 3 found products plus a `not_found` list. Throwing when any product is missing would break "compare this grocery basket" workflows where some products are regional or recent.

**A barcode whose fetch failed goes in `failed`, never in `not_found`.** The two are opposite claims: `not_found` asserts Open Food Facts answered and holds no record, while a failed fetch means the barcode was never checked. Classification is by how the promise settled, never by error text — the service resolves `null` only for a genuine not-found, so any rejection is a failure. Failures stay per-barcode instead of aborting the call, so a mixed batch keeps the rows that resolved; the framework reads a non-empty `failed` array as partial success and records it on the tool span.

**Failures leave the service already carrying their contract `reason` and recovery hint.** Handlers stay pure — the service passes `{ reason, ...ctx.recoveryFor(reason) }` on every throw, so `data.reason` and `data.recovery.hint` reach both client surfaces with no handler-side try/catch. Reasons resolve from the error's `JsonRpcErrorCode`, never from message text.

**Every upstream 4xx is `upstream_rejected` and non-retryable.** A request the upstream refuses will be refused again, so retrying only aims more traffic at a backend already saying no. `data.status` disambiguates which 4xx it was, and the upstream's own `detail` is surfaced in the message.

**The text backend's 10,000-result window is enforced before the request.** `search.openfoodfacts.org` rejects `page * page_size > 10000` with an HTTP 400. Checking it in the handler turns a four-attempt backoff ending in a retryable-looking outage into a validation failure naming the highest reachable page. Scoped to the text path — `/api/v2/search` publishes no equivalent ceiling and its deep pages fail unpredictably rather than at a fixed bound, so truncation guidance there warns instead of promising a reachable page count.

**`format()` renders what `structuredContent` carries — no formatter-local slicing.** The text surface previously capped parsed ingredients at 20 and category tags at 5 (3 in search), rendered completeness only as a rounded percentage, and dropped `vegan`/`vegetarian` when the value was `maybe`. None of it reduced the payload — the full arrays and exact scalars were already in `structuredContent` — so the caps bought nothing and left text-only clients (Claude Desktop) with a quietly incomplete record that no follow-up call could complete, since re-calling returns the same trimmed text. Two of the losses were silent misreadings rather than omissions: `79%` is indistinguishable from an exact `0.79` when the value is `0.7875`, and `maybe` is a real OFF verdict ("depends on sourcing") that rendered identically to no verdict at all. These are capped-*list* cases in name only; the honest fix is full parity, and the `fields` input already exists for callers who want a smaller response. Outline-on-overflow does not apply — it addresses one document-shaped record too large to inline, and a product record is neither document-shaped nor near the budget: the heaviest real payloads observed (55 parsed ingredients) serialize to roughly 9 KB of `structuredContent` and 7.5 KB of text against a 24 KB outline budget, and the `fields` input already gives a caller who wants less a way to ask for it.

**A clipped hit count is labelled, never rounded off or hidden.** The text backend stops counting at 10,000 and reports `is_count_exact: false` when it does; `total_is_lower_bound` carries that straight through to the caller, and `format()` renders the figure as `10000+`. The alternative — presenting the ceiling as an exact total — makes every broad query report the same fabricated number, and made the pagination guidance derive a precise page count from it. Detection reads the upstream flag rather than comparing the count against `TEXT_SEARCH_RESULT_WINDOW`: the page-depth limit and the hit-counting limit are separate limits that sit at the same number today, and only the backend knows when it stopped counting.

**`additives_tag` is refused alongside a text query instead of being sent.** The search-a-licious index has no `additives_tags` field, so the clause compiles to a phrase match on a missing field and returns zero hits — an answer indistinguishable from "no product contains this additive". A declared `additives_filter_needs_tag_search` failure naming the working combination beats a silent empty result. Every other filter is indexed on both backends and combines with a query freely.

**`off_browse_taxonomy` is a separate tool, not bundled into `off_search_products`.** Tag vocabulary lookup is an independent need — it's used to build search filters, not as part of executing a search. Keeping it separate maintains clean tool boundaries and allows tag exploration without triggering a search call.

**Field selection via input enum, not open string array.** Restricts to the fields the server actually handles and normalizes, preventing callers from requesting raw OFF fields that the output schema doesn't cover. The enum doubles as documentation of what's available.

**NOVA group as `number` in output, `enum(['1','2','3','4'])` in search input.** Zod coercion converts the input string to the parameter value. The raw nutriments object also embeds `nova-group` as a number, but the typed `nova_group` field is its only home in the output — see the nutrient-coverage note below for why it is excluded from the open nutrient maps.

**Nutriments normalized in the output schema.** The raw OFF nutriments object uses hyphenated keys (`energy-kcal_100g`) that are not valid TypeScript identifiers. Normalization maps to underscore form (`energy_kcal_100g`) and takes the `_100g` and `_serving` variants; `_value` and `_modifier` are dropped as redundant with `_100g`.

**Nutrient coverage is open, not an allowlist.** The macros keep named schema fields, and every other nutrient on the record lands in `additional_100g` / `additional_serving` keyed by normalized name. A fixed map silently narrowed a nutrition database to a dozen macronutrients — calcium, iron, cholesterol, trans fat, added sugars, and the vitamins were all present upstream and dropped, so questions the record could answer came back empty with no field subset or follow-up call that would retrieve them. Two constraints make the open map safe:

- **Exclusion is per exact raw key, not per base nutrient**, derived from the named map so the two cannot drift. The named set is asymmetric across suffixes — `saturated-fat_100g` is named while `saturated-fat_serving` is not — so excluding by base name would drop per-serving macros from both surfaces. Each nutrient therefore appears in exactly one place.
- **The per-key unit is carried, never assumed.** OFF reports most nutrients in grams but not all: `energy` is kJ and `energy-kcal` is kcal on the same product, and some keys (the fruits-vegetables estimates) have no `_unit` sibling at all, so the unit is optional rather than defaulted. Normalizing everything to "grams" would have mislabeled them.

`nova-group` is excluded outright: OFF stores the NOVA processing class inside the nutriments map with an empty unit, and it is already surfaced as the typed `nova_group` field, so passing it through would report the same classification twice.

**Per-serving figures always carry their denominator.** `serving_size` (as printed), `serving_quantity` (parsed), and `serving_quantity_unit` are requested and returned alongside the `_serving` nutriments; `format()` restates the serving size on the per-serving heading and says outright when OFF has recorded none. Per-serving numbers without a serving size cannot be compared across products or converted to or from the per-100g figures. `serving_quantity` is coerced rather than type-tested — OFF returns it as a JSON number for most products and a numeric string for others, so a `typeof === 'number'` guard would drop it for a whole class of records. Its unit is not assumed to be grams: it is millilitres for liquids.

---

## Known Limitations

- **Crowd-sourced completeness varies widely by region.** French and Western European products are well-covered; products from other regions may be sparse or missing entirely.
- **The live taxonomy cannot be listed or paged.** `search.openfoodfacts.org/autocomplete` suggests against a term: it reports no match total, has no offset or cursor, and answers an empty list for an empty query. So `off_browse_taxonomy` reports no `total_in_facet` for the five live facets, exposes no offset input, and answers an unfiltered call from the in-process sample rather than the full vocabulary. The `world.openfoodfacts.org` taxonomy endpoints (`/labels.json`, `/categories.json`) remain 503 for anonymous bots and are unused.
- **E-numbers do not resolve upstream.** The autocomplete suggester matches display names, and `e322`/`e100`/`e330` each return a page of unrelated E-numbers. The `additives` facet therefore leans on the 44-entry in-process sample for exact E-number lookups; an E-number outside it will not resolve, though its chemical name (`lecithin`, `aspartame`, `curcumin`) will.
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
| `search.openfoodfacts.org/search?q=…&fields=…&page=…&page_size=…` | GET | ~10/min (search budget) |
| `search.openfoodfacts.org/autocomplete?q=…&taxonomy_names=…&size=…` | GET | ~10/min (taxonomy budget) |

Only the first two rows are governed by a published upstream limit. Open Food Facts documents 15 req/min/IP for `GET /api/v*/product` and 10 req/min/IP for `GET /api/v*/search`, both on `world.openfoodfacts.org`; the local budgets match. `search.openfoodfacts.org` is a separate deployment (search-a-licious) that the published limits do not name and for which no limit is documented, so its two rows are conservative local choices, not mirrors of an upstream figure. The text and tag search paths share one budget, so requests reaching the endpoint the documented 10/min covers stay within it regardless of how a query routes.

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
| Label | `labels_tags` | `en:organic` |
| Nutrition grade | `nutrition_grades_tags` | `a` |
| NOVA group | `nova_groups_tags` | `4` |
| Country | `countries_tags` | `en:france` |
| Allergen | `allergens_tags` | `en:milk` |
| Additive | `additives_tags` | `en:e322` |

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
