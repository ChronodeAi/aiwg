# Independent DMN standards check

These unmodified normative schemas come from [OMG DMN 1.6](https://www.omg.org/spec/DMN/1.6).
`schema-provenance.json` records each official URL and exact SHA-256. Imported DI/DC
schemas are vendored too, so validation requires no network. Schema declarations,
namespace and identifier constraints come from the standard, not AIWG's importer.

For an exported DMN file:

```bash
python3 test/fixtures/decision/interop-review/validate-dmn.py /path/to/exported.dmn
```

The helper requires an **already installed** Python/lxml. No new package dependency
is added and no network installation occurs. It verifies frozen schema hashes before
validation and disables external network/entity access. This is a separate optional
qualification command; the ordinary Vitest regressions run using existing Node
dependencies. Passing AIWG's own import/export cycle is not evidence of XSD validity.

The original reviewed commit `5630b94844b4f2d6e6a191940c4263356454c516` emitted the
same `id` on `definitions` and `decision`. The independent validator rejected that
export with `SCHEMAV_CVC_DATATYPE_VALID_1_2_1` on `decision/@id` (`xs:ID` uniqueness).
Re-run the command on the fixed exporter rather than treating this historical
failure description as current evidence. XSD validation alone also does not prove
FEEL evaluation equivalence, graph mapping, or OPA interoperability.
