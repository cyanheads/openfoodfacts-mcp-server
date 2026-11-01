# openfoodfacts-mcp-server - Directory Structure

Generated on: 2026-11-01 15:21:26

```text
openfoodfacts-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-skill/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── mirror-init.ts
│   ├── mirror-refresh.ts
│   ├── mirror-status.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   └── openfoodfacts-guide/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── browse-taxonomy.tool.ts
│   │       │   ├── compare-products.tool.ts
│   │       │   ├── get-product.tool.ts
│   │       │   ├── index.ts
│   │       │   └── search-products.tool.ts
│   │       └── read-source.ts
│   ├── services/
│   │   ├── mirror/
│   │   │   ├── mirror-feeds.ts
│   │   │   ├── mirror-ingester.ts
│   │   │   ├── mirror-job.ts
│   │   │   ├── mirror-lock.ts
│   │   │   ├── mirror-queries.ts
│   │   │   ├── mirror-scheduler.ts
│   │   │   ├── mirror-store.ts
│   │   │   ├── mirror-sync.ts
│   │   │   └── record-builder.ts
│   │   ├── openfoodfacts/
│   │   │   ├── analyzer-stop-words.ts
│   │   │   ├── nutrition-sets.ts
│   │   │   ├── openfoodfacts-service.ts
│   │   │   ├── types.ts
│   │   │   └── user-agent.ts
│   │   └── taxonomy/
│   │       └── taxonomy-service.ts
│   ├── utils/
│   │   └── markdown.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   ├── as-sold/
│   │   │   ├── v2-3017620422003.json
│   │   │   ├── v2-3664346306027.json
│   │   │   ├── v2-7613035530799.json
│   │   │   ├── v35-16256866.json
│   │   │   ├── v35-3017620422003.json
│   │   │   ├── v35-3033710065783.json
│   │   │   ├── v35-3664346306027.json
│   │   │   ├── v35-7612100914199.json
│   │   │   ├── v35-7613035530799.json
│   │   │   ├── v35-8445290133403.json
│   │   │   └── v35-99999999999994.json
│   │   ├── ingredients/
│   │   │   ├── product-0028400157827.json
│   │   │   ├── product-3046920022651.json
│   │   │   └── product-7622210449283.json
│   │   ├── mirror/
│   │   │   ├── 1001-as-sold-0011126007200.json
│   │   │   ├── 1001-per-100ml-0008112100298.json
│   │   │   ├── 1001-per-serving-0011110135056.json
│   │   │   ├── 1002-as-sold-0006423460193.json
│   │   │   ├── 1002-both-3175681026650.json
│   │   │   ├── 1002-per-100ml-0008295661098.json
│   │   │   ├── 1002-per-serving-0000111301201.json
│   │   │   ├── 1003-as-sold-0000460938714.json
│   │   │   ├── 1003-both-0016000490949.json
│   │   │   ├── 1003-per-100ml-0011110427052.json
│   │   │   ├── 1003-per-serving-0000790310013.json
│   │   │   ├── 1003-prepared-only-0070177248499.json
│   │   │   ├── 1003-unaggregated-0039047145764.json
│   │   │   ├── 1004-as-sold-0008346800025.json
│   │   │   ├── 1004-as-sold-0030000010402.json
│   │   │   ├── 1004-both-0016000289994.json
│   │   │   ├── 1004-estimate-only-0029444423725.json
│   │   │   ├── 1004-no-nutrition-0075779920002.json
│   │   │   ├── 1004-per-100ml-0008017310112.json
│   │   │   ├── 1004-per-serving-0009300000482.json
│   │   │   ├── 1004-prepared-only-01723380.json
│   │   │   ├── 1004-prepared-only-7613035530799.json
│   │   │   ├── 1004-unaggregated-0009800007639.json
│   │   │   ├── le1000-as-sold-0000790200123.json
│   │   │   ├── le1000-both-0044276023004.json
│   │   │   ├── le1000-no-nutrition-0025000054167.json
│   │   │   ├── le1000-per-100ml-0008295661012.json
│   │   │   ├── le1000-per-serving-0000651041025.json
│   │   │   └── le1000-prepared-only-0799475327049.json
│   │   ├── as-sold-captures.ts
│   │   ├── barcode-cases.ts
│   │   ├── canonical-tag-ids.ts
│   │   ├── text-search-fields.ts
│   │   └── upstream-envelopes.ts
│   ├── mcp-server/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── browse-taxonomy.tool.test.ts
│   │           ├── compare-products.tool.test.ts
│   │           ├── get-product.tool.test.ts
│   │           └── search-products.tool.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── mirror/
│   │   │   ├── mirror-feeds.test.ts
│   │   │   ├── mirror-lock.test.ts
│   │   │   ├── mirror-queries.test.ts
│   │   │   ├── mirror-scheduler.test.ts
│   │   │   ├── mirror-store.test.ts
│   │   │   ├── mirror-sync.test.ts
│   │   │   └── record-builder.test.ts
│   │   ├── openfoodfacts/
│   │   │   ├── nutrition-sets.test.ts
│   │   │   └── openfoodfacts-service.test.ts
│   │   └── taxonomy/
│   │       └── taxonomy-service.test.ts
│   ├── tools/
│   └── utils/
│       └── markdown.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── mcp.json
├── package.json
├── plugin.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
