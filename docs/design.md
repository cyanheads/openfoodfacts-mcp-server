# openfoodfacts-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `off_get_product` | Fetch a product by barcode (EAN-13/UPC). Returns name, brands, quantity, ingredients (raw text + parsed list), allergens, additives, Nutri-Score, NOVA group, Green-Score, nutriments per 100g and per serving, categories, labels, packaging, origins, image URL, and completeness signal. Missing fields mean "not yet entered in the database" — not that the attribute is absent from the real product. | `barcode` (string, required), `fields` (optional field subset) | `readOnlyHint: true` |
| `off_search_products` | Search by keyword and/or structured tag filters. Returns summary rows with barcodes for follow-up lookups. Use when the barcode is unknown or to explore a category. Filters use canonical tag IDs (e.g. `en:organic`, `en:gluten-free`) — use `off_browse_taxonomy` to resolve human terms to tag IDs. | `query` (text search), `categories_tag`, `brands_tag`, `labels_tag`, `nutrition_grade`, `nova_group`, `countries_tag`, `page`, `page_size` | `readOnlyHint: true` |
| `off_compare_products` | Side-by-side nutrition and scoring comparison for 2–10 barcodes. Fetches all products in parallel, returns a normalized table of calories, fat, saturated fat, sugars, salt, protein, fiber, Nutri-Score, NOVA, and Green-Score. Designed for "which of these cereals is healthiest?" workflows. | `barcodes` (array of 2–10 EAN/UPC strings) | `readOnlyHint: true` |
| `off_browse_taxonomy` | Look up canonical tag IDs for the common filter vocabularies: categories, labels, allergens, additives, countries, nova groups, nutrition grades. Returns a curated list of tag IDs and their display names for a given facet, optionally filtered by a search term. Use before `off_search_products` to build precise filter values. | `facet` (enum), `search` (optional filter term), `limit` | `readOnlyHint: true`, `openWorldHint: false` |

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

- No API key. Mandatory identifying `User-Agent` header: `openfoodfacts-mcp-server/0.1.0 (casey@caseyjhand.com)` — baked into the service layer, not per-call.
- Read-only — no write-back of product edits.
- Per-endpoint rate limits: product reads ~100/min, search ~10/min. Rate limiting enforced in service layer.
- Field selection mandatory on every request — the product object is ~200 keys; always scope `fields=`.
- Tag vocabulary, not free text — search filters use canonical tag IDs (`en:organic`, `en:gluten-free`).
- Missing fields signal incomplete crowd-sourced data, not product attribute absence — surface this distinction explicitly in tool descriptions and output.
- Computed scores (Nutri-Score, NOVA, Green-Score) carry regional formula and missing-data caveats — return grade letters as-is, never infer absolute health claims.
- DataCanvas for `off_compare_products` when comparing large batches.
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
- `nutrition_grades=e` — single letter a–e
- Multiple filters compose as AND

**Tag filter params in search:** `categories_tags`, `labels_tags`, `allergens_tags`, `additives_tags`, `brands_tags`, `countries_tags` — use canonical `en:X` format. The `_en` suffix variants accept plain English slugs.

### Taxonomy endpoints

