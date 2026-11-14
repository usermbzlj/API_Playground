#!/usr/bin/env python3
"""RELAY_MODEL_ECHO v0.1  (probe design + fixture spec credit: Grok Bot; impl + local measurement: 阿坤家的笨鱼)

Problem (measured on a local OpenAI-compatible aggregate gateway, 2026-11-14):
a gateway answered HTTP 200 with a well-formed body for a request whose model
name was one character off, and separately answered 200 + choices with an EMPTY
content string when a reasoning model exhausted max_tokens on thinking. In both
cases the naive gate "200 + choices present -> SUCCESS" reports a pass. The
failure is not a missing criterion and not a truncated receipt: the gate measures
a different quantity than the one being asked about.

Two quantities, and they are NOT interchangeable:
  weak   : does the response carry a 'model' field?
           An echo satisfies it. Echoing the request name proves nothing.
  strong : does a wrong model name stop being 200?
           This is the one that catches silent fallback.

Measured shapes on the local gateway (endpoint and credentials removed):
  correct name   -> 200, response 'model' == request name (pure echo), 2233 ms
  one char wrong -> 404, body lists the provider's available model names
  bad prefix     -> 404, "no adapter registered for provider"

Third trap, and the reason this fixture exists in its current shape:
  a transient status (429 / 5xx / no response) is NOT a rejection.
  Reading 429 as "the gateway rejected the wrong name" turns an unknown into a
  pass — the same shape as reading ERROR_ACCESS_DENIED as ERROR_SHARING_VIOLATION.

Gate:
  correct probe not 200                       -> REQUEST_FAILED
  correct 200 but content empty               -> EMPTY_BODY
  any probe transient (429 / 5xx / no reply)  -> INCONCLUSIVE_TRANSIENT
  typo probe 2xx                              -> SILENT_FALLBACK
  bad-prefix probe 2xx                        -> PARTIAL_REJECT
  both non-2xx, resp model absent             -> REJECTS_AND_NO_FIELD
  both non-2xx, resp model == request         -> REJECTS_AND_ECHO
  both non-2xx, resp model != request         -> MISMATCH_REPORTED
Naive baseline: "http == 200 and choices present -> SUCCESS".
analyze_only, stdlib only, exit 0 iff selftest all pass.
Optional live probe (never in selftest): python3 relay_model_echo_v0_1.py --probe --endpoint URL --model NAME
"""
from __future__ import annotations

import hashlib
import json
import sys

TRANSIENT = {408, 425, 429, 500, 502, 503, 504}


def _probe(rec, name):
    return rec.get(name) or {}


def _status(rec, name):
    return _probe(rec, name).get("http")


def _is_transient(rec, name):
    st = _status(rec, name)
    return (st is None) or (isinstance(st, int) and st in TRANSIENT)


def judge(rec):
    requested = rec.get("requested_model")
    ok = _probe(rec, "correct")
    ok_status = ok.get("http")
    if ok_status != 200:
        return {"verdict": "REQUEST_FAILED", "detail": "correct name did not return 200"}
    if ok.get("content_len", 0) == 0:
        return {
            "verdict": "EMPTY_BODY",
            "detail": "200 with choices but empty content (finish_reason=%s)" % ok.get("finish_reason"),
        }
    for name in ("typo", "bad_prefix"):
        if _is_transient(rec, name):
            return {
                "verdict": "INCONCLUSIVE_TRANSIENT",
                "detail": "%s probe returned %s: not a rejection" % (name, _status(rec, name)),
            }
    typo_ok = isinstance(_status(rec, "typo"), int) and 200 <= _status(rec, "typo") < 300
    prefix_ok = isinstance(_status(rec, "bad_prefix"), int) and 200 <= _status(rec, "bad_prefix") < 300
    if typo_ok:
        return {"verdict": "SILENT_FALLBACK", "detail": "wrong model name still returned 2xx"}
    if prefix_ok:
        return {"verdict": "PARTIAL_REJECT", "detail": "bad prefix not rejected while wrong name was"}
    resp_model = ok.get("model")
    if not resp_model:
        return {"verdict": "REJECTS_AND_NO_FIELD", "detail": "wrong name rejected; no model field to trust"}
    if resp_model == requested:
        return {"verdict": "REJECTS_AND_ECHO", "detail": "wrong name rejected; model field is an echo"}
    return {"verdict": "MISMATCH_REPORTED", "detail": "wrong name rejected; model field differs from request"}


def naive(rec):
    ok = _probe(rec, "correct")
    return "SUCCESS" if ok.get("http") == 200 and ok.get("has_choices") else "FAIL"


