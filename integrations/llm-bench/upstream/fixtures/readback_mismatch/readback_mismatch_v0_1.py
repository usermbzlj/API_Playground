#!/usr/bin/env python3
"""READBACK_MISMATCH v0.1

Synthetic analyze_only fixture. Closed verdict set: PASS, READBACK_MISMATCH.
expected_verdict is its own field. spec_version and criteria_digest are
required on every judged row: the digest is sha256 of the canonical criteria
body for that spec_version. A row is judged only by the body it stamps.
A newer, unregistered body is not applied in its place.

Arms:
  positive   written value w, read-back value r, w == r -> PASS
  negative   truncated write, in-memory hash h_mem != on-disk hash h_disk
             -> READBACK_MISMATCH

The pinned naive baseline (also the v0.0 criteria) treats write_ok as PASS
and never compares the read-back. On the negative arm that baseline returns
PASS, so the arm is a must-fail for it.

Stdlib only. No credentials, no real payloads.
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
EXPECTED_PATH = HERE / "expected.json"
RUN_OUT_PATH = HERE / "run_out_v0_1.json"

CLOSED = ("PASS", "READBACK_MISMATCH")
FIXTURE = "readback_mismatch"

# Synthetic payload. The negative arm writes only the first TRUNCATED_LEN bytes
# and still records write_ok, which is the false-green the naive baseline trusts.
PAYLOAD = b"synthetic-payload-v0.1-0123456789ABCDEF"
TRUNCATED_LEN = 8
POSITIVE_W = "synthetic-w"

CRITERIA: dict[str, dict[str, Any]] = {
    "v0.0": {
        "spec_version": "v0.0",
        "fixture": FIXTURE,
        "closed_verdicts": list(CLOSED),
        "rules": [
            "legacy: write_ok true -> PASS; the read-back is not compared",
        ],
    },
    "v0.1": {
        "spec_version": "v0.1",
        "fixture": FIXTURE,
        "closed_verdicts": list(CLOSED),
        "rules": [
            "positive control: written value w equals read-back value r -> PASS; otherwise READBACK_MISMATCH",
            "negative control: in-memory hash h_mem differs from on-disk hash h_disk after a truncated write -> READBACK_MISMATCH; equal hashes -> PASS",
            "expected_verdict is a dedicated field and is not an input to the judge",
            "spec_version and criteria_digest are required; criteria_digest is sha256 of the canonical JSON body of that spec_version",
            "a sample is judged only by the registered body whose digest it stamps; a newer body is not substituted",
        ],
    },
}

# Present on purpose and deliberately not registered. A judge that always
# applies the newest text would accept a truncated write. The stamped judge must not.
UNREGISTERED: dict[str, Any] = {
    "spec_version": "v0.2",
    "fixture": FIXTURE,
    "closed_verdicts": list(CLOSED),
    "rules": [
        "unregistered draft: write_ok true -> PASS even when h_mem != h_disk",
    ],
}

REGISTRY = CRITERIA


def canon_bytes(body: Any) -> bytes:
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def criteria_digest(body: Any) -> str:
    return hashlib.sha256(canon_bytes(body)).hexdigest()


def naive_judge(row: dict[str, Any]) -> str:
    """Pinned false-green baseline (v0.0): a completed write is PASS.

    This function must stay wrong on the negative arm. The selftest fails if
    it starts agreeing with the v0.1 verdict there.
    """
    if row.get("write_ok") is True:
        return "PASS"
    return "READBACK_MISMATCH"


def apply_v0_1(row: dict[str, Any]) -> str:
    arm = row.get("arm")
    if arm == "positive":
        return "PASS" if row.get("w") is not None and row.get("w") == row.get("r") else "READBACK_MISMATCH"
    if arm == "negative":
        h_mem = row.get("h_mem")
        h_disk = row.get("h_disk")
        if not isinstance(h_mem, str) or not isinstance(h_disk, str):
            return "READBACK_MISMATCH"
        return "PASS" if h_mem == h_disk else "READBACK_MISMATCH"
    raise ValueError(f"unknown arm {arm!r}")


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
    if row.get("write_ok") is True:
        return "PASS"
    return "READBACK_MISMATCH"


def _readback_text(text: str) -> str:
    raw = text.encode("utf-8")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "value.txt"
        path.write_bytes(raw)
        return path.read_bytes().decode("utf-8")


def _truncated_write() -> tuple[str, str, int]:
    h_mem = hashlib.sha256(PAYLOAD).hexdigest()
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "blob.bin"
        path.write_bytes(PAYLOAD[:TRUNCATED_LEN])
        disk = path.read_bytes()
    return h_mem, hashlib.sha256(disk).hexdigest(), len(disk)


def _stamped(spec: str, fields: dict[str, Any]) -> dict[str, Any]:
    row = dict(fields)
    row["spec_version"] = spec
    row["criteria_digest"] = criteria_digest(CRITERIA[spec])
    return row


def build_rows() -> dict[str, Any]:
    read_back = _readback_text(POSITIVE_W)
    h_mem, h_disk, written_len = _truncated_write()
    digests = {spec: criteria_digest(body) for spec, body in CRITERIA.items()}
    positive = _stamped(
        "v0.1",
        {
            "arm": "positive",
            "case_id": "positive-w-equals-r",
            "w": POSITIVE_W,
            "r": read_back,
            "write_ok": True,
            "expected_verdict": "PASS",
            "must_fail": False,
        },
    )
    negative = _stamped(
        "v0.1",
        {
            "arm": "negative",
            "case_id": "negative-truncated-hash",
            "w": None,
            "r": None,
            "payload_len": len(PAYLOAD),
            "written_len": written_len,
            "truncated": True,
            "h_mem": h_mem,
            "h_disk": h_disk,
            "write_ok": True,
            "expected_verdict": "READBACK_MISMATCH",
            "must_fail": True,
        },
    )
    old_facts = {
        "arm": "negative",
        "case_id": "old-sample-v0-0-truncated",
        "w": None,
        "r": None,
        "payload_len": len(PAYLOAD),
        "written_len": written_len,
        "truncated": True,
        "h_mem": h_mem,
        "h_disk": h_disk,
        "write_ok": True,
        "expected_verdict": "PASS",
        "note": "stamped v0.0; the same bytes under v0.1 are READBACK_MISMATCH",
    }
    old_sample = _stamped("v0.0", old_facts)
    unbound_base = {
        "arm": "positive",
        "w": POSITIVE_W,
        "r": read_back,
        "write_ok": True,
    }
    missing_spec = dict(unbound_base)
    missing_spec["case_id"] = "probe-missing-spec-version"
    missing_spec["criteria_digest"] = digests["v0.1"]
    missing_digest = dict(unbound_base)
    missing_digest["case_id"] = "probe-missing-criteria-digest"
    missing_digest["spec_version"] = "v0.1"
    wrong_digest = dict(unbound_base)
    wrong_digest["case_id"] = "probe-digest-of-other-body"
    wrong_digest["spec_version"] = "v0.1"
    wrong_digest["criteria_digest"] = criteria_digest(UNREGISTERED)
    unknown_spec = dict(unbound_base)
    unknown_spec["case_id"] = "probe-unregistered-spec"
    unknown_spec["spec_version"] = "v0.2"
    unknown_spec["criteria_digest"] = criteria_digest(UNREGISTERED)
    return {
        "fixture": FIXTURE,
        "spec_version": "v0.1",
        "closed_verdicts": list(CLOSED),
        "columns": [
            "arm",
            "w",
            "r",
            "h_mem",
            "h_disk",
            "expected_verdict",
            "spec_version",
            "criteria_digest",
        ],
        "criteria": CRITERIA,
        "criteria_digest": digests,
        "unregistered_criteria": UNREGISTERED,
        "unregistered_criteria_digest": criteria_digest(UNREGISTERED),
        "arms": [positive, negative],
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
            and row["spec_version"] == "v0.1"
            and row["criteria_digest"] == criteria_digest(CRITERIA["v0.1"])
        )
        if row["must_fail"]:
            ok = ok and naive == "PASS" and naive != got["verdict"] and inherited == "PASS"
        add(f"arm-{row['case_id']}", ok, f"verdict={got['verdict']} naive={naive}")
        arm_rows.append(
            {
                "case_id": row["case_id"],
                "arm": row["arm"],
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

    positive = doc["arms"][0]
    negative = doc["arms"][1]
    add("positive-live-readback-equal", positive["w"] == positive["r"] == POSITIVE_W)
    add(
        "negative-truncated-and-hashes-differ",
        negative["truncated"] is True
        and negative["written_len"] == TRUNCATED_LEN
        and negative["written_len"] < negative["payload_len"]
        and negative["h_mem"] != negative["h_disk"]
        and negative["h_mem"] == hashlib.sha256(PAYLOAD).hexdigest()
        and negative["h_disk"] == hashlib.sha256(PAYLOAD[:TRUNCATED_LEN]).hexdigest(),
    )

    probe_rows: list[dict[str, Any]] = []
    for row in doc["binding_probes"]:
        got = judge(row)
        case_id = row["case_id"]
        if case_id == "old-sample-v0-0-truncated":
            v01 = apply_v0_1(row)
            ok = (
                got["criteria_bound"] is True
                and got["bound_spec_version"] == "v0.0"
                and got["verdict"] == "PASS"
                and got["verdict"] == row["expected_verdict"]
                and v01 == "READBACK_MISMATCH"
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
