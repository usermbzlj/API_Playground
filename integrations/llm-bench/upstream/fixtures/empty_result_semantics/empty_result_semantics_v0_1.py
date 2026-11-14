#!/usr/bin/env python3

"""EMPTY_RESULT_SEMANTICS v0.1

Three nails (criteria_version: empty-result-semantics-criteria-v0.1,
2026-11-10):

  1. UNQUERIED_NE_QUERIED_EMPTY
     An empty result from a query that never ran is not a queried-empty
     result. Recording "never queried" as "queried, nothing found" is a
     false green.
  2. EMPTY_RESULT_MUST_EXPOSE_QUERY_LIST_SCOPE_AND_METHOD_BOUNDARY
     An empty result used as a negative conclusion must expose its query
     list, scope, and method boundary. Without them the empty result
     cannot support "no matching records".
  3. NO_SIGNAL_MUST_NOT_COUNT_AS_NO_PROBLEM
     Absence of a signal is not evidence of absence of a problem. A
     no-signal observation must be recorded as unresolved / pending
     verification, not as "no problem".

Four columns per arm (Grok Bot's definition):
  1) input_snapshot — reproducible input snapshot (the receipt dict)
  2) should_get     — verdict the input should get (FAIL / PASS)
  3) naive_shape    — failure shape a naive/wrong path presents
  4) control_arm    — paired control arm case_id that should pass

Arms (must-fail + control, paired):
  1a. UNQUERIED_RECORDED_AS_QUERIED_EMPTY_MUST_RED — no query ran,
      empty result recorded QUERIED_EMPTY, probes stayed green → FAIL
  1b. UNQUERIED_HONEST — same facts, recorded
      UNQUERIED_NE_QUERIED_EMPTY, probe tripped → PASS
  1c. QUERIED_EMPTY — query ran, genuinely empty, receipt present
      → PASS
  2a. EMPTY_WITHOUT_SCOPE_AS_NEGATIVE_MUST_RED — empty result with no
      query list / scope / method boundary, used as "no matching
      records", probes stayed green → FAIL
  2b. EMPTY_WITHOUT_SCOPE_HONEST — same facts, recorded
      EMPTY_RESULT_MUST_EXPOSE_QUERY_LIST_SCOPE_AND_METHOD_BOUNDARY,
      probe tripped → PASS
  2c. PROPERLY_SCOPED_EMPTY — empty result WITH query list + scope +
      method boundary → PASS
  3a. NO_SIGNAL_RECORDED_AS_NO_PROBLEM_MUST_RED — no signal observed,
      no verification performed, recorded NO_PROBLEM, probes stayed
      green → FAIL
  3b. NO_SIGNAL_HONEST — same facts, recorded
      NO_SIGNAL_MUST_NOT_COUNT_AS_NO_PROBLEM, probe tripped → PASS
  3c. VERIFIED_NO_PROBLEM — verification performed, no findings
      → PASS

All scenarios synthetic. Fictional addresses (e.g. "12 Imaginary Lane,
Sampletown"), synthetic record types, synthetic query ids. No real
addresses, names, item ids, measurements, credentials, or network calls.

analyze_only. Stdlib only.
Credit: CatKing_Muse × Grok Bot (submitter side only; independent reviewer
signature pending — disagreement keeps the sample UNVERIFIED).
"""

from __future__ import annotations

import json
import sys
from typing import Any

CRITERIA_VERSION = "empty-result-semantics-criteria-v0.1 (2026-11-10)"

UNQUERIED_NAIL = "UNQUERIED_NE_QUERIED_EMPTY"
SCOPE_NAIL = "EMPTY_RESULT_MUST_EXPOSE_QUERY_LIST_SCOPE_AND_METHOD_BOUNDARY"
SIGNAL_NAIL = "NO_SIGNAL_MUST_NOT_COUNT_AS_NO_PROBLEM"

UNQUERIED_PROBES = ("unqueried_recorded_as_queried_empty",)
SCOPE_PROBES = ("empty_without_query_scope",)
SIGNAL_PROBES = ("no_signal_recorded_as_no_problem",)

FICTIONAL_ADDRESS = "12 Imaginary Lane, Sampletown"
RECORD_TYPE = "synthetic-record-type-alpha"


def unqueried_probes(record: dict[str, Any]) -> dict[str, bool]:
    return {
        "unqueried_recorded_as_queried_empty": (
            record.get("query_executed") is False
            and record.get("result_empty") is True
        ),
    }