`/labels.json`, `/categories.json`, `/facets/categories.json` — return HTTP 503 for anonymous bot requests (rate-limited, requires registered session). **Not usable.** Taxonomy for `off_browse_taxonomy` is implemented as an embedded curated vocabulary in the service layer using known canonical tag patterns, not via live taxonomy endpoint calls.

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
  found: z.boolean().describe('False when the barcode exists in no record (status:0). A false result means no contributor has entered this product yet.'),
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
    }).optional().describe('Nutrition figures. All values may be absent if nutrition data not yet entered.'),
    categories_tags: z.array(z.string()).optional().describe('Category tag IDs in canonical form (e.g. "en:spreads"). Useful as filter values for off_search_products.'),
    labels_tags: z.array(z.string()).optional().describe('Label/certification tag IDs (e.g. "en:organic", "en:no-gluten").'),
    packaging_tags: z.array(z.string()).optional().describe('Packaging material tag IDs.'),
    origins_tags: z.array(z.string()).optional().describe('Ingredient origin tag IDs. Frequently empty.'),
    image_url: z.string().optional().describe('Front image URL (CDN-hosted JPEG).'),
    completeness: z.number().optional().describe('Data completeness score from 0–1. Below 0.5 indicates many fields are missing.'),
    data_quality_tags: z.array(z.string()).optional().describe('Crowd-sourced data quality flags (e.g. "en:nutrition-completed", "en:ingredients-completed-at-least-for-one-language").'),
  }).optional().describe('Product data. Absent when found is false.'),
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
    when: 'Open Food Facts API returns 5xx or is unreachable',
    retryable: true,
    recovery: 'Retry after a brief pause. If persistent, the Open Food Facts service may be experiencing high load.',
  },
]
```

---

### `off_search_products`

**Description:** Search Open Food Facts by text and/or structured tag filters. Returns a summary list with barcodes, product names, brands, Nutri-Score, NOVA group, and categories — enough for triage and selection, not full label data. Use `off_get_product` on the returned barcodes for complete details. Filter values must be canonical tag IDs (e.g. `en:organic`, `en:gluten-free`) — use `off_browse_taxonomy` to resolve human terms to tag IDs. Data is crowd-sourced; result count reflects contributed products, not all products in the market.

**Input schema:**

```ts
z.object({
  query: z.string().optional()
    .describe('Full-text search term across product names, brands, and ingredients. Combine with tag filters for precision. Example: "dark chocolate 70%".'),
  categories_tag: z.string().optional()
    .describe('Canonical category tag ID. Example: "en:breakfast-cereals", "en:cheeses". Use off_browse_taxonomy with facet="categories" to discover valid values.'),
  brands_tag: z.string().optional()
    .describe('Brand slug (lowercased, hyphenated). Example: "nutella", "kellogs". Fuzzy — partial matches may work.'),
  labels_tag: z.string().optional()
    .describe('Canonical label/certification tag ID. Example: "en:organic", "en:fair-trade", "en:no-gluten". Use off_browse_taxonomy with facet="labels".'),
  nutrition_grade: z.enum(['a', 'b', 'c', 'd', 'e']).optional()
    .describe('Filter by Nutri-Score grade. "a" is highest nutritional quality, "e" is lowest. Products without a score are excluded.'),
  nova_group: z.enum(['1', '2', '3', '4']).optional()
    .describe('Filter by NOVA food processing class. 1=unprocessed/minimally processed, 4=ultra-processed. Products without a NOVA score are excluded.'),
  countries_tag: z.string().optional()
    .describe('Canonical country tag ID. Example: "en:france", "en:united-states". Filters to products sold in that country.'),
  page: z.number().int().min(1).default(1)
    .describe('Page number (1-based). Use with page_size to paginate results.'),
  page_size: z.number().int().min(1).max(50).default(20)
    .describe('Results per page (1–50, default 20). Keep low for initial exploration; increase for comparison workflows.'),
})
```

At least one of `query`, `categories_tag`, `brands_tag`, `labels_tag`, `nutrition_grade`, `nova_group`, or `countries_tag` must be provided (validated in handler).

**Output schema:**

```ts
z.object({
  total: z.number().describe('Total matching products in the database for this query.'),
  page: z.number().describe('Current page number (1-based).'),
  page_count: z.number().describe('Products returned on this page (mirrors page_size except possibly on the last page). Not the total number of pages — compute total_pages as Math.ceil(total / page_size) if needed.'),
  products: z.array(z.object({
    barcode: z.string().describe('EAN/UPC barcode. Pass to off_get_product for full details.'),
    product_name: z.string().optional().describe('Product name. May be absent for incompletely entered products.'),
    brands: z.string().optional().describe('Brand name(s).'),
    nutriscore_grade: z.string().optional().describe('Nutri-Score letter (a–e). Absent when not computed.'),
    nova_group: z.number().optional().describe('NOVA processing class (1–4). Absent when not assigned.'),
    categories_tags: z.array(z.string()).optional().describe('Category tag IDs.'),
  })).describe('Matching products. Use barcodes with off_get_product for full label data.'),
})
```

**Errors:**

```ts
errors: [
  {
    reason: 'no_filters',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'No search query or filter was provided',
    recovery: 'Provide at least one of: query, categories_tag, brands_tag, labels_tag, nutrition_grade, nova_group, or countries_tag.',
  },
  {
    reason: 'upstream_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'Open Food Facts API returns 5xx or is unreachable',
    retryable: true,
    recovery: 'Retry after a brief pause. The Open Food Facts service may be rate-limiting or experiencing high load.',
  },
]
```

---

### `off_compare_products`

**Description:** Side-by-side nutrition and scoring comparison for 2–10 products by barcode. Fetches all products in parallel and returns a normalized table of energy (kcal/100g), fat, saturated fat, sugars, salt, protein, fiber, Nutri-Score, NOVA group, and Green-Score. Designed for "which of these three cereals is healthiest?" or "compare these pasta brands" workflows. Missing nutrition data for any product is preserved as null — comparisons are not imputed. Scores carry regional caveats.

**Input schema:**

```ts
z.object({
  barcodes: z.array(
    z.string().regex(/^\d{8,14}$/).describe('EAN-13 or UPC barcode.')
  ).min(2).max(10)
    .describe('2–10 barcodes to compare. All products are fetched in parallel. Example: ["3017620422003", "7622210100146"].'),
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
  })).describe('Comparison rows, one per barcode in input order.'),
  succeeded: z.number().describe('Number of barcodes that resolved to a found product.'),
  not_found: z.array(z.string()).describe('Barcodes with no contributor record. Not an error — product may exist but not yet entered.'),
})
```

DataCanvas: when comparing ≥5 products, the handler registers the comparison table as a canvas dataframe and returns a `canvas_id` in enrichment for downstream SQL queries. Use `spillover()` from `api-canvas` for the spill logic.

**Errors:** No declared contract — partial results (some barcodes found, some not) are returned in the output, not thrown as errors. Upstream 5xx → `serviceUnavailable()` factory.

---

### `off_browse_taxonomy`

**Description:** Browse and search the canonical tag vocabulary for Open Food Facts filter facets. Returns tag IDs and display names for use as filter values in `off_search_products`. Covers categories, labels/certifications, allergens, additives, countries, NOVA groups, and Nutri-Score grades. The taxonomy is embedded — not fetched live — because the OFF taxonomy API is unavailable to anonymous bot clients. Tag IDs use the `en:` prefix convention (e.g. `en:organic`, `en:gluten-free`, `en:milk`).

**Input schema:**

```ts
z.object({
  facet: z.enum([
    'categories', 'labels', 'allergens', 'additives', 'countries',
    'nova_groups', 'nutrition_grades',
  ]).describe('Which vocabulary to browse. "categories" covers food categories (en:cheeses, en:breakfast-cereals). "labels" covers certifications (en:organic, en:fair-trade). "allergens" covers declared allergens (en:milk, en:gluten). "additives" covers E-numbers (en:e322). "countries" covers country-of-sale tags (en:france). "nova_groups" and "nutrition_grades" return the complete fixed vocabularies.'),
  search: z.string().optional()
    .describe('Filter term — case-insensitive substring match against tag ID or display name. Example: "gluten" returns en:gluten, en:no-gluten, en:no-added-gluten. Omit to list all entries for the facet (may be large for categories).'),
  limit: z.number().int().min(1).max(100).default(20)
    .describe('Maximum entries to return (1–100, default 20). Categories has 200K+ entries — always provide a search term when browsing categories.'),
})
```

**Output schema:**

```ts
z.object({
  facet: z.string().describe('The facet that was browsed.'),
  tags: z.array(z.object({
    id: z.string().describe('Canonical tag ID (e.g. "en:organic"). Use this value in off_search_products filter parameters.'),
    name: z.string().describe('Human-readable display name (e.g. "Organic").'),
    products: z.number().optional().describe('Approximate count of products with this tag. Not available for all facets.'),
  })).describe('Matching tag entries.'),
  total_in_facet: z.number().optional().describe('Total entries in this facet before search filtering. Large for categories (~200K).'),
})
```

**Errors:** No domain failures — taxonomy is embedded. Invalid `facet` value is caught by Zod enum validation.

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `openfoodfacts-service` | Open Food Facts API v2 (`world.openfoodfacts.org`) | `off_get_product`, `off_search_products`, `off_compare_products` |
| `taxonomy-service` | Embedded curated vocabulary (no live API) | `off_browse_taxonomy` |

### `openfoodfacts-service`

- **Base URL:** `https://world.openfoodfacts.org`
- **User-Agent:** `openfoodfacts-mcp-server/0.1.0 (casey@caseyjhand.com)` — sent on every request. Required by OFF terms.
- **Field selection:** every call includes `fields=` to scope the product object.
- **Methods:**
  - `getProduct(barcode, fields)` → raw product object or `null` (status:0)
  - `searchProducts(params)` → `{count, page, page_count, page_size, products[]}`
