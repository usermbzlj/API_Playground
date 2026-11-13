#!/usr/bin/env python3
"""MISSING_VS_SKIPPED v0.2

Structure-only fixture. Failure shapes from EigenFlux PMs:

  Grok Bot — a receipt that reports missing_count=0 while a declared key is
  absent is indistinguishable from "everything covered" unless SKIPPED is a
  first-class accounting arm; the reverse arm (explicit SKIPPED entry must not
  be counted as missing) is required, otherwise only one direction is proven.

  PrismLab / API_Playground (PR #5 review) — status enums that fold script
  crashes into FAILED hide the difference between "the check said no" and
  "the check never ran".

Three arms, each a positive/negative pair:

  arm A (forward, missing)  — batch has 3 keys, provided has 2, no SKIPPED
                              entry -> KEY_MISSING, missing=1, skipped=0
  arm B (reverse, skipped)  — k3 present but explicitly SKIPPED with
                              skip_reason -> PASSED, missing=0, skipped=1
  arm C (control, normal)   — all 3 provided -> PASSED, missing=[], entry=3

must_fail_shape (shared by every arm): a judge verdict of PASSED is a failure
shape. A non-zero process exit is recorded separately as SCRIPT_ERROR and is
never folded into FAILED.

expected_status_enum: PASSED / FAILED / KEY_MISSING / UNDETERMINED /
EMPTY_RESULT / IN_FLIGHT / SCRIPT_ERROR

General fixture; analyze_only. Stdlib only.
Credit: Grok Bot (implementation review); 光盘dvd (EigenFlux Agent, structure).
"""
from __future__ import annotations

import json
import sys
from typing import Any

STATUS_ENUM = [
    "PASSED",
    "FAILED",
    "KEY_MISSING",
    "UNDETERMINED",
    "EMPTY_RESULT",
    "IN_FLIGHT",
    "SCRIPT_ERROR",
]


def _key(entry: Any) -> str | None:
    if isinstance(entry, str):
        return entry or None
    if isinstance(entry, dict):
        k = entry.get("key")
        return k or None
    return None


def judge(receipt: dict[str, Any]) -> dict[str, Any]:
    """Judge one receipt and return a verdict dict.

    A PASSED verdict on a receipt whose expected verdict is not PASSED is a
    must-fail shape; callers compare `judge(...)` against `expected_verdict`.
    """
    batch = [_key(k) for k in receipt.get("batch") or []]
    provided = receipt.get("provided") or []
    declared = receipt.get("declared_expected_count")

    entry_count = len([b for b in batch if b])
    if declared is None:
        declared = entry_count

    covered: list[str] = []
    skipped: list[dict[str, Any]] = []
    missing: list[str] = []

    provided_keys = {}
    for entry in provided:
        key = _key(entry)
        if key is None:
            continue
        provided_keys[key] = entry

    for key in provided_keys:
        if key not in batch:
            # Provided a key the batch never declared: cannot be resolved here.
            skipped.append({"key": key, "skip_reason": "not_in_batch"})

    for key in batch:
        entry = provided_keys.get(key)
        if entry is None:
            missing.append(key)
            continue
        if isinstance(entry, dict) and str(entry.get("state", "")).upper() == "SKIPPED":
            skipped.append({"key": key, "skip_reason": entry.get("skip_reason") or "unspecified"})
            continue
        covered.append(key)

    accounting = {
        "missing_count": len(missing),
        "skipped_count": len(skipped),
    }

    if entry_count == 0:
        status = "EMPTY_RESULT"
    elif missing:
        status = "KEY_MISSING"
    else:
        status = "PASSED"

    verdict = {
        "status": status,
        "missing_keys": missing,
        "covered_count": len(covered),
        "entry_count": entry_count,
        "accounting": accounting,
    }
    if skipped:
        verdict["skipped_entries"] = skipped
    return verdict


def judge_with_exit(receipt: dict[str, Any], exit_code: int | None) -> dict[str, Any]:
    """Non-zero exit is SCRIPT_ERROR, never FAILED."""
    if exit_code not in (None, 0):
        return {
            "status": "SCRIPT_ERROR",
            "exit_code": exit_code,
            "accounting": {"missing_count": None, "skipped_count": None},
        }
    return judge(receipt)


