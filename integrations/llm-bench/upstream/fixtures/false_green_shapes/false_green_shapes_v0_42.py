#!/usr/bin/env python3
"""FALSE_GREEN_SHAPES v0.42

Adds three peer-supplied shapes on top of v0.41 (prior files untouched; S7-S73
rows re-run here by import so one command checks S7-S76).

  S74 EXIT0_ZERO_BYTE_SUCCESS / EMPTY_PAYLOAD_CLAIMED_OK
      Exit code 0 (or status==ok) with byte_count/stdout_bytes==0 while claiming
      artifact_ok / success / delivered. Naive greens on exit_code alone.
      Strict harness requires byte_count>0 (or explicit empty_ok with
      empty_declared True) when claiming success. Distinct from the separate
      ZERO_BYTE_FALSE_NONZERO pack (rows>0 vs bytes==0 conflict): this shape is
      about claiming success on a truly empty payload.
      Rules while claiming artifact_ok / success_ok / delivered:
        - byte_count (or stdout_bytes) must be present
        - if bytes==0 and empty_declared is not True → FAIL/EXIT0_ZERO_BYTE_SUCCESS
        - if bytes missing → UNKNOWN/BYTE_COUNT_UNDECLARED
      Naive greens: exit_code==0 / status==ok / ok True / artifact_ok True.
      Credit: 多一口吃不胖 (EigenFlux — exit0 空产物层负控).

  S75 SINGLETON_ARRAY_UNPACKED / CONTAINER_TYPE_FLIP
      Serialization/CLI path that accepts both array and object targets shares a
      default that unpacks a one-element array into an object. Parameter names
      stay correct; peer rejects by container type; rejection reason may be
      swallowed so the call looks like a no-op success. Strict green only when
      ALL hold while claiming send_ok / serialize_ok:
        - first_non_ws_char equals target_bracket ("[" for array, "{" for object)
        - container_type_observed equals container_type_intended
        - singleton_unpacked is not True
      Rules:
        - claiming with singleton_unpacked True → FAIL/SINGLETON_ARRAY_UNPACKED
        - claiming with first_non_ws_char != target_bracket → FAIL/BRACKET_MISMATCH
        - claiming with observed != intended container → FAIL/CONTAINER_TYPE_FLIP
        - claiming without intended/observed/bracket → UNKNOWN/CONTAINER_UNDECLARED
      Naive greens: exit_code==0 / status==ok / params_ok True / send_ok True.
      Credit: BOOM (EigenFlux — 单元素数组拆包 + 包装对象分支).

  S76 ACCEPTED_NOT_DELIVERED / QUEUED_AS_SUCCESS
      Command exit 0 and output contains success/accepted wording, but the
      delivery layer is queued_for_retry (or equivalent). Acceptance receipt
      mistaken for delivery. Distinct from pure exit-code greens: delivery_state
      must be terminal-delivered.
      Rules while claiming delivered / delivery_ok:
        - delivery_state in {delivered, confirmed} → OK
        - delivery_state in {queued_for_retry, accepted, queued, pending} →
          FAIL/ACCEPTED_NOT_DELIVERED
        - delivery_state missing → UNKNOWN/DELIVERY_STATE_UNDECLARED
        - exit_code!=0 cannot count as delivered success
      Naive greens: exit_code==0 / "success" in output / status==accepted/ok.
      Credit: Jaemin (EigenFlux — accepted≠delivered; queued_for_retry 观察).

analyze_only. Stdlib only. Run: python3 false_green_shapes_v0_42.py
"""
from __future__ import annotations
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import false_green_shapes_v0_41 as v41


def s74_naive(r):
    if r.get("artifact_ok") is True or r.get("success_ok") is True or r.get("delivered") is True:
        return "OK"
    if r.get("exit_code") == 0:
        return "OK"
    if r.get("status") == "ok" or r.get("ok") is True:
        return "OK"
    return "FAIL"


def s74_struct(r):
    claiming = (
        r.get("artifact_ok") is True
        or r.get("success_ok") is True
        or r.get("delivered") is True
        or r.get("claiming_success") is True
        or r.get("status") == "ok"
        or r.get("ok") is True
        or r.get("exit_code") == 0
    )
    if not claiming:
        return "FAIL"
    bytes_v = r.get("byte_count")
    if bytes_v is None:
        bytes_v = r.get("stdout_bytes")
    if bytes_v is None:
        return "UNKNOWN/BYTE_COUNT_UNDECLARED"
    if int(bytes_v) == 0 and r.get("empty_declared") is not True:
        return "FAIL/EXIT0_ZERO_BYTE_SUCCESS"
    return "OK"


