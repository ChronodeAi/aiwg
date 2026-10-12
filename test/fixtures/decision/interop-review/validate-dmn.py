"""Optional independent offline check: python3 validate-dmn.py exported.dmn.

Requires an existing Python lxml installation; this helper installs nothing.
All schema imports resolve to the pinned local files. No network or entities.
"""
import hashlib
import json
import sys
from pathlib import Path
from lxml import etree

HERE = Path(__file__).resolve().parent
manifest = json.loads((HERE / 'schema-provenance.json').read_text())
for record in manifest['files']:
    actual = hashlib.sha256((HERE / record['name']).read_bytes()).hexdigest()
    if actual != record['sha256']:
        raise SystemExit('Pinned schema digest mismatch: ' + record['name'])
parser = etree.XMLParser(no_network=True, resolve_entities=False, load_dtd=False)
schema = etree.XMLSchema(etree.parse(str(HERE / 'DMN16.xsd'), parser))
document = etree.parse(sys.argv[1], parser)
if not schema.validate(document):
    print(schema.error_log, file=sys.stderr)
    raise SystemExit(1)
print('PASS: exported document validates against pinned OMG DMN 1.6 XSD')