def _rec(requested, ok_http, ok_model, ok_len, typo_http, prefix_http, finish="stop", has_choices=True):
    return {
        "requested_model": requested,
        "correct": {
            "http": ok_http,
            "model": ok_model,
            "content_len": ok_len,
            "finish_reason": finish,
            "has_choices": has_choices,
        },
        "typo": {"http": typo_http},
        "bad_prefix": {"http": prefix_http},
    }


ROWS = [
    {
        "case_id": "RME-SILENT-FALLBACK-MUST-RED",
        "note": "wrong name one char off still 200 -> naive calls it a pass",
        "rec": _rec("aggregate/glm-5-3-flash", 200, "aggregate/glm-5-3-flash", 2, 200, 404),
        "expect": "SILENT_FALLBACK",
    },
    {
        "case_id": "RME-EMPTY-BODY-MUST-RED",
        "note": "reasoning model ate max_tokens: 200 + choices + empty content",
        "rec": _rec("aggregate/glm-5-3-flash", 200, "aggregate/glm-5-3-flash", 0, 404, 404, finish="length"),
        "expect": "EMPTY_BODY",
    },
    {
        "case_id": "RME-TYPO-429-NOT-A-REJECTION-MUST-RED",
        "note": "429 is transient; counting it as rejection turns unknown into pass",
        "rec": _rec("aggregate/glm-5-3-flash", 200, "aggregate/glm-5-3-flash", 2, 429, 404),
        "expect": "INCONCLUSIVE_TRANSIENT",
    },
    {
        "case_id": "RME-TYPO-503-MUST-RED",
        "rec": _rec("aggregate/glm-5-3-flash", 200, "aggregate/glm-5-3-flash", 2, 503, 404),
        "expect": "INCONCLUSIVE_TRANSIENT",
    },
    {
        "case_id": "RME-TYPO-NO-REPLY-MUST-RED",
        "rec": _rec("aggregate/glm-5-3-flash", 200, "aggregate/glm-5-3-flash", 2, None, 404),
        "expect": "INCONCLUSIVE_TRANSIENT",
    },
    {
        "case_id": "RME-REJECTS-AND-ECHO-HONEST",
        "note": "local gateway measured shape: strong holds, weak carries no information",
        "rec": _rec("aggregate/glm-5-3-flash", 200, "aggregate/glm-5-3-flash", 2, 404, 404),
        "expect": "REJECTS_AND_ECHO",
    },
    {
        "case_id": "RME-REJECTS-NO-FIELD",
        "rec": _rec("some/model", 200, None, 2, 404, 404),
        "expect": "REJECTS_AND_NO_FIELD",
    },
    {
        "case_id": "RME-MISMATCH-REPORTED",
        "note": "backend self-reports a different name: real routing, not echo",
        "rec": _rec("vendor-a/model-x", 200, "vendor-b/model-y", 2, 404, 404),
        "expect": "MISMATCH_REPORTED",
    },
    {
        "case_id": "RME-PARTIAL-REJECT",
        "note": "wrong name rejected but bogus prefix accepted: do not report a clean pass",
        "rec": _rec("aggregate/glm-5-3-flash", 200, "aggregate/glm-5-3-flash", 2, 404, 200),
        "expect": "PARTIAL_REJECT",
    },
    {
        "case_id": "RME-REQUEST-FAILED",
        "rec": _rec("aggregate/glm-5-3-flash", 404, None, 0, 404, 404),
        "expect": "REQUEST_FAILED",
    },
    {
        "case_id": "RME-EMPTY-BEFORE-TRANSIENT",
        "note": "precedence: empty body outranks a transient sibling probe",
        "rec": _rec("m/x", 200, "m/x", 0, 503, 503, finish="length"),
        "expect": "EMPTY_BODY",
    },
    {
        "case_id": "RME-SILENT-FALLBACK-BEATS-ECHO",
        "note": "fallback outranks field state: the field would look fine either way",
        "rec": _rec("m/x", 200, "m/x", 2, 200, 200),
        "expect": "SILENT_FALLBACK",
    },
]


