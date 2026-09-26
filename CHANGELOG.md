# Changelog

All notable changes to this project are documented in this file. An integrator
should be able to read what changed between two commits here rather than
reconstruct it from `git log`.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0.0, a minor version may contain a wire-observable change — the
`@x402/*` response shapes are the compatibility surface, and
[`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) is where the wire behaviour is
pinned.

## [Unreleased]

### Added

- Optional mTLS client-certificate authentication for outbound webhooks. A
  delivery carrying `mtls.ref` is sent with a client certificate resolved from a
  ref, over a pooled per-credential agent, and still carries the existing HMAC
  signature when a secret is also configured. Credential references — never key
  material — are what travel on the Kafka wire record and in the dead-letter
  store, so rotation no longer requires a redeploy. Unavailable credentials
  degrade to signature-only delivery with a warning, and a receiver whose
  certificate fails verification is not retried (#429).
- Optional two-tier cache for catalog searches, behind `CATALOG_SEARCH_CACHE=1`:
  an in-process LRU in front of a shared Redis entry, with Redis Pub/Sub
  invalidation across replicas. The catalog write version is part of the cache
  key, so a cached search is never stale. Redis being unreachable degrades to
  querying the catalog directly. Adds the `x402_catalog_cache_lookups_total`
  series (#392).
- Semantic discovery over MCP: the `prompts` and `resources` halves of the
  protocol alongside the existing tools. Four `x402://catalog/…` resources expose
  the catalog, a search, one resource, and a per-network summary; three prompt
  templates (`generate_payment_uri`, `query_dispute_status`, `audit_transaction`)
  describe how to build and inspect a payment. Capabilities are advertised only
  when the server can serve them. A new input boundary validates every argument
  against a format — a transaction hash is 64 hex characters, a URL is http(s) —
  and seller-controlled catalog text is stripped of invisible characters and
  emitted inside a labelled data block, so a malicious listing cannot smuggle
  instructions into an agent's context (#391).
- `CHANGELOG.md`, so an integrator can tell what changed between two commits
  (#212).
- Tests for both documented CLI entry points, `validate-discovery` and
  `x402-mcp`, driven from the `package.json` `bin` map (#208).

### Changed

- Client IP addresses are pseudonymised before they reach a rate-limit bucket
  key or an audit actor, and are no longer written to logs. This makes the
  claim in `docs/PRIVACY.md` true for shared stores (Redis,
  `RATE_LIMIT_STORE=postgres`, the CRDT store) that previously persisted the raw
  address. `IP_HASH_SECRET` overrides the derived HMAC key (#204).

### Fixed

- `server.js` now installs `unhandledRejection` / `uncaughtException` handlers
  and reports a listen or metrics-listener bind failure, exiting non-zero with
  a diagnostic instead of dying silently (#205).
- Invisible characters are stripped from MCP text before ANSI escape sequences,
  not after. The escape byte is itself a C0 control, so stripping controls first
  removed the escape on its own and left the `[31m` body behind as visible text —
  an escape sequence surviving in pieces. The whole sequence is now matched and
  removed as one unit (#391).
- The catalog search cache key now includes every filter `CatalogStore.search()`
  supports. `type`, `payTo`, `scheme`, `network` and `offset` were missing, so
  two searches differing only in those shared one entry — a caller filtering on
  `network=stellar:pubnet` could be served a result set cached for
  `network=stellar:testnet`, and `offset` could serve the same page twice. A
  guard test derives its cases from the store's own filter list, so a filter
  added there without being added here fails the suite (#392).
- A manual `POST /discovery/resources` now broadcasts a cache invalidation like
  the cataloging that follows a payment already did. The writing replica was
  always correct, but peers kept serving the previous generation until their TTL
  expired (#392).
- The MCP integration test's JSON-RPC client now also rejects on an
  `isError: true` result rather than only on a JSON-RPC `error`, so a tool-level
  refusal cannot be mistaken for a successful call (#387).

### Documentation

- `test/mcp.test.js` now explains what it covers and why it spawns the CLI rather
  than driving the server in-process, and the stray debug logging and
  thinking-out-loud comments in it are gone (#387).

## [0.0.1] - 2026-08-11

Initial conformance spike: a minimal x402 facilitator for Stellar, built on
`@x402/stellar`.

### Added

- HTTP transport (`/verify`, `/settle`, `/supported`, `/usage`, health and
  readiness endpoints) over the upstream `ExactStellarScheme`.
- Caller authentication (API keys) and open mode, hop-count `TRUST_PROXY`
  resolution, and CORS by route class.
- Rate limiting and usage metering with a daily sponsored-fee ceiling,
  including shared stores for multi-instance and multi-region deployments.
- The Bazaar catalog: discovery and hybrid search, automatic cataloging,
  Postgres migrations, and an MCP server for agents.
- The `validate-discovery` seller CLI.
- Settlement store, idempotency, webhooks with a transactional outbox and a
  dead-letter queue, structured request logging, audit logging, Prometheus
  metrics, readiness probes and OpenTelemetry tracing.
- Pubnet support as an explicit opt-in with its own signer pool and fee
  ceiling.