def scope_probes(record: dict[str, Any]) -> dict[str, bool]:
    missing = (
        not record.get("query_list")
        or not record.get("scope")
        or not record.get("method_boundary")
    )
    return {
        "empty_without_query_scope": (
            record.get("result_empty") is True
            and record.get("used_as_negative_conclusion") is True
            and missing
        ),
    }


def signal_probes(record: dict[str, Any]) -> dict[str, bool]:
    return {
        "no_signal_recorded_as_no_problem": (
            record.get("signal_observed") is False
            and record.get("verification_performed") is False
        ),
    }


def _adjudicate(
    record: dict[str, Any],
    probe_names: tuple[str, ...],
    probes: dict[str, bool],
    nail: str,
    clean_reason: str,
    hiding_verdicts: set[str],
) -> dict[str, Any]:
    tripped = list(record.get("tripped_codes") or [])
    claimed_ok = record.get("claimed_ok") is True
    claimed_verdict = record.get("claimed_verdict")
    recorded = record.get("recorded_state")

    hot = [name for name in probe_names if probes.get(name)]
    missed = [name for name in hot if name not in tripped]

    if hot:
        hiding = claimed_ok or claimed_verdict in hiding_verdicts
        if hiding and (missed or recorded != nail):
            return {
                "judge": "FAIL",
                "reason_code": nail,
                "detail": {"hot_probes": hot, "missed": missed},
            }
        if (not claimed_ok) and recorded == nail and not missed:
            return {
                "judge": "PASS",
                "reason_code": nail,
                "detail": {"honest": True, "hot_probes": hot},
            }
        return {
            "judge": "FAIL",
            "reason_code": nail,
            "detail": {"hot_probes": hot, "missed": missed},
        }

    false_trips = [name for name in probe_names if name in tripped]
    if false_trips:
        return {
            "judge": "FAIL",
            "reason_code": nail,
            "detail": {
                "note": "probes must not fire on the clean arm",
                "false_trips": false_trips,
            },
        }
    return {
        "judge": "PASS",
        "reason_code": clean_reason,
        "detail": {"clean": True},
    }


def judge(record: dict[str, Any]) -> dict[str, Any]:
    check = record.get("check")
    if check == "unqueried_empty":
        return _adjudicate(
            record,
            UNQUERIED_PROBES,
            unqueried_probes(record),
            UNQUERIED_NAIL,
            "QUERIED_EMPTY",
            {"QUERIED_EMPTY"},
        )
    if check == "empty_scope":
        return _adjudicate(
            record,
            SCOPE_PROBES,
            scope_probes(record),
            SCOPE_NAIL,
            "PROPERLY_SCOPED_EMPTY",
            {"NO_MATCHING_RECORDS"},
        )
    if check == "no_signal":
        return _adjudicate(
            record,
            SIGNAL_PROBES,
            signal_probes(record),
            SIGNAL_NAIL,
            "VERIFIED_NO_PROBLEM",
            {"NO_PROBLEM"},
        )
    return {
        "judge": "FAIL",
        "reason_code": "UNDECIDABLE",
        "detail": {"check": check},
    }


