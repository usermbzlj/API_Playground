#!/usr/bin/env python3
"""REQUEST_REPLAY v0.1

Synthetic analyze_only fixture. Closed verdict set: PASS, REQUEST_REPLAY.
Columns: nonce, seen_before (bool), expected_verdict. expected_verdict is not
an input to the judge. spec_version and criteria_digest are required: the
digest is sha256 of the canonical criteria body for that spec_version, and a
row is judged only by the body it stamps.

Arms:
  positive   sequence r1..r4, each nonce unique and unseen -> PASS
  negative   one previously used nonce replayed -> REQUEST_REPLAY
  boundary   a well-formed nonce that has never been seen -> PASS

The pinned naive baseline (also the v0.0 criteria) returns PASS for every
well-formed nonce and ignores seen_before. On the negative arm that baseline
returns PASS, so the arm is a must-fail for it. The boundary arm is the same
shape as a format-only accept, and stays PASS.

Stdlib only. No credentials, no real requests.
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

CLOSED = ("PASS", "REQUEST_REPLAY")
FIXTURE = "request_replay"
NONCE_RE = re.compile(r"^n-[0-9]{4}$")
POSITIVE_NONCES = ("n-0001", "n-0002", "n-0003", "n-0004")
REPLAY_NONCE = "n-0002"
BOUNDARY_NONCE = "n-0005"

CRITERIA: dict[str, dict[str, Any]] = {
    "v0.0": {
        "spec_version": "v0.0",
        "fixture": FIXTURE,
        "closed_verdicts": list(CLOSED),
        "nonce_pattern": r"^n-[0-9]{4}$",
        "rules": [
            "legacy: a well-formed nonce -> PASS; seen_before and prior nonces are ignored",
        ],
    },
    "v0.1": {
        "spec_version": "v0.1",
        "fixture": FIXTURE,
        "closed_verdicts": list(CLOSED),
        "nonce_pattern": r"^n-[0-9]{4}$",
        "rules": [
            "positive: each request in r1..rn carries a nonce absent from prior_nonces and seen_before false -> PASS",
            "negative: a nonce that appears in prior_nonces (seen_before true) -> REQUEST_REPLAY",
            "boundary: a well-formed nonce absent from prior_nonces (seen_before false) -> PASS, which is not a replay",
            "seen_before must be a bool and must equal (nonce in prior_nonces)",
            "expected_verdict is a dedicated field and is not an input to the judge",
            "spec_version and criteria_digest are required; criteria_digest is sha256 of the canonical JSON body of that spec_version",
            "a sample is judged only by the registered body whose digest it stamps; a newer body is not substituted",
        ],
    },
}

UNREGISTERED: dict[str, Any] = {
    "spec_version": "v0.2",
    "fixture": FIXTURE,
    "closed_verdicts": list(CLOSED),
    "nonce_pattern": r"^n-[0-9]{4}$",
    "rules": [
        "unregistered draft: a well-formed nonce -> PASS even when it was seen before",
    ],
}

REGISTRY = CRITERIA


def canon_bytes(body: Any) -> bytes:
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def criteria_digest(body: Any) -> str:
    return hashlib.sha256(canon_bytes(body)).hexdigest()


def well_formed(nonce: Any) -> bool:
    return isinstance(nonce, str) and NONCE_RE.fullmatch(nonce) is not None


def naive_judge(row: dict[str, Any]) -> str:
    """Pinned false-green baseline (v0.0): any well-formed nonce is PASS.

    This function must stay wrong on the negative arm. The selftest fails if
    it starts agreeing with the v0.1 verdict there.
    """
    if well_formed(row.get("nonce")):
        return "PASS"
    return "REQUEST_REPLAY"


def _seen(row: dict[str, Any]) -> bool:
    nonce = row.get("nonce")
    prior = row.get("prior_nonces")
    if not isinstance(prior, list):
        raise ValueError("prior_nonces must be a list")
    return nonce in prior


def apply_v0_1(row: dict[str, Any]) -> str:
    nonce = row.get("nonce")
    seen_before = row.get("seen_before")
    if not isinstance(seen_before, bool):
        raise ValueError("seen_before must be bool")
    seen = _seen(row)
    if seen_before != seen:
        raise ValueError("seen_before does not match prior_nonces")
    if seen:
        return "REQUEST_REPLAY"
    if not well_formed(nonce):
        raise ValueError("PASS requires a well-formed nonce")
    return "PASS"


IMPLEMENTATIONS = {
    "v0.0": naive_judge,
    "v0.1": apply_v0_1,
}


def bind(row: dict[str, Any]) -> dict[str, Any] | None:
    spec = row.get("spec_version")
    digest = row.get("criteria_digest")
    if not isinstance(spec, str) or not spec:
        return None
    if not isinstance(digest, str) or len(digest) != 64:
        return None
    body = REGISTRY.get(spec)
    if body is None:
        return None
    if digest != criteria_digest(body):
        return None
    return body


def judge(row: dict[str, Any]) -> dict[str, Any]:
    """Judge one row by the criteria body it stamps. Never reads expected_verdict."""
    body = bind(row)
    if body is None:
        return {"criteria_bound": False, "verdict": None, "bound_spec_version": None}
    verdict = IMPLEMENTATIONS[body["spec_version"]](row)
    if verdict not in CLOSED:
        raise RuntimeError(f"verdict {verdict!r} outside closed set")
    return {
        "criteria_bound": True,
        "verdict": verdict,
        "bound_spec_version": body["spec_version"],
    }


def judge_ignoring_stamp(row: dict[str, Any]) -> str:
    """The inheritance bug: apply the unregistered newer body to every row."""
    if well_formed(row.get("nonce")):
        return "PASS"
    return "REQUEST_REPLAY"


def _stamped(spec: str, fields: dict[str, Any]) -> dict[str, Any]:
    row = dict(fields)
    row["spec_version"] = spec
    row["criteria_digest"] = criteria_digest(CRITERIA[spec])
    return row


def _sequence_row(spec: str, case_id: str, arm: str, nonce: str, prior: list[str], expected: str, must_fail: bool) -> dict[str, Any]:
    seen = nonce in prior
    return _stamped(
        spec,
        {
            "case_id": case_id,
            "arm": arm,
            "nonce": nonce,
            "seen_before": seen,
            "prior_nonces": list(prior),
            "expected_verdict": expected,
            "must_fail": must_fail,
        },
    )


def build_rows() -> dict[str, Any]:
    arms: list[dict[str, Any]] = []
    prior: list[str] = []
    for i, nonce in enumerate(POSITIVE_NONCES, start=1):
        arms.append(
            _sequence_row("v0.1", f"r{i}", "positive", nonce, prior, "PASS", False)
        )
        prior.append(nonce)
    history = list(prior)
    arms.append(
        _sequence_row("v0.1", "replay", "negative", REPLAY_NONCE, history, "REQUEST_REPLAY", True)
    )
    arms.append(
        _sequence_row("v0.1", "boundary", "boundary", BOUNDARY_NONCE, history, "PASS", False)
    )
    old_sample = _sequence_row(
        "v0.0",
        "old-sample-v0-0-replay",
        "negative",
        REPLAY_NONCE,
        history,
        "PASS",
        False,
    )
    old_sample["note"] = "stamped v0.0; the same nonce under v0.1 is REQUEST_REPLAY"
    digests = {spec: criteria_digest(body) for spec, body in CRITERIA.items()}
    template = {
        "nonce": BOUNDARY_NONCE,
        "seen_before": False,
        "prior_nonces": history,
    }
    missing_spec = dict(template)
    missing_spec["case_id"] = "probe-missing-spec-version"
    missing_spec["criteria_digest"] = digests["v0.1"]
    missing_digest = dict(template)
    missing_digest["case_id"] = "probe-missing-criteria-digest"
    missing_digest["spec_version"] = "v0.1"
    wrong_digest = dict(template)
    wrong_digest["case_id"] = "probe-digest-of-other-body"
    wrong_digest["spec_version"] = "v0.1"
    wrong_digest["criteria_digest"] = criteria_digest(UNREGISTERED)
    unknown_spec = dict(template)
    unknown_spec["case_id"] = "probe-unregistered-spec"
    unknown_spec["spec_version"] = "v0.2"
    unknown_spec["criteria_digest"] = criteria_digest(UNREGISTERED)
    return {
        "fixture": FIXTURE,
        "spec_version": "v0.1",
        "closed_verdicts": list(CLOSED),
        "columns": ["nonce", "seen_before", "expected_verdict"],
        "criteria": CRITERIA,
        "criteria_digest": digests,
        "unregistered_criteria": UNREGISTERED,
        "unregistered_criteria_digest": criteria_digest(UNREGISTERED),
        "arms": arms,
        "binding_probes": [old_sample, missing_spec, missing_digest, wrong_digest, unknown_spec],
    }


def _strip_verdict(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k != "expected_verdict"}


def evaluate(doc: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    on_disk = json.loads(EXPECTED_PATH.read_text(encoding="utf-8"))
    checks: list[dict[str, Any]] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    add("expected_json_matches_materialized_rows", on_disk == doc)
    add(
        "criteria_digest_changes_with_spec_version",
        len({criteria_digest(b) for b in (*CRITERIA.values(), UNREGISTERED)}) == 3,
    )
    add("unregistered_body_not_in_registry", "v0.2" not in REGISTRY)

    positives = [r for r in doc["arms"] if r["arm"] == "positive"]
    add(
        "positive-nonces-unique",
        [r["nonce"] for r in positives] == list(POSITIVE_NONCES)
        and len({r["nonce"] for r in positives}) == len(positives),
    )

    arm_rows: list[dict[str, Any]] = []
    for row in doc["arms"]:
        got = judge(row)
        stripped = judge(_strip_verdict(row))
        naive = naive_judge(row)
        inherited = judge_ignoring_stamp(row)
        ok = (
            got["criteria_bound"] is True
            and got["bound_spec_version"] == "v0.1"
            and got["verdict"] == row["expected_verdict"]
            and got["verdict"] in CLOSED
            and stripped == got
            and isinstance(row["seen_before"], bool)
            and row["seen_before"] == (row["nonce"] in row["prior_nonces"])
            and row["spec_version"] == "v0.1"
            and row["criteria_digest"] == criteria_digest(CRITERIA["v0.1"])
            and all(k in row for k in ("nonce", "seen_before", "expected_verdict"))
        )
        if row["arm"] == "boundary":
            ok = ok and well_formed(row["nonce"]) and row["nonce"] not in row["prior_nonces"] and naive == "PASS"
        if row["must_fail"]:
            ok = ok and naive == "PASS" and naive != got["verdict"] and inherited == "PASS"
        add(f"arm-{row['case_id']}", ok, f"verdict={got['verdict']} naive={naive} seen_before={row['seen_before']}")
        arm_rows.append(
            {
                "case_id": row["case_id"],
                "arm": row["arm"],
                "nonce": row["nonce"],
                "seen_before": row["seen_before"],
                "expected_verdict": row["expected_verdict"],
                "verdict": got["verdict"],
                "naive_verdict": naive,
                "ignoring_stamp_verdict": inherited,
                "criteria_bound": got["criteria_bound"],
                "bound_spec_version": got["bound_spec_version"],
                "must_fail": row["must_fail"],
                "ok": ok,
            }
        )

    # In-sequence replay: r3's nonce replaced by r1's, against the same prefix.
    mutated = dict(positives[2])
    mutated["nonce"] = positives[0]["nonce"]
    mutated["seen_before"] = True
    mutated_got = judge(mutated)
    add(
        "mutation-in-sequence-replay-must-fail",
        mutated_got["verdict"] == "REQUEST_REPLAY" and naive_judge(mutated) == "PASS",
        f"verdict={mutated_got['verdict']}",
    )

    probe_rows: list[dict[str, Any]] = []
    for row in doc["binding_probes"]:
        got = judge(row)
        case_id = row["case_id"]
        if case_id == "old-sample-v0-0-replay":
            v01 = apply_v0_1(row)
            ok = (
                got["criteria_bound"] is True
                and got["bound_spec_version"] == "v0.0"
                and got["verdict"] == "PASS"
                and got["verdict"] == row["expected_verdict"]
                and v01 == "REQUEST_REPLAY"
                and judge_ignoring_stamp(row) == "PASS"
            )
            detail = f"stamped={got['verdict']} v0.1_would={v01}"
        else:
            ok = got["criteria_bound"] is False and got["verdict"] is None and got["verdict"] != "PASS"
            detail = "unbound"
        add(case_id, ok, detail)
        probe_rows.append(
            {
                "case_id": case_id,
                "criteria_bound": got["criteria_bound"],
                "verdict": got["verdict"],
                "bound_spec_version": got["bound_spec_version"],
                "ok": ok,
            }
        )
    return checks, arm_rows + probe_rows


def main() -> int:
    doc = build_rows()
    checks, rows = evaluate(doc)
    ok_n = sum(1 for c in checks if c["ok"])
    payload = {
        "fixture": FIXTURE,
        "version": "v0.1",
        "closed_verdicts": list(CLOSED),
        "criteria_digest": doc["criteria_digest"],
        "all_match": ok_n == len(checks),
        "selftest": f"{ok_n}/{len(checks)}",
        "naive_wrong_caught": sum(1 for r in rows if r.get("must_fail") and r["ok"]),
        "checks": checks,
        "rows": rows,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    RUN_OUT_PATH.write_bytes(text.encode("utf-8"))
    sys.stdout.buffer.write(text.encode("utf-8"))
    return 0 if payload["all_match"] else 1


if __name__ == "__main__":
    sys.exit(main())
