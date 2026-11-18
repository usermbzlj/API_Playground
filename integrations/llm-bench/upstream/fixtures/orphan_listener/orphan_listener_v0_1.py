#!/usr/bin/env python3
"""ORPHAN_LISTENER v0.1

Synthetic analyze_only fixture. Closed verdict set:
  PASS, UNKNOWN, ORPHAN_LISTENER_ACCEPTED, CONNECTED_ONLY, CONNECT_FAILED

The system under test is a local listener ("is this port a live service?"),
the judge is the probe's claim about it. The whole point of the fixture:
"the port accepts a TCP connection" is not evidence that the service is alive.

Arms:
  healthy-live-listener            request answered, body carries price_version,
                                   owner pid alive                    -> PASS
  negative-lingering-listen        connect_ok, no request answer, port still
                                   LISTEN, owner pid dead              -> UNKNOWN
                                                                        (LISTEN_NO_ANSWER)
  orphan-accepts-valid-response    connect_ok, request answered with a valid
                                   body, owner pid dead (inherited fd) -> ORPHAN_LISTENER_ACCEPTED
  connect-only-probe               probe never sends a request          -> CONNECTED_ONLY
  answered-without-price-version   request answered, body lacks the
                                   required field                     -> UNKNOWN
                                                                        (BODY_INVALID_PRICE_VERSION)
  no-listener                      connection refused                 -> CONNECT_FAILED

The pinned naive baseline (also the v0.0 criteria) treats connect_ok as PASS.
That is the false green this fixture exists to catch: on every arm where the
socket accepts but the service is not healthy, the baseline says PASS and the
honest judge does not. Those arms are must_fail for the baseline.

Every judged row must carry:
  spec_version      a registered criteria body version
  criteria_digest   sha256 of the canonical JSON body of that spec_version
  injection_receipt {action, effect_evidence, expected_code} for injected arms
A row without a complete receipt is not judged: it is not PASS and it does not
count toward a pass rate. The fixture reports it as unjudged with a reason.

Stdlib only. No credentials, no real payloads, no network I/O: every listener
state is a synthetic row. The row shape mirrors what a real probe writes
(connect_ok / request_answered / listen_state / owner_alive / body).
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

CLOSED = (
    "PASS",
    "UNKNOWN",
    "ORPHAN_LISTENER_ACCEPTED",
    "CONNECTED_ONLY",
    "CONNECT_FAILED",
)
REASONS = (
    "LISTEN_NO_ANSWER",
    "BODY_INVALID_PRICE_VERSION",
)
FIXTURE = "orphan_listener"
PRICE_VERSION = "pv-2026-11-01"

CRITERIA: dict[str, dict[str, Any]] = {
    "v0.0": {
        "spec_version": "v0.0",
        "fixture": FIXTURE,
        "closed_verdicts": list(CLOSED),
        "rules": [
            "legacy: connect_ok true -> PASS; the request is never sent and the response body is never read",
        ],
    },
    "v0.1": {
        "spec_version": "v0.1",
        "fixture": FIXTURE,
        "closed_verdicts": list(CLOSED),
        "rules": [
            "PASS requires a real request answered with a body carrying price_version, and a live owner pid",
            "connect_ok true but request_answered not true -> UNKNOWN with reason LISTEN_NO_ANSWER; a listener that accepts but never answers is never PASS",
            "request answered without price_version in the body -> UNKNOWN with reason BODY_INVALID_PRICE_VERSION",
            "request answered with a valid body but owner_alive false (socket inherited or left behind) -> ORPHAN_LISTENER_ACCEPTED, never PASS: answering is not the same as having a process that maintains state",
            "connect_ok not true -> CONNECT_FAILED",
            "probe_mode connect_only caps the verdict at CONNECTED_ONLY and never yields PASS",
            "expected_verdict is a dedicated field and is not an input to the judge",
            "spec_version and criteria_digest are required; criteria_digest is sha256 of the canonical JSON body of that spec_version",
            "a row is judged only by the registered body whose digest it stamps; a newer body is not substituted",
            "injection_receipt {action, effect_evidence, expected_code} is required; missing any field makes the row unjudged, not PASS",
        ],
    },
}

# Present on purpose and deliberately not registered. A judge that always
# applies the newest text would call the lingering-LISTEN arm PASS.
UNREGISTERED: dict[str, Any] = {
    "spec_version": "v0.2",
    "fixture": FIXTURE,
    "closed_verdicts": list(CLOSED),
    "rules": [
        "unregistered draft: connect_ok true -> PASS even when nothing answers",
    ],
}

REGISTRY = CRITERIA


def canon_bytes(body: Any) -> bytes:
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def criteria_digest(body: Any) -> str:
    return hashlib.sha256(canon_bytes(body)).hexdigest()


def naive_judge(row: dict[str, Any]) -> str:
    """Pinned false-green baseline (v0.0): a successful connect is PASS.

    This function must stay wrong on every arm where the socket accepts but the
    service is not healthy. The selftest fails if it starts agreeing there.
    """
    if row.get("connect_ok") is True:
        return "PASS"
    return "CONNECT_FAILED"


def connect_only_judge(row: dict[str, Any]) -> str:
    """Deliberately weak probe: stops after TCP connect."""
    return "CONNECTED_ONLY" if row.get("connect_ok") is True else "CONNECT_FAILED"


def apply_v0_1(row: dict[str, Any]) -> str:
    if row.get("probe_mode") == "connect_only":
        return connect_only_judge(row)
    if row.get("connect_ok") is not True:
        return "CONNECT_FAILED"
    if row.get("request_answered") is not True:
        return "UNKNOWN"
    body = row.get("response_body")
    if not isinstance(body, dict) or body.get("price_version") != PRICE_VERSION:
        return "UNKNOWN"
    if row.get("owner_alive") is not True:
        return "ORPHAN_LISTENER_ACCEPTED"
    return "PASS"


IMPLEMENTATIONS = {
    "v0.0": naive_judge,
    "v0.1": apply_v0_1,
}

RECEIPT_FIELDS = ("action", "effect_evidence", "expected_code")


def unjudged_reason(row: dict[str, Any]) -> str | None:
    spec = row.get("spec_version")
    digest = row.get("criteria_digest")
    receipt = row.get("injection_receipt")
    if not isinstance(spec, str) or not spec:
        return "MISSING_SPEC_VERSION"
    if not isinstance(digest, str) or len(digest) != 64:
        return "MISSING_CRITERIA_DIGEST"
    body = REGISTRY.get(spec)
    if body is None:
        return "UNREGISTERED_SPEC"
    if digest != criteria_digest(body):
        return "DIGEST_MISMATCH"
    if not isinstance(receipt, dict):
        return "INJECTION_RECEIPT_MISSING"
    for field in RECEIPT_FIELDS:
        value = receipt.get(field)
        if not isinstance(value, str) or not value:
            return "INJECTION_RECEIPT_INCOMPLETE"
    return None


def judge(row: dict[str, Any]) -> dict[str, Any]:
    """Judge one row by the criteria body it stamps. Never reads expected_verdict."""
    reason = unjudged_reason(row)
    if reason is not None:
        return {
            "criteria_bound": False,
            "verdict": None,
            "bound_spec_version": None,
            "unjudged_reason": reason,
        }
    body = REGISTRY[row["spec_version"]]
    verdict = IMPLEMENTATIONS[body["spec_version"]](row)
    if verdict not in CLOSED:
        raise RuntimeError(f"verdict {verdict!r} outside closed set")
    return {
        "criteria_bound": True,
        "verdict": verdict,
        "bound_spec_version": body["spec_version"],
        "unjudged_reason": None,
    }


def judge_ignoring_stamp(row: dict[str, Any]) -> str:
    """The inheritance bug: apply the unregistered newer body to every row."""
    return naive_judge(row)


def _stamped(spec: str, fields: dict[str, Any]) -> dict[str, Any]:
    row = dict(fields)
    row["spec_version"] = spec
    row["criteria_digest"] = criteria_digest(CRITERIA[spec])
    return row


def _receipt(action: str, effect: str, code: str) -> dict[str, str]:
    return {"action": action, "effect_evidence": effect, "expected_code": code}


def build_rows() -> dict[str, Any]:
    digests = {spec: criteria_digest(body) for spec, body in CRITERIA.items()}

    healthy = _stamped(
        "v0.1",
        {
            "arm": "positive",
            "case_id": "healthy-live-listener",
            "listen_state": "LISTEN",
            "owner_alive": True,
            "connect_ok": True,
            "request_answered": True,
            "probe_mode": "request",
            "response_body": {"price_version": PRICE_VERSION},
            "expected_verdict": "PASS",
            "expected_reason": None,
            "must_fail": False,
            "injection_receipt": _receipt(
                "start listener with a live owner",
                "request answered and body carries price_version",
                "PASS",
            ),
        },
    )
    lingering = _stamped(
        "v0.1",
        {
            "arm": "negative",
            "case_id": "negative-lingering-listen-dead-owner",
            "listen_state": "LISTEN",
            "socket_held_by": "inherited_fd",
            "owner_alive": False,
            "connect_ok": True,
            "request_answered": False,
            "probe_mode": "request",
            "response_body": None,
            "expected_verdict": "UNKNOWN",
            "expected_reason": "LISTEN_NO_ANSWER",
            "must_fail": True,
            "injection_receipt": _receipt(
                "kill the owner process, leave the inherited listening socket in place",
                "connect_ok true, no request answer before the probe timeout, port still LISTEN",
                "UNKNOWN_LISTEN_NO_ANSWER",
            ),
        },
    )
    orphan = _stamped(
        "v0.1",
        {
            "arm": "negative",
            "case_id": "orphan-accepts-valid-response",
            "listen_state": "LISTEN",
            "socket_held_by": "inherited_fd",
            "owner_alive": False,
            "connect_ok": True,
            "request_answered": True,
            "probe_mode": "request",
            "response_body": {"price_version": PRICE_VERSION},
            "expected_verdict": "ORPHAN_LISTENER_ACCEPTED",
            "expected_reason": None,
            "must_fail": True,
            "injection_receipt": _receipt(
                "keep the inherited listening socket open after the owner exits",
                "request answered with a valid price_version while the owner pid is gone",
                "ORPHAN_LISTENER_ACCEPTED",
            ),
        },
    )
    connect_only = _stamped(
        "v0.1",
        {
            "arm": "negative",
            "case_id": "connect-only-probe",
            "listen_state": "LISTEN",
            "socket_held_by": "inherited_fd",
            "owner_alive": False,
            "connect_ok": True,
            "request_answered": None,
            "probe_mode": "connect_only",
            "response_body": None,
            "expected_verdict": "CONNECTED_ONLY",
            "expected_reason": None,
            "must_fail": True,
            "injection_receipt": _receipt(
                "probe performs connect() only and closes",
                "connect_ok true, request never sent, no response body observed",
                "CONNECTED_ONLY",
            ),
        },
    )
    bad_body = _stamped(
        "v0.1",
        {
            "arm": "negative",
            "case_id": "answered-without-price-version",
            "listen_state": "LISTEN",
            "owner_alive": True,
            "connect_ok": True,
            "request_answered": True,
            "probe_mode": "request",
            "response_body": {"status": "ok"},
            "expected_verdict": "UNKNOWN",
            "expected_reason": "BODY_INVALID_PRICE_VERSION",
            "must_fail": True,
            "injection_receipt": _receipt(
                "listener answers 200 with a body that omits price_version",
                "request answered but the required field is absent from the body",
                "UNKNOWN_BODY_INVALID_PRICE_VERSION",
            ),
        },
    )
    closed_port = _stamped(
        "v0.1",
        {
            "arm": "positive",
            "case_id": "no-listener",
            "listen_state": "CLOSED",
            "owner_alive": False,
            "connect_ok": False,
            "request_answered": False,
            "probe_mode": "request",
            "response_body": None,
            "expected_verdict": "CONNECT_FAILED",
            "expected_reason": None,
            "must_fail": False,
            "injection_receipt": _receipt(
                "close the port and stop the process",
                "connect() refused",
                "CONNECT_FAILED",
            ),
        },
    )

    old_facts = {
        "arm": "negative",
        "case_id": "old-sample-v0-0-lingering-listen",
        "listen_state": "LISTEN",
        "socket_held_by": "inherited_fd",
        "owner_alive": False,
        "connect_ok": True,
        "request_answered": False,
        "probe_mode": "request",
        "response_body": None,
        "expected_verdict": "PASS",
        "expected_reason": None,
        "must_fail": False,
        "injection_receipt": _receipt(
            "kill the owner process, leave the inherited listening socket in place",
            "connect_ok true, no request answer",
            "PASS",
        ),
        "note": "stamped v0.0; the same row under v0.1 is UNKNOWN(LISTEN_NO_ANSWER)",
    }
    old_sample = _stamped("v0.0", old_facts)

    base = {
        "arm": "negative",
        "listen_state": "LISTEN",
        "owner_alive": False,
        "connect_ok": True,
        "request_answered": False,
        "probe_mode": "request",
        "response_body": None,
        "expected_verdict": "UNKNOWN",
        "expected_reason": "LISTEN_NO_ANSWER",
        "injection_receipt": _receipt(
            "synthetic", "synthetic", "UNKNOWN_LISTEN_NO_ANSWER"
        ),
    }

    def probe(case_id: str, **overrides: Any) -> dict[str, Any]:
        row = dict(base)
        row.update(overrides)
        row["case_id"] = case_id
        return row

    missing_spec = probe("probe-missing-spec-version", criteria_digest=digests["v0.1"])
    missing_digest = probe("probe-missing-criteria-digest", spec_version="v0.1")
    wrong_digest = probe(
        "probe-digest-of-other-body",
        spec_version="v0.1",
        criteria_digest=criteria_digest(UNREGISTERED),
    )
    unknown_spec = probe(
        "probe-unregistered-spec",
        spec_version="v0.2",
        criteria_digest=criteria_digest(UNREGISTERED),
    )
    missing_receipt = probe(
        "probe-injection-receipt-missing",
        spec_version="v0.1",
        criteria_digest=digests["v0.1"],
    )
    missing_receipt.pop("injection_receipt")
    partial_receipt = probe(
        "probe-injection-receipt-incomplete",
        spec_version="v0.1",
        criteria_digest=digests["v0.1"],
        injection_receipt={"action": "synthetic", "expected_code": "UNKNOWN"},
    )

    return {
        "fixture": FIXTURE,
        "spec_version": "v0.1",
        "closed_verdicts": list(CLOSED),
        "reasons": list(REASONS),
        "columns": [
            "arm",
            "case_id",
            "listen_state",
            "owner_alive",
            "connect_ok",
            "request_answered",
            "probe_mode",
            "response_body",
            "expected_verdict",
            "expected_reason",
            "must_fail",
            "injection_receipt",
            "spec_version",
            "criteria_digest",
        ],
        "criteria": CRITERIA,
        "criteria_digest": digests,
        "unregistered_criteria": UNREGISTERED,
        "unregistered_criteria_digest": criteria_digest(UNREGISTERED),
        "arms": [healthy, lingering, orphan, connect_only, bad_body, closed_port],
        "binding_probes": [
            old_sample,
            missing_spec,
            missing_digest,
            wrong_digest,
            unknown_spec,
            missing_receipt,
            partial_receipt,
        ],
    }


def _strip_verdict(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k not in ("expected_verdict", "expected_reason")}


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
            ok = (
                ok
                and got["verdict"] != "PASS"
                and naive == "PASS"
                and naive != got["verdict"]
                and inherited == "PASS"
            )
        else:
            ok = ok and naive == got["verdict"]
        add(f"arm-{row['case_id']}", ok, f"verdict={got['verdict']} naive={naive}")
        arm_rows.append(
            {
                "case_id": row["case_id"],
                "arm": row["arm"],
                "expected_verdict": row["expected_verdict"],
                "verdict": got["verdict"],
                "expected_reason": row["expected_reason"],
                "naive_verdict": naive,
                "ignoring_stamp_verdict": inherited,
                "criteria_bound": got["criteria_bound"],
                "bound_spec_version": got["bound_spec_version"],
                "must_fail": row["must_fail"],
                "ok": ok,
            }
        )

    # Structural assertions: the rows must actually contain the shapes the
    # criteria claim to judge. A row that says "no answer" while carrying a
    # response body would make the verdict unearned.
    by_id = {r["case_id"]: r for r in doc["arms"]}
    add(
        "lingering-listen-shape",
        by_id["negative-lingering-listen-dead-owner"]["connect_ok"] is True
        and by_id["negative-lingering-listen-dead-owner"]["request_answered"] is False
        and by_id["negative-lingering-listen-dead-owner"]["listen_state"] == "LISTEN"
        and by_id["negative-lingering-listen-dead-owner"]["owner_alive"] is False
        and by_id["negative-lingering-listen-dead-owner"]["response_body"] is None,
    )
    add(
        "orphan-accepted-shape",
        by_id["orphan-accepts-valid-response"]["request_answered"] is True
        and by_id["orphan-accepts-valid-response"]["response_body"]["price_version"] == PRICE_VERSION
        and by_id["orphan-accepts-valid-response"]["owner_alive"] is False,
    )
    add(
        "connect-only-never-answers",
        by_id["connect-only-probe"]["probe_mode"] == "connect_only"
        and by_id["connect-only-probe"]["request_answered"] is None,
    )
    add(
        "no-arm-with-accept-but-no-answer-is-PASS",
        all(
            not (r.get("connect_ok") is True and r.get("request_answered") is not True)
            or r["expected_verdict"] != "PASS"
            for r in doc["arms"]
        ),
    )
    add(
        "every-arm-has-three-field-receipt",
        all(
            isinstance(r.get("injection_receipt"), dict)
            and all(isinstance(r["injection_receipt"].get(f), str) and r["injection_receipt"].get(f) for f in RECEIPT_FIELDS)
            for r in doc["arms"]
        ),
    )

    probe_rows: list[dict[str, Any]] = []
    for row in doc["binding_probes"]:
        got = judge(row)
        case_id = row["case_id"]
        if case_id == "old-sample-v0-0-lingering-listen":
            v01 = apply_v0_1(row)
            ok = (
                got["criteria_bound"] is True
                and got["bound_spec_version"] == "v0.0"
                and got["verdict"] == "PASS"
                and got["verdict"] == row["expected_verdict"]
                and v01 == "UNKNOWN"
                and judge_ignoring_stamp(row) == "PASS"
            )
            detail = f"stamped={got['verdict']} v0.1_would={v01}"
        else:
            ok = got["criteria_bound"] is False and got["verdict"] is None
            detail = f"unjudged reason={got['unjudged_reason']}"
        add(case_id, ok, detail)
        probe_rows.append(
            {
                "case_id": case_id,
                "criteria_bound": got["criteria_bound"],
                "verdict": got["verdict"],
                "bound_spec_version": got["bound_spec_version"],
                "unjudged_reason": got["unjudged_reason"],
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