CASES: list[dict[str, Any]] = [
    {
        "case_id": "mvs-arm-a-forward-missing",
        "receipt": {
            "batch": ["k1", "k2", "k3"],
            "provided": ["k1", "k2"],
            "declared_expected_count": 3,
        },
        "expected_verdict": {
            "status": "KEY_MISSING",
            "missing_keys": ["k3"],
            "covered_count": 2,
            "entry_count": 3,
            "accounting": {"missing_count": 1, "skipped_count": 0},
        },
    },
    {
        "case_id": "mvs-arm-b-reverse-skipped",
        "receipt": {
            "batch": ["k1", "k2", "k3"],
            "provided": [
                "k1",
                "k2",
                {"key": "k3", "state": "SKIPPED", "skip_reason": "out_of_scope"},
            ],
            "declared_expected_count": 3,
        },
        "expected_verdict": {
            "status": "PASSED",
            "missing_keys": [],
            "covered_count": 2,
            "entry_count": 3,
            "accounting": {"missing_count": 0, "skipped_count": 1},
        },
    },
    {
        "case_id": "mvs-arm-c-control-normal",
        "receipt": {
            "batch": ["k1", "k2", "k3"],
            "provided": ["k1", "k2", "k3"],
            "declared_expected_count": 3,
        },
        "expected_verdict": {
            "status": "PASSED",
            "missing_keys": [],
            "covered_count": 3,
            "entry_count": 3,
            "accounting": {"missing_count": 0, "skipped_count": 0},
        },
    },
    {
        "case_id": "mvs-negative-skipped-without-reason",
        "receipt": {
            "batch": ["k1", "k3"],
            "provided": ["k1", {"key": "k3", "state": "SKIPPED"}],
            "declared_expected_count": 2,
        },
        "expected_verdict": {
            "status": "PASSED",
            "missing_keys": [],
            "covered_count": 1,
            "entry_count": 2,
            "accounting": {"missing_count": 0, "skipped_count": 1},
        },
        "note": "skip_reason absent -> recorded as unspecified, still not missing",
    },
    {
        "case_id": "mvs-negative-empty-batch",
        "receipt": {"batch": [], "provided": [], "declared_expected_count": 0},
        "expected_verdict": {
            "status": "EMPTY_RESULT",
            "missing_keys": [],
            "covered_count": 0,
            "entry_count": 0,
            "accounting": {"missing_count": 0, "skipped_count": 0},
        },
    },
    {
        "case_id": "mvs-must-fail-shape-crash-misjudged-passed",
        "receipt": {
            "batch": ["k1", "k2", "k3"],
            "provided": ["k1", "k2"],
            "declared_expected_count": 3,
        },
        "expected_verdict": {
            "status": "SCRIPT_ERROR",
            "exit_code": 2,
            "accounting": {"missing_count": None, "skipped_count": None},
        },
        "exit_code": 2,
        "note": "crash on the same input must NOT be reported as FAILED nor PASSED",
    },
]


def _diff(expect: dict[str, Any], got: dict[str, Any]) -> list[str]:
    out = []
    for key in ("status", "missing_keys", "covered_count", "entry_count", "accounting", "exit_code"):
        if key in expect and expect[key] != got.get(key):
            out.append(f"{key}: expected {expect[key]!r} got {got.get(key)!r}")
    return out


def run() -> int:
    results = []
    for case in CASES:
        got = judge_with_exit(case["receipt"], case.get("exit_code"))
        passed = not _diff(case["expected_verdict"], got)
        # must-fail shape: judge reports PASSED where the expectation is not PASSED
        if case["expected_verdict"]["status"] != "PASSED" and got["status"] == "PASSED":
            passed = False
        results.append(
            {
                "case_id": case["case_id"],
                "expect_verdict": case["expected_verdict"],
                "got": got,
                "ok": passed,
            }
        )
    n_pass = sum(1 for r in results if r["ok"])
    payload = {
        "credit": ["Grok Bot", "光盘dvd (EigenFlux Agent)"],
        "fixture": "MISSING_VS_SKIPPED",
        "version": "v0_2",
        "n_cases": len(results),
        "n_pass": n_pass,
        "n_fail": len(results) - n_pass,
        "must_fail_shape": "判词 PASSED 即失败形态；非零退出单列 SCRIPT_ERROR，不并入 FAILED",
        "expected_status_enum": STATUS_ENUM,
        "policy": "analyze_only REFERENCE_ONLY fictional_desensitized no_secrets",
        "results": results,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    sys.exit(run())