def selftest():
    checks = []
    rows_out = []
    for row in ROWS:
        got = judge(row["rec"])["verdict"]
        naive_v = naive(row["rec"])
        rows_out.append(
            {
                "case_id": row["case_id"],
                "note": row.get("note", ""),
                "expect": row["expect"],
                "got": got,
                "naive": naive_v,
                "match": got == row["expect"],
                "naive_false_green": naive_v == "SUCCESS" and got in ("SILENT_FALLBACK", "EMPTY_BODY", "INCONCLUSIVE_TRANSIENT"),
            }
        )

    # 1 every row matches its expectation
    checks.append(("rows match expect", all(r["match"] for r in rows_out)))
    # 2 naive baseline really does produce false greens (fixture is not vacuous)
    checks.append(("naive yields false greens", any(r["naive_false_green"] for r in rows_out)))
    # 3 transient is never reported as a rejection
    checks.append(
        (
            "transient never counted as rejection",
            all(
                judge(r["rec"])["verdict"] not in ("REJECTS_AND_ECHO", "REJECTS_AND_NO_FIELD", "MISMATCH_REPORTED")
                for r in ROWS
                if _is_transient(r["rec"], "typo") or _is_transient(r["rec"], "bad_prefix")
            ),
        )
    )
    # 4 echo is reported as no-information, never as MISMATCH
    checks.append(
        (
            "echo never reported as backend self-report",
            judge(_rec("m/x", 200, "m/x", 2, 404, 404))["verdict"] == "REJECTS_AND_ECHO",
        )
    )
    # 5 silent fallback is never reported as a clean pass
    checks.append(
        (
            "silent fallback never a pass",
            judge(_rec("m/x", 200, "m/x", 2, 200, 404))["verdict"] == "SILENT_FALLBACK",
        )
    )

    n_rows = len(rows_out)
    n_row_ok = sum(1 for r in rows_out if r["match"])
    n_chk_ok = sum(1 for _, ok in checks if ok)
    out = {
        "fixture": "relay_model_echo",
        "version": "0.1",
        "all_match": n_row_ok == n_rows and n_chk_ok == len(checks),
        "n": n_rows,
        "n_match": n_row_ok,
        "checks": [{"name": n, "ok": ok} for n, ok in checks],
        "n_checks": len(checks),
        "n_checks_ok": n_chk_ok,
        "rows": rows_out,
    }
    return out


def live_probe(endpoint, key, model, timeout=60):
    """Optional, never used by selftest. Endpoint and key come from the caller."""
    import urllib.error
    import urllib.request

    def call(m, max_tokens=64):
        body = json.dumps(
            {
                "model": m,
                "messages": [{"role": "user", "content": "reply with the single word: ok"}],
                "max_tokens": max_tokens,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                status = resp.status
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            status = exc.code
        except Exception:
            return {"http": None, "model": None, "content_len": 0, "finish_reason": None, "has_choices": False}
        try:
            parsed = json.loads(raw)
        except Exception:
            return {"http": status, "model": None, "content_len": 0, "finish_reason": None, "has_choices": False}
        choice = (parsed.get("choices") or [{}])[0] or {}
        message = choice.get("message") or {}
        return {
            "http": status,
            "model": parsed.get("model"),
            "content_len": len(message.get("content") or ""),
            "finish_reason": choice.get("finish_reason"),
            "has_choices": bool(parsed.get("choices")),
        }

    typo = model[:-1] + ("X" if model[-1:] != "X" else "Y")
    prefix = model.split("/")[0] + "_nonexistent_prefix/probe-model"
    rec = {
        "requested_model": model,
        "correct": call(model),
        "typo": call(typo),
        "bad_prefix": call(prefix),
    }
    return {"probe": rec, "verdict": judge(rec)}


def main(argv):
    if "--probe" in argv:
        import argparse
        import os

        ap = argparse.ArgumentParser()
        ap.add_argument("--probe", action="store_true")
        ap.add_argument("--endpoint", required=True)
        ap.add_argument("--model", required=True)
        ap.add_argument("--api-key-env", default="GW_KEY")
        args = ap.parse_args(argv)
        key = os.environ.get(args.api_key_env, "")
        if not key:
            print(json.dumps({"verdict": "NO_KEY", "detail": args.api_key_env}, ensure_ascii=False))
            return 0
        print(json.dumps(live_probe(args.endpoint, key, args.model), ensure_ascii=False, indent=2))
        return 0
    out = selftest()
    text = json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True)
    print(text)
    with open(__file__, "rb") as f:
        script_sha = hashlib.sha256(f.read()).hexdigest()
    meta = {
        "script_sha256": script_sha,
        # Hash the emitted text, not a captured file: .gitattributes marks
        # integrations/llm-bench/upstream/** as -text, so the same logical
        # output is CRLF on Windows and LF elsewhere. A file hash is not a
        # reproducible receipt; the text hash is.
        "run_out_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }
    print("META " + json.dumps(meta, sort_keys=True), file=sys.stderr)
    return 0 if out["all_match"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
