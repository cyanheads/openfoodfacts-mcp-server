<div align="center">
  <h1>@cyanheads/openfoodfacts-mcp-server</h1>
  <p><b>Look up food products by barcode, search by ingredient or nutrition filter, compare products side-by-side, and browse the canonical tag vocabulary via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/openfoodfacts-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/openfoodfacts-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/openfoodfacts-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^5.9.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/openfoodfacts-mcp-server/releases/latest/download/openfoodfacts-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=openfoodfacts-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3BlbmZvb2RmYWN0cy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22openfoodfacts-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fopenfoodfacts-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://openfoodfacts.caseyjhand.com/mcp](https://openfoodfacts.caseyjhand.com/mcp)

</div>

---

## Tools

Four tools for working with [Open Food Facts](https://world.openfoodfacts.org/) — a free, crowd-sourced database of 3M+ packaged food products:

| Tool | Description |
|:-----|:------------|
| `off_get_product` | Fetch a packaged food product by barcode. Returns name, brand, quantity, ingredients, allergens, additives, Nutri-Score, NOVA group, Green-Score, nutrition per 100g/serving, categories, labels, and data completeness. |
| `off_search_products` | Search by text query and/or structured tag filters (category, brand, label, Nutri-Score grade, NOVA group, country). Returns summary rows with barcodes for follow-up lookups. |
| `off_compare_products` | Side-by-side nutrition and scoring comparison for 2–10 products by barcode. Returns a normalized table of energy, macros, salt, Nutri-Score, NOVA, and Green-Score. |
| `off_browse_taxonomy` | Browse and search the canonical tag vocabulary (categories, labels, allergens, additives, countries, NOVA groups, Nutri-Score grades) for use as filter values in `off_search_products`. |

### `off_get_product`

Fetch a packaged food product by barcode (EAN-13 or UPC).

- Accepts 8–14 digit barcodes (EAN-13, EAN-8, UPC-A, UPC-E)
- Returns ingredients (raw text and parsed list with percent estimates, vegan/vegetarian flags), all 14 major allergens as tag IDs, E-number additives, Nutri-Score a–e, NOVA 1–4, Green-Score/Eco-Score, full nutriments per 100g and per serving, categories/labels/packaging/origins as canonical tag IDs, front image URL, and data completeness score (0–1)
- Optional `fields` parameter restricts the response to a subset (e.g., scores only, or nutrition only)
- Open Food Facts is crowd-sourced — a missing field means "not yet entered by contributors," not that the attribute is absent from the actual product
- `found: false` means no contributor has recorded this barcode yet — not a product defect

---

### `off_search_products`

Search Open Food Facts by text and/or structured tag filters.

- Full-text search across product names, brands, and ingredients
- Structured filters: `categories_tag`, `brands_tag`, `labels_tag`, `nutrition_grade` (a–e), `nova_group` (1–4), `countries_tag`
- All filter values are canonical tag IDs — use `off_browse_taxonomy` to resolve human terms (e.g., "organic" → `en:organic`)
- Pagination via `page` (1-based) and `page_size` (1–50, default 20); response includes `total` count for computing total pages
- Returns summary rows (barcode, name, brand, Nutri-Score, NOVA, categories) — use `off_get_product` for full label data
- Result counts reflect contributed products, not total products on the market
- Search rate-limited to ~10 requests/min by the Open Food Facts API

---

### `off_compare_products`

Side-by-side nutrition and scoring comparison for 2–10 barcodes.

- Fetches all products in parallel
- Returns a normalized comparison table: energy (kcal/100g), fat, saturated fat, sugars, salt, protein, fiber, Nutri-Score, NOVA group, and Green-Score
- Missing nutrition data is preserved as `null` — comparisons are not imputed or estimated
- `not_found` list identifies barcodes with no contributor record (partial results are not an error)

---

### `off_browse_taxonomy`

Browse the canonical Open Food Facts tag vocabulary before building `off_search_products` filters.

- Facets: `categories`, `labels`, `allergens`, `additives`, `countries`, `nova_groups`, `nutrition_grades`
- Optional `search` parameter: case-insensitive substring match against tag ID or display name (e.g., `"gluten"` → `en:gluten`, `en:no-gluten`, `en:no-added-gluten`)
- Taxonomy is embedded (not fetched live) because the OFF taxonomy API is unavailable to anonymous bot clients at current traffic levels
- Categories facet has 200K+ entries — always include a `search` term when browsing categories
- `limit` controls results returned (1–100, default 20)

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Open Food Facts-specific:

- No API key required — the identifying `User-Agent` header (required by OFF terms) is baked into the service layer
- Token-bucket rate limiting per endpoint class: product reads (~100/min), search (~10/min)
- Automatic retry (3 attempts, 500ms base) with HTML error page detection for 503 during high load
- Nutriments normalized from raw hyphenated keys (`energy-kcal_100g`) to underscore form — only the `_100g` and `_serving` variants are returned
- Embedded tag taxonomy for `off_browse_taxonomy` — curated 200+ category subset, full allergen/label/additive vocabularies

Agent-friendly output:

- `found` field on every product response — explicit `false` when a barcode has no contributor record, not a thrown error
- Missing fields signal incomplete crowd-sourced data, not product attribute absence — surfaced in descriptions and format output
- Computed scores (Nutri-Score, NOVA, Green-Score) returned as-is with regional caveat notes — not interpreted or normalized to health claims
- `not_found` list in `off_compare_products` allows partial batch comparisons without request failure

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
| `OFF_RATE_LIMIT_PRODUCT` | Product read rate limit (requests/min). | `100` |
| `OFF_RATE_LIMIT_SEARCH` | Search rate limit (requests/min). | `10` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`). | `info` |
| `LOGS_DIR` | Log file directory (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

> **Attribution:** Open Food Facts data is released under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1.0/). Downstream use must cite [Open Food Facts](https://world.openfoodfacts.org/).

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
| `src/services/taxonomy` | Embedded tag vocabulary service for `off_browse_taxonomy`. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
