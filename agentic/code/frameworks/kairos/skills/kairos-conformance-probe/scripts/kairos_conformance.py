#!/usr/bin/env python3
"""Kairos conformance probe runner.

Executes the documented-behaviour claims in a claims registry against a live
Kairos node and writes a receipt plus one finding per failed claim.

Python 3.11+ standard library only.

Usage:
    kairos_conformance.py --node http://127.0.0.1:4101
    kairos_conformance.py --node URL --allow-mutation --out .aiwg/kairos/conformance/run-1
    kairos_conformance.py --node URL --only 'KC-RES-*' --skip KC-MCP-012 --allow-mutation
    kairos_conformance.py --node URL --list

Safety:
    * Without --allow-mutation only claims with "mutates": false run. Every claim
      that creates fixtures, calls a write tool or exhausts a rate-limit bucket
      is marked "mutates": true.
    * All writes go to a fresh namespace (--namespace, default
      kairos-conformance-<utc>) and carry idempotency keys derived from the run.
    * The bearer token is read from the environment variable named by
      --token-env and never written to the receipt or findings.

Exit codes:
    0  every executed claim passed (skips allowed)
    1  at least one claim failed (Kairos behaviour differs from its docs)
    2  no failures, but at least one claim errored (probe could not decide)
    3  usage error or the node could not be reached
"""

from __future__ import annotations

import argparse
import copy
import fnmatch
import hashlib
import http.client
import json
import os
import platform
import re
import shlex
import sqlite3
import subprocess
import sys
import time
import urllib.parse
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

RECEIPT_SCHEMA = "kairos_conformance_receipt/v1"
CLAIMS_SCHEMA = "kairos_conformance_claims/v1"
FINDING_SCHEMA = "kairos_finding/v1"
MCP_PROTOCOL_VERSION = "2025-11-25"
EXCERPT_CHARS = 2000
MISSING = object()

SCRIPT_PATH = Path(__file__).resolve()
DEFAULT_CLAIMS_DIR = SCRIPT_PATH.parent.parent / "claims"


