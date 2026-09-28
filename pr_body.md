Closes #429
Closes #392
Closes #391
Closes #387

## Summary

This PR implements four issues assigned to this repository:

### 1. feat(webhooks): Implement Mutual TLS (mTLS) Client Certificate Authentication for Enterprise Webhooks (#429)

**Problem:** Enterprise merchants require mutual TLS (mTLS) authentication for webhook delivery to guarantee cryptographic authenticity of all incoming facilitator events. The existing webhook system only supported HMAC-SHA256 signatures.

**Changes:**
- Added `src/webhooks/mtls.js` — Full mTLS implementation with:
  - Custom HTTPS Agent factory loading merchant TLS certificates from secure vault
  - Per-endpoint mTLS configuration fields in the webhook schema
  - Certificate expiration alerting with `describeCertificate()` and `checkCertificateExpiry()`
  - Fallback to HMAC-SHA256 signatures for non-enterprise merchants
  - Agent pooling per credential to reuse TLS connection pools across deliveries
  - Credential lifecycle management with TTL-based re-resolution from Vault
- Updated `src/webhooks/dispatcher.js` — Added mTLS delivery support alongside existing HMAC signing
- Added `test/helpers/test-certificates.js` — Self-contained X.509 certificate builder using only `node:crypto` for real TLS handshake testing
- Added `test/webhooks.test.js` — Comprehensive mTLS test suite covering:
  - mTLS delivery success and certificate rejection
  - mTLS + HMAC signature composition
  - Certificate expiry alerting (warning window, lapsed, healthy)
  - Credential lifecycle (pooling, rotation, concurrent deliveries)
  - mTLS record plumbing and dead-letter handling

**Verification:** `npm test -- test/webhooks.test.js` passes all 34 tests. `npm run lint` is clean.

---

### 2. perf(cache): Implement Multi-Tier Redis & Local Memory LRU Cache for Catalog Searches (#392)

**Problem:** Discovery is the read-mostly hot path of the facilitator. Every miss against `/discovery/search` costs a full Postgres scan with a lexical + dense ranking pass.

**Changes:**
- Added `src/catalog/cache.js` — Two-tier cache implementation:
  - L1: In-process LRU cache (~5s TTL) absorbing repeat traffic on this node
  - L2: Redis cache (60s TTL) absorbing traffic that misses L1 across replicas
  - Cross-replica invalidation via Redis Pub/Sub
  - Version-based correctness using `CatalogStore.getVersion()` to prevent stale reads
  - OpenTelemetry metrics for cache hit/miss ratios
- Added `src/catalog/search.js` — Search integration with cache-aware query routing
- Updated `src/config.js` — Added `catalogSearchCache` configuration option
- Updated `src/server.js` — Wired the cache into the server startup pipeline
- Added `test/catalog.cache.test.js` — 816 lines of comprehensive cache tests covering:
  - L1/L2 hit/miss behavior
  - Version-based invalidation
  - Redis Pub/Sub invalidation
  - Cache pruning and TTL expiry
  - Metrics tracking

**Verification:** `npm test -- test/catalog.cache.test.js` passes. `npm run lint` is clean.

---

### 3. feat(mcp): Add Semantic Resource Discovery & Prompt Templates to MCP Server (#391)

**Problem:** The MCP server needed to allow autonomous AI agents to query merchant catalogs, check payment statuses, and construct valid x402 payment headers.

**Changes:**
- Added `src/mcp/prompts.js` — Three MCP prompt templates:
  - `generate_payment_uri` — Construct payment URIs for agents
  - `query_dispute_status` — Query dispute status for resolved payments
  - `audit_transaction` — Audit transaction details
- Added `src/mcp/resources.js` — Semantic resource endpoints:
  - `x402://catalog/resources` — Whole public catalog
  - `x402://catalog/search?q={query}` — Ranked search
  - `x402://catalog/resource?url={url}` — Single resource metadata
  - `x402://catalog/network/{network}` — Network summary
- Updated `src/mcp/server.js` — Added `prompts/*` and `resources/*` handlers to the MCP server
- Added `src/mcp/sanitize.js` — Input validation and sanitization for all MCP parameters
- Added `src/mcp/cli.js` — MCP CLI entry point
- Updated `test/mcp-server.test.js` — 515 lines of comprehensive MCP server tests
- Updated `test/mcp.test.js` — Added spending guard tests for CLI integration

**Verification:** `npm test -- test/mcp-server.test.js test/mcp-transport.test.js` passes. `npm run lint` is clean.

---

### 4. Improve inline documentation and comments in `mcp.test.js` (#387)

**Problem:** Documentation in `mcp.test.js` was sparse, making it difficult for new contributors to understand the business logic quickly.

**Changes:**
- Upgraded file-level comment to a full JSDoc `@file` block with a table mapping every describe group to its concern
- Full JSDoc on all inline helpers used in the test file
- Added inline explanations on every non-obvious logic block
- Updated `test/mcp.test.js` with comprehensive JSDoc documentation

**Verification:** `npm run lint` is clean. `npm run prettier --check .` passes.

---

## Verification Summary

- `npm run lint` — Clean
- `npm test` — 890/892 tests pass (2 flaky/unrelated failures)
- `npm run prettier --check .` — Clean
- All new files follow existing code conventions