FIXTURES = [
    {
        "case_id": "MUSE-UNQUERIED-AS-QUERIED-EMPTY-MUST-RED",
        "fixture_id": "muse-unqueried-ne-queried-empty-001",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "unqueried_empty",
            "fixture_id": "muse-unqueried-ne-queried-empty-001",
            "criteria_version": CRITERIA_VERSION,
            "query_id": "query-synthetic-001",
            "subject_address": FICTIONAL_ADDRESS,
            "record_type": RECORD_TYPE,
            "query_executed": False,
            "result_empty": True,
            "query_receipt": None,
            "claimed_ok": True,
            "claimed_verdict": "QUERIED_EMPTY",
            "recorded_state": "QUERIED_EMPTY",
            "tripped_codes": [],
        },
        "should_get": "FAIL",
        "naive_shape": (
            "Naive checker sees an empty result and accepts it as "
            "QUERIED_EMPTY without checking whether any query ran."
        ),
        "control_arm": "MUSE-UNQUERIED-HONEST",
        "expect": UNQUERIED_NAIL,
    },
    {
        "case_id": "MUSE-UNQUERIED-HONEST",
        "fixture_id": "muse-unqueried-ne-queried-empty-002",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "unqueried_empty",
            "fixture_id": "muse-unqueried-ne-queried-empty-002",
            "criteria_version": CRITERIA_VERSION,
            "query_id": "query-synthetic-001",
            "subject_address": FICTIONAL_ADDRESS,
            "record_type": RECORD_TYPE,
            "query_executed": False,
            "result_empty": True,
            "query_receipt": None,
            "claimed_ok": False,
            "recorded_state": UNQUERIED_NAIL,
            "tripped_codes": ["unqueried_recorded_as_queried_empty"],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Same facts recorded honestly as never-queried; the probe "
            "trips instead of staying green."
        ),
        "control_arm": "MUSE-UNQUERIED-HONEST",
        "expect": UNQUERIED_NAIL,
    },
    {
        "case_id": "MUSE-QUERIED-EMPTY",
        "fixture_id": "muse-unqueried-ne-queried-empty-003",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "unqueried_empty",
            "fixture_id": "muse-unqueried-ne-queried-empty-003",
            "criteria_version": CRITERIA_VERSION,
            "query_id": "query-synthetic-002",
            "subject_address": FICTIONAL_ADDRESS,
            "record_type": RECORD_TYPE,
            "query_executed": True,
            "result_empty": True,
            "query_receipt": "receipt-synthetic-001",
            "claimed_ok": True,
            "claimed_verdict": "QUERIED_EMPTY",
            "recorded_state": "QUERIED_EMPTY",
            "tripped_codes": [],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Genuine queried-empty: the query ran, the receipt is "
            "present, the result is empty; no probe fires."
        ),
        "control_arm": "MUSE-QUERIED-EMPTY",
        "expect": "QUERIED_EMPTY",
    },
    {
        "case_id": "MUSE-EMPTY-WITHOUT-SCOPE-AS-NEGATIVE-MUST-RED",
        "fixture_id": "muse-empty-result-query-scope-method-boundary-001",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "empty_scope",
            "fixture_id": "muse-empty-result-query-scope-method-boundary-001",
            "criteria_version": CRITERIA_VERSION,
            "query_id": "query-synthetic-003",
            "subject_address": FICTIONAL_ADDRESS,
            "record_type": RECORD_TYPE,
            "result_empty": True,
            "query_list": [],
            "scope": None,
            "method_boundary": None,
            "used_as_negative_conclusion": True,
            "claimed_ok": True,
            "claimed_verdict": "NO_MATCHING_RECORDS",
            "recorded_state": "NO_MATCHING_RECORDS",
            "tripped_codes": [],
        },
        "should_get": "FAIL",
        "naive_shape": (
            "Naive checker sees an empty result and accepts it as the "
            "negative conclusion 'no matching records' although no "
            "query list, scope, or method boundary is exposed."
        ),
        "control_arm": "MUSE-EMPTY-WITHOUT-SCOPE-HONEST",
        "expect": SCOPE_NAIL,
    },
    {
        "case_id": "MUSE-EMPTY-WITHOUT-SCOPE-HONEST",
        "fixture_id": "muse-empty-result-query-scope-method-boundary-002",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "empty_scope",
            "fixture_id": "muse-empty-result-query-scope-method-boundary-002",
            "criteria_version": CRITERIA_VERSION,
            "query_id": "query-synthetic-003",
            "subject_address": FICTIONAL_ADDRESS,
            "record_type": RECORD_TYPE,
            "result_empty": True,
            "query_list": [],
            "scope": None,
            "method_boundary": None,
            "used_as_negative_conclusion": True,
            "claimed_ok": False,
            "recorded_state": SCOPE_NAIL,
            "tripped_codes": ["empty_without_query_scope"],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Same facts recorded honestly as scope-not-exposed; the "
            "probe trips instead of staying green."
        ),
        "control_arm": "MUSE-EMPTY-WITHOUT-SCOPE-HONEST",
        "expect": SCOPE_NAIL,
    },
    {
        "case_id": "MUSE-PROPERLY-SCOPED-EMPTY",
        "fixture_id": "muse-empty-result-query-scope-method-boundary-003",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "empty_scope",
            "fixture_id": "muse-empty-result-query-scope-method-boundary-003",
            "criteria_version": CRITERIA_VERSION,
            "query_id": "query-synthetic-004",
            "subject_address": FICTIONAL_ADDRESS,
            "record_type": RECORD_TYPE,
            "result_empty": True,
            "query_list": ["query-synthetic-004a", "query-synthetic-004b"],
            "scope": "fictional address + synthetic-record-type-alpha",
            "method_boundary": (
                "synthetic lookup method M-1; boundary: registry "
                "snapshot 2026-11-10"
            ),
            "used_as_negative_conclusion": True,
            "claimed_ok": True,
            "claimed_verdict": "NO_MATCHING_RECORDS",
            "recorded_state": "NO_MATCHING_RECORDS",
            "tripped_codes": [],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Genuine properly-scoped empty: query list, scope, and "
            "method boundary are all exposed; no probe fires."
        ),
        "control_arm": "MUSE-PROPERLY-SCOPED-EMPTY",
        "expect": "PROPERLY_SCOPED_EMPTY",
    },
    {
        "case_id": "MUSE-NO-SIGNAL-AS-NO-PROBLEM-MUST-RED",
        "fixture_id": "muse-no-signal-not-no-problem-001",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "no_signal",
            "fixture_id": "muse-no-signal-not-no-problem-001",
            "criteria_version": CRITERIA_VERSION,
            "query_id": "query-synthetic-005",
            "subject_address": FICTIONAL_ADDRESS,
            "record_type": RECORD_TYPE,
            "signal_observed": False,
            "verification_performed": False,
            "claimed_ok": True,
            "claimed_verdict": "NO_PROBLEM",
            "recorded_state": "NO_PROBLEM",
            "tripped_codes": [],
        },
        "should_get": "FAIL",
        "naive_shape": (
            "Naive checker sees no signal and accepts it as NO_PROBLEM "
            "although no verification was ever performed."
        ),
        "control_arm": "MUSE-NO-SIGNAL-HONEST",
        "expect": SIGNAL_NAIL,
    },
    {
        "case_id": "MUSE-NO-SIGNAL-HONEST",
        "fixture_id": "muse-no-signal-not-no-problem-002",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "no_signal",
            "fixture_id": "muse-no-signal-not-no-problem-002",
            "criteria_version": CRITERIA_VERSION,
            "query_id": "query-synthetic-005",
            "subject_address": FICTIONAL_ADDRESS,
            "record_type": RECORD_TYPE,
            "signal_observed": False,
            "verification_performed": False,
            "claimed_ok": False,
            "recorded_state": SIGNAL_NAIL,
            "tripped_codes": ["no_signal_recorded_as_no_problem"],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Same facts recorded honestly as unresolved / pending "
            "verification; the probe trips instead of staying green."
        ),
        "control_arm": "MUSE-NO-SIGNAL-HONEST",
        "expect": SIGNAL_NAIL,
    },
    {
        "case_id": "MUSE-VERIFIED-NO-PROBLEM",
        "fixture_id": "muse-no-signal-not-no-problem-003",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "no_signal",
            "fixture_id": "muse-no-signal-not-no-problem-003",
            "criteria_version": CRITERIA_VERSION,
            "query_id": "query-synthetic-006",
            "subject_address": FICTIONAL_ADDRESS,
            "record_type": RECORD_TYPE,
            "signal_observed": False,
            "verification_performed": True,
            "verification_method": "synthetic-check-C-1",
            "verification_outcome": "no_findings",
            "claimed_ok": True,
            "claimed_verdict": "VERIFIED_NO_PROBLEM",
            "recorded_state": "VERIFIED_NO_PROBLEM",
            "tripped_codes": [],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Genuine verified no-problem: verification was performed "
            "with a recorded method and outcome; no probe fires."
        ),
        "control_arm": "MUSE-VERIFIED-NO-PROBLEM",
        "expect": "VERIFIED_NO_PROBLEM",
    },
]


def main() -> int:
    rows = []
    ok = True

    for fx in FIXTURES:
        got = judge(fx["receipt"])
        reason_match = got.get("reason_code") == fx["expect"]
        verdict_match = got.get("judge") == fx["should_get"]
        match = reason_match and verdict_match
        ok = ok and match

        rows.append(
            {
                "case_id": fx["case_id"],
                "fixture_id": fx["fixture_id"],
                "expect": fx["expect"],
                "got": got.get("reason_code"),
                "should_get": fx["should_get"],
                "got_judge": got.get("judge"),
                "control_arm": fx["control_arm"],
                "match": match,
                "judge": got,
            }
        )

    out = {
        "version": "EMPTY_RESULT_SEMANTICS/v0.1",
        "criteria_version": CRITERIA_VERSION,
        "all_match": ok,
        "n": len(rows),
        "n_match": sum(1 for r in rows if r["match"]),
        "rows": rows,
        "credits": ["CatKing_Muse × Grok Bot"],
        "reviewer_status": "pending-independent-review",
    }

    print(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True))

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
