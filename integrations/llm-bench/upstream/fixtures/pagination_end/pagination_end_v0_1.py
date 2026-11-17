#!/usr/bin/env python3
"""PAGINATION_END v0.1

Synthetic analyze_only fixture. Closed verdict set: GREEN, RED.
expected_verdict is its own field and is not an input. criteria_digest is
sha256 of the README criteria section (raw bytes between the markers).

The pinned naive baseline treats has_more false, or a missing / null / empty
next_cursor, as GREEN. Each red rule has a must-fail row where that baseline
returns GREEN.

Stdlib only. No credentials, no network.
Credit: rules co-designed with EigenFlux agent 洋洋的workbuddy.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
EXPECTED_PATH = HERE / "expected.json"
RUN_OUT_PATH = HERE / "run_out_v0_1.json"
README_PATH = HERE / "README.md"

CLOSED = ("GREEN", "RED")
FIXTURE = "pagination_end"
SPEC = "v0.1"
BEGIN = b"<!-- BEGIN CRITERIA -->\n"
END = b"<!-- END CRITERIA -->"

RED_RULES = (
    "CONTRACT_FIELD_MISSING",
    "EMPTY_STRING_CURSOR",
    "HAS_MORE_TRUE_WITH_NULL_CURSOR",
    "PAGINATION_END_CONTRADICTION",
    "FULL_PAGE_NOT_PROBED",
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


def _full_page(page: dict[str, Any]) -> bool:
    items = page.get("items")
    page_size = page.get("page_size")
    return _is_int(items) and _is_int(page_size) and page_size > 0 and items == page_size


def _consistent_empty(probe: Any) -> bool:
    if not isinstance(probe, dict):
        return False
    if not _is_int(probe.get("items")) or probe.get("items") != 0:
        return False
    if probe.get("has_more") is not False:
        return False
    if "next_cursor" not in probe:
        return False
    return probe.get("next_cursor") is None


def naive_judge(page: dict[str, Any]) -> str:
    """Pinned false-green: end reached if has_more is false or the cursor is blank.

    This function must stay wrong on every must-fail row.
    """
    if page.get("has_more") is False:
        return "GREEN"
    if "next_cursor" not in page or page.get("next_cursor") in (None, ""):
        return "GREEN"
    return "RED"


def apply_v0_1(page: dict[str, Any], probe: Any) -> tuple[str, str]:
    """Honest judge. First match wins. Never reads expected_verdict."""
    if "next_cursor" not in page:
        return "RED", "CONTRACT_FIELD_MISSING"
    cursor = page.get("next_cursor")
    if cursor == "":
        return "RED", "EMPTY_STRING_CURSOR"
    has_more = page.get("has_more")
    if has_more is True and cursor is None:
        return "RED", "HAS_MORE_TRUE_WITH_NULL_CURSOR"
    if has_more is False and isinstance(cursor, str) and cursor != "":
        return "RED", "PAGINATION_END_CONTRADICTION"
    if _full_page(page) and not _consistent_empty(probe):
        return "RED", "FULL_PAGE_NOT_PROBED"
    items = page.get("items")
    page_size = page.get("page_size")
    short = _is_int(items) and _is_int(page_size) and items < page_size
    if has_more is False and cursor is None and (short or _consistent_empty(probe)):
        return "GREEN", "END_CONFIRMED"
    return "RED", "UNCLASSIFIED"


def judge(row: dict[str, Any], digest: str) -> dict[str, Any]:
    if row.get("spec_version") != SPEC or row.get("criteria_digest") != digest:
        return {"criteria_bound": False, "verdict": None, "reason_code": None}
    page = row.get("page")
    if not isinstance(page, dict):
        return {"criteria_bound": True, "verdict": "RED", "reason_code": "UNCLASSIFIED"}
    verdict, reason = apply_v0_1(page, row.get("probe"))
    if verdict not in CLOSED:
        raise RuntimeError(f"verdict {verdict!r} outside closed set")
    return {"criteria_bound": True, "verdict": verdict, "reason_code": reason}


def _page(items: int, page_size: int, has_more: bool, cursor: Any, *, omit_cursor: bool = False) -> dict[str, Any]:
    page: dict[str, Any] = {"items": items, "page_size": page_size, "has_more": has_more}
    if not omit_cursor:
        page["next_cursor"] = cursor
    return page


def _case(
    case_id: str,
    page: dict[str, Any],
    probe: dict[str, Any] | None,
    verdict: str,
    reason: str,
    must_fail: bool,
    digest: str,
) -> dict[str, Any]:
    return {
        "case_id": case_id,
        "page": page,
        "probe": probe,
        "expected_verdict": verdict,
        "reason_code": reason,
        "must_fail": must_fail,
        "spec_version": SPEC,
        "criteria_digest": digest,
    }


def build_rows() -> dict[str, Any]:
    digest = criteria_digest()
    empty = _page(0, 10, False, None)
    cases = [
        _case("positive-short-page", _page(2, 10, False, None), None, "GREEN", "END_CONFIRMED", False, digest),
        _case("positive-empty-page", empty, None, "GREEN", "END_CONFIRMED", False, digest),
        _case(
            "positive-full-page-with-empty-probe",
            _page(10, 10, False, None),
            empty,
            "GREEN",
            "END_CONFIRMED",
            False,
            digest,
        ),
        _case(
            "red-pagination-end-contradiction",
            _page(3, 10, False, "cur-9"),
            None,
            "RED",
            "PAGINATION_END_CONTRADICTION",
            True,
            digest,
        ),
        _case(
            "red-full-page-not-probed",
            _page(10, 10, False, None),
            None,
            "RED",
            "FULL_PAGE_NOT_PROBED",
            True,
            digest,
        ),
        _case(
            "red-full-page-still-open",
            _page(10, 10, True, "cur-2"),
            None,
            "RED",
            "FULL_PAGE_NOT_PROBED",
            False,
            digest,
        ),
        _case(
            "red-empty-string-cursor",
            _page(1, 10, False, ""),
            None,
            "RED",
            "EMPTY_STRING_CURSOR",
            True,
            digest,
        ),
        _case(
            "red-contract-field-missing",
            _page(1, 10, False, None, omit_cursor=True),
            None,
            "RED",
            "CONTRACT_FIELD_MISSING",
            True,
            digest,
        ),
        _case(
            "red-has-more-true-null-cursor",
            _page(4, 10, True, None),
            None,
            "RED",
            "HAS_MORE_TRUE_WITH_NULL_CURSOR",
            True,
            digest,
        ),
    ]
    return {
        "fixture": FIXTURE,
        "spec_version": SPEC,
        "criteria_digest": digest,
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
    mutated = criteria_section_bytes() + b" "
    add(
        "criteria_digest_tracks_section_bytes",
        hashlib.sha256(mutated).hexdigest() != digest,
    )

    rows: list[dict[str, Any]] = []
    greens = 0
    must_fail_reasons: set[str] = set()
    for case_id, row in doc["cases"].items():
        got = judge(row, digest)
        stripped = judge(_strip(row), digest)
        naive = naive_judge(row["page"])
        ok = (
            got["criteria_bound"] is True
            and got["verdict"] == row["expected_verdict"]
            and got["reason_code"] == row["reason_code"]
            and got["verdict"] in CLOSED
            and stripped == got
            and row["spec_version"] == SPEC
            and row["criteria_digest"] == digest
            and set(row) >= {"expected_verdict", "reason_code"}
        )
        if row["must_fail"]:
            ok = ok and naive == "GREEN" and naive != got["verdict"]
            must_fail_reasons.add(row["reason_code"])
        if got["verdict"] == "GREEN":
            greens += 1
            ok = ok and row["reason_code"] == "END_CONFIRMED" and naive == "GREEN"
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

    add("at_least_two_positive_cases", greens >= 2)
    add("must_fail_covers_each_red_rule", must_fail_reasons == set(RED_RULES))

    paired = doc["cases"]["positive-full-page-with-empty-probe"]
    add(
        "positive_full_page_paired_with_consistent_empty_page",
        _full_page(paired["page"]) and _consistent_empty(paired["probe"]) and paired["expected_verdict"] == "GREEN",
    )
    empty_string = doc["cases"]["red-empty-string-cursor"]
    add(
        "empty_string_listed_separately",
        empty_string["reason_code"] == "EMPTY_STRING_CURSOR"
        and apply_v0_1(empty_string["page"], None)[1] != "PAGINATION_END_CONTRADICTION",
    )
    missing = doc["cases"]["red-contract-field-missing"]
    add("missing_cursor_is_not_green", "next_cursor" not in missing["page"] and missing["expected_verdict"] == "RED")

    # A whitespace cursor is non-empty, so it stays in family A.
    space_verdict, space_reason = apply_v0_1(_page(2, 10, False, " "), None)
    add("whitespace_cursor_is_contradiction", space_verdict == "RED" and space_reason == "PAGINATION_END_CONTRADICTION")

    # A full page is not rescued by an empty page that still carries a cursor.
    bad_probe = _page(0, 10, False, "cur-left")
    bad_verdict, bad_reason = apply_v0_1(_page(10, 10, False, None), bad_probe)
    add("inconsistent_empty_probe_stays_red", bad_verdict == "RED" and bad_reason == "FULL_PAGE_NOT_PROBED")

    # Honest continuation that is not a full page matches no green rule.
    cont_verdict, cont_reason = apply_v0_1(_page(2, 10, True, "cur-2"), None)
    add("short_continuation_is_not_green", cont_verdict != "GREEN" and cont_reason == "UNCLASSIFIED")

    unbound_specs = [
        ("probe-missing-spec-version", {k: v for k, v in paired.items() if k != "spec_version"}),
        ("probe-missing-criteria-digest", {k: v for k, v in paired.items() if k != "criteria_digest"}),
        ("probe-digest-of-other-body", {**paired, "criteria_digest": hashlib.sha256(b"other-body").hexdigest()}),
        ("probe-unregistered-spec", {**paired, "spec_version": "v0.2"}),
    ]
    for name, row in unbound_specs:
        got = judge(row, digest)
        add(name, got["criteria_bound"] is False and got["verdict"] is None and got["verdict"] != "GREEN")
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
