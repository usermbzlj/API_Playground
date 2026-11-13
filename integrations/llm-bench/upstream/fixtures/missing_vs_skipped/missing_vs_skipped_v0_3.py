#!/usr/bin/env python3
"""MISSING_VS_SKIPPED v0.3

Structure-only fixture. Failure shapes from EigenFlux PMs:

  Grok Bot — a receipt that reports missing_count=0 while a declared key is
  absent is indistinguishable from "everything covered" unless SKIPPED is a
  first-class accounting arm; the reverse arm (explicit SKIPPED entry must not
  be counted as missing) is required, otherwise only one direction is proven.

  Grok Bot (second review of v0.2) — three probes that v0.2 failed:
    1. declared_expected_count did not take part in the verdict: batch declared
       3, provided 2, still PASSED -> must be UNDETERMINED with a must-fail case.
    2. a batch where every key is SKIPPED judged PASSED with covered=0 ->
       must be UNDETERMINED, aligned with undetermined_cap.
    3. keys outside the declared batch (e.g. typo k2x) were counted into
       skipped_count -> must be a separate extra_keys arm.

  PrismLab / API_Playground (PR #5 review) — status enums that fold script
  crashes into FAILED hide the difference between "the check said no" and
  "the check never ran".

Arms:

  A forward, missing          batch 3 / provided 2            -> KEY_MISSING
  B reverse, skipped          k3 explicitly SKIPPED            -> PASSED
  C control, normal           all 3 provided                  -> PASSED
  D declared mismatch         4 declared / 3 in batch         -> UNDETERMINED
  E all skipped               every key SKIPPED, covered=0    -> UNDETERMINED
  F extra keys                typo k2x outside batch          -> extra_keys arm
  G empty batch               batch []                        -> EMPTY_RESULT
  H crash                     same input, exit 2              -> SCRIPT_ERROR

must_fail_shape (shared by every arm): a judge verdict of PASSED is a failure
shape. A non-zero process exit is recorded separately as SCRIPT_ERROR and is
never folded into FAILED.

Mutation probe (optional in v0.2, required in v0.3): a judge that folds
SKIPPED into missing must go red on arm B. `judge_mutated_skips_as_missing`
is that mutant; case mvs-mutation-skips-as-missing-detected asserts the
mutant disagrees with the honest verdict.

expected_status_enum: PASSED / FAILED / KEY_MISSING / UNDETERMINED /
EMPTY_RESULT / IN_FLIGHT / SCRIPT_ERROR

General fixture; analyze_only. Stdlib only.
Credit: Grok Bot (implementation review, probes 1-3 and the mutation probe);
光盘dvd (EigenFlux Agent, structure).
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

UNDETERMINED_CAP = 0.20


def _key(entry: Any) -> str | None:
    if isinstance(entry, str):
        return entry or None
    if isinstance(entry, dict):
        k = entry.get("key")
        return k or None
    return None


def _is_skipped(entry: Any) -> bool:
    return isinstance(entry, dict) and str(entry.get("state", "")).upper() == "SKIPPED"


def judge(receipt: dict[str, Any], *, skips_as_missing: bool = False) -> dict[str, Any]:
    """Judge one receipt and return a verdict dict.

    `skips_as_missing=True` is the mutation probe: it produces the false-green
    shape this fixture exists to catch. Never use it in production paths.
    """
    batch = [_key(k) for k in receipt.get("batch") or []]
    batch = [b for b in batch if b]
    entry_count = len(batch)
    declared = receipt.get("declared_expected_count")

    covered: list[str] = []
    skipped: list[dict[str, Any]] = []
    missing: list[str] = []
    extra: list[str] = []
    evidence_gaps: list[str] = []

    provided_keys: dict[str, Any] = {}
    for entry in receipt.get("provided") or []:
        key = _key(entry)
        if key is None:
            continue
        provided_keys[key] = entry

    # probe 3: keys outside the declared batch are extra, never skipped
    for key in provided_keys:
        if key not in batch:
            extra.append(key)

    for key in batch:
        entry = provided_keys.get(key)
        if entry is None:
            missing.append(key)
            continue
        if _is_skipped(entry):
            if skips_as_missing:
                missing.append(key)
            else:
                skipped.append(
                    {"key": key, "skip_reason": entry.get("skip_reason") or "unspecified"}
                )
            continue
        covered.append(key)

    # probe 1: the declared denominator must be reconciled with the batch
    if declared is None:
        evidence_gaps.append("declared_expected_count_missing")
    elif declared != entry_count:
        evidence_gaps.append(f"declared_vs_batch_mismatch:{declared}!={entry_count}")

    accounting = {
        "missing_count": len(missing),
        "skipped_count": len(skipped),
        "extra_count": len(extra),
        "declared_expected_count": declared,
    }

    undetermined_ratio = 0.0
    if entry_count:
        declared_ref = declared if isinstance(declared, int) and declared > entry_count else entry_count
        undetermined_ratio = (declared_ref - len(covered) - len(missing)) / declared_ref
        undetermined_ratio = round(max(undetermined_ratio, 0.0), 4)

    if entry_count == 0:
        status = "EMPTY_RESULT"
    elif evidence_gaps:
        status = "UNDETERMINED"
    elif missing:
        status = "KEY_MISSING"
    elif covered == [] and skipped:
        # probe 2: every declared key skipped -> covered=0 -> not a pass
        status = "UNDETERMINED"
        evidence_gaps.append("all_skipped_zero_coverage")
    else:
        status = "PASSED"

    if entry_count and covered == [] and not skipped and not missing:
        status = "UNDETERMINED"

    verdict: dict[str, Any] = {
        "status": status,
        "missing_keys": missing,
        "covered_count": len(covered),
        "entry_count": entry_count,
        "accounting": accounting,
        "undetermined_ratio": undetermined_ratio,
        "undetermined_cap": UNDETERMINED_CAP,
        "degraded": bool(undetermined_ratio > UNDETERMINED_CAP),
    }
    if skipped:
        verdict["skipped_entries"] = skipped
    if extra:
        verdict["extra_keys"] = extra
    if evidence_gaps:
        verdict["evidence_gap"] = evidence_gaps
    return verdict


def judge_mutated_skips_as_missing(receipt: dict[str, Any]) -> dict[str, Any]:
    """Mutation probe: folds SKIPPED into missing. Must go red on arm B."""
    return judge(receipt, skips_as_missing=True)


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
            "accounting": {"missing_count": 1, "skipped_count": 0, "extra_count": 0},
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
            "accounting": {"missing_count": 0, "skipped_count": 1, "extra_count": 0},
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
            "accounting": {"missing_count": 0, "skipped_count": 0, "extra_count": 0},
        },
    },
    {
        "case_id": "mvs-arm-d-declared-mismatch-undetermined",
        "receipt": {
            "batch": ["k1", "k2", "k3"],
            "provided": ["k1", "k2"],
            "declared_expected_count": 4,
        },
        "expected_verdict": {
            "status": "UNDETERMINED",
            "missing_keys": ["k3"],
            "covered_count": 2,
            "entry_count": 3,
            "accounting": {"missing_count": 1, "skipped_count": 0, "extra_count": 0},
        },
        "note": "Grok probe 1: declared 4 vs batch 3 -> evidence gap beats KEY_MISSING, must not pass",
    },
    {
        "case_id": "mvs-arm-e-all-skipped-undetermined",
        "receipt": {
            "batch": ["k1", "k2"],
            "provided": [
                {"key": "k1", "state": "SKIPPED", "skip_reason": "out_of_scope"},
                {"key": "k2", "state": "SKIPPED", "skip_reason": "out_of_scope"},
            ],
            "declared_expected_count": 2,
        },
        "expected_verdict": {
            "status": "UNDETERMINED",
            "missing_keys": [],
            "covered_count": 0,
            "entry_count": 2,
            "accounting": {"missing_count": 0, "skipped_count": 2, "extra_count": 0},
        },
        "note": "Grok probe 2: covered=0 while skipped>0 is not a pass; aligns with undetermined_cap",
    },
    {
        "case_id": "mvs-arm-f-extra-key-not-skipped",
        "receipt": {
            "batch": ["k1", "k2"],
            "provided": ["k1", "k2", "k2x"],
            "declared_expected_count": 2,
        },
        "expected_verdict": {
            "status": "PASSED",
            "extra_keys": ["k2x"],
            "covered_count": 2,
            "entry_count": 2,
            "accounting": {"missing_count": 0, "skipped_count": 0, "extra_count": 1},
        },
        "note": "Grok probe 3: typo key goes to extra_keys, never into skipped_count",
    },
    {
        "case_id": "mvs-negative-empty-batch",
        "receipt": {"batch": [], "provided": [], "declared_expected_count": 0},
        "expected_verdict": {
            "status": "EMPTY_RESULT",
            "missing_keys": [],
            "covered_count": 0,
            "entry_count": 0,
            "accounting": {"missing_count": 0, "skipped_count": 0, "extra_count": 0},
        },
    },
    {
        "case_id": "mvs-must-fail-shape-declared-count-ignored",
        "receipt": {
            "batch": ["k1", "k2", "k3"],
            "provided": ["k1", "k2"],
            "declared_expected_count": 4,
        },
        "expected_verdict": {
            "status": "UNDETERMINED",
            "missing_keys": ["k3"],
            "covered_count": 2,
            "entry_count": 3,
            "accounting": {"missing_count": 1, "skipped_count": 0, "extra_count": 0},
        },
        "must_fail_note": "PASSED on this input is the failure shape Grok probe 1 found in v0.2",
    },
    {
        "case_id": "mvs-mutation-skips-as-missing-detected",
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
            "accounting": {"missing_count": 0, "skipped_count": 1, "extra_count": 0},
        },
        "mutation": True,
        "note": "mutation probe: the SKIPPED->missing mutant must disagree on arm B",
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

COMPARED_KEYS = (
    "status",
    "missing_keys",
    "covered_count",
    "entry_count",
    "extra_keys",
    "exit_code",
)


def _diff(expect: dict[str, Any], got: dict[str, Any]) -> list[str]:
    out = []
    for key in COMPARED_KEYS:
        if key in expect and expect[key] != got.get(key):
            out.append(f"{key}: expected {expect[key]!r} got {got.get(key)!r}")
    exp_acc = expect.get("accounting")
    if isinstance(exp_acc, dict):
        got_acc = got.get("accounting") or {}
        for sub, val in exp_acc.items():
            if isinstance(val, int) and got_acc.get(sub) != val:
                out.append(f"accounting.{sub}: expected {val} got {got_acc.get(sub)}")
    return out


def run() -> int:
    results = []
    for case in CASES:
        receipt = case["receipt"]
        exit_code = case.get("exit_code")
        if case.get("mutation"):
            honest = judge_with_exit(receipt, exit_code)
            mutant = judge_mutated_skips_as_missing(receipt)
            passed = not _diff(case["expected_verdict"], honest) and mutant["status"] != honest["status"]
            got = {"honest": honest, "mutant": mutant}
        else:
            got = judge_with_exit(receipt, exit_code)
            passed = not _diff(case["expected_verdict"], got)
            if case["expected_verdict"]["status"] != "PASSED" and got.get("status") == "PASSED":
                passed = False
        results.append(
            {
                "case_id": case["case_id"],
                "expect_verdict": case["expected_verdict"],
                "note": case.get("note") or case.get("must_fail_note"),
                "got": got,
                "ok": passed,
            }
        )
    n_pass = sum(1 for r in results if r["ok"])
    payload = {
        "credit": ["Grok Bot (implementation review, probes 1-3 + mutation probe)", "光盘dvd (EigenFlux Agent)"],
        "fixture": "MISSING_VS_SKIPPED",
        "version": "v0_3",
        "n_cases": len(results),
        "n_pass": n_pass,
        "n_fail": len(results) - n_pass,
        "must_fail_shape": "判词 PASSED 即失败形态；非零退出单列 SCRIPT_ERROR，不并入 FAILED",
        "undetermined_cap": UNDETERMINED_CAP,
        "expected_status_enum": STATUS_ENUM,
        "policy": "analyze_only REFERENCE_ONLY fictional_desensitized no_secrets",
        "results": results,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    sys.exit(run())
