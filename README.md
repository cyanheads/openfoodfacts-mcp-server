<div align="center">
  <h1>@cyanheads/openfoodfacts-mcp-server</h1>
  <p><b>Look up food products by barcode, search by keyword, tag, allergen, or nutrition filter, compare products side-by-side, and browse the canonical tag vocabulary via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.7-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openfoodfacts-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openfoodfacts-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfoodfacts-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Packaged-food data from Open Food Facts, a crowd-sourced database of 3M+ products. Look up items by barcode, search by text, tags, allergens, and nutrient thresholds, compare products side by side, and resolve everyday terms to the canonical tags the filters take. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `off_get_product` | Fetch one product by barcode: ingredients, allergens and traces, additives, scores, nutrition, and tags |
| `off_search_products` | Search by text, tag filters, allergen exclusions, and per-100 g nutrient thresholds; returns summary rows with barcodes |
| `off_compare_products` | Compare 2–10 products by barcode on per-100 g nutrition, Nutri-Score, NOVA, and Green-Score |
| `off_browse_taxonomy` | Resolve a human term to the canonical tag ID that `off_search_products` filters on |

## Capability reference

### `off_get_product` <sub>tool</sub>

- `barcode` is digits only, 4–40 digits after any leading zeros; optional `fields` trims the response and pulls in what a field depends on (`nutriments` brings the serving size), with `requested_fields` echoing what was fetched
- Returns ingredients (raw text plus a parsed tree up to three levels deep with `percent_estimate`), `allergens_tags`, `traces_tags`, `additives_tags`, `ingredients_analysis_tags` (vegan, vegetarian, palm-oil verdicts), `nutriscore_grade`, `nova_group`, `ecoscore_grade` (Green-Score), `nutriments` per 100 g and per serving, category/label/packaging/origin/country tags, `image_url`, and `completeness` (0–1)
- `traces_tags: ["en:none"]` means the label states no traces, while an empty array means none entered yet; a barcode no contributor has recorded fails as `not_found`

---

### `off_search_products` <sub>tool</sub>

- `query` (up to 24 words; every word except common stop words must match the name, generic name, categories, labels, or brand) plus tag filters `categories_tag`, `brands_tag`, `labels_tag` (up to 10, all must apply), `allergens_tag`, `traces_tag`, `ingredients_analysis_tag`, `additives_tag`, `nutrition_grade`, `nova_group`, `countries_tag`, the `exclude_allergens` / `exclude_traces` lists (up to 14 each), and up to 18 per-100 g `nutrient_filters`, all combined as AND; `page_size` 1–50 (default 20), optional `sort_by`
- Summary rows carry `barcode`, `product_name`, `brands`, `nutriscore_grade`, `nova_group`, `ecoscore_grade`, and `categories_tags`, alongside `total`, `total_is_lower_bound`, `last_page`, and `omitted`; responses using an exclusion carry `exclusion_coverage`, since products with no allergen data entered pass it
- `query` or `nutrient_filters` routes the search to a text index that lags the live database (flagged in `text_index_snapshot`), serves only the first 10,000 results, and rejects `additives_tag` as `additives_filter_needs_tag_search`; tag-only searches read the live database through page 10, and a page past either bound fails as `page_out_of_range`

---

### `off_compare_products` <sub>tool</sub>

- 2–10 `barcodes`, returned one row each in input order
- Rows carry `found`, `nutriscore_grade`, `nova_group`, `ecoscore_grade`, per-100 g energy, fat, saturated fat, sugars, salt, protein, and fiber, and `completeness`; missing values stay absent, never imputed
- `not_found` lists barcodes with no contributor record and `failed` lists fetches that failed, each with a `reason`; a failed barcode gets no row and never blocks the rest

---

### `off_browse_taxonomy` <sub>tool</sub>

- `facet` is one of `categories`, `labels`, `allergens`, `additives`, `countries`, `nova_groups`, `nutrition_grades`; `search` matches a substring of the tag ID, name, or a synonym ("shellfish" → `en:crustaceans`); `limit` 1–100 (default 20), with no paging
- Returns `tags[]` of `id` and `name`, where `id` goes to `off_search_products` unchanged; `nova_groups` and `nutrition_grades` come back complete with `total_in_facet`
- The five open facets resolve against the live Open Food Facts taxonomy and fall back to a small offline sample, with a `notice`, when it is unreachable or the budget is spent; omitting `search` returns only that sample

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Open Food Facts-specific:

- No API key; the identifying `User-Agent` Open Food Facts' terms require is built in
- Per-endpoint request budgets (product 15/min, search 10/min, taxonomy 10/min), counted per upstream attempt; transient failures (5xx other than 501, timeouts, 429 with `Retry-After`) retry up to 4 attempts, while a 4xx or 501 is sent once
- Nutriments normalized from hyphenated keys (`energy-kcal_100g` → `energy_kcal_100g`), with named macros plus `additional_100g` / `additional_serving` maps that carry each nutrient's own unit
- Tag filters take canonical IDs (`en:organic`, `en:no-gluten`); on text searches a case variant, synonym, or brand name is canonicalized before it is sent (`US` → `en:united-states`, `Nutella` → `nutella`)
- Every field is contributor-entered, so a missing one means not yet recorded rather than absent from the product; Nutri-Score, NOVA, and Green-Score are Open Food Facts' own computed grades, returned as-is, and carry regional formula caveats

Agent-friendly output:

- Per-serving nutrition carries its denominator: `serving_size`, `serving_quantity`, `serving_quantity_unit`, and a note when none is recorded
- Graceful partial failure: `off_compare_products` returns resolved rows alongside `not_found` and `failed`
- Explicit count bounds: `total_is_lower_bound`, `last_page`, and `omitted` on searches, and an exhausted page is reported as such rather than as zero matches
- Typed failures: each carries a declared `reason` (`upstream_error`, `upstream_timeout`, `upstream_rejected`, `rate_limited`, plus per-tool input reasons) and a recovery hint on both client surfaces

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account. Open Food Facts asks clients to identify themselves, and the server's `User-Agent` does so without configuration.

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

| Variable | Description | Default |
|:---------|:------------|:--------|
| `OFF_BASE_URL` | Open Food Facts API base URL. | `https://world.openfoodfacts.org` |
| `OFF_RATE_LIMIT_PRODUCT` | Product read budget (requests/min). The default is Open Food Facts' published per-IP limit; lower it on a shared outbound IP. | `15` |
| `OFF_RATE_LIMIT_SEARCH` | Search budget (requests/min). The default is Open Food Facts' published per-IP limit. | `10` |
| `OFF_RATE_LIMIT_TAXONOMY` | Taxonomy lookup budget (requests/min), shared by `off_browse_taxonomy`, tag canonicalization on text searches, and exclusion checks. | `10` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
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
| `src/services/taxonomy` | Tag vocabulary — live resolution, offline sample, and tag-value canonicalization. |
| `src/utils` | Markdown escaping for contributor-entered values in text output. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome — see [`CONTRIBUTING.md`](./.github/CONTRIBUTING.md) for the forms and what makes a report actionable. Report vulnerabilities through [private disclosure](./.github/SECURITY.md), never a public issue. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details. Open Food Facts data is released under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1.0/); downstream use must cite [Open Food Facts](https://world.openfoodfacts.org/).
