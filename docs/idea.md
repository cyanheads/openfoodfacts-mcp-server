# openfoodfacts-mcp-server — Idea & Requirements

Barcode-to-label for 3M+ food products worldwide via Open Food Facts — ingredients, allergens, additives, Nutri-Score, NOVA processing class, and per-100g nutrition.

| | |
|---|---|
| **Status** | Pre-build design · scaffolded on `@cyanheads/mcp-ts-core@0.9.16` |
| **Category** | external-data |
| **Auth** | none (identifying User-Agent required) |
| **API cost** | free, open data (ODbL); ~100 req/min product reads, ~10 req/min search |
| **Pattern** | deep single-source |
| **Complexity** | low |
| **Composes with** | `usda-mcp-server`, `openfda-mcp-server` |

## Overview

Global packaged-food database via [Open Food Facts](https://world.openfoodfacts.org) — barcode lookup for 3M+ products with ingredients, allergens, additives, Nutri-Score, NOVA processing class, Green-Score, and per-100g nutrition. Free, open data (ODbL), no key; the API only asks for an identifying User-Agent.

Complements `usda-mcp-server` (US FoodData Central — generic, US-centric foods): Open Food Facts is the global, barcode-addressable, branded-product side. Enter a barcode anywhere in the world and get the label back. Crowd-sourced, so completeness varies by region and product — but it's the largest open product database that exists.

## Audience

Diet and allergen tracking, grocery and meal-planning tools, health-conscious shoppers, agents turning a barcode or product name into structured nutrition and ingredient data.

## User Goals

- Look up a product by barcode and get its full label (ingredients, nutrition, scores)
- Search by name, brand, or category when the barcode is unknown
- Check a product for specific allergens or additives
- Compare the nutrition or processing level of several products
- Filter by attribute (organic, vegan, gluten-free, Nutri-Score grade)

## API Surface

Open Food Facts API v2, keyless. Barcode (EAN-13 / UPC) is the primary key; field selection trims the large product object. An identifying User-Agent is mandatory per their terms.

| Endpoint | Purpose | Notes |
|:---|:---|:---|
| `/api/v2/product/{barcode}.json` | Single product by barcode | `fields=` selects a subset of the ~200-key object |
| `/api/v2/search` | Filtered product search | Tag filters: categories, brands, labels, nutrition_grades, nova_group, allergens, countries |
| `/api/v2/product/{barcode}?fields=…` | Field-scoped reads | Keep payloads small |
| Taxonomy (`/categories.json`, `/labels.json`, …) | Facet / tag vocabularies | Resolve human terms to canonical tag IDs |

Key fields: `product_name`, `brands`, `quantity`, `ingredients_text` + parsed `ingredients[]`, `allergens_tags`, `additives_tags`, `nutriscore_grade`, `nova_group` (1–4), `ecoscore_grade` / `environmental_score`, `nutriments` (per 100g + per serving), `categories_tags`, `labels_tags`, `packaging`, `origins`, `image_url`.

## Tool Surface (planned)

| Tool | Behavior |
|:---|:---|
| `off_get_product` | **Primary.** Product by barcode (EAN/UPC): name, brands, quantity, ingredients (raw + parsed), allergens, additives, Nutri-Score, NOVA group, Green-Score, nutriments per 100g and per serving, categories, labels, packaging, origins, image URL. Field selection to trim the object. |
| `off_search_products` | Search by name/keyword plus structured filters: category, brand, label, nutrition_grade (a–e), nova_group, allergen-free, country. Returns summary fields + barcodes for follow-up. Discovery path when the barcode is unknown. |
| `off_compare_products` | Side-by-side comparison of N barcodes → table of calories, sugar, salt, fat, protein, fiber, Nutri-Score, NOVA. "Which of these three cereals is healthiest?" |
| `off_browse_taxonomy` | Resolve human terms to canonical tag IDs and browse facet vocabularies (categories, labels, allergens, additives). "plant-based milk" → `en:plant-based-milks`. Builds precise search filters. |

## Design Notes & Requirements

- **Field selection is mandatory discipline** — the product object is ~200 keys; always scope `fields=`.
- **Tag vocabulary, not free text** — search filters use canonical tags (`en:organic`), hence `off_browse_taxonomy`.
- **Data is crowd-sourced** — completeness and accuracy vary. Surface completeness signals where present, and never imply a missing field means "absent from the product" — it means "not yet entered." Be explicit in tool descriptions.
- **Computed scores carry caveats** — Nutri-Score, NOVA, Green-Score have regional formula versions and missing-data sensitivity. Return grade letters, not absolute truth.
- **Identifying User-Agent is required** (`app-name/version (contact)`) — bake into the service layer. Read-only; no write-back of product edits.
- **Per-endpoint rate limits** — product reads ~100/min, search ~10/min, facets ~2/min. Rate-limit search/facet paths more tightly than reads.
- DataCanvas fits large-category search and many-item comparison.

## Build Constraints

- Framework: `@cyanheads/mcp-ts-core@0.9.16`
- No key, but mandatory identifying User-Agent → hostable
- Attribution: data under ODbL; credit Open Food Facts
- Per-endpoint rate limiting in the service layer
- (Moonshot) sibling databases share the API shape — Open Beauty Facts, Open Pet Food Facts, Open Products Facts — a `domain` param could extend later; scope v1 to food
