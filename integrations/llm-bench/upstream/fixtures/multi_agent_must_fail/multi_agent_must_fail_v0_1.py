#!/usr/bin/env python3

"""MULTI_AGENT_MUST_FAIL v0.1

Two nails (criteria_version: multi-agent-must-fail-criteria-v0.1, 2026-11-10):

  A. CONTEXT_ISOLATION_MUST_NOT_COUNT_AS_SECURITY_ISOLATION
     Separate contexts are not credential/tool isolation. A report that
     claims "isolated" from context separation while credentials or tools
     are shared is a false green.
  B. MULTI_AGENT_COST_MUST_BE_REPORTED_BESIDE_PERFORMANCE
     A benchmark report that shows accuracy without cost is incomplete.
     Cost must be reported beside performance, measured, not estimated.

Four columns per arm (Grok Bot's definition):
  1) input_snapshot — reproducible input snapshot (the receipt dict)
  2) should_get     — verdict the input should get (FAIL / PASS)
  3) naive_shape    — failure shape a naive/wrong path presents
  4) control_arm    — paired control arm case_id that should pass

Arms (must-fail + control, paired):
  A1. CONTEXT_ISOLATION_CLAIMED_MUST_RED — contexts separate, credential
      shared, claimed ISOLATED, probes stayed green → FAIL
  A2. CONTEXT_ISOLATION_HONEST — same facts, recorded
      CONTEXT_ISOLATION_MUST_NOT_COUNT_AS_SECURITY_ISOLATION, probe
      tripped → PASS
  A3. CONTEXT_ISOLATION_TOOLS_SHARED_MUST_RED — contexts separate, tool
      pool shared, claimed ISOLATED, probes stayed green → FAIL
  A4. SECURITY_ISOLATION_ESTABLISHED — contexts separate, per-agent
      credentials and tools, no shared secrets → PASS
  B1. ACCURACY_ONLY_MUST_RED — accuracy only, no cost, claimed COMPLETE,
      probes stayed green → FAIL
  B2. ACCURACY_ONLY_HONEST — same facts, recorded
      MULTI_AGENT_COST_MUST_BE_REPORTED_BESIDE_PERFORMANCE, probe
      tripped → PASS
  B3. COST_UNMEASURED_MUST_RED — cost given as "negligible" with no
      measurement, claimed COMPLETE, probes stayed green → FAIL
  B4. COST_REPORTED_BESIDE_PERFORMANCE — accuracy + measured cost
      (3.2x single-agent cost) → PASS

All scenarios synthetic. Placeholder agents (agent-A / agent-B), synthetic
run ids and report ids. No real addresses, names, item ids, measurements,
credentials, or network calls.

analyze_only. Stdlib only.
Credit: CatKing_Muse × Grok Bot (submitter side only; independent reviewer
signature pending — disagreement keeps the sample UNVERIFIED).
"""

from __future__ import annotations

import json
import sys
from typing import Any

CRITERIA_VERSION = "multi-agent-must-fail-criteria-v0.1 (2026-11-10)"

ISOLATION_NAIL = "CONTEXT_ISOLATION_MUST_NOT_COUNT_AS_SECURITY_ISOLATION"
COST_NAIL = "MULTI_AGENT_COST_MUST_BE_REPORTED_BESIDE_PERFORMANCE"

ISOLATION_PROBES = (
    "context_isolated_but_credentials_shared",
    "context_isolated_but_tools_shared",
)
COST_PROBES = (
    "accuracy_reported_cost_missing",
    "cost_reported_without_measurement",
)


def _as_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def isolation_probes(record: dict[str, Any]) -> dict[str, bool]:
    separate = record.get("contexts_separate") is True
    return {
        "context_isolated_but_credentials_shared": (
            separate and record.get("credentials_shared") is True
        ),
        "context_isolated_but_tools_shared": (
            separate and record.get("tools_shared") is True
        ),
    }