def s75_naive(r):
    if r.get("send_ok") is True or r.get("serialize_ok") is True or r.get("params_ok") is True:
        return "OK"
    if r.get("exit_code") == 0:
        return "OK"
    if r.get("status") == "ok" or r.get("ok") is True:
        return "OK"
    return "FAIL"


def s75_struct(r):
    claiming = (
        r.get("send_ok") is True
        or r.get("serialize_ok") is True
        or r.get("params_ok") is True
        or r.get("claiming_send_ok") is True
        or r.get("status") == "ok"
        or r.get("ok") is True
        or r.get("exit_code") == 0
    )
    if not claiming:
        return "FAIL"
    intended = r.get("container_type_intended")
    observed = r.get("container_type_observed")
    bracket = r.get("first_non_ws_char")
    target = r.get("target_bracket")
    if intended is None or observed is None or bracket is None or target is None:
        return "UNKNOWN/CONTAINER_UNDECLARED"
    if r.get("singleton_unpacked") is True:
        return "FAIL/SINGLETON_ARRAY_UNPACKED"
    if str(bracket) != str(target):
        return "FAIL/BRACKET_MISMATCH"
    if str(observed) != str(intended):
        return "FAIL/CONTAINER_TYPE_FLIP"
    return "OK"


def s76_naive(r):
    out = str(r.get("output") or r.get("stdout") or "")
    if "success" in out.lower() or "accepted" in out.lower():
        return "OK"
    if r.get("status") in ("ok", "accepted", "success"):
        return "OK"
    if r.get("delivery_ok") is True or r.get("delivered") is True:
        return "OK"
    if r.get("exit_code") == 0:
        return "OK"
    if r.get("ok") is True:
        return "OK"
    return "FAIL"


def s76_struct(r):
    claiming = (
        r.get("delivery_ok") is True
        or r.get("delivered") is True
        or r.get("claiming_delivered") is True
        or r.get("status") in ("ok", "accepted", "success")
        or r.get("ok") is True
        or r.get("exit_code") == 0
        or ("success" in str(r.get("output") or "").lower())
        or ("accepted" in str(r.get("output") or "").lower())
    )
    if not claiming:
        return "FAIL"
    rc = r.get("exit_code")
    if rc is not None and rc != 0:
        return "FAIL/TRANSPORT_FAIL_AS_DELIVERED"
    state = r.get("delivery_state")
    if state is None:
        return "UNKNOWN/DELIVERY_STATE_UNDECLARED"
    state_l = str(state).lower()
    if state_l in ("delivered", "confirmed"):
        return "OK"
    if state_l in ("queued_for_retry", "accepted", "queued", "pending", "retrying"):
        return "FAIL/ACCEPTED_NOT_DELIVERED"
    return "FAIL/ACCEPTED_NOT_DELIVERED"


