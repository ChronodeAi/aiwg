# Jev JSON parse bounds

Accepted for #3016. The 50 ms `vm.runInNewContext` watchdog measures elapsed time,
including time when the host is not scheduling the parser. It can therefore turn
a trivial valid response into `invalid-output` and trigger extra collection
requests and reservations. Increasing the timer cannot guarantee acceptance
under arbitrary scheduling delay.

M01 in `test/fixtures/decision/amendment-traceability-v1.json` registers
`SEC-RESPONSE-PARSE-TIME`. Its intent remains: **hostile provider JSON cannot
consume unbounded parse time**. This decision changes the enforcement mechanism,
preserving the control, ID, G2 gate, and executable evidence. The evidence adds a
generous **500 ms per-thread CPU budget per parse**, measured with
`process.cpuUsage()` (user plus system CPU), for worst admissible 1 MiB bodies.
This is a regression assertion, not a runtime timer or a universal latency SLA.

| Option | Disposition |
|---|---|
| Scale the timer by bytes with a larger floor | Rejected: scheduling delay is independent of body size and can exceed any floor. |
| Retry once on timeout with a fixed total timeout | Rejected: both parses can encounter the same delay; doubles work without guaranteeing acceptance. |
| Drop the timer only for small inputs; bound size and depth | Improves small responses, but leaves larger admissible responses vulnerable to load. |
| Bound bytes and structure for every response; remove the timer | Chosen: admission depends only on input, with a fixed maximum amount of parsing work. |

`readBoundedBody` already rejects declared and streamed bodies over **1,048,576
bytes**, before fatal UTF-8 decoding. Pinned HTTPS decompression feeds that same
reader, so the limit also applies to decompressed bytes. `parseBoundedJson`
defensively repeats the byte check and scans iteratively before native
`JSON.parse`, rejecting more than **64 simultaneously open containers** and
duplicate keys in each object, including escaped equivalents. The existing
answer-key scanner is extended here rather than adding another parser subsystem.
The native parser remains responsible for complete JSON grammar validation.

The scan skips escaped string contents, retains one key set per open object, and
decodes only key tokens. The cursor only moves forward, including past the
whitespace consumed by lookahead. String spans are disjoint; slicing and parsing
each key token therefore touches at most the total key bytes, which cannot
exceed the body bytes. Key whitespace checks use a constant-size character
regex and scan disjoint spans. There is no suffix copy, suffix regex, recursive
walk, or repeated search from the start. With native key-set lookup, scanning
work is linear in body size; retained key text and the allocated object graph
also scale with that input. The maximum-key-count CPU measurement exercises
the per-key slice, parse, whitespace check, and set operations together.

A separate key-count ceiling is unnecessary. A compact object member with value
`0` costs encoded key-content bytes plus five bytes (quotes, colon, value, and
comma); outer braces minus the missing final comma cost one more byte. There
is one empty key, 94 distinct one-byte keys, and 10,763 distinct two-byte keys
(94² ASCII pairs, 1,920 two-byte Unicode characters, and seven short escapes).
Using all of these and then shortest remaining three-byte keys fits exactly
**132,441 unique members** in one object, with one byte of padding. Longer keys
or values cannot increase that count. Distinct keys may repeat in separate
objects; across the entire body a conservative bound is 262,144 members, and
there are at most 524,287 one-byte array values in a flat array. Duplicate keys
and excessive depth fail before the full body parse. Oversize fails before the
scan. No reviver, provider code execution, VM context, or graph clone is used.
These are fixed bounds on work and memory, not promises about elapsed time on a
descheduled host. A structurally admissible response cannot fail this helper
because of host load. Duplicate keys anywhere in the response are now rejected,
including metadata; malformed responses still become sanitized `invalid-output`.

All four call sites remain unchanged: `observeResponse` (wire model/usage
observation), `evaluate`'s error-body request-ID extraction, `evaluate`'s successful
answer normalization, and `evaluateMany`'s successful batch normalization. Each
gets bytes from `readBoundedBody`. The separate change to parse successful
responses once remains independent of this helper change.

