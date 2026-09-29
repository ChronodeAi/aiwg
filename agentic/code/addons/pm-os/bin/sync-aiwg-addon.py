#!/usr/bin/env python3
"""Synchronize authoritative PMOS sources into the project-local AIWG addon.

The standalone PMOS tree remains the authoring surface. The AIWG addon keeps
an additive, path-normalized copy of that content. Addon-only artifacts are
never deleted; in particular, ``skills/pm-os-quickref`` and
``registry/addon-inventory.json`` are owned by the addon packaging layer.

Run without arguments to update the addon, or pass ``--check`` for a strictly
read-only drift check suitable for CI.
"""

from __future__ import annotations

import argparse
import os
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


SCRIPT_RELATIVE_PATH = "bin/sync-aiwg-addon.py"
ADDON_RELATIVE_PATH = Path(".aiwg/addons/pm-os")

# Ordered longest/specific-first so every standalone path has one stable addon
# representation. These substitutions apply only to explicitly text-like files.
REFERENCE_NORMALIZATIONS: tuple[tuple[str, str], ...] = (
    ("skills/", "skills/"),
    ("agents/", "agents/"),
    ("commands/", "commands/"),
    ("registry/", "registry/"),
    ("", ""),
    ("knowledge/", "knowledge/"),
    ("templates/", "templates/"),
    ("examples/", "examples/"),
)

TEXT_SUFFIXES = frozenset(
    {
        ".cjs",
        ".css",
        ".csv",
        ".html",
        ".js",
        ".json",
        ".jsx",
        ".md",
        ".mjs",
        ".py",
        ".scss",
        ".sh",
        ".svg",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".xml",
        ".yaml",
        ".yml",
    }
)
TEXT_FILENAMES = frozenset({"AGENTS.md", "CLAUDE.md", "Dockerfile", "Makefile"})


class SyncError(RuntimeError):
    """Raised when the source-to-addon sync cannot be performed safely."""


@dataclass(frozen=True)
class DirectoryMapping:
    source: Path
    destination: Path
    preserved_prefixes: tuple[Path, ...] = ()


@dataclass(frozen=True)
class FilePlan:
    source: Path
    destination: Path
    expected: bytes
    mode: int
    replacement_counts: tuple[int, ...]


@dataclass(frozen=True)
class Drift:
    plan: FilePlan
    reasons: tuple[str, ...]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Synchronize standalone PMOS sources into .aiwg/addons/pm-os."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="report drift without creating directories or changing files",
    )
    parser.add_argument(
        "--root",
        type=Path,
        help="project root (defaults to the parent of this script's bin directory)",
    )
    return parser.parse_args(argv)


def is_text_like(path: Path) -> bool:
    return path.name in TEXT_FILENAMES or path.suffix.lower() in TEXT_SUFFIXES


def normalize_content(path: Path, content: bytes) -> tuple[bytes, tuple[int, ...]]:
    """Return addon-local content and per-rule replacement counts."""

    if not is_text_like(path):
        return content, (0,) * len(REFERENCE_NORMALIZATIONS)

    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SyncError(f"text-like source is not valid UTF-8: {path}") from exc

    counts: list[int] = []
    for standalone, addon_local in REFERENCE_NORMALIZATIONS:
        counts.append(text.count(standalone))
        text = text.replace(standalone, addon_local)
    return text.encode("utf-8"), tuple(counts)


def is_preserved(relative_path: Path, preserved_prefixes: tuple[Path, ...]) -> bool:
    return any(
        relative_path == prefix or prefix in relative_path.parents
        for prefix in preserved_prefixes
    )


def require_safe_source(path: Path, project_root: Path) -> None:
    if not path.is_file():
        raise SyncError(f"required source file is missing: {path.relative_to(project_root)}")
    if path.is_symlink():
        raise SyncError(f"source symlinks are not supported: {path.relative_to(project_root)}")


def require_safe_destination(path: Path, addon_root: Path) -> None:
    resolved_root = addon_root.resolve()
    try:
        path.resolve(strict=False).relative_to(resolved_root)
    except ValueError as exc:
        raise SyncError(f"destination escapes addon root: {path}") from exc
    if path.is_symlink():
        raise SyncError(f"destination symlinks are not supported: {path}")