NEW_ROWS = [
  ("S74-mf-exit0-zero-bytes", "S74", "observed_shape_desensitized(多一口吃不胖)",
   {"exit_code": 0, "byte_count": 0, "artifact_ok": True, "status": "ok"},
   "FAIL/EXIT0_ZERO_BYTE_SUCCESS", True),
  ("S74-mf-stdout-bytes-zero", "S74", "hand_built",
   {"exit_code": 0, "stdout_bytes": 0, "ok": True, "success_ok": True},
   "FAIL/EXIT0_ZERO_BYTE_SUCCESS", True),
  ("S74-ct-bytes-undeclared", "S74", "hand_built",
   {"exit_code": 0, "artifact_ok": True, "status": "ok"},
   "UNKNOWN/BYTE_COUNT_UNDECLARED", True),
  ("S74-gt-nonzero-bytes", "S74", "observed_shape_desensitized(多一口吃不胖)",
   {"exit_code": 0, "byte_count": 128, "artifact_ok": True, "status": "ok"},
   "OK", False),
  ("S74-gt-explicit-empty-declared", "S74", "hand_built",
   {"exit_code": 0, "byte_count": 0, "empty_declared": True, "success_ok": True},
   "OK", False),
  ("S75-mf-singleton-unpacked", "S75", "observed_shape_desensitized(BOOM)",
   {"container_type_intended": "array", "container_type_observed": "object",
    "first_non_ws_char": "{", "target_bracket": "[",
    "singleton_unpacked": True, "params_ok": True, "send_ok": True, "exit_code": 0},
   "FAIL/SINGLETON_ARRAY_UNPACKED", True),
  ("S75-mf-bracket-mismatch", "S75", "hand_built",
   {"container_type_intended": "array", "container_type_observed": "array",
    "first_non_ws_char": "{", "target_bracket": "[",
    "singleton_unpacked": False, "serialize_ok": True, "ok": True},
   "FAIL/BRACKET_MISMATCH", True),
  ("S75-mf-wrapped-object-inner-array", "S75", "observed_shape_desensitized(BOOM)",
   {"container_type_intended": "array", "container_type_observed": "object",
    "first_non_ws_char": "{", "target_bracket": "[",
    "singleton_unpacked": False, "params_ok": True, "status": "ok", "exit_code": 0},
   "FAIL/BRACKET_MISMATCH", True),
  ("S75-ct-undeclared", "S75", "hand_built",
   {"send_ok": True, "exit_code": 0, "params_ok": True},
   "UNKNOWN/CONTAINER_UNDECLARED", True),
  ("S75-gt-array-bracket-match", "S75", "observed_shape_desensitized(BOOM)",
   {"container_type_intended": "array", "container_type_observed": "array",
    "first_non_ws_char": "[", "target_bracket": "[",
    "singleton_unpacked": False, "send_ok": True, "exit_code": 0},
   "OK", False),
  ("S76-mf-queued-for-retry", "S76", "observed_shape_desensitized(Jaemin)",
   {"exit_code": 0, "output": "accepted success", "delivery_state": "queued_for_retry",
    "delivery_ok": True, "status": "accepted"},
   "FAIL/ACCEPTED_NOT_DELIVERED", True),
  ("S76-mf-accepted-as-delivered", "S76", "hand_built",
   {"exit_code": 0, "output": "ok accepted", "delivery_state": "accepted",
    "delivered": True, "ok": True},
   "FAIL/ACCEPTED_NOT_DELIVERED", True),
  ("S76-ct-state-undeclared", "S76", "hand_built",
   {"exit_code": 0, "output": "success", "status": "ok"},
   "UNKNOWN/DELIVERY_STATE_UNDECLARED", True),
  ("S76-gt-confirmed-delivered", "S76", "observed_shape_desensitized(Jaemin)",
   {"exit_code": 0, "output": "success", "delivery_state": "delivered",
    "delivery_ok": True, "status": "ok"},
   "OK", False),
]

FNS = dict(v41.FNS)
FNS.update({
    "S74": (s74_naive, s74_struct),
    "S75": (s75_naive, s75_struct),
    "S76": (s76_naive, s76_struct),
})
ROWS = list(v41.ROWS) + NEW_ROWS
CANT_TELL = ("UNKNOWN", "UNDECIDABLE", "RETRYABLE")

def main():
    ok = 0; out = []; naive_wrong = 0
    for rid, shape, prov, arg, exp, mf in ROWS:
        naive, struct = FNS[shape]
        g, n = struct(arg), naive(arg)
        passed = (g == exp) and ((n != exp) if mf else (n == exp))
        naive_wrong += (n != exp)
        ok += passed
        out.append({"id": rid, "shape": shape, "provenance": prov, "expected": exp,
                    "struct": g, "naive": n, "must_fail_arm": mf, "pass": passed})
    ct = [r for r in out if r["expected"].split("/")[0] in CANT_TELL]
    forced = sum(1 for r in ct if r["naive"] in ("OK", "FAIL"))
    ctl = forced == len(ct)
    ok += ctl
    total = len(ROWS) + 1
    new_wrong = sum(1 for r in out if r["shape"] in ("S74", "S75", "S76") and r["naive"] != r["expected"])
    res = {"fixture": "FALSE_GREEN_SHAPES", "version": "0.42", "selftest": f"{ok}/{total}",
           "naive_wrong_rows": naive_wrong, "naive_wrong_new_shapes": f"{new_wrong}/{len(NEW_ROWS)}",
           "naive_forced_verdicts_on_cant_tell": forced, "forced_verdict_control": ctl, "rows": out}
    json.dump(res, open("run_out_v0_42.json", "w"), ensure_ascii=False, indent=1)
    print(f"selftest {ok}/{total}; naive wrong {naive_wrong}/{len(ROWS)} (new shapes {new_wrong}/{len(NEW_ROWS)}); forced verdicts on can't-tell {forced}/{len(ct)}")
    for r in out:
        if not r["pass"]:
            print("FAIL_ROW", r)
    return 0 if ok == total else 1

if __name__ == "__main__":
    raise SystemExit(main())
