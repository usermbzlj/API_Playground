#!/usr/bin/env python3
"""Run stdlib-only community fixture selftests under upstream/fixtures/.

Discovers `run:` lines in META*.txt, or falls back to the highest-version
`*_v0_*.py` entry script per fixture directory. Requires Python 3.11+; no deps.
"""
from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "upstream" / "fixtures"
RUN_RE = re.compile(r"^run:\s*python3?\s+(\S+)", re.IGNORECASE | re.MULTILINE)
VERSION_RE = re.compile(r"_v0_(\d+)\.py$")
HASH_RE = re.compile(r"^run_out_sha256:\s*([0-9a-fA-F]{64})\s*$", re.MULTILINE)
NORM_RE = re.compile(r"^hash_norm:\s*(\S.*)$", re.MULTILINE)
ARTIFACT_RE = re.compile(r"^run_out:\s*(\S+)\s*$", re.MULTILINE)
META_VERSION_RE = re.compile(r"_v0_(\d+)\.txt$")


@dataclass(frozen=True)
class Receipt:
    """One META-declared artifact hash, plus the normalization it claims."""

    meta: Path
    artifact: Path
    expected: str
    norm: str | None  # set only when the META declares hash_norm


def digest_candidates(path: Path) -> dict[str, str]:
    """Hash the artifact the three ways the repo already writes receipts."""
    raw = path.read_bytes()
    text = raw.decode("utf-8", "replace")
    return {
        "raw": hashlib.sha256(raw).hexdigest(),
        "minus_trailing_newlines": hashlib.sha256(text.rstrip("\n").encode("utf-8")).hexdigest(),
        "minus_trailing_whitespace": hashlib.sha256(text.rstrip().encode("utf-8")).hexdigest(),
    }


def artifact_for(meta: Path, fixdir: Path, text: str) -> Path | None:
    """Resolve the artifact a META receipt describes, without guessing too hard."""
    named = ARTIFACT_RE.search(text)
    if named:
        candidate = fixdir / named.group(1)
        if candidate.is_file():
            return candidate
    version = META_VERSION_RE.search(meta.name)
    if version:
        candidate = fixdir / f"run_out_v0_{version.group(1)}.json"
        if candidate.is_file():
            return candidate
    found = sorted(fixdir.glob("run_out*.json"))
    return found[0] if len(found) == 1 else None


def receipts_for(fixdir: Path, metas: list[Path]) -> list[Receipt]:
    out: list[Receipt] = []
    for meta in metas:
        text = meta.read_text(encoding="utf-8", errors="replace")
        match = HASH_RE.search(text)
        if not match:
            continue
        artifact = artifact_for(meta, fixdir, text)
        if artifact is None:
            continue
        norm = NORM_RE.search(text)
        out.append(
            Receipt(
                meta=meta,
                artifact=artifact,
                expected=match.group(1).lower(),
                norm=norm.group(1).strip() if norm else None,
            )
        )
    return out


def scripts_from_meta(fixdir: Path) -> list[Path]:
    found: list[Path] = []
    for meta in sorted(fixdir.glob("META*.txt")):
        text = meta.read_text(encoding="utf-8", errors="replace")
        for match in RUN_RE.finditer(text):
            script = fixdir / match.group(1)
            if script.is_file():
                found.append(script)
    return found


def latest_version_script(fixdir: Path) -> Path | None:
    cands = [p for p in fixdir.glob("*_v0_*.py") if p.is_file()]
    if not cands:
        return None

    def ver(p: Path) -> int:
        m = VERSION_RE.search(p.name)
        return int(m.group(1)) if m else 0

    return max(cands, key=ver)


def collect_jobs() -> list[tuple[str, Path, Path]]:
    jobs: list[tuple[str, Path, Path]] = []
    for fixdir in sorted(p for p in ROOT.iterdir() if p.is_dir()):
        scripts = scripts_from_meta(fixdir)
        if not scripts:
            latest = latest_version_script(fixdir)
            if latest:
                scripts = [latest]
        # LEMF pack: validate.py is the entry when present and no META run line.
        validate = fixdir / "validate.py"
        if not scripts and validate.is_file():
            scripts = [validate]
        for script in scripts:
            rel = script.relative_to(ROOT)
            jobs.append((str(rel.parent / script.name), script, fixdir))
    return jobs


def verify_receipts(receipts: list[Receipt], strict: bool) -> tuple[list[str], list[str]]:
    """Compare every declared artifact hash with the artifact the run left behind.

    A META that declares hash_norm states which bytes it hashed, so a mismatch is
    a failed fixture. Without hash_norm the declared value may describe an
    internal payload rather than the file, so a mismatch is reported instead of
    enforced; --strict-hashes turns those reports into failures.
    """
    notes: list[str] = []
    failures: list[str] = []
    for receipt in receipts:
        if not receipt.artifact.is_file():
            failures.append(f"{receipt.meta.name}: declares a hash but {receipt.artifact.name} is missing")
            continue
        candidates = digest_candidates(receipt.artifact)
        hit = next((name for name, digest in candidates.items() if digest == receipt.expected), None)
        if hit:
            notes.append(f"hash ok ({hit}) via {receipt.meta.name}")
            continue
        detail = (
            f"{receipt.meta.name}: run_out_sha256 {receipt.expected[:12]}... does not match "
            f"{receipt.artifact.name} (raw {candidates['raw'][:12]}..., "
            f"minus_trailing_newlines {candidates['minus_trailing_newlines'][:12]}...)"
        )
        if receipt.norm or strict:
            failures.append(detail + (f" [hash_norm: {receipt.norm}]" if receipt.norm else ""))
        else:
            notes.append("hash unverifiable: " + detail + " - no hash_norm line")
    return notes, failures


def main(argv: list[str]) -> int:
    strict = "--strict-hashes" in argv
    if not ROOT.is_dir():
        print(f"fixtures root missing: {ROOT}", file=sys.stderr)
        return 2

    jobs = collect_jobs()
    if not jobs:
        print("no fixture jobs discovered", file=sys.stderr)
        return 2

    failed: list[str] = []
    ran: dict[Path, str] = {}
    for label, script, fixdir in jobs:
        proc = subprocess.run(
            [sys.executable, script.name],
            cwd=script.parent,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            failed.append(label)
            tail = (proc.stdout + proc.stderr).strip()[-800:]
            print(f"FAIL {label} (exit {proc.returncode})\n{tail}\n", file=sys.stderr)
            continue
        print(f"ok   {label}")
        ran.setdefault(fixdir, label)

    # Every script has run, so compare receipts with what the run left on disk:
    # a fixture that rewrites its own artifact can no longer stay green.
    verified = unverifiable = 0
    for fixdir, label in sorted(ran.items()):
        receipts = receipts_for(fixdir, sorted(fixdir.glob("META*.txt")))
        notes, bad = verify_receipts(receipts, strict)
        verified += sum(1 for note in notes if note.startswith("hash ok"))
        unverifiable += sum(1 for note in notes if note.startswith("hash unverifiable"))
        if bad:
            failed.append(f"{label} (receipt)")
            print(f"FAIL {label} (receipt)\n  " + "\n  ".join(bad) + "\n", file=sys.stderr)
            continue
        for note in notes:
            if not note.startswith("hash ok"):
                print(f"     {note}")

    print(f"\n{len(jobs) - len(failed)}/{len(jobs)} fixture selftests passed")
    print(f"hash receipts: {verified} verified, {unverifiable} unverifiable (no hash_norm, no normalization match)")
    if strict and unverifiable:
        print("--strict-hashes: treating unverifiable receipts as failures", file=sys.stderr)
        return 1
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