def build_plan(project_root: Path) -> list[FilePlan]:
    addon_root = project_root / ADDON_RELATIVE_PATH
    if not addon_root.is_dir():
        raise SyncError(f"AIWG addon directory is missing: {ADDON_RELATIVE_PATH}")

    mappings = (
        DirectoryMapping(
            Path("skills"),
            Path("skills"),
            preserved_prefixes=(Path("pm-os-quickref"),),
        ),
        DirectoryMapping(Path("agents"), Path("agents")),
        DirectoryMapping(
            Path("registry"),
            Path("registry"),
            preserved_prefixes=(Path("addon-inventory.json"),),
        ),
        DirectoryMapping(Path("🧠 Knowledge"), Path("knowledge")),
        DirectoryMapping(Path("📄 Templates"), Path("templates")),
        DirectoryMapping(Path("💎 Examples"), Path("examples")),
        DirectoryMapping(Path("docs"), Path("docs")),
        DirectoryMapping(Path("bin"), Path("bin")),
    )
    single_files = (
        (Path("CLAUDE.md"), Path("CLAUDE.md")),
        (Path(".mcp.json"), Path(".mcp.json")),
    )

    plans: list[FilePlan] = []
    destinations: set[Path] = set()

    def add_file(source: Path, destination: Path) -> None:
        require_safe_source(source, project_root)
        require_safe_destination(destination, addon_root)
        if destination in destinations:
            raise SyncError(
                f"multiple sources map to {destination.relative_to(project_root)}"
            )
        destinations.add(destination)
        expected, replacement_counts = normalize_content(source, source.read_bytes())
        plans.append(
            FilePlan(
                source=source,
                destination=destination,
                expected=expected,
                mode=stat.S_IMODE(source.stat().st_mode),
                replacement_counts=replacement_counts,
            )
        )

    for mapping in mappings:
        source_root = project_root / mapping.source
        if not source_root.is_dir():
            raise SyncError(f"required source directory is missing: {mapping.source}")
        if source_root.is_symlink():
            raise SyncError(f"source directory symlinks are not supported: {mapping.source}")
        for source in sorted(
            (candidate for candidate in source_root.rglob("*") if candidate.is_file()),
            key=lambda candidate: candidate.relative_to(source_root).as_posix(),
        ):
            relative_path = source.relative_to(source_root)
            if is_preserved(relative_path, mapping.preserved_prefixes):
                continue
            add_file(source, addon_root / mapping.destination / relative_path)

    for source_relative, destination_relative in single_files:
        add_file(project_root / source_relative, addon_root / destination_relative)

    return sorted(plans, key=lambda plan: plan.destination.relative_to(project_root).as_posix())


def find_drift(plans: list[FilePlan]) -> list[Drift]:
    drift: list[Drift] = []
    for plan in plans:
        reasons: list[str] = []
        if not plan.destination.exists():
            reasons.append("missing")
        elif not plan.destination.is_file():
            reasons.append("not-a-file")
        else:
            if plan.destination.read_bytes() != plan.expected:
                reasons.append("content")
            if stat.S_IMODE(plan.destination.stat().st_mode) != plan.mode:
                reasons.append("mode")
        if reasons:
            drift.append(Drift(plan=plan, reasons=tuple(reasons)))
    return drift


def atomic_write(plan: FilePlan) -> None:
    plan.destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=plan.destination.parent,
            prefix=".pmos-addon-sync-",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(plan.expected)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        os.chmod(temporary_path, plan.mode)
        os.replace(temporary_path, plan.destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    default_root = Path(__file__).resolve().parent.parent
    project_root = (args.root or default_root).expanduser().resolve()

    try:
        plans = build_plan(project_root)
        drift = find_drift(plans)
    except (OSError, SyncError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    replacement_totals = [0] * len(REFERENCE_NORMALIZATIONS)
    for plan in plans:
        for index, count in enumerate(plan.replacement_counts):
            replacement_totals[index] += count

    if args.check:
        for item in drift:
            path = item.plan.destination.relative_to(project_root).as_posix()
            print(f"DRIFT {path}: {','.join(item.reasons)}")
        if drift:
            print(f"ERROR: {len(drift)} of {len(plans)} managed addon files drifted")
            return 1
        print(f"OK: {len(plans)} managed addon files are synchronized")
        return 0

    try:
        for item in drift:
            atomic_write(item.plan)
            path = item.plan.destination.relative_to(project_root).as_posix()
            print(f"UPDATED {path}: {','.join(item.reasons)}")
    except OSError as exc:
        print(f"ERROR: failed to update addon: {exc}", file=sys.stderr)
        return 2

    replacements = ", ".join(
        f"{standalone!r}={count}"
        for (standalone, _), count in zip(REFERENCE_NORMALIZATIONS, replacement_totals)
    )
    print(
        f"OK: synchronized {len(plans)} managed addon files "
        f"({len(drift)} updated; replacements: {replacements})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