def cost_probes(record: dict[str, Any]) -> dict[str, bool]:
    accuracy = _as_number(record.get("accuracy"))
    cost = record.get("cost")
    measured = record.get("cost_measured") is True
    return {
        "accuracy_reported_cost_missing": (
            accuracy is not None and cost is None and not measured
        ),
        "cost_reported_without_measurement": (
            cost is not None and not measured
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
    if check == "isolation":
        return _adjudicate(
            record,
            ISOLATION_PROBES,
            isolation_probes(record),
            ISOLATION_NAIL,
            "SECURITY_ISOLATION_ESTABLISHED",
            {"ISOLATED"},
        )
    if check == "cost":
        return _adjudicate(
            record,
            COST_PROBES,
            cost_probes(record),
            COST_NAIL,
            "COST_REPORTED_BESIDE_PERFORMANCE",
            {"COMPLETE"},
        )
    return {
        "judge": "FAIL",
        "reason_code": "UNDECIDABLE",
        "detail": {"check": check},
    }


FIXTURES = [
    {
        "case_id": "MUSE-CONTEXT-ISOLATION-CLAIMED-MUST-RED",
        "fixture_id": "muse-context-isolation-not-security-isolation-001",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "isolation",
            "fixture_id": "muse-context-isolation-not-security-isolation-001",
            "criteria_version": CRITERIA_VERSION,
            "agents": ["agent-A", "agent-B"],
            "contexts_separate": True,
            "credentials_shared": True,
            "tools_shared": False,
            "run_id": "run-synthetic-001",
            "claimed_ok": True,
            "claimed_verdict": "ISOLATED",
            "tripped_codes": [],
        },
        "should_get": "FAIL",
        "naive_shape": (
            "Naive checker sees separate contexts and accepts the "
            "ISOLATED claim without checking credential sharing."
        ),
        "control_arm": "MUSE-CONTEXT-ISOLATION-HONEST",
        "expect": ISOLATION_NAIL,
    },
    {
        "case_id": "MUSE-CONTEXT-ISOLATION-HONEST",
        "fixture_id": "muse-context-isolation-not-security-isolation-002",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "isolation",
            "fixture_id": "muse-context-isolation-not-security-isolation-002",
            "criteria_version": CRITERIA_VERSION,
            "agents": ["agent-A", "agent-B"],
            "contexts_separate": True,
            "credentials_shared": True,
            "tools_shared": False,
            "run_id": "run-synthetic-001",
            "claimed_ok": False,
            "recorded_state": ISOLATION_NAIL,
            "tripped_codes": ["context_isolated_but_credentials_shared"],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Same facts recorded honestly; the probe trips instead of "
            "staying green."
        ),
        "control_arm": "MUSE-CONTEXT-ISOLATION-HONEST",
        "expect": ISOLATION_NAIL,
    },
    {
        "case_id": "MUSE-CONTEXT-ISOLATION-TOOLS-SHARED-MUST-RED",
        "fixture_id": "muse-context-isolation-not-security-isolation-003",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "isolation",
            "fixture_id": "muse-context-isolation-not-security-isolation-003",
            "criteria_version": CRITERIA_VERSION,
            "agents": ["agent-A", "agent-B"],
            "contexts_separate": True,
            "credentials_shared": False,
            "tools_shared": True,
            "run_id": "run-synthetic-002",
            "claimed_ok": True,
            "claimed_verdict": "ISOLATED",
            "tripped_codes": [],
        },
        "should_get": "FAIL",
        "naive_shape": (
            "Naive checker sees separate contexts and accepts the "
            "ISOLATED claim without checking the shared tool pool."
        ),
        "control_arm": "MUSE-SECURITY-ISOLATION-ESTABLISHED",
        "expect": ISOLATION_NAIL,
    },
    {
        "case_id": "MUSE-SECURITY-ISOLATION-ESTABLISHED",
        "fixture_id": "muse-context-isolation-not-security-isolation-004",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "isolation",
            "fixture_id": "muse-context-isolation-not-security-isolation-004",
            "criteria_version": CRITERIA_VERSION,
            "agents": ["agent-A", "agent-B"],
            "contexts_separate": True,
            "credentials_shared": False,
            "tools_shared": False,
            "run_id": "run-synthetic-003",
            "claimed_ok": True,
            "claimed_verdict": "ISOLATED",
            "tripped_codes": [],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Genuine isolation: separate contexts and per-agent "
            "credentials and tools; no probe fires."
        ),
        "control_arm": "MUSE-SECURITY-ISOLATION-ESTABLISHED",
        "expect": "SECURITY_ISOLATION_ESTABLISHED",
    },
    {
        "case_id": "MUSE-ACCURACY-ONLY-MUST-RED",
        "fixture_id": "muse-multi-agent-cost-beside-performance-001",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "cost",
            "fixture_id": "muse-multi-agent-cost-beside-performance-001",
            "criteria_version": CRITERIA_VERSION,
            "report_id": "report-synthetic-001",
            "agents": ["agent-A", "agent-B", "agent-C"],
            "accuracy": 0.92,
            "cost": None,
            "cost_measured": False,
            "claimed_ok": True,
            "claimed_verdict": "COMPLETE",
            "tripped_codes": [],
        },
        "should_get": "FAIL",
        "naive_shape": (
            "Naive checker sees accuracy 0.92 and accepts the report as "
            "COMPLETE without any cost figure."
        ),
        "control_arm": "MUSE-ACCURACY-ONLY-HONEST",
        "expect": COST_NAIL,
    },
    {
        "case_id": "MUSE-ACCURACY-ONLY-HONEST",
        "fixture_id": "muse-multi-agent-cost-beside-performance-002",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "cost",
            "fixture_id": "muse-multi-agent-cost-beside-performance-002",
            "criteria_version": CRITERIA_VERSION,
            "report_id": "report-synthetic-001",
            "agents": ["agent-A", "agent-B", "agent-C"],
            "accuracy": 0.92,
            "cost": None,
            "cost_measured": False,
            "claimed_ok": False,
            "recorded_state": COST_NAIL,
            "tripped_codes": ["accuracy_reported_cost_missing"],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Same facts recorded honestly; the probe trips instead of "
            "staying green."
        ),
        "control_arm": "MUSE-ACCURACY-ONLY-HONEST",
        "expect": COST_NAIL,
    },
    {
        "case_id": "MUSE-COST-UNMEASURED-MUST-RED",
        "fixture_id": "muse-multi-agent-cost-beside-performance-003",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "cost",
            "fixture_id": "muse-multi-agent-cost-beside-performance-003",
            "criteria_version": CRITERIA_VERSION,
            "report_id": "report-synthetic-002",
            "agents": ["agent-A", "agent-B"],
            "accuracy": 0.88,
            "cost": "negligible",
            "cost_measured": False,
            "claimed_ok": True,
            "claimed_verdict": "COMPLETE",
            "tripped_codes": [],
        },
        "should_get": "FAIL",
        "naive_shape": (
            "Naive checker sees a cost word ('negligible') and accepts "
            "the report as COMPLETE although nothing was measured."
        ),
        "control_arm": "MUSE-COST-REPORTED-BESIDE-PERFORMANCE",
        "expect": COST_NAIL,
    },
    {
        "case_id": "MUSE-COST-REPORTED-BESIDE-PERFORMANCE",
        "fixture_id": "muse-multi-agent-cost-beside-performance-004",
        "criteria_version": CRITERIA_VERSION,
        "receipt": {
            "check": "cost",
            "fixture_id": "muse-multi-agent-cost-beside-performance-004",
            "criteria_version": CRITERIA_VERSION,
            "report_id": "report-synthetic-003",
            "agents": ["agent-A", "agent-B"],
            "accuracy": 0.90,
            "cost": 3.2,
            "cost_unit": "x single-agent cost",
            "cost_measured": True,
            "claimed_ok": True,
            "claimed_verdict": "COMPLETE",
            "tripped_codes": [],
        },
        "should_get": "PASS",
        "naive_shape": (
            "Genuine complete report: accuracy 0.90 beside measured cost "
            "3.2x single-agent cost; no probe fires."
        ),
        "control_arm": "MUSE-COST-REPORTED-BESIDE-PERFORMANCE",
        "expect": "COST_REPORTED_BESIDE_PERFORMANCE",
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
        "version": "MULTI_AGENT_MUST_FAIL/v0.1",
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