`SEC-RESPONSE-PARSE-TIME` directly exercises the production helper (an internal
module export, also re-exported from `src/decision/index.ts`). Bodies are constructed before
measurement, each is exactly 1,048,576 UTF-8 bytes, and each gets one warmup and
three measured parses. The cheapest of the three samples must stay below 500 ms of this thread's CPU time (`process.threadCpuUsage`, Node 23.9 or later; older runtimes report the figure without asserting it);
the test prints all samples. Measurements include the defensive byte check,
scan, key decoding, and full native parse, without transport/normalization work.
The following samples were measured on Node v24.12.0 with the requested two-suite
Vitest command and concurrent `npm run -s typecheck` (CPU usage is per process).

| Worst body shape | Process CPU ms, three samples | CPU budget per parse |
|---|---|---:|
| 64 open arrays around a long string | 4.835, 9.082, 6.184 | 500 ms |
| Maximum-key-count object: 132,441 shortest unique keys | 119.394, 118.992, 108.393 | 500 ms |
| Long string with escaped quotes/backslashes and literal container characters | 23.118, 11.071, 11.443 | 500 ms |
| Array of 349,525 empty objects | 32.277, 30.728, 30.982 | 500 ms |

The same evidence test proves that 1 MiB plus one byte and 65 containers are
rejected before the full body reaches `JSON.parse`. Separate byte tests include
multibyte UTF-8 and stream rejection. `SEC-RESPONSE-PARSE-LOAD` injects a VM
watchdog that always throws and a clock jump to 60,000 ms; valid output succeeds
without invoking that watchdog. No regression assertion measures elapsed time.

`SEC-RESPONSE-PARSE-PROPERTY` generates 600 valid source trees with xorshift32
seed `0x3016c0de`. The independent source-tree oracle records container depth
and decoded duplicate keys; native parsed graph depth is checked for unique-key
trees (native parsing erases earlier duplicate members). Cases span scalars,
objects, arrays, 63–66 containers, JSON whitespace, literal punctuation inside
strings, escaped quotes/backslashes, escaped equivalents, paired/lone surrogates,
and keys reused in separate objects. Admitted trees equal native parse results;
duplicate or over-depth trees are rejected. Three invalid corruptions per tree
and explicit malformed-grammar cases are rejected by both native parsing and
the helper. The lexical scanner need not validate all grammar: any input that
survives admission still passes through native `JSON.parse`.

For valid JSON, structural punctuation occurs only outside strings; an escaped
quote cannot close a string, and valid Unicode escape hex digits cannot contain
structural punctuation. A string followed by JSON whitespace and a colon is an
object key in the current object. Native decoding of that key uses exactly the
same UTF-16 identity as the final parse, including lone surrogates. Thus the
scanner's container stack and per-object duplicate view follow the source
structure. Invalid JSON cannot be accepted: the scanner either rejects it or
the final native parse does.

**Behavior change:** duplicate keys are rejected anywhere in the response,
not only inside `answers`: top-level `model`/`usage`, metadata, error-body fields,
and nested answer objects all receive the same admission policy. Successful
responses become `invalid-output`; error-body correlation extraction discards
an invalid body and retains the HTTP status mapping. The collector observer
still receives bounded raw bytes even when admission fails.

An offline duplicate-preserving audit of all 511 JSON/JSONL/NDJSON fixtures under
`test/fixtures` and `agentic/code/addons/decision-engine/examples` read 845 valid
documents and 27 embedded JSON strings, with no duplicate keys anywhere;
11 malformed fixture documents/lines were excluded as non-JSON. Those stored
documents contain no raw Jev `answers` maps. Jev's code-generated response
fixtures in `test/fixtures/decision/dispatcher-fake-jev.mjs`,
`test/unit/decision/batch.test.ts`, and
`test/conformance/decision-v1/vectors/vendor.ts` serialize unique metadata and
answer objects; their intentional duplicate mutations target `answers`.
The transport negative cases also intentionally duplicate metadata/nested keys.
No retained valid response shape is affected. No retained raw live Jev response
was found in those repository fixtures, so this audit does not establish that
all real provider output is duplicate-free; a real duplicate-bearing response
will now be rejected.