- **Rate limiting:** token bucket per endpoint class — product reads (100/min), search (10/min). Implemented via the framework's rate limiter.
- **Retry:** `withRetry` on the full fetch+parse pipeline. 3 attempts, 500ms base delay (upstream is stateless; 5xx is transient).
- **Parse failure:** HTML error pages (503 during high load) detected by content-type check → `ServiceUnavailable` (not `SerializationError`).
- **Missing barcode:** `status:0` in a 200 response → handler calls `ctx.fail('not_found', ...)`. Do not throw on HTTP status.

### `taxonomy-service`

Embedded static JSON mapping `facet → [{id, name, products?}]` for the major OFF vocabularies. Categories uses a curated subset (~200 most-common tags) — not an exhaustive live dump. Labels, allergens, additives use substantially complete sets from the OFF taxonomy files. Filtered by substring match in the service layer. No network calls; `openWorldHint: false` is correct.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OFF_BASE_URL` | No | Base URL override. Default: `https://world.openfoodfacts.org`. Useful for testing against a mock server. |
| `OFF_RATE_LIMIT_PRODUCT` | No | Product read rate limit (requests/min). Default: `100`. |
| `OFF_RATE_LIMIT_SEARCH` | No | Search rate limit (requests/min). Default: `10`. |

No API key. The identifying User-Agent is hardcoded in the service layer from `package.json` name/version and a static contact address.

