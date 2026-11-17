#!/usr/bin/env python3

"""DEP_DRIFT_UNLOCKED v0.1 (submitted 2026-11-15 as an additional commit on
PR usermbzlj/API_Playground#8, branch muse-llm-bench-fixtures-v0.1;
independent reviewer signature pending - disagreement keeps the sample
UNVERIFIED)

One nail (criteria_version: dep-drift-unlocked-criteria-v0.1, 2026-11-13):

  DEP_DRIFT_UNLOCKED
  "Version pinned" is not "dependency tree identical". Start the same MCP
  server twice (a day apart, or with a forced cache clear) and export the
  full dependency tree each time (pip freeze / npm ls --all). If the trees
  differ while the lockfile is unchanged, the build drifted under a pinned
  version claim: judge DEP_DRIFT_UNLOCKED, not PASS.

Four columns per arm (Grok Bot's definition):
  1) input_snapshot — reproducible input snapshot (the receipt dict)
  2) should_get     — verdict the input should get (FAIL / PASS)
  3) naive_shape    — failure shape a naive/wrong path presents
  4) control_arm    — paired control arm case_id that should pass

Arms (must-fail + control, paired):
  D1. DEP_DRIFT_CLAIMED_PINNED_MUST_RED — lockfile hash identical across
      two runs, trees differ (transitive dep resolved to another version
      under a floating range), report claims "versions pinned = PASS",
      probes stayed green -> FAIL
  D2. DEP_DRIFT_HONEST — same facts, recorded DEP_DRIFT_UNLOCKED, probe
      tripped -> PASS
  D3. LOCKFILE_CHANGED_EXPLAINS_DRIFT — lockfile hash changed between
      runs, trees differ -> EXPLAINED_BY_LOCKFILE_CHANGE, not drift;
      the rule must not over-fire -> PASS
  D4. LOCKFILE_INSTALL_TWICE_IDENTICAL — lockfile install run twice,
      trees byte-identical -> NO_DRIFT -> PASS

All scenarios synthetic. Placeholder server (mcp-server-a), synthetic
package names/versions/hashes. No real addresses, names, item ids,
measurements, credentials, or network calls.

analyze_only. Stdlib only.
Credit: CatKing_Muse x Grok Bot (submitter side only; independent reviewer
signature pending - disagreement keeps the sample UNVERIFIED).
"""

from __future__ import annotations

import json

CRITERIA_VERSION = "dep-drift-unlocked-criteria-v0.1"

# The rule under test: pin is a claim about the lockfile, drift is a fact
# about the resolved tree. Only the tree decides drift; the lockfile
# decides whether the drift is explained.
def judge(run: dict) -> str:
    lock_same = run["lockfile_hash_run1"] == run["lockfile_hash_run2"]
    tree_same = run["tree_run1"] == run["tree_run2"]
    if tree_same:
        return "NO_DRIFT"
    if lock_same:
        return "DEP_DRIFT_UNLOCKED"
    return "EXPLAINED_BY_LOCKFILE_CHANGE"


# The naive path: "lockfile unchanged => pinned => PASS". It never looks
# at the tree, so drift under a pinned claim sails through as green.
def naive_judge(run: dict) -> str:
    if run["lockfile_hash_run1"] == run["lockfile_hash_run2"]:
        return "PASS"
    return "REVIEW"


TREE_A = {
    "mcp-server-a": "1.4.0",
    "dep-alpha": "2.1.0",
    "dep-beta": "0.9.3",
    "dep-gamma": "3.0.1",
}
TREE_B = dict(TREE_A, **{"dep-beta": "0.9.4"})  # floating range re-resolved

ARMS = [
    {
        "fixture_id": "muse-dep-drift-unlocked-001",
        "input_snapshot": {
            "server": "mcp-server-a",
            "lockfile_hash_run1": "sha256:aaaa1111",
            "lockfile_hash_run2": "sha256:aaaa1111",
            "tree_run1": TREE_A,
            "tree_run2": TREE_B,
            "claim": "versions pinned = PASS",
            "probes_tripped": False,
        },
        "should_get": "FAIL",
        "naive_shape": "naive_judge returns PASS (lockfile unchanged, tree never compared)",
        "control_arm": "muse-dep-drift-unlocked-002",
    },
    {
        "fixture_id": "muse-dep-drift-unlocked-002",
        "input_snapshot": {
            "server": "mcp-server-a",
            "lockfile_hash_run1": "sha256:aaaa1111",
            "lockfile_hash_run2": "sha256:aaaa1111",
            "tree_run1": TREE_A,
            "tree_run2": TREE_B,
            "claim": "DEP_DRIFT_UNLOCKED",
            "probes_tripped": True,
        },
        "should_get": "PASS",
        "naive_shape": "n/a (control: same facts, honest verdict, probe tripped)",
        "control_arm": "self",
    },
    {
        "fixture_id": "muse-dep-drift-unlocked-003",
        "input_snapshot": {
            "server": "mcp-server-a",
            "lockfile_hash_run1": "sha256:aaaa1111",
            "lockfile_hash_run2": "sha256:bbbb2222",
            "tree_run1": TREE_A,
            "tree_run2": TREE_B,
            "claim": "EXPLAINED_BY_LOCKFILE_CHANGE",
            "probes_tripped": False,
        },
        "should_get": "PASS",
        "naive_shape": "n/a (control: drift explained by a lockfile change, rule must not over-fire)",
        "control_arm": "self",
    },
    {
        "fixture_id": "muse-dep-drift-unlocked-004",
        "input_snapshot": {
            "server": "mcp-server-a",
            "lockfile_hash_run1": "sha256:aaaa1111",
            "lockfile_hash_run2": "sha256:aaaa1111",
            "tree_run1": TREE_A,
            "tree_run2": dict(TREE_A),
            "claim": "NO_DRIFT",
            "probes_tripped": False,
        },
        "should_get": "PASS",
        "naive_shape": "n/a (positive control: lockfile install twice, trees byte-identical)",
        "control_arm": "self",
    },
]


def selftest() -> dict:
    results = []
    for arm in ARMS:
        snap = arm["input_snapshot"]
        verdict = judge(snap)
        if arm["fixture_id"] == "muse-dep-drift-unlocked-001":
            # Must-fail: the rule must flag drift, and the naive path must
            # get it wrong (PASS) — otherwise the sample proves nothing.
            ok = verdict == "DEP_DRIFT_UNLOCKED" and naive_judge(snap) == "PASS"
            results.append({"case_id": arm["fixture_id"], "match": ok,
                            "rule": verdict, "naive": naive_judge(snap)})
        else:
            # Controls: rule verdict must agree with the recorded claim.
            ok = verdict == snap["claim"]
            results.append({"case_id": arm["fixture_id"], "match": ok,
                            "rule": verdict, "claim": snap["claim"]})
    return {
        "criteria_version": CRITERIA_VERSION,
        "all_match": all(r["match"] for r in results),
        "results": results,
    }


if __name__ == "__main__":
    out = selftest()
    print(json.dumps(out, indent=2, ensure_ascii=False))
    raise SystemExit(0 if out["all_match"] else 1)
