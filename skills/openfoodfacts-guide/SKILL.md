---
name: openfoodfacts-guide
description: Judgment for the off_* tools (Open Food Facts) — allergy checks that never overclaim, choosing among a product's many barcodes, where tag IDs come from, grade ranges, free-from searches, and the search budget. Use when answering allergy, diet, ingredient, additive, Nutri-Score, NOVA, or product-comparison questions about packaged foods with off_get_product, off_search_products, off_compare_products, or off_browse_taxonomy.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Packaged, barcoded foods as Open Food Facts contributors recorded them: label text, declared allergens and traces, additives, Open Food Facts' computed grades, and nutrition per 100 g (per 100 ml for liquids) and per serving. It is not a verdict on whether a food is safe for a particular person, and it holds no recalls. Reference composition for generic, unbranded foods belongs to a food-composition database such as USDA FoodData Central.

## Identifiers

| Identifier | Where it comes from |
|:--|:--|
| Barcode | The user (a scan or the pack), or the rows of off_search_products. One product has many barcodes — sizes, regional editions, reformulations — and each is a separate record with its own completeness and grades. |
| Tag ID (`en:organic`, `en:nuts`) | off_browse_taxonomy, or the tag arrays on a product record. The same ID can mean different things in different facets: the category `en:nuts` holds peanut products, while the allergen `en:nuts` means tree nuts. |
| Category tags | A record carries its category's ancestors too (a pistachio row lists `en:snacks`, `en:salty-snacks`, `en:nuts`, `en:pistachios`), so a broad category filter also matches products filed under its subcategories. |
| Off-taxonomy entries | A product's tag arrays can hold contributor entries the taxonomy never canonicalized: a non-`en:` prefix or display text with capitals, spaces, or accents (`fr:Goûter`, `en:Pâtes à tartiner`). Don't reuse one as a filter value; resolve the concept with off_browse_taxonomy first. |

## Gates

1. **Allergy questions: never answer "safe" or "free of X".** Report what the record says and how far it goes. Read all three sources: `ingredients_text` (in the label's own language, often with allergens emphasized in capitals or brackets), `allergens_tags`, and `traces_tags`. An empty `traces_tags` means no trace data was entered, not that the label carries no warning. When the three disagree, say the record is unreliable: a record can carry a truncated ingredients text beside allergen tags that text cannot support. End by pointing the user to the physical label.
2. **Nut allergies need two tags.** `en:nuts` means tree nuts; peanuts are the separate `en:peanuts`. Check both on the record, and pass both to exclude_allergens or exclude_traces.
3. **Free-from searches start from a positive claim.** An exclusion alone also passes every product with no allergen data entered, so select first on something the record asserts: a label (`en:no-gluten`, `en:vegan`) or a free-from category (`en:gluten-free-pasta`). Add the exclusion on top, then confirm shortlisted barcodes with off_get_product. For vegan, the ingredients-analysis verdict `en:vegan` is Open Food Facts' computation from the parsed ingredients, while the label `en:vegan` is a claim printed on the pack. They are different evidence, so say which one you used.
4. **Grade ranges take one call per grade.** nutrition_grade and nova_group each take a single value. For "Nutri-Score B or better", search once with `a` and once with `b`, then merge the results. A product with no grade drops out of both searches.
5. **A product named without a barcode: pick a barcode deliberately.** Don't take the first search row on faith. Records for one product can carry different Nutri-Score and NOVA grades even when their nutrition is identical, when one record's ingredient list or other entered data is incomplete. Prefer the user's own barcode. Otherwise sort by unique_scans_n, favor high completeness, and name the barcode the answer came from.
6. **Grades are Open Food Facts' computation from the record**, not the grade printed on the pack. When a user quotes a different grade, the record's data is the first suspect: check its `completeness`, `data_quality_tags`, and ingredient list.
7. **Spend searches one at a time.** The search budget is about 10 upstream requests a minute on the default configuration. The server process holds it, so every caller of a shared deployment draws from it, and each retry of a failing request spends its own slot. Never fan out parallel searches; when the budget runs out, the error's `data.retryAfter` gives the wait. Product lookups draw on a separate budget, but off_compare_products spends one lookup from it per barcode, the same as off_get_product.

## Workflows

**Allergy or diet check on one product.** Call off_get_product, with `fields` narrowed to the ingredients, allergen, trace, and analysis fields when nutrition doesn't matter. Apply gates 1 and 2. If the user named a product rather than a barcode, apply gate 5 first.

**Find products matching a diet and a nutrition target.** Resolve each human term (category, label, allergen, country) with off_browse_taxonomy. Express the diet as a positive claim (gate 3), the grade as one search per grade (gate 4), and the nutrition target as nutrient_filters. Nutrient filters move the search to the lagging text index, and each row then carries the index values the filters were checked against. The index compares energy-kcal, fat, saturated-fat, carbohydrates, and sugars as whole numbers, so the server checks every returned row against the constraints and leaves out rows that fail, counting them in `outside_constraints`. A page can come back short or empty while later pages hold matches, and `total` and `last_page` describe the index's whole-number answer, not the products that meet the constraints. A range inside one whole number (`sugars` above 3.9 and below 4) can pass few rows, so add a query or tag filters. Confirm the shortlist with off_get_product before presenting it.

**Compare products.** off_compare_products returns nutrition and grades only: no ingredients, allergens, or additives. Open Food Facts returns one preparation state of the nutrition per read: figures for the prepared product arrive in a row's `prepared` object, and a row whose as-sold figures are absent beside it means that read returned none, not that the record holds none. Don't compare an as-sold figure with a prepared one. For additives or allergens, follow up per barcode with off_get_product, narrowing `fields` to `additives_tags`, `allergens_tags`, and `ingredients_text`. Mind the shared product budget when the list is long (gate 7). Don't count additives by array length: `additives_tags` can list a parent and a specific form of the same additive (`en:e322` lecithins and `en:e322i` soya lecithin on one record). off_browse_taxonomy with facet `additives` and the E-number gives the additive's name.

**A tag-only search fails with upstream_error.** Searches by tag filters alone and searches carrying a query read separate backends, so one can fail while the other answers. Add a query word the product's name or category would carry (`pasta` with `categories_tag` `en:pastas`) to reroute the same filters to the text index. This doesn't work with additives_tag, and the text index lags the live database, so say so when you report results that came through it.
