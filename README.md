<div align="center">
  <h1>@cyanheads/openfoodfacts-mcp-server</h1>
  <p><b>Look up food products by barcode, search by ingredient or nutrition filter, compare products side-by-side, and browse the canonical tag vocabulary via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openfoodfacts-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openfoodfacts-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfoodfacts-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openfoodfacts-mcp-server/releases/latest/download/openfoodfacts-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openfoodfacts-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmZvb2RmYWN0cy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openfoodfacts-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenfoodfacts-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openfoodfacts.caseyjhand.com/mcp](https://openfoodfacts.caseyjhand.com/mcp)

</div>

---

## Overview

Food product data from Open Food Facts, a crowd-sourced database of 3M+ packaged food products. Look up items by barcode, search by text and nutrition/allergen/label tags, compare products side-by-side, and resolve everyday terms to the canonical tag vocabulary from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `off_get_product` | Fetch a packaged food product by barcode. Returns name, brand, quantity, ingredients, declared and trace allergens, additives, the vegan/vegetarian/palm-oil analysis, Nutri-Score, NOVA group, Green-Score, nutrition per 100g/serving, categories, labels, countries of sale, and data completeness. |
| `off_search_products` | Search by text query, structured tag filters (category, brand, label, allergen, additive, Nutri-Score grade, NOVA group, country), and numeric per-100 g nutrient thresholds. Returns summary rows with barcodes for follow-up lookups. |
| `off_compare_products` | Side-by-side nutrition and scoring comparison for 2–10 products by barcode. Returns a normalized table of energy, macros, salt, Nutri-Score, NOVA, and Green-Score. |
| `off_browse_taxonomy` | Resolve a human term to the canonical tag ID (categories, labels, allergens, additives, countries, NOVA groups, Nutri-Score grades) that `off_search_products` filters on, against the live Open Food Facts taxonomy. |

## Capability reference

### `off_get_product` <sub>tool</sub>

- Accepts 8–14 digit barcodes (EAN-13, EAN-8, UPC-A, UPC-E)
- Returns ingredients (raw text and parsed list with percent estimates, vegan/vegetarian flags, and each entry's sub-ingredients nested under it — wheat flour under "cereal", palm oil under "vegetable oils" — up to three levels deep), all 14 major allergens as tag IDs, E-number additives, Nutri-Score (`a`–`e`, `unknown`, `not-applicable`), NOVA 1–4, Green-Score (`a-plus`, `a`–`f`, `unknown`, `not-applicable`), every nutrient Open Food Facts holds per 100g and per serving, the serving size those per-serving figures are measured against, categories/labels/packaging/origins/countries of sale as canonical tag IDs, front image URL, and data completeness score (0–1)
- `traces_tags` carries the "may contain" allergen warning separately from the declared `allergens_tags`; `["en:none"]` is the label stating no traces, while an empty array means not yet entered — never trace-free
- `ingredients_analysis_tags` carries the vegan, vegetarian, and palm-oil verdicts Open Food Facts computes itself, including its "maybe" states, rather than leaving the per-ingredient flags to be aggregated by the caller
- Optional `fields` parameter restricts the response to a subset (e.g., scores only, or nutrition only); a field that cannot be read on its own arrives with what it depends on — `nutriments` brings the serving size its per-serving figures are measured against — and `requested_fields` echoes the full set that was fetched
- Open Food Facts is crowd-sourced — a missing field means "not yet entered by contributors," not that the attribute is absent from the actual product
- A barcode no contributor has recorded raises the `not_found` error carrying a recovery hint — it is never returned as an empty result

---

### `off_search_products` <sub>tool</sub>

- Full-text `query` plus structured tag filters — `categories_tag`, `brands_tag`, `labels_tag`, `allergens_tag`, `additives_tag`, `nutrition_grade` (a–e), `nova_group` (1–4), `countries_tag` — and numeric `nutrient_filters`, all combining as AND; all tag values are canonical IDs, resolved via `off_browse_taxonomy` (`brands_tag` matches an exact slug, not free text)
- Numeric `nutrient_filters` express per-100 g thresholds over `energy-kcal`, `fat`, `saturated-fat`, `carbohydrates`, `sugars`, `fiber`, `proteins`, `salt`, and `sodium` — each a `{ nutrient, operator, value }` triple with `lt` / `lte` / `gt` / `gte`; pair two entries on one nutrient for a range. They AND with every other filter and are served by the text backend, so supplying one routes the search there even without `query`
- `additives_tag` filters only on searches carrying neither `query` nor `nutrient_filters` — both route to a backend with no additives field, so the pairing is rejected up front rather than silently returning zero hits
- Pagination via `page` (1-based) and `page_size` (1–50, default 20); text searches serve only the first 10,000 results (`page * page_size` beyond that is rejected), tag-only searches publish no window but refuse deep pages unpredictably
- `total` is exact on tag-only searches; text searches stop counting at 10,000 and set `total_is_lower_bound: true` with the count rendered as `10000+`
- The two paths read different indexes: a search carrying `query` is answered by a text index that lags the live database, and says so on both response surfaces; a tag-only search reads the live database. A recently contributed product can be missing from the first and present in the second
- `sort_by` (`last_modified_t`, `unique_scans_n`, `created_t`, `popularity_key`) orders newest or highest first on both paths; omitting it leaves text searches relevance-ranked
- A page past the end of a result set is reported as an exhausted page naming the deepest page that holds products, not as a zero-match search — the broaden-the-filters guidance appears only when nothing matched
- Returns summary rows (barcode, name, brand, Nutri-Score, NOVA, categories) — chain to `off_get_product` for full label data; counts reflect contributed products, not the market
- Own client-side budget of ~10 requests/min, kept well inside what Open Food Facts asks of clients

---

### `off_compare_products` <sub>tool</sub>

- Accepts 2–10 barcodes, compared in the order provided
- Returns a normalized comparison table: energy (kcal/100g), fat, saturated fat, sugars, salt, protein, fiber, Nutri-Score, NOVA group, and Green-Score; missing nutrition data is preserved as `null`, never imputed
- `not_found` lists barcodes with no contributor record (not an error — the product may simply not be entered yet)
- `failed` lists barcodes whose fetch itself failed, with a per-barcode reason — kept separate from `not_found`, and a failed barcode never blocks the rows that did resolve

---

### `off_browse_taxonomy` <sub>tool</sub>

- Facets `categories`, `labels`, `allergens`, `additives`, `countries` resolve live against the Open Food Facts taxonomy (case-insensitive substring match on tag ID, display name, or a common synonym — "shellfish" resolves to `en:crustaceans`); upstream tags are often plural, so pass the returned `id` through unchanged. Among the live matches, the tag spelling the term itself ranks first (`lentil` → `en:lentils` ahead of `en:lentil-soups`), so a small `limit` does not cut it
- `nova_groups` and `nutrition_grades` are closed vocabularies, returned complete, with bare `"1"`–`"4"` / `"a"`–`"e"` ids
- Live lookups fall back to a small in-process sample when Open Food Facts is unreachable or the budget is spent, and say so rather than failing; omitting `search` returns only that sample, since Open Food Facts can't enumerate a full facet — no `total_in_facet` is reported for the open facets
- `limit` controls results (1–100, default 20); there is no offset or page — narrow the search term instead
- Own client-side budget of ~10 requests/min, separate from the search budget

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Open Food Facts-specific:

- No API key required — the identifying `User-Agent` header (required by OFF terms) is baked into the service layer
- Token-bucket rate limiting per endpoint class: product reads (~15/min), search (~10/min), taxonomy resolution (~10/min). The product and search defaults are the per-IP ceilings Open Food Facts publishes; lower them on a shared outbound IP. Budgets count upstream requests, so a retried request spends its own slot and a budget exhausted mid-retry surfaces as `rate_limited` rather than sending. A local refusal says so — it never reports itself as an Open Food Facts rate limit
- Automatic retry (4 attempts, 500ms base) for transient failures only — 5xx other than 501, timeouts, and 429 (honoring `Retry-After`), with HTML error page detection for 503 during high load. The HTTP status decides: a 4xx or a 501 is sent once and never retried, and the upstream's own explanation is surfaced instead — a rendered error page served with a refusal is reported as a refusal, not as load
- Nutriments normalized from raw hyphenated keys (`energy-kcal_100g`) to underscore form — the `_100g` and `_serving` variants of every nutrient on the record, with the macros as named fields and the rest in an open map that carries each nutrient's own unit (micronutrients are reported in grams, so calcium `0.071` is 71 mg)
- Live tag resolution for `off_browse_taxonomy` against the Open Food Facts taxonomy, merged behind a small in-process sample that covers offline operation and is authoritative for E-number lookups, which the upstream suggester answers poorly

Agent-friendly output:

- Per-serving nutrition always carries its denominator — `serving_size` as printed plus the parsed `serving_quantity`/`serving_quantity_unit`, and an explicit note when Open Food Facts has recorded none
- Computed scores (Nutri-Score, NOVA, Green-Score) returned as-is with regional caveat notes — not interpreted or normalized to health claims
- Graceful partial failure — `off_compare_products` returns resolved rows even when others fail, splitting confirmed-missing barcodes into `not_found` and failed fetches into `failed`
- Every failure carries a declared `reason` and a recovery hint on both client surfaces — timeouts, upstream outages, upstream rejections, and rate limits each resolve to their own error code and their own next step

## Getting started

### Public Hosted Instance

A public instance is available at `https://openfoodfacts.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "openfoodfacts-mcp-server": {
      "type": "streamable-http",
      "url": "https://openfoodfacts.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

No API key is required. Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "openfoodfacts-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/openfoodfacts-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "openfoodfacts-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/openfoodfacts-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "openfoodfacts-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/openfoodfacts-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key needed. The server sends an identifying `User-Agent` to comply with Open Food Facts' terms of service — this is baked in and requires no configuration.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/openfoodfacts-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd openfoodfacts-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if you need to override rate limits or the base URL
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `OFF_BASE_URL` | Open Food Facts API base URL. Override for local testing against a mock server. | `https://world.openfoodfacts.org` |
| `OFF_RATE_LIMIT_PRODUCT` | Product read rate limit (requests/min). Matches the 15 req/min/IP Open Food Facts documents for product reads. | `15` |
| `OFF_RATE_LIMIT_SEARCH` | Search rate limit (requests/min). | `10` |
| `OFF_RATE_LIMIT_TAXONOMY` | Taxonomy resolution rate limit (requests/min). A spent budget falls back to the offline sample rather than failing. | `10` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Log file directory (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t openfoodfacts-mcp-server .
docker run --rm -p 3010:3010 openfoodfacts-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/openfoodfacts-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/services/openfoodfacts` | Open Food Facts API client — HTTP, rate limiting, retry, field normalization. |
| `src/services/taxonomy` | Tag vocabulary service for `off_browse_taxonomy` — live resolution, offline sample, merge and fallback policy. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Attribution

Open Food Facts data is released under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1.0/). Downstream use must cite [Open Food Facts](https://world.openfoodfacts.org/).

## Contributing

Bugs, feature requests, and documentation gaps all belong in an issue — see [`CONTRIBUTING.md`](./.github/CONTRIBUTING.md) for the forms, what makes a report actionable, and how to tell a server bug from a framework one. Vulnerabilities go through [private disclosure](./.github/SECURITY.md), never a public issue.

Working on the code? Both gates must be green:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
