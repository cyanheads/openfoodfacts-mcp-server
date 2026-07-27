# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-26

OFF_RATE_LIMIT_PRODUCT now defaults to 15/min, the per-IP ceiling Open Food Facts publishes for product reads, down from a default that permitted 6.6x that rate.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-26

off_browse_taxonomy resolves search terms against the live Open Food Facts taxonomy instead of a 79-entry embedded list, and nova_groups tag IDs are now bare digits that round-trip into off_search_products.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-26 · ⚠️ Breaking

BREAKING: off_get_product drops the unreachable found field and makes product required. Nutriments now cover every upstream nutrient via additional_100g/additional_serving, per-serving figures carry serving_size, and format() reaches full parity with structuredContent.

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-07-26

Add allergens_tag/additives_tag search filters, correct the brands_tag exact-match description, and stop reporting the text backend's clipped 10,000-result count as an exact total.

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-07-26

Declare typed reasons (upstream_error, upstream_timeout, upstream_rejected, rate_limited) across the service layer, split off_compare_products failures from not_found, pre-flight the text-search 10k-result window, and adopt mcp-ts-core ^0.11.0.

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-07-05

Combine free-text queries with tag filters in off_search_products via a single search-a-licious Lucene query, escape free text against injection, rewrite tool descriptions to drop implementation details, and derive USER_AGENT from package.json.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-07-05

Fix off_search_products score-filter query params, off_browse_taxonomy false truncation on filtered searches, and off_get_product field-subset rendering; adopt mcp-ts-core ^0.10.12, clearing a transitive js-yaml DoS advisory.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9: two new static devcheck guards (dependency specifiers, plugin marketplace manifests), re-synced vendored skills, and dependency refresh.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-15

Run the release:github script under bun instead of tsx, which is not installed.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core ^0.10.6: truncation disclosure on search and taxonomy, explicit server identity, MCPB bundle hardening, and Docker healthcheck.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-04

off_search_products: add sort_by parameter and ecoscore_grade (Green-Score) to search result rows.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core ^0.9.21 — per-request log context fix, secret-stripped error messages, and fail-fast retry behavior.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-30

Public hosted endpoint at https://openfoodfacts.caseyjhand.com/mcp — connect via Streamable HTTP without installing.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-30

Initial release — 4 tools for barcode lookup, product search, side-by-side comparison, and taxonomy browsing across the Open Food Facts database (3M+ products, keyless, ODbL 1.0).
