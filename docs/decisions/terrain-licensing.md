# Terrain provider policy decision

English source. [Russian mirror](../ru/terrain-licensing.md).

TASK-060 introduces a configuration boundary before any streaming/cache code.
`providerPolicy(unknown)` validates exactly eight fields and snapshots a frozen
policy. Unknown providers, blank attribution/license, invalid TTL or malformed
license-evidence hashes fail closed. No paid API key is needed for policy tests.

Google live tiles accept only transient memory use, TTL 0, offline false and
prefetch false. TTL 0 means this adapter grants no application-level retention;
HTTP caching directives and current provider terms still govern the loader.
Persistent R2 caching, regional prefetch and offline redistribution are denied.
Paid API access alone supplies no offline/cache authorization. A future Google
exception requires a separately reviewed contract change; a client-provided
hash cannot switch these restrictions off.

Owned/licensed datasets may request persistence/offline/prefetch only with a
64-character SHA-256 reference to reviewed permission evidence, a nonempty
license and attribution. This hash identifies evidence; it does not verify its
legal meaning. The deployment owner supplies reviewed configuration. Tests use
synthetic license evidence and confer no rights to an actual external dataset.
TTL is an integer from 0 to 31536000 seconds. No provider fetch, API secret,
Cloudflare deployment, live Google integration or physical cache is introduced.