---

## Implementation Order

1. **Config** — `src/config/server-config.ts` with `OFF_BASE_URL`, `OFF_RATE_LIMIT_PRODUCT`, `OFF_RATE_LIMIT_SEARCH`.
2. **Taxonomy service** — `src/services/taxonomy/taxonomy-service.ts` + embedded vocabulary JSON. No network. Implement first because it has no deps and provides the vocabulary needed to validate design decisions.
3. **OpenFoodFacts service** — `src/services/openfoodfacts/openfoodfacts-service.ts` with `getProduct()` and `searchProducts()`. Validate against real API.
4. **`off_get_product`** — primary tool, single-product lookup with field normalization.
5. **`off_search_products`** — search with composed tag filters.
6. **`off_compare_products`** — parallel fetch + normalization + optional DataCanvas spill.
7. **`off_browse_taxonomy`** — thin wrapper over taxonomy service.
8. **`createApp()` wiring** — register all tools, set `instructions`.

Each step is independently testable via `bun run devcheck` + `bun run rebuild`.

---

## Design Decisions

**No resources.** Product data is mutable (crowd-sourced) and not suitable for stable URI caching. Tool-only clients are the primary target.

**No prompts.** The domain is data retrieval; no recurring analysis frameworks benefit from a prompt template.

**Taxonomy is embedded, not live.** The OFF taxonomy API (`/labels.json`, `/categories.json`) returns 503 for anonymous bot clients at current traffic levels. Embedding a curated vocabulary is the only reliable path. The tradeoff is that very new tags won't appear, but the 200 most-used category tags, all 14 major allergens, and the full label/certification vocabulary are stable.

**`off_compare_products` keeps partial results in output, not errors.** When 3 of 5 barcodes resolve and 2 are not found, the caller gets a comparison table for the 3 found products plus a `not_found` list. Throwing when any product is missing would break "compare this grocery basket" workflows where some products are regional or recent.

**`off_browse_taxonomy` is a separate tool, not bundled into `off_search_products`.** Tag vocabulary lookup is an independent need — it's used to build search filters, not as part of executing a search. Keeping it separate maintains clean tool boundaries and allows tag exploration without triggering a search call.

**Field selection via input enum, not open string array.** Restricts to the fields the server actually handles and normalizes, preventing callers from requesting raw OFF fields that the output schema doesn't cover. The enum doubles as documentation of what's available.

**NOVA group as `number` in output, `enum(['1','2','3','4'])` in search input.** Zod coercion converts the input string to the parameter value. The nutriments object also embeds `nova-group` as a number; consistency is preserved in the output schema.

**Nutriments normalized in the output schema.** The raw OFF nutriments object uses hyphenated keys (`energy-kcal_100g`) that are not valid TypeScript identifiers. The service layer normalizes to underscore form (`energy_kcal_100g`) and extracts only the `_100g` and `_serving` variants — the raw key suffixes (`_value`, `_unit`, `_modifier`) are dropped from structured output but surfaced in `format()` for display context where relevant.

---

## Known Limitations

- **Crowd-sourced completeness varies widely by region.** French and Western European products are well-covered; products from other regions may be sparse or missing entirely.
- **Taxonomy endpoint unavailable to bots.** `/labels.json` and `/categories.json` return 503 for anonymous bot clients. `off_browse_taxonomy` uses embedded vocabulary.
- **Search rate limit is strict (10/min).** Agents running rapid multi-search workflows will hit this. Surface the rate limit in service-layer error messaging and backoff.
- **Barcode collisions exist.** A small number of barcodes map to multiple regional product variants. OFF returns the most-contributed variant; the tool doesn't attempt disambiguation.
- **Eco-Score/Green-Score is often "unknown".** Requires packaging material data, origins, and transport data — typically incomplete. The tool returns the value as-is.
- **NOVA group 2 (culinary ingredients) is rarely tagged.** Most products without a NOVA tag are either unprocessed (1) or ultra-processed (4); the middle categories are underrepresented in crowd-sourced data.

---

## API Reference

### Endpoints used

| Endpoint | Method | Rate limit |
|:---------|:-------|:-----------|
| `/api/v2/product/{barcode}.json?fields=…` | GET | ~100/min |
| `/api/v2/search?fields=…&page=…&page_size=…&{filters}` | GET | ~10/min |

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
| Nutrition grade | `nutrition_grades` | `a` |
| NOVA group | `nova_groups` | `4` |
| Country | `countries_tags` | `en:france` |
| Allergen | `allergens_tags` | `en:milk` |

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
