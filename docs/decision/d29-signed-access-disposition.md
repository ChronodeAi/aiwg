# D29 signed-access fixture disposition (#3747)

The signed access/v2 schema is additive. Existing unsigned access/v1 records remain historical and are refused by the evaluation boundary. No historical access time was re-signed.

The new `test/fixtures/decision/d29-signed-access/` fixtures sit alongside frozen D29 corpora. `valid.json` is a schema-shape fixture with a deliberately non-verifying signature; `d29-access.test.ts` signs its body at runtime with a fresh throwaway Ed25519 key and genesis keyring. `unsigned.json`, `missing-bundle.json`, `bad-time.json` and `unknown-field.json` cover schema refusals in that same test. No private keys are committed.

## Scorer repin

The current-byte scorer contract requires repinning after adding signed access verification and extracting preparation/scoring from the oversized entry. The entry pins all four extracted modules. Only the fields below changed; all other JSON fields, corpus/gold/labels, analysis, reviews, budgets and assertions remain unchanged. Public seeds remain ineligible for collection.

The unchanged assertions in `d29-synthetic-v6.test.mjs` (V6-04 and dry run), `d29-synthetic-v7.test.mjs` (V7-06) and `d29-synthetic-v8.test.mjs` (V8-07) consume these nine files and reproduce their digests. `d29-provenance.test.mjs` verifies current entry bytes and detects changed bytes in every extracted module.

| File | Changed JSON pointers | Before SHA-256 | After SHA-256 |
|---|---|---|---|
| test/fixtures/decision/d29-synthetic-v6/preregistration.json | /scorerDigest | sha256:e3ed88487bc943b8d0388e19067d57bffea3122cbf597bfac172b3d1e6cf4ad4 | sha256:cd60132f5fd25b315ff04b90ee05d534f59fa431bedde6a1e302b11ea289bd81 |
| test/fixtures/decision/d29-synthetic-v6/approval-template.json | /preregistrationDigest | sha256:f5e6a262bed7df57ede3693b5cde7b8211c973aa219fdf4400c22af205e49c2c | sha256:b6dfb8a4ed32200e2b88d4e42daebe41334b83e98857a38231323d3b683ece7a |
| test/fixtures/decision/d29-synthetic-v6/dry-run.json | /scorerDigest, /preregistrationDigest, /approvalTemplateDigest | sha256:3298efabecf478ad86dafa47cff9ef730f1e28e4cbe63a87e7a63430fe6afba4 | sha256:fecd63e71e06d845f67ff074303e235025ea20ebab306fb8f6d39063507a394f |
| test/fixtures/decision/d29-synthetic-v7/preregistration.json | /scorerDigest | sha256:708cd36a11302531c82f360ea3362cca812d2016966ca9f3aad013d156c3bbbc | sha256:c330566486d02edff1fd01327ca68d888476b08ec4de606ebd6813ea94b33df7 |
| test/fixtures/decision/d29-synthetic-v7/approval-template.json | /preregistrationDigest | sha256:ec0da265b48c72df5dce7dd9d8e2af0c582b5234668302412a4c2e32d86ad193 | sha256:bf487fe2bd07b37ee1837932d435022d4241e3e7728c5a12e829d417498d3946 |
| test/fixtures/decision/d29-synthetic-v7/dry-run.json | /scorerDigest, /preregistrationDigest, /approvalTemplateDigest | sha256:6666434d92cf87a98c4cbd019fe07f0c2a1ac35e9b38d3c856a169798616686a | sha256:d37bd8fa58097e5e2f49acfad789d57170e6ea8478d24459b0143364a39da0e3 |
| test/fixtures/decision/d29-synthetic-v8/preregistration.json | /scorerDigest | sha256:a3dab498bbf73596d8b82a03bf13bdd735b905317910df63e2707935d9caeb1c | sha256:f6b588113ce0e4607af4237cc85448b17831fd2e86f35711bfd7aaf53b4c3a67 |
| test/fixtures/decision/d29-synthetic-v8/approval-template.json | /preregistrationDigest | sha256:c60549011365680e6bc9ecdd753d224c4a040405b0d9e65633df0509623ca89a | sha256:18b023235e525433ac8b77845c0ab9ac9dd2733386a2a4f7141a583176db3e82 |
| test/fixtures/decision/d29-synthetic-v8/dry-run.json | /scorerDigest, /preregistrationDigest, /approvalTemplateDigest | sha256:378769b953f7cea6e2b3cb799debb75e379875b20cc123732a63c7b61229129c | sha256:e7cb9207ac18b94068c1885262fbf99f18267cfdff5e5808d49ee65311d5bbb6 |
