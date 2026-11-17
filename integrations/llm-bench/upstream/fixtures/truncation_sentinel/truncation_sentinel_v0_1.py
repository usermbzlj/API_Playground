#!/usr/bin/env python3
"""TRUNCATION_SENTINEL v0.1

Synthetic analyze_only fixture. Closed verdict set: PASS, FAIL, TRUNCATED.
TRUNCATED is neither PASS nor FAIL. Any one of the three comparisons failing
yields TRUNCATED. A sentinel on the first shard with a later shard missing
is TRUNCATED, never PASS. A JSON prefix that still parses is not PASS.

Samples are built deterministically in this file. No network.

The pinned naive baseline returns PASS for any non-empty stream, and also
returns PASS when json.loads succeeds. It never returns TRUNCATED.

Stdlib only. No credentials.
Credit: co-designed with EigenFlux agent 真虾. Real-machine bytes for
cut-before-sentinel and sha-mismatch are a TODO and are not invented here.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
EXPECTED_PATH = HERE / "expected.json"
RUN_OUT_PATH = HERE / "run_out_v0_1.json"
README_PATH = HERE / "README.md"

CLOSED = ("PASS", "FAIL", "TRUNCATED")
FIXTURE = "truncation_sentinel"
SPEC = "v0.1"
BEGIN = b"<!-- BEGIN CRITERIA -->\n"
END = b"<!-- END CRITERIA -->"
SENTINEL_LINE = re.compile(br"#sha8:[0-9a-f]{8}\n")

# Slots left open for 真虾. v0.1 does not attach real-machine bytes.
REAL_SAMPLE_TODO = (
    {"arm": "cut-before-sentinel", "status": "TODO", "owner": "真虾", "payload": None},
    {"arm": "sha-mismatch", "status": "TODO", "owner": "真虾", "payload": None},
)


def criteria_section_bytes(raw: bytes | None = None) -> bytes:
    blob = README_PATH.read_bytes() if raw is None else raw
    start = blob.find(BEGIN)
    if start < 0:
        raise RuntimeError("BEGIN CRITERIA marker missing")
    body_at = start + len(BEGIN)
    end = blob.find(END, body_at)
    if end < 0:
        raise RuntimeError("END CRITERIA marker missing")
    section = blob[body_at:end]
    if not section.endswith(b"\n"):
        raise RuntimeError("criteria section must keep its trailing LF")
    return section


def criteria_digest(raw: bytes | None = None) -> str:
    return hashlib.sha256(criteria_section_bytes(raw)).hexdigest()


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _sha8(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()[:8]


def _sentinel(body: str) -> str:
    return f"#sha8:{_sha8(body.encode('utf-8'))}\n"


def _complete_lines(blob: bytes) -> tuple[list[bytes], bool]:
    """Return LF-terminated lines and whether the blob itself ends on LF."""
    if not blob.endswith(b"\n"):
        if b"\n" not in blob:
            return [], False
        head, _partial = blob.rsplit(b"\n", 1)
        return [part + b"\n" for part in head.split(b"\n")], False
    parts = blob.split(b"\n")[:-1]
    return [part + b"\n" for part in parts], True


def _is_sentinel(line: bytes) -> bool:
    return SENTINEL_LINE.fullmatch(line) is not None


def _shard_bytes(shard: Any) -> bytes | None:
    if shard is None:
        return None
    if not isinstance(shard, str):
        raise ValueError("shard must be a string or null")
    return shard.encode("utf-8")


def _stream_facts(shards: list[Any]) -> dict[str, Any]:
    present = [blob for blob in (_shard_bytes(shard) for shard in shards) if blob is not None]
    stream = b"".join(present)
    lines, ends_lf = _complete_lines(stream)
    records = [line for line in lines if not _is_sentinel(line)]
    body = b"".join(records)
    sentinel_at: list[int] = []
    for index, shard in enumerate(shards):
        blob = _shard_bytes(shard)
        if blob is None:
            continue
        shard_lines, _ = _complete_lines(blob)
        if any(_is_sentinel(line) for line in shard_lines):
            sentinel_at.append(index)
    last_line = lines[-1] if lines else b""
    return {
        "stream": stream,
        "ends_lf": ends_lf and stream != b"",
        "records": records,
        "body": body,
        "sentinel_at": sentinel_at,
        "last_line": last_line,
        "last_index": len(shards) - 1,
    }


def naive_judge(row: dict[str, Any]) -> str:
    """Pinned false-green: non-empty bytes, or a parseable JSON prefix, is PASS.

    This function must stay wrong on every must-fail row. It never returns
    TRUNCATED, so a truncated-but-parseable prefix stays PASS here.
    """
    facts = _stream_facts(list(row.get("shards") or []))
    stream: bytes = facts["stream"]
    if stream:
        try:
            json.loads(stream.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        else:
            return "PASS"
        return "PASS"
    return "FAIL"


def apply_v0_1(row: dict[str, Any]) -> tuple[str, str]:
    """Honest judge. First match wins. json.loads is intentionally not called."""
    declared_bytes = row.get("declared_bytes")
    declared_records = row.get("declared_records")
    if not _is_int(declared_bytes) or not _is_int(declared_records):
        return "FAIL", "DECLARATION_ABSENT"
    shards = row.get("shards")
    if not isinstance(shards, list) or not shards:
        return "FAIL", "DECLARATION_ABSENT"
    facts = _stream_facts(shards)
    last_index = facts["last_index"]
    if any(index != last_index for index in facts["sentinel_at"]):
        return "TRUNCATED", "SENTINEL_IN_FIRST_SHARD"
    if not facts["ends_lf"]:
        return "TRUNCATED", "CUT_MID_LINE"
    if not facts["sentinel_at"]:
        return "TRUNCATED", "CUT_BEFORE_SENTINEL"
    body: bytes = facts["body"]
    records: list[bytes] = facts["records"]
    if declared_bytes != len(body) or declared_records != len(records):
        return "TRUNCATED", "COUNT_MISMATCH"
    last_line: bytes = facts["last_line"]
    if (not _is_sentinel(last_line)) or last_line != f"#sha8:{_sha8(body)}\n".encode("ascii"):
        return "TRUNCATED", "SHA_MISMATCH"
    return "PASS", "COMPLETE"


def judge(row: dict[str, Any], digest: str) -> dict[str, Any]:
    if row.get("spec_version") != SPEC or row.get("criteria_digest") != digest:
        return {"criteria_bound": False, "verdict": None, "reason_code": None}
    verdict, reason = apply_v0_1(row)
    if verdict not in CLOSED:
        raise RuntimeError(f"verdict {verdict!r} outside closed set")
    return {"criteria_bound": True, "verdict": verdict, "reason_code": reason}


def _case(
    case_id: str,
    shards: list[Any],
    declared_bytes: int | None,
    declared_records: int | None,
    verdict: str,
    reason: str,
    must_fail: bool,
    digest: str,
) -> dict[str, Any]:
    return {
        "case_id": case_id,
        "shards": shards,
        "declared_bytes": declared_bytes,
        "declared_records": declared_records,
        "expected_verdict": verdict,
        "reason_code": reason,
        "must_fail": must_fail,
        "spec_version": SPEC,
        "criteria_digest": digest,
    }


def _records(n: int, start: int = 1) -> str:
    return "".join(f"r{i:04d}\n" for i in range(start, start + n))


def build_rows() -> dict[str, Any]:
    digest = criteria_digest()
    single_body = _records(2)
    single = _case(
        "positive-single-shard",
        [single_body + _sentinel(single_body)],
        len(single_body.encode("utf-8")),
        2,
        "PASS",
        "COMPLETE",
        False,
        digest,
    )
    multi_body = _records(3)
    multi_head, multi_tail = _records(2), _records(1, start=3)
    multi = _case(
        "positive-multi-shard",
        [multi_head, multi_tail + _sentinel(multi_body)],
        len(multi_body.encode("utf-8")),
        3,
        "PASS",
        "COMPLETE",
        False,
        digest,
    )
    cut_body = _records(2)
    cut_before = _case(
        "cut-before-sentinel",
        [cut_body],
        len(cut_body.encode("utf-8")),
        2,
        "TRUNCATED",
        "CUT_BEFORE_SENTINEL",
        True,
        digest,
    )
    sha_body = _records(2)
    sha_bad = _case(
        "sha-mismatch",
        [sha_body + "#sha8:00000000\n"],
        len(sha_body.encode("utf-8")),
        2,
        "TRUNCATED",
        "SHA_MISMATCH",
        True,
        digest,
    )
    mid_full = _records(2)
    mid = _case(
        "cut-mid-line",
        [mid_full[:-4]],
        len(mid_full.encode("utf-8")),
        2,
        "TRUNCATED",
        "CUT_MID_LINE",
        True,
        digest,
    )
    prefix = _records(1)
    later = _records(1, start=2)
    first_shard = _case(
        "sentinel-in-first-shard",
        [prefix + _sentinel(prefix), None],
        len((prefix + later).encode("utf-8")),
        2,
        "TRUNCATED",
        "SENTINEL_IN_FIRST_SHARD",
        True,
        digest,
    )
    # The full document and the cut prefix are each one record line. The prefix
    # is valid JSON; the declared byte count is the uncut document, and the
    # sentinel was never written. Parsing that prefix must not become PASS.
    full_json = '[{"id":1},{"id":2},{"id":3}]\n'
    short_json = '[{"id":1},{"id":2}]\n'
    parseable = _case(
        "neg-parseable-json-prefix",
        [short_json],
        len(full_json.encode("utf-8")),
        1,
        "TRUNCATED",
        "CUT_BEFORE_SENTINEL",
        True,
        digest,
    )
    count_body = _records(2)
    count_bad = _case(
        "count-mismatch",
        [count_body + _sentinel(count_body)],
        len(count_body.encode("utf-8")),
        3,
        "TRUNCATED",
        "COUNT_MISMATCH",
        True,
        digest,
    )
    undeclared = _case(
        "fail-declaration-absent",
        [_records(1)],
        None,
        None,
        "FAIL",
        "DECLARATION_ABSENT",
        True,
        digest,
    )
    cases = [single, multi, cut_before, sha_bad, mid, first_shard, parseable, count_bad, undeclared]
    return {
        "fixture": FIXTURE,
        "spec_version": SPEC,
        "criteria_digest": digest,
        "real_sample_todo": [dict(item) for item in REAL_SAMPLE_TODO],
        "cases": {row["case_id"]: row for row in cases},
    }


def _strip(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k not in ("expected_verdict", "reason_code")}


def evaluate(doc: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    on_disk = json.loads(EXPECTED_PATH.read_text(encoding="utf-8"))
    digest = criteria_digest()
    checks: list[dict[str, Any]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    add("expected_json_matches_materialized_rows", on_disk == doc)
    add("criteria_digest_matches_readme_section", doc["criteria_digest"] == digest and len(digest) == 64)
    add(
        "criteria_digest_tracks_section_bytes",
        hashlib.sha256(criteria_section_bytes() + b" ").hexdigest() != digest,
    )
    todos = doc["real_sample_todo"]
    add(
        "real_sample_todo_slots_open",
        [item["arm"] for item in todos] == ["cut-before-sentinel", "sha-mismatch"]
        and all(item["status"] == "TODO" and item["payload"] is None and item["owner"] == "真虾" for item in todos),
    )

    rows: list[dict[str, Any]] = []
    positives = 0
    for case_id, row in doc["cases"].items():
        got = judge(row, digest)
        stripped = judge(_strip(row), digest)
        naive = naive_judge(row)
        ok = (
            got["criteria_bound"] is True
            and got["verdict"] == row["expected_verdict"]
            and got["reason_code"] == row["reason_code"]
            and got["verdict"] in CLOSED
            and stripped == got
            and row["criteria_digest"] == digest
        )
        if got["verdict"] == "TRUNCATED":
            ok = ok and got["verdict"] not in ("PASS", "FAIL")
        if row["must_fail"]:
            ok = ok and naive == "PASS" and naive != got["verdict"] and naive != "TRUNCATED"
        if row["expected_verdict"] == "PASS":
            positives += 1
            ok = ok and got["reason_code"] == "COMPLETE"
        add(f"arm-{case_id}", ok, f"verdict={got['verdict']} reason={got['reason_code']} naive={naive}")
        rows.append(
            {
                "case_id": case_id,
                "expected_verdict": row["expected_verdict"],
                "reason_code": row["reason_code"],
                "verdict": got["verdict"],
                "got_reason": got["reason_code"],
                "naive_verdict": naive,
                "criteria_bound": got["criteria_bound"],
                "must_fail": row["must_fail"],
                "ok": ok,
            }
        )

    add("at_least_two_positive_controls", positives >= 2)

    first = doc["cases"]["sentinel-in-first-shard"]
    prefix = "r0001\n"
    embedded = first["shards"][0].split("#sha8:", 1)[1][:8]
    add(
        "sentinel_in_first_shard_never_pass",
        first["shards"][1] is None
        and embedded == _sha8(prefix.encode("utf-8"))
        and apply_v0_1(first) == ("TRUNCATED", "SENTINEL_IN_FIRST_SHARD"),
        f"prefix_sha8={embedded}",
    )

    prefix_json = doc["cases"]["neg-parseable-json-prefix"]["shards"][0]
    parsed = json.loads(prefix_json)
    parsed_verdict = apply_v0_1(doc["cases"]["neg-parseable-json-prefix"])
    add(
        "parseable_prefix_is_not_pass",
        parsed == [{"id": 1}, {"id": 2}]
        and parsed_verdict[0] == "TRUNCATED"
        and parsed_verdict[0] not in ("PASS", "FAIL")
        and naive_judge(doc["cases"]["neg-parseable-json-prefix"]) == "PASS",
    )

    # Each comparison fails on its own: the other two hold on these rows.
    alone = {
        "cut-mid-line": "CUT_MID_LINE",
        "cut-before-sentinel": "CUT_BEFORE_SENTINEL",
        "count-mismatch": "COUNT_MISMATCH",
        "sha-mismatch": "SHA_MISMATCH",
    }
    for case_id, reason in alone.items():
        verdict, got_reason = apply_v0_1(doc["cases"][case_id])
        add(f"comparison-alone-{case_id}", verdict == "TRUNCATED" and got_reason == reason)

    multi = doc["cases"]["positive-multi-shard"]
    add(
        "multi_shard_sentinel_only_on_last",
        "#sha8:" not in multi["shards"][0] and multi["shards"][1].startswith("r0003\n#sha8:"),
    )

    paired = doc["cases"]["positive-single-shard"]
    unbound_specs = [
        ("probe-missing-spec-version", {k: v for k, v in paired.items() if k != "spec_version"}),
        ("probe-missing-criteria-digest", {k: v for k, v in paired.items() if k != "criteria_digest"}),
        ("probe-digest-of-other-body", {**paired, "criteria_digest": hashlib.sha256(b"other-body").hexdigest()}),
        ("probe-unregistered-spec", {**paired, "spec_version": "v0.2"}),
    ]
    for name, row in unbound_specs:
        got = judge(row, digest)
        add(name, got["criteria_bound"] is False and got["verdict"] is None and got["verdict"] != "PASS")
        rows.append(
            {
                "case_id": name,
                "criteria_bound": got["criteria_bound"],
                "verdict": got["verdict"],
                "ok": got["criteria_bound"] is False and got["verdict"] is None,
            }
        )
    return checks, rows


def main() -> int:
    doc = build_rows()
    checks, rows = evaluate(doc)
    ok_n = sum(1 for c in checks if c["ok"])
    payload = {
        "fixture": FIXTURE,
        "version": SPEC,
        "closed_verdicts": list(CLOSED),
        "criteria_digest": doc["criteria_digest"],
        "real_sample_todo": doc["real_sample_todo"],
        "all_match": ok_n == len(checks),
        "selftest": f"{ok_n}/{len(checks)}",
        "naive_wrong_caught": sum(1 for r in rows if r.get("must_fail") and r.get("ok")),
        "checks": checks,
        "rows": rows,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    RUN_OUT_PATH.write_bytes(text.encode("utf-8"))
    sys.stdout.buffer.write(text.encode("utf-8"))
    return 0 if payload["all_match"] else 1


if __name__ == "__main__":
    sys.exit(main())