# --------------------------------------------------------------------------- utilities


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_z(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def excerpt(text: str, limit: int = EXCERPT_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"... [{len(text) - limit} more chars]"


class ProbeError(Exception):
    """The probe could not establish its precondition or evaluate a step."""


class SkipClaim(Exception):
    """The claim does not apply to this node or run configuration."""


# --------------------------------------------------------------------------- templating

TEMPLATE_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


@dataclass
class RunContext:
    node: str
    namespace: str
    run_token: str
    fixtures_x: dict[str, str] = field(default_factory=dict)
    fixtures_v: dict[str, str] = field(default_factory=dict)


def resolve_name(name: str, ctx: RunContext, saved: dict[str, Any], claim_id: str) -> Any:
    if name == "ns":
        return ctx.namespace
    if name == "run":
        return ctx.run_token
    if name == "node":
        return ctx.node
    if name == "claim":
        return claim_id.lower()
    if name == "now":
        return utc_now().strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    if name.startswith("utc_ago_hours:"):
        hours = float(name.split(":", 1)[1])
        return (utc_now() - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    if name.startswith("x."):
        key = name[2:]
        if key not in ctx.fixtures_x:
            raise ProbeError(f"fixture xtype '{key}' was not created")
        return ctx.fixtures_x[key]
    if name.startswith("v."):
        key = name[2:]
        if key not in ctx.fixtures_v:
            raise ProbeError(f"fixture vector '{key}' was not created")
        return ctx.fixtures_v[key]
    if name.startswith("s."):
        key = name[2:]
        if key not in saved:
            raise ProbeError(f"saved value '{key}' is not defined")
        return saved[key]
    raise ProbeError(f"unknown template variable '{name}'")


def render(value: Any, ctx: RunContext, saved: dict[str, Any], claim_id: str) -> Any:
    """Substitute {{...}} templates; a string that is exactly one template keeps the value's type."""
    if isinstance(value, str):
        whole = TEMPLATE_RE.fullmatch(value.strip()) if value.strip() == value else None
        if whole:
            return copy.deepcopy(resolve_name(whole.group(1), ctx, saved, claim_id))

        def sub(match: re.Match[str]) -> str:
            resolved = resolve_name(match.group(1), ctx, saved, claim_id)
            return resolved if isinstance(resolved, str) else json.dumps(resolved)

        return TEMPLATE_RE.sub(sub, value)
    if isinstance(value, list):
        return [render(item, ctx, saved, claim_id) for item in value]
    if isinstance(value, dict):
        return {
            render(k, ctx, saved, claim_id): render(v, ctx, saved, claim_id) for k, v in value.items()
        }
    return value


def template_names(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, str):
        found.update(m.group(1).strip() for m in TEMPLATE_RE.finditer(value))
    elif isinstance(value, list):
        for item in value:
            found |= template_names(item)
    elif isinstance(value, dict):
        for k, v in value.items():
            found |= template_names(k)
            found |= template_names(v)
    return found


# --------------------------------------------------------------------------- JSON paths
# Grammar: segments separated by '.', each a key, or bracket forms:
#   [0] index, [*] every element, [?key=value] filter a list, ["literal key"].
# Once a [*] or filter is applied the remaining segments map over the list.

SEG_RE = re.compile(r'\[(\*|-?\d+|\?[^\]=]+=[^\]]*|"(?:[^"\\]|\\.)*")\]|([^.\[\]]+)')


def parse_path(path: str) -> list[tuple[str, Any]]:
    tokens: list[tuple[str, Any]] = []
    if path in ("", "$"):
        return tokens
    pos = 0
    while pos < len(path):
        if path[pos] == ".":
            pos += 1
            continue
        match = SEG_RE.match(path, pos)
        if not match:
            raise ProbeError(f"bad JSON path '{path}' at {pos}")
        bracket, key = match.group(1), match.group(2)
        if key is not None:
            tokens.append(("key", key))
        elif bracket == "*":
            tokens.append(("all", None))
        elif bracket.startswith("?"):
            fkey, fval = bracket[1:].split("=", 1)
            tokens.append(("filter", (fkey, fval)))
        elif bracket.startswith('"'):
            tokens.append(("key", json.loads(bracket)))
        else:
            tokens.append(("index", int(bracket)))
        pos = match.end()
    return tokens


def _step(value: Any, token: tuple[str, Any]) -> Any:
    kind, arg = token
    if value is MISSING:
        return MISSING
    if kind == "key":
        return value.get(arg, MISSING) if isinstance(value, dict) else MISSING
    if kind == "index":
        if isinstance(value, list) and -len(value) <= arg < len(value):
            return value[arg]
        return MISSING
    return MISSING


def get_path(doc: Any, path: str) -> Any:
    value = doc
    tokens = parse_path(path)
    mapped = False
    for token in tokens:
        kind, arg = token
        if kind == "all":
            if mapped:
                value = [x for sub in value if isinstance(sub, list) for x in sub]
            else:
                if not isinstance(value, list):
                    return MISSING
                value = list(value)
                mapped = True
            continue
        if kind == "filter":
            fkey, fval = arg

            def keep(item: Any) -> bool:
                if not isinstance(item, dict) or fkey not in item:
                    return False
                actual = item[fkey]
                return (actual if isinstance(actual, str) else json.dumps(actual)) == fval

            if mapped:
                value = [x for x in value if keep(x)]
            else:
                if not isinstance(value, list):
                    return MISSING
                value = [x for x in value if keep(x)]
                mapped = True
            continue
        if mapped:
            value = [v for v in (_step(item, token) for item in value) if v is not MISSING]
        else:
            value = _step(value, token)
    return value


def json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def keys_anywhere(value: Any) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            found.add(k)
            found |= keys_anywhere(v)
    elif isinstance(value, list):
        for item in value:
            found |= keys_anywhere(item)
    return found


# --------------------------------------------------------------------------- transport


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    text: str
    json: Any
    elapsed_ms: float
    rate_waits_s: float = 0.0
    extra: dict[str, Any] = field(default_factory=dict)

    def doc(self) -> Any:
        return self.json if self.json is not None else MISSING


class Transport:
    def __init__(self, node: str, token: str | None, timeout: float, max_rate_wait: float,
                 write_budget: int = 0) -> None:
        self.node = node.rstrip("/")
        parts = urllib.parse.urlsplit(self.node)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise SystemExit(f"error: --node must be an http(s) URL, got {node!r}")
        self.scheme = parts.scheme
        self.host = parts.hostname
        self.port = parts.port
        self.base_path = parts.path.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.max_rate_wait = max_rate_wait
        self.write_budget = write_budget
        self.recent_writes: list[float] = []
        self.requests_sent = 0
        self.paced_s = 0.0

    def _pace(self, method: str) -> None:
        """Keep this runner's writes under --write-budget per minute so other clients of
        the node's per-IP write limit are not starved by a read-only probe."""
        if not self.write_budget or method not in ("POST", "PUT", "PATCH", "DELETE"):
            return
        now = time.monotonic()
        self.recent_writes = [t for t in self.recent_writes if now - t < 60.0]
        if len(self.recent_writes) >= self.write_budget:
            delay = 60.0 - (now - self.recent_writes[0]) + 0.1
            time.sleep(delay)
            self.paced_s += delay
            now = time.monotonic()
            self.recent_writes = [t for t in self.recent_writes if now - t < 60.0]
        self.recent_writes.append(now)

    def _once(self, method: str, path: str, body: bytes | None,
              headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
        """One HTTP exchange that still reads a response the server sent before
        it stopped reading the body (for example 413 on an oversized upload)."""
        conn_cls = http.client.HTTPSConnection if self.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(self.host, self.port, timeout=self.timeout)
        try:
            conn.putrequest(method, self.base_path + path, skip_accept_encoding=True)
            for name, value in headers.items():
                conn.putheader(name, value)
            if body is not None:
                conn.putheader("Content-Length", str(len(body)))
            conn.endheaders()
            if body is not None:
                try:
                    conn.send(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the server answered early; read what it sent
            resp = conn.getresponse()
            raw = resp.read()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, raw
        finally:
            conn.close()

    def send(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        auth: str = "default",
        retry_429: bool = True,
    ) -> Response:
        all_headers = {"Accept": "application/json", "Connection": "close"}
        if body is not None:
            all_headers["Content-Type"] = "application/json"
        if self.token and auth != "none":
            all_headers["Authorization"] = f"Bearer {self.token}"
        all_headers.update(headers or {})
        waited = 0.0
        while True:
            self._pace(method)
            started = time.monotonic()
            self.requests_sent += 1
            try:
                status, resp_headers, raw = self._once(method, path, body, all_headers)
            except (http.client.HTTPException, TimeoutError, OSError) as exc:
                raise ProbeError(f"{method} {path}: transport error: {exc!r}") from exc
            elapsed = (time.monotonic() - started) * 1000.0
            if status == 429 and retry_429:
                retry_after = resp_headers.get("retry-after", "5")
                try:
                    delay = max(float(retry_after), 1.0) + 0.25
                except ValueError:
                    delay = 5.25
                if waited + delay > self.max_rate_wait:
                    raise ProbeError(
                        f"{method} {path}: still rate-limited after waiting {waited:.1f}s"
                    )
                time.sleep(delay)
                waited += delay
                continue
            text = raw.decode("utf-8", errors="replace")
            try:
                parsed = json.loads(text) if text.strip() else None
            except json.JSONDecodeError:
                parsed = None
            return Response(status, resp_headers, text, parsed, elapsed, waited)


# --------------------------------------------------------------------------- assertions

ASSERT_OPS = (
    "equals", "not_equals", "in", "contains", "not_contains", "length", "approx", "exists",
    "type", "matches", "keys_equal", "keys_include", "keys_exclude", "all_equal", "sorted",
    "set_equals", "superset_of", "delta", "stable", "no_key_anywhere", "json_text_equals_path",
)


def _fmt(value: Any) -> Any:
    if value is MISSING:
        return "<missing>"
    return value


def evaluate_path_op(op: str, spec: dict[str, Any], observed: Any, responses: list[Response],
                     saved: dict[str, Any], doc_getter) -> tuple[bool, Any]:
    expected = spec.get(op)
    if op == "equals":
        return observed == expected, expected
    if op == "not_equals":
        return observed != expected, f"not {canonical_json(expected)}"
    if op == "in":
        return (None if observed is MISSING else observed) in expected, expected
    if op == "contains":
        return observed is not MISSING and isinstance(observed, (list, str)) and expected in observed, expected
    if op == "not_contains":
        ok = observed is MISSING or not isinstance(observed, (list, str)) or expected not in observed
        return ok, f"no {expected if isinstance(expected, str) else canonical_json(expected)}"
    if op == "length":
        return isinstance(observed, (list, dict, str)) and len(observed) == expected, expected
    if op == "approx":
        tol = spec.get("tol", 1e-9)
        if isinstance(observed, bool) or not isinstance(observed, (int, float)):
            return False, expected
        return abs(observed - expected) <= tol, f"{expected} ± {tol}"
    if op == "exists":
        return (observed is not MISSING) == bool(expected), expected
    if op == "type":
        allowed = expected if isinstance(expected, list) else [expected]
        return observed is not MISSING and json_type(observed) in allowed, expected
    if op == "matches":
        return isinstance(observed, str) and re.search(expected, observed) is not None, expected
    if op == "keys_equal":
        return isinstance(observed, dict) and sorted(observed) == sorted(expected), sorted(expected)
    if op == "keys_include":
        return isinstance(observed, dict) and set(expected) <= set(observed), expected
    if op == "keys_exclude":
        return isinstance(observed, dict) and not (set(expected) & set(observed)), expected
    if op == "all_equal":
        return isinstance(observed, list) and all(item == expected for item in observed), expected
    if op == "sorted":
        if not isinstance(observed, list):
            return False, expected
        ordered = sorted(observed, reverse=(expected == "desc"))
        return observed == ordered, expected
    if op == "set_equals":
        return isinstance(observed, list) and sorted(map(canonical_json, observed)) == sorted(
            map(canonical_json, expected)), sorted(expected, key=canonical_json)
    if op == "superset_of":
        return isinstance(observed, list) and all(item in observed for item in expected), expected
    if op == "delta":
        base = saved.get(spec["from"], MISSING)
        if base is MISSING or not isinstance(observed, (int, float)) or not isinstance(base, (int, float)):
            return False, f"{spec['from']} + {expected}"
        return observed - base == expected, f"{spec['from']}({base}) + {expected}"
    if op == "stable":
        values = [canonical_json(_fmt(get_path(r.doc(), spec["path"]))) for r in responses]
        return len(set(values)) == 1 and len(values) > 0, "identical across repeats"
    if op == "no_key_anywhere":
        present = sorted(keys_anywhere(observed) & set(expected)) if observed is not MISSING else []
        return not present, f"none of {expected}"
    if op == "json_text_equals_path":
        other = doc_getter(expected)
        try:
            parsed = json.loads(observed) if isinstance(observed, str) else MISSING
        except json.JSONDecodeError:
            parsed = MISSING
        return parsed is not MISSING and parsed == other, f"JSON text equal to {expected}"
    raise ProbeError(f"unknown assertion op '{op}'")


def run_assertion(spec: dict[str, Any], responses: list[Response], saved: dict[str, Any]) -> dict[str, Any]:
    """Evaluate one assertion; returns a result record."""
    on = spec.get("on", "last")
    targets: list[Response]
    if not responses:
        raise ProbeError("assertion without a response")
    if on == "last":
        targets = [responses[-1]]
    elif on == "first":
        targets = [responses[0]]
    elif on == "each":
        targets = responses
    else:
        raise ProbeError(f"bad 'on': {on}")

    def check(resp: Response) -> tuple[bool, Any, Any, str, str]:
        if "status" in spec:
            exp = spec["status"]
            ok = resp.status in exp if isinstance(exp, list) else resp.status == exp
            return ok, exp, resp.status, "status", "status"
        if "status_not" in spec:
            exp = spec["status_not"]
            return resp.status != exp, f"not {exp}", resp.status, "status_not", "status"
        if "header" in spec:
            name = spec["header"].lower()
            value = resp.headers.get(name, MISSING)
            for op in ("equals", "matches", "exists"):
                if op in spec:
                    if op == "exists":
                        ok = (value is not MISSING) == bool(spec[op])
                    elif op == "equals":
                        ok = value == spec[op]
                    else:
                        ok = isinstance(value, str) and re.search(spec[op], value) is not None
                    return ok, spec[op], _fmt(value), op, f"header:{name}"
            raise ProbeError(f"header assertion needs an op: {spec}")
        if "text_contains" in spec:
            return spec["text_contains"] in resp.text, spec["text_contains"], excerpt(resp.text, 300), "text_contains", "body"
        if "text_not_contains" in spec:
            needle = spec["text_not_contains"]
            return needle not in resp.text, f"not '{needle}'", excerpt(resp.text, 300), "text_not_contains", "body"
        if "count_lte" in spec:
            return len(responses) <= spec["count_lte"], spec["count_lte"], len(responses), "count_lte", "responses"
        if "exit_code" in spec:
            code = resp.extra.get("exit_code")
            return code == spec["exit_code"], spec["exit_code"], code, "exit_code", "exit_code"
        if "stderr_matches" in spec:
            err = resp.extra.get("stderr", "")
            return re.search(spec["stderr_matches"], err) is not None, spec["stderr_matches"], excerpt(err, 300), "stderr_matches", "stderr"
        if "path" in spec:
            path = spec["path"]
            doc = resp.doc()
            observed = get_path(doc, path) if doc is not MISSING else MISSING
            op = next((o for o in ASSERT_OPS if o in spec), None)
            if op is None:
                raise ProbeError(f"path assertion without op: {spec}")

            def doc_getter(other_path: str) -> Any:
                return get_path(doc, other_path) if doc is not MISSING else MISSING

            ok, exp = evaluate_path_op(op, spec, observed, responses, saved, doc_getter)
            return ok, exp, _fmt(observed), op, path
        raise ProbeError(f"unrecognised assertion: {spec}")

    outcomes = [check(r) for r in targets]
    passed = all(o[0] for o in outcomes)
    chosen = next((o for o in outcomes if not o[0]), outcomes[-1])
    _, exp, observed, op, target = chosen
    return {
        "op": op,
        "target": target,
        "on": on,
        "expected": exp,
        "observed": observed if not isinstance(observed, str) else excerpt(observed, 500),
        "pass": passed,
        "why": spec.get("why"),
    }


# --------------------------------------------------------------------------- steps


def redact_headers(headers: dict[str, str]) -> dict[str, str]:
    out = {}
    for k, v in headers.items():
        if k.lower() in ("authorization", "x-admin-key", "x-api-key"):
            out[k] = "<redacted>"
        else:
            out[k] = v
    return out


KEPT_RESPONSE_HEADERS = (
    "content-type", "cache-control", "retry-after", "x-ratelimit-limit",
    "x-ratelimit-remaining", "x-request-id", "strict-transport-security",
    "allow", "x-content-type-options",
)


class StepRunner:
    def __init__(self, transport: Transport, ctx: RunContext, options: argparse.Namespace) -> None:
        self.t = transport
        self.ctx = ctx
        self.opts = options

    def build_request(self, step: dict[str, Any]) -> dict[str, Any]:
        """Normalise http/mcp/tool steps into one HTTP request description."""
        if "http" in step:
            http = step["http"]
            req = {
                "method": http.get("method", "GET").upper(),
                "path": http["path"],
                "headers": dict(http.get("headers", {})),
                "auth": http.get("auth", "default"),
            }
            if "json" in http:
                req["body"] = json.dumps(http["json"]).encode("utf-8")
            elif "raw" in http:
                req["body"] = http["raw"].encode("utf-8")
            elif "raw_body_bytes" in http:
                pad = max(int(http["raw_body_bytes"]) - 16, 0)
                req["body"] = b'{"source_id":"' + b"a" * pad + b'"}'
            return req
        if "mcp" in step:
            mcp = step["mcp"]
            message: dict[str, Any] = {"jsonrpc": "2.0", "method": mcp["method"]}
            if not mcp.get("notification"):
                message["id"] = mcp.get("id", 1)
            if "params" in mcp:
                message["params"] = mcp["params"]
            headers = {"MCP-Protocol-Version": MCP_PROTOCOL_VERSION}
            headers.update(mcp.get("headers", {}))
            for name in mcp.get("drop_headers", []):
                headers.pop(name, None)
            return {
                "method": "POST", "path": mcp.get("path", "/mcp"), "headers": headers,
                "auth": mcp.get("auth", "default"),
                "body": json.dumps(message).encode("utf-8"),
            }
        if "tool" in step:
            tool = step["tool"]
            if "batch" in tool:
                body = {"tools": tool["batch"]}
                path = "/api/v1/agent/tools/execute-batch"
            else:
                body = {"tool": tool["tool"], "input": tool.get("input", {})}
                path = "/api/v1/agent/tools/execute"
            return {
                "method": "POST", "path": path, "headers": {}, "auth": tool.get("auth", "default"),
                "body": json.dumps(body).encode("utf-8"),
            }
        raise ProbeError(f"step has no request kind: {sorted(step)}")

    def run_sqlite(self, spec: dict[str, Any]) -> Response:
        store = self.opts.sqlite_store
        if not store:
            raise SkipClaim("needs --sqlite-store")
        started = time.monotonic()
        con = sqlite3.connect(store, timeout=15, isolation_level=None)
        try:
            cur = con.execute(spec["sql"], spec.get("params", []))
            rows = [list(r) for r in cur.fetchall()] if cur.description else []
            doc = {"rows": rows, "rowcount": cur.rowcount}
        finally:
            con.close()
        elapsed = (time.monotonic() - started) * 1000.0
        return Response(200, {}, json.dumps(doc), doc, elapsed)

    def run_cli(self, spec: dict[str, Any]) -> Response:
        bindir = self.opts.kairos_bin
        if not bindir:
            raise SkipClaim("needs --kairos-bin")
        argv = list(spec["argv"])
        exe = Path(bindir) / argv[0]
        if not exe.exists():
            raise SkipClaim(f"{argv[0]} not found in --kairos-bin")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/tmp")}
        if self.t.token:
            env["KAIROS_API_TOKEN"] = self.t.token
        started = time.monotonic()
        proc = subprocess.run(
            [str(exe), *argv[1:]], capture_output=True, text=True, env=env,
            timeout=spec.get("timeout", 60),
        )
        elapsed = (time.monotonic() - started) * 1000.0
        try:
            parsed = json.loads(proc.stdout) if proc.stdout.strip() else None
        except json.JSONDecodeError:
            parsed = None
        return Response(
            200, {}, proc.stdout, parsed, elapsed,
            extra={"exit_code": proc.returncode, "stderr": proc.stderr},
        )

    def execute(self, step: dict[str, Any], claim_id: str, saved: dict[str, Any], phase: str) -> dict[str, Any]:
        raw_expect = step.get("expect", [])
        step = render(step, self.ctx, saved, claim_id)
        record: dict[str, Any] = {"name": step.get("name", "step"), "phase": phase}
        responses: list[Response] = []

        if "compute" in step:
            comp = step["compute"]
            saved[comp["var"]] = sha256_bytes(str(comp["sha256"]).encode("utf-8"))
            record["compute"] = {"var": comp["var"]}
            record["assertions"] = []
            return record

        repeat = int(step.get("repeat", 1))
        stop_on = step.get("stop_on_status")
        if "sqlite" in step:
            record["request"] = {"sqlite": step["sqlite"]["sql"], "params": step["sqlite"].get("params", [])}
            responses.append(self.run_sqlite(step["sqlite"]))
        elif "cli" in step:
            record["request"] = {"argv": step["cli"]["argv"]}
            responses.append(self.run_cli(step["cli"]))
        else:
            req = self.build_request(step)
            body = req.get("body")
            record["request"] = {
                "method": req["method"],
                "path": req["path"],
                "headers": redact_headers(req["headers"]),
                "auth": "none" if req["auth"] == "none" else ("bearer" if self.t.token else "none"),
                "body_excerpt": excerpt(body.decode("utf-8", errors="replace")) if body else None,
                "body_bytes": len(body) if body else 0,
            }
            record["_curl"] = curl_command(self.ctx.node, req)
            for _ in range(repeat):
                resp = self.t.send(
                    req["method"], req["path"], body=body, headers=req["headers"],
                    auth=req["auth"], retry_429=not step.get("no_rate_retry", False),
                )
                responses.append(resp)
                if stop_on is not None and resp.status == stop_on:
                    break

        last = responses[-1]
        record["response"] = {
            "status": last.status,
            "headers": {k: v for k, v in last.headers.items() if k in KEPT_RESPONSE_HEADERS},
            "body_excerpt": excerpt(last.text),
            "body_sha256": sha256_bytes(last.text.encode("utf-8")),
        }
        if last.extra:
            record["response"]["exit_code"] = last.extra.get("exit_code")
            record["response"]["stderr_excerpt"] = excerpt(last.extra.get("stderr", ""), 800)
        if len(responses) > 1:
            record["response"]["count"] = len(responses)
            record["response"]["statuses"] = [r.status for r in responses]
        record["elapsed_ms"] = round(sum(r.elapsed_ms for r in responses), 2)
        waits = sum(r.rate_waits_s for r in responses)
        if waits:
            record["rate_limit_wait_s"] = round(waits, 2)

        # Saves run before assertions so an assertion can compare fields of one response.
        for var, path in (step.get("save") or {}).items():
            value = get_path(last.doc(), path)
            if value is MISSING:
                raise ProbeError(f"save '{var}': path '{path}' missing in response ({last.status})")
            saved[var] = value
        for var, spec in (step.get("save_regex") or {}).items():
            source = last.extra.get(spec.get("stream", "stderr"), "") if spec.get("stream") else last.text
            match = re.search(spec["pattern"], source)
            if not match:
                raise ProbeError(f"save_regex '{var}': no match for {spec['pattern']}")
            saved[var] = match.group(1)

        record["assertions"] = [run_assertion(a, responses, saved) for a in step.get("expect", [])]
        for raw, rec in zip(raw_expect, record["assertions"]):
            # Signatures use the unrendered path so fixture ids never enter a fingerprint.
            if "path" in raw and raw["path"] != rec["target"]:
                rec["target_template"] = raw["path"]
        return record


def curl_command(node: str, req: dict[str, Any]) -> str:
    parts = ["curl", "-sS", "-i", "-X", req["method"], shlex.quote(node.rstrip("/") + req["path"])]
    for k, v in req["headers"].items():
        parts += ["-H", shlex.quote(f"{k}: {v}")]
    if req.get("auth") != "none":
        parts += ["${KAIROS_API_TOKEN:+-H}", '${KAIROS_API_TOKEN:+"Authorization: Bearer $KAIROS_API_TOKEN"}']
    body = req.get("body")
    if body:
        parts += ["-H", shlex.quote("Content-Type: application/json")]
        if len(body) > 4096:
            parts += ["--data-binary", f"@<({len(body)}-byte body; see probe spec)>"]
        else:
            parts += ["--data-binary", shlex.quote(body.decode("utf-8", errors="replace"))]
    return " ".join(parts)


# --------------------------------------------------------------------------- claims


def load_claims(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != CLAIMS_SCHEMA:
        raise SystemExit(f"error: {path} is not a {CLAIMS_SCHEMA} file")
    ids = [c["id"] for c in data.get("claims", [])]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise SystemExit(f"error: duplicate claim ids: {dupes}")
    return data


def claim_fixture_refs(claim: dict[str, Any]) -> tuple[set[str], set[str]]:
    names = template_names(claim.get("probe", {}))
    xs = {n[2:] for n in names if n.startswith("x.")}
    vs = {n[2:] for n in names if n.startswith("v.")}
    return xs, vs


def selected(claim: dict[str, Any], only: list[str], skip: list[str]) -> bool:
    keys = (claim["id"], claim.get("area", ""))
    if only and not any(fnmatch.fnmatchcase(k, pat) for pat in only for k in keys):
        return False
    if skip and any(fnmatch.fnmatchcase(k, pat) for pat in skip for k in keys):
        return False
    return True


@dataclass
class NodeFacts:
    url: str
    version: str | None
    health: dict[str, Any] | None
    meta: dict[str, Any] | None
    meta_sha256: str | None
    profile: str
    auth_enabled: bool | None
    admin_waiver: bool | None
    store_backend: str | None
    namespace_policy: bool | None
    admin_available: bool
    admin_basis: str


def discover_node(t: Transport) -> NodeFacts:
    health_resp = t.send("GET", "/api/v1/health", auth="none")
    if health_resp.status != 200 or not isinstance(health_resp.json, dict):
        raise ProbeError(f"GET /api/v1/health returned {health_resp.status}")
    meta_resp = t.send("GET", "/api/v1/meta", auth="none")
    meta = meta_resp.json if meta_resp.status == 200 and isinstance(meta_resp.json, dict) else None
    meta_sha = sha256_bytes(meta_resp.text.encode("utf-8")) if meta is not None else None
    auth_enabled = (meta or {}).get("auth", {}).get("enabled")
    waiver = (meta or {}).get("auth", {}).get("admin_waiver")
    backend = (meta or {}).get("store", {}).get("backend")
    policy = (meta or {}).get("authorization", {}).get("namespace_policy")
    if backend == "postgres":
        profile = "pg"
    elif auth_enabled is False:
        profile = "dev"
    else:
        profile = "other"
    admin, basis = False, "no admin path"
    if auth_enabled is False and waiver:
        admin, basis = True, "development admin waiver (auth off)"
    elif auth_enabled and t.token:
        me = t.send("GET", "/api/v1/auth/me")
        role = me.json.get("role") if isinstance(me.json, dict) else None
        admin = role == "admin"
        basis = f"bearer token role={role!r} (GET /api/v1/auth/me {me.status})"
    return NodeFacts(
        url=t.node, version=(meta or health_resp.json).get("version"), health=health_resp.json,
        meta=meta, meta_sha256=meta_sha, profile=profile, auth_enabled=auth_enabled,
        admin_waiver=waiver, store_backend=backend, namespace_policy=policy,
        admin_available=admin, admin_basis=basis,
    )


def skip_reason(claim: dict[str, Any], node: NodeFacts, opts: argparse.Namespace, token: str | None) -> str | None:
    profile = claim.get("profile", "any")
    if profile != "any" and profile != node.profile:
        return f"profile {profile} claim; node profile is {node.profile}"
    if is_mutating(claim) and not opts.allow_mutation:
        return "mutating claim; run with --allow-mutation"
    if claim.get("requires_admin") and not node.admin_available:
        return f"needs admin ({node.admin_basis})"
    for req in claim.get("requires", []):
        if req == "bearer" and not (token and node.auth_enabled):
            return "needs a bearer token on an auth-enabled node"
        if req == "namespace_policy" and not node.namespace_policy:
            return "needs a configured namespace policy"
        if req == "sqlite_store" and not (opts.sqlite_store and node.store_backend == "sqlite"):
            return "needs --sqlite-store for a sqlite node"
        if req == "kairos_bin" and not opts.kairos_bin:
            return "needs --kairos-bin"
    when = claim.get("when_meta")
    if when:
        if node.meta is None:
            return "needs GET /api/v1/meta"
        for path, expected in when.items():
            observed = get_path(node.meta, path)
            if observed is MISSING or observed != expected:
                return f"when_meta {path}={expected!r} not met (observed {_fmt(observed)!r})"
    return None


# --------------------------------------------------------------------------- fixtures


def build_fixtures(
    runner: StepRunner, spec: dict[str, Any], need_x: set[str], need_v: set[str],
) -> dict[str, Any]:
    """Create the referenced fixture xtypes and vectors with two retry-safe batch calls.

    A fixture xtype always comes with its declared out-edges, transitively, so a
    resolution from a fixture source sees the same graph whatever claims are selected.
    """
    ctx = runner.ctx
    xtypes_spec = spec.get("xtypes", {})
    vectors_spec = spec.get("vectors", {})
    for name in sorted(need_v):
        if name not in vectors_spec:
            raise ProbeError(f"unknown fixture vector '{name}'")
        need_x.add(vectors_spec[name]["source"])
        need_x.add(vectors_spec[name]["target"])
    frontier = set(need_x)
    while frontier:
        grown: set[str] = set()
        for vname in sorted(vectors_spec):
            item = vectors_spec[vname]
            if item["source"] in frontier and vname not in need_v:
                need_v.add(vname)
                if item["target"] not in need_x:
                    grown.add(item["target"])
        need_x |= grown
        frontier = grown
    for name in sorted(need_x):
        if name not in xtypes_spec:
            raise ProbeError(f"unknown fixture xtype '{name}'")
    log: dict[str, Any] = {"xtypes": {}, "vectors": {}, "requests": []}
    x_names = sorted(n for n in need_x if n not in ctx.fixtures_x)
    if x_names:
        batch = []
        for name in x_names:
            item = xtypes_spec[name]
            inp = {
                "idempotency_key": f"{ctx.run_token}:fixture:xtype:{name}",
                "name": item.get("name", name),
                "namespace": ctx.namespace,
                "kind": item.get("kind", "data"),
            }
            for key in ("metadata", "content"):
                if key in item:
                    inp[key] = item[key]
            batch.append({"tool": "create_xtype", "input": inp})
        _run_fixture_batch(runner, batch, x_names, ctx.fixtures_x, log)
    v_names = sorted(n for n in need_v if n not in ctx.fixtures_v)
    if v_names:
        batch = []
        for name in v_names:
            item = vectors_spec[name]
            batch.append({"tool": "create_vector", "input": {
                "idempotency_key": f"{ctx.run_token}:fixture:vector:{name}",
                "source_id": ctx.fixtures_x[item["source"]],
                "target_id": ctx.fixtures_x[item["target"]],
                "vector_type": item["vector_type"],
                "name": item.get("name", name),
                "weight": item.get("weight", 1.0),
                "parameters": item.get("parameters", {}),
            }})
        _run_fixture_batch(runner, batch, v_names, ctx.fixtures_v, log)
    log["xtypes"] = {n: ctx.fixtures_x[n] for n in sorted(ctx.fixtures_x)}
    log["vectors"] = {n: ctx.fixtures_v[n] for n in sorted(ctx.fixtures_v)}
    return log


def _run_fixture_batch(runner: StepRunner, batch: list[dict[str, Any]], names: list[str],
                       sink: dict[str, str], log: dict[str, Any]) -> None:
    body = json.dumps({"tools": batch}).encode("utf-8")
    resp = runner.t.send("POST", "/api/v1/agent/tools/execute-batch", body=body)
    log["requests"].append({"status": resp.status, "count": len(batch), "elapsed_ms": round(resp.elapsed_ms, 2)})
    if resp.status != 200 or not isinstance(resp.json, dict):
        raise ProbeError(f"fixture batch failed: HTTP {resp.status}: {excerpt(resp.text, 400)}")
    results = resp.json.get("results", [])
    for name, result in zip(names, results):
        if result.get("error") is not None or not isinstance(result.get("data"), dict):
            raise ProbeError(f"fixture '{name}' failed: {canonical_json(result.get('error'))}")
        sink[name] = result["data"]["id"]


# --------------------------------------------------------------------------- findings


def assertion_signature(step_name: str, assertion: dict[str, Any]) -> str:
    return f"{step_name}:{assertion['op']}:{assertion.get('target_template', assertion['target'])}"


def fixture_digest(claim: dict[str, Any], fixtures_spec: dict[str, Any], ctx: RunContext) -> list[str]:
    """Describe the fixture graph a claim ran against, so a finding is reproducible elsewhere."""
    xs, vs = claim_fixture_refs(claim)
    vectors_spec = fixtures_spec.get("vectors", {})
    names = set(vs) | {n for n, item in vectors_spec.items() if item["source"] in xs}
    lines = []
    for name in sorted(names):
        item = vectors_spec.get(name)
        if item is None or name not in ctx.fixtures_v:
            continue
        lines.append(
            f"- `{name}` = {item['vector_type']} `{item['source']}` -> `{item['target']}`, weight "
            f"{item['weight']}, parameters {canonical_json(item.get('parameters', {}))} (id `{ctx.fixtures_v[name]}`)"
        )
    for name in sorted(xs - {vectors_spec[n]["source"] for n in names if n in vectors_spec}
                       - {vectors_spec[n]["target"] for n in names if n in vectors_spec}):
        if name in ctx.fixtures_x:
            lines.append(f"- xtype `{name}` (id `{ctx.fixtures_x[name]}`)")
    return lines


def build_finding(claim: dict[str, Any], result: dict[str, Any], node: NodeFacts,
                  data: dict[str, Any], docs_index: dict[str, str], recorded_at: str,
                  opts: argparse.Namespace, ctx: RunContext) -> dict[str, Any]:
    claims_meta = data.get("kairos", {})
    failed = [
        (step, a) for step in result["steps"] for a in step.get("assertions", []) if not a["pass"]
    ]
    signatures = sorted({assertion_signature(step["name"], a) for step, a in failed})
    doc_file, line = claim["doc"], int(claim["line"])
    preimage = "|".join([
        FINDING_SCHEMA, claim["id"], claim["surface"], f"{doc_file}:{line}", ";".join(signatures),
    ])
    fingerprint = sha256_bytes(preimage.encode("utf-8"))
    finding_id = f"KF-{claim['id']}-{fingerprint[:12]}"
    id_names = {v: f"<{k}>" for k, v in ctx.fixtures_x.items()}
    id_names.update({v: f"<{k}>" for k, v in ctx.fixtures_v.items()})

    def render_value(v: Any) -> str:
        text = v if isinstance(v, str) else canonical_json(v)
        for fid in sorted(id_names, key=len, reverse=True):
            text = text.replace(fid, id_names[fid])
        return text

    observed_lines = []
    for step, a in failed:
        why = f" ({a['why']})" if a.get("why") else ""
        observed_lines.append(
            f"step `{step['name']}` {render_value(a['target'])} [{a['op']}]: expected "
            f"{render_value(a['expected'])}; observed {render_value(a['observed'])}{why}"
        )
    observed = "\n".join(observed_lines)
    expected = claim["statement"]
    failing_steps = []
    for step, _ in failed:
        if step not in failing_steps:
            failing_steps.append(step)
    curls = [s["_curl"] for s in result["steps"] if s.get("_curl") and s["phase"] == "setup"]
    curls += [s["_curl"] for s in failing_steps if s.get("_curl")]
    try:
        claims_arg = str(opts.claims_path.relative_to(SCRIPT_PATH.parent.parent))
    except ValueError:
        claims_arg = str(opts.claims_path)
    rerun = (
        f"python3 scripts/{SCRIPT_PATH.name} --node {shlex.quote(node.url)} --claims "
        f"{shlex.quote(claims_arg)} --only {claim['id']}"
        + (" --allow-mutation" if is_mutating(claim) else "")
    )
    command = "\n".join([rerun, *curls])
    output_text = "\n\n".join(
        f"# {s['name']} -> HTTP {s.get('response', {}).get('status')}\n{s.get('response', {}).get('body_excerpt', '')}"
        for s in failing_steps
    )
    ref = f"{claims_meta.get('tag', 'v' + str(claims_meta.get('version')))}@{claims_meta.get('commit', '?')}"
    kind = claim.get("finding_kind", "conformance")
    title = f"[{kind}] {claim['statement'].rstrip('.')} ({doc_file}:{line}, v{claims_meta.get('version')})"
    if len(title) > 200:
        title = title[:197] + "..."
    also = claim.get("also", [])
    fixtures = fixture_digest(claim, data.get("fixtures", {}), ctx)
    gap = f" Operator-known gap {claim['known_gap']}." if claim.get("known_gap") else ""
    body = "\n".join([
        "## Summary\n",
        f"`{doc_file}:{line}` documents: {claim['statement']}\n",
        f"Kairos {node.version} ({node.profile} profile, store {node.store_backend}) behaves differently: "
        f"{len(failed)} assertion(s) failed.{gap}\n",
        "## Documentation\n",
        f"- `{doc_file}:{line}` at `{ref}`" + "".join(f"\n- `{x}`" for x in also) + "\n",
        "## Expected\n", f"{expected}\n",
        "## Observed\n", "```text", observed, "```\n",
        *(["## Fixture graph\n", *fixtures, ""] if fixtures else []),
        "## Reproduction\n", "```sh", command, "```\n",
        "## Response excerpt\n", "```text", excerpt(output_text, 3000), "```\n",
        "## Evidence\n",
        f"- claim `{claim['id']}` (area `{claim.get('area')}`, severity `{claim['severity']}`)",
        f"- node `{node.url}` version `{node.version}`, `/api/v1/meta` sha256 `{node.meta_sha256}`",
        f"- fingerprint `{fingerprint}`",
    ])
    sources = []
    if doc_file in docs_index:
        sources.append({"ref": f"{doc_file}@{ref}", "sha256": docs_index[doc_file]})
    sources.append({"ref": f"claims:{opts.claims_path.name}", "sha256": opts.claims_sha256})
    return {
        "schema": FINDING_SCHEMA,
        "finding_id": finding_id,
        "kind": kind,
        "title": title,
        "severity": claim["severity"],
        "claim_id": claim["id"],
        "surface": claim["surface"],
        "probe_status": "fail",
        "command": command,
        "output": {
            "excerpt": excerpt(output_text, EXCERPT_CHARS),
            "sha256": sha256_bytes(output_text.encode("utf-8")),
        },
        "doc_citation": {
            "file": doc_file, "line_start": line, "line_end": int(claim.get("line_end", line)), "ref": ref,
        },
        "expected": expected,
        "observed": observed,
        "node": {
            "url": node.url, "version": node.version, "profile": node.profile,
            "meta_sha256": node.meta_sha256,
        },
        "recorded_at": recorded_at,
        "sources": sources,
        "assertion_signatures": signatures,
        "fingerprint": fingerprint,
        "status": "open",
        "body": body,
        **({"known_gap": claim["known_gap"]} if claim.get("known_gap") else {}),
    }


# --------------------------------------------------------------------------- main


def run_claim(runner: StepRunner, claim: dict[str, Any]) -> dict[str, Any]:
    saved: dict[str, Any] = {}
    started = time.monotonic()
    result: dict[str, Any] = {
        "id": claim["id"], "area": claim.get("area"), "doc": claim["doc"], "line": claim["line"],
        "statement": claim["statement"], "surface": claim["surface"], "profile": claim.get("profile", "any"),
        "severity": claim["severity"], "mutates": bool(claim.get("mutates")),
        "requires_admin": bool(claim.get("requires_admin")), "steps": [],
    }
    if claim.get("known_gap"):
        result["known_gap"] = claim["known_gap"]
    status = "pass"
    reason = None
    try:
        for phase in ("setup", "steps"):
            for step in claim["probe"].get(phase, []):
                record = runner.execute(step, claim["id"], saved, "setup" if phase == "setup" else "probe")
                result["steps"].append(record)
                if any(not a["pass"] for a in record["assertions"]):
                    if phase == "setup":
                        failed = [a for a in record["assertions"] if not a["pass"]]
                        raise ProbeError(
                            f"setup step '{record['name']}' precondition failed: "
                            + "; ".join(f"{a['target']} {a['op']} {canonical_json(a['expected'])} "
                                        f"observed {canonical_json(_fmt(a['observed']))}" for a in failed)
                        )
                    status = "fail"
    except SkipClaim as exc:
        status, reason = "skip", str(exc)
    except ProbeError as exc:
        status, reason = "error", str(exc)
    except Exception as exc:  # noqa: BLE001 - a probe bug must not abort the run
        status, reason = "error", f"{type(exc).__name__}: {exc}"
    result["status"] = status
    if reason:
        result["reason"] = reason
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000.0, 2)
    return result


def default_namespace(now: datetime) -> str:
    return "kairos-conformance-" + now.strftime("%Y%m%dt%H%M%Sz")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Probe a live Kairos node against its documented claims.")
    p.add_argument("--node", required=True, help="Kairos base URL, e.g. http://127.0.0.1:4101")
    p.add_argument("--token-env", default="KAIROS_API_TOKEN",
                   help="environment variable holding the bearer token (default KAIROS_API_TOKEN)")
    p.add_argument("--claims", default=None,
                   help="claims registry (default: claims/kairos-<node version>.claims.json next to this script)")
    p.add_argument("--namespace", default=None, help="write namespace (default kairos-conformance-<utc>)")
    p.add_argument("--out", default=None, help="receipt directory (default .aiwg/kairos/conformance/<run_id>)")
    p.add_argument("--findings-dir", default=".aiwg/kairos/findings",
                   help="where failed claims are written as kairos_finding/v1 records (default .aiwg/kairos/findings)")
    p.add_argument("--only", action="append", default=[], help="glob on claim id or area; repeatable")
    p.add_argument("--skip", action="append", default=[], help="glob on claim id or area; repeatable")
    p.add_argument("--allow-mutation", action="store_true",
                   help="run claims that write (fixtures, observations, write tools, rate-limit bursts)")
    p.add_argument("--sqlite-store", default=None,
                   help="path of the node's SQLite file, for store-level claims on a throwaway node")
    p.add_argument("--kairos-bin", default=None, help="directory holding kairos-* CLIs, for cli claims")
    p.add_argument("--timeout", type=float, default=30.0, help="per-request timeout seconds")
    p.add_argument("--write-budget", type=int, default=None,
                   help="max write-method requests per minute from this runner (default 20 when read-only, "
                        "unlimited with --allow-mutation; 0 disables)")
    p.add_argument("--max-rate-wait", type=float, default=150.0,
                   help="maximum seconds to wait out 429 responses for one request")
    p.add_argument("--list", action="store_true", help="list claims and exit")
    return p.parse_args(argv)


def is_mutating(claim: dict[str, Any]) -> bool:
    xs, vs = claim_fixture_refs(claim)
    return bool(claim.get("mutates") or xs or vs)


def print_claims(data: dict[str, Any], only: list[str], skip: list[str]) -> None:
    for c in sorted(data["claims"], key=lambda c: c["id"]):
        if selected(c, only, skip):
            print(f"{c['id']:16} {c['surface']:4} {c.get('profile', 'any'):4} "
                  f"{'W' if is_mutating(c) else 'R'} {c['doc']}:{c['line']}  {c['statement']}")


def main(argv: list[str] | None = None) -> int:
    opts = parse_args(argv)
    started_at = utc_now()
    token = os.environ.get(opts.token_env) or None
    budget = opts.write_budget if opts.write_budget is not None else (0 if opts.allow_mutation else 20)
    transport = Transport(opts.node, token, opts.timeout, opts.max_rate_wait, budget)

    if opts.list and opts.claims:
        print_claims(load_claims(Path(opts.claims)), opts.only, opts.skip)
        return 0

    try:
        node = discover_node(transport)
    except ProbeError as exc:
        print(f"error: cannot reach Kairos node: {exc}", file=sys.stderr)
        return 3

    claims_path = Path(opts.claims) if opts.claims else DEFAULT_CLAIMS_DIR / f"kairos-{node.version}.claims.json"
    if not claims_path.exists():
        print(f"error: claims file {claims_path} not found (pass --claims)", file=sys.stderr)
        return 3
    opts.claims_path = claims_path.resolve()
    opts.claims_sha256 = sha256_file(claims_path)
    data = load_claims(claims_path)
    kairos_meta = data.get("kairos", {})
    docs_index = {d["file"]: d["sha256"] for d in data.get("docs", [])}

    if opts.list:
        print_claims(data, opts.only, opts.skip)
        return 0

    namespace = opts.namespace or default_namespace(started_at)
    if not re.fullmatch(r"[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,4}", namespace) or len(namespace) > 128:
        print("error: --namespace must be 1-5 dot-separated [A-Za-z0-9_-] labels", file=sys.stderr)
        return 3
    run_suffix = sha256_bytes(f"{node.url}|{namespace}".encode("utf-8"))[:6]
    run_id = "kcr-" + started_at.strftime("%Y%m%dt%H%M%Sz") + "-" + run_suffix
    out_dir = Path(opts.out) if opts.out else Path(".aiwg/kairos/conformance") / run_id
    ctx = RunContext(node=transport.node, namespace=namespace, run_token=run_id)
    runner = StepRunner(transport, ctx, opts)

    claims = [c for c in data["claims"] if selected(c, opts.only, opts.skip)]
    claims.sort(key=lambda c: (bool(c.get("run_last")), c["id"]))

    plan: list[tuple[dict[str, Any], str | None]] = [(c, skip_reason(c, node, opts, token)) for c in claims]
    need_x: set[str] = set()
    need_v: set[str] = set()
    for claim, reason in plan:
        if reason is None:
            xs, vs = claim_fixture_refs(claim)
            need_x |= xs
            need_v |= vs

    fixtures_log: dict[str, Any] = {"created": False}
    fixture_error: str | None = None
    if need_x or need_v:
        try:
            fixtures_log = build_fixtures(runner, data.get("fixtures", {}), need_x, need_v)
            fixtures_log["created"] = True
        except ProbeError as exc:
            fixture_error = str(exc)
            fixtures_log = {"created": False, "error": fixture_error}

    results: list[dict[str, Any]] = []
    for claim, reason in plan:
        xs, vs = claim_fixture_refs(claim)
        if reason is not None:
            result = {"id": claim["id"], "area": claim.get("area"), "doc": claim["doc"], "line": claim["line"],
                      "statement": claim["statement"], "surface": claim["surface"],
                      "profile": claim.get("profile", "any"), "severity": claim["severity"],
                      "mutates": bool(claim.get("mutates")), "requires_admin": bool(claim.get("requires_admin")),
                      "status": "skip", "reason": reason, "steps": [], "elapsed_ms": 0.0}
            if claim.get("known_gap"):
                result["known_gap"] = claim["known_gap"]
        elif fixture_error and (xs or vs):
            result = run_claim(runner, {**claim, "probe": {}})
            result["status"], result["reason"] = "error", f"fixtures unavailable: {fixture_error}"
        else:
            result = run_claim(runner, claim)
        results.append(result)
        mark = {"pass": "PASS", "fail": "FAIL", "skip": "skip", "error": "ERR "}[result["status"]]
        print(f"{mark} {claim['id']:16} {result.get('reason') or claim['statement']}", file=sys.stderr)

    recorded_at = iso_z(utc_now())
    counts = {s: sum(1 for r in results if r["status"] == s) for s in ("pass", "fail", "skip", "error")}
    by_area: dict[str, dict[str, int]] = {}
    for r in results:
        area = by_area.setdefault(r.get("area") or "-", {"pass": 0, "fail": 0, "skip": 0, "error": 0})
        area[r["status"]] += 1

    findings = []
    for claim, _ in plan:
        result = next(r for r in results if r["id"] == claim["id"])
        if result["status"] == "fail":
            finding = build_finding(claim, result, node, data, docs_index, recorded_at, opts, ctx)
            result["finding_id"] = finding["finding_id"]
            findings.append(finding)

    exit_code = 1 if counts["fail"] else (2 if counts["error"] else 0)
    for r in results:
        for s in r["steps"]:
            if "_curl" in s:
                s["reproduce"] = s.pop("_curl")

    out_dir.mkdir(parents=True, exist_ok=True)
    findings_dir = Path(opts.findings_dir)
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "recorded_at": recorded_at,
        "started_at": iso_z(started_at),
        "run_id": run_id,
        "runner": {
            "script": SCRIPT_PATH.name,
            "sha256": sha256_file(SCRIPT_PATH),
            "python": platform.python_version(),
        },
        "node": {
            "url": node.url,
            "version": node.version,
            "meta_sha256": node.meta_sha256,
            "profile": node.profile,
            "auth_enabled": node.auth_enabled,
            "admin_waiver": node.admin_waiver,
            "store_backend": node.store_backend,
            "namespace_policy": node.namespace_policy,
            "admin_available": node.admin_available,
            "admin_basis": node.admin_basis,
        },
        "claims_file": {
            "path": str(opts.claims_path),
            "sha256": opts.claims_sha256,
            "kairos_version": kairos_meta.get("version"),
            "version_match": kairos_meta.get("version") == node.version,
            "claims_total": len(data["claims"]),
            "claims_selected": len(claims),
        },
        "options": {
            "allow_mutation": opts.allow_mutation,
            "namespace": namespace,
            "only": opts.only,
            "skip": opts.skip,
            "token_env": opts.token_env,
            "token_present": bool(token),
            "sqlite_store": bool(opts.sqlite_store),
            "kairos_bin": bool(opts.kairos_bin),
        },
        "fixtures": fixtures_log,
        "requests_sent": transport.requests_sent,
        "write_budget_per_min": budget,
        "paced_s": round(transport.paced_s, 2),
        "results": results,
        "summary": {
            "total": len(results),
            **counts,
            "by_area": {k: by_area[k] for k in sorted(by_area)},
            "failed_claims": [r["id"] for r in results if r["status"] == "fail"],
            "errored_claims": [r["id"] for r in results if r["status"] == "error"],
            "findings": [str(findings_dir / f"{f['finding_id']}.json") for f in findings],
            "exit_code": exit_code,
        },
    }
    receipt_path = out_dir / "receipt.json"
    receipt_bytes = (json.dumps(receipt, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
    receipt_path.write_bytes(receipt_bytes)
    receipt_sha = sha256_bytes(receipt_bytes)
    if findings:
        findings_dir.mkdir(parents=True, exist_ok=True)
        for f in findings:
            f["receipt"] = {"path": str(receipt_path), "sha256": receipt_sha}
            (findings_dir / f"{f['finding_id']}.json").write_text(
                json.dumps(f, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")

    print(
        f"kairos conformance: {counts['pass']} pass, {counts['fail']} fail, {counts['skip']} skip, "
        f"{counts['error']} error; receipt {receipt_path} (sha256 {receipt_sha[:16]}...)",
        file=sys.stderr,
    )
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
