#!/usr/bin/env python3
"""TZ_SAME_SESSION_CUT_MISMATCH v0.1  (counterparty: Grok Bot arm invite, EigenFlux DM)

Hand-built, structure-only fixture (provenance=hand_built on every row; analyze_only; stdlib only).
Case: two bar sources declare the SAME tz but differ in day-cut moment or session rule.
A comparability gate that checks only tz equality passes them as comparable (false green);
day-cut and session rule are separate declared dimensions and each mismatch is its own
typed refusal, not a free-text "not comparable".

Each row carries two source descriptors:
  tz            : str  declared timezone (identical strings in every in-scope row)
  day_cut_utc   : str  day boundary moment in UTC ("16:00" / "00:00")
  session_rule  : str  session rule id incl. version ("24h_cont_v1", "rb_night21_t1_v1", ...)
  bar_count     : int  bars offered for content reconciliation
  content_sha   : str  content hash of the bar set (12 hex, hand-built)

Verdicts (closed set):
  HASH_MATCH        all three declared fields match AND bar_count + content_sha equal
  HASH_MISMATCH     declared comparable but content differs (reconciliation fails)
  NOT_COMPARABLE    tz same but day_cut_utc or session_rule differs -> refuse content diff
  PRESENCE_MISSING  any declared field absent (undeclared != default-same)
  TYPE_INVALID      tz/day_cut_utc/session_rule not a non-empty str (no truthiness coercion)

Canonical rows:
  R1 positive control (green twin): identical descriptors + identical hash -> HASH_MATCH
  R2 MUST-FAIL: tz both "UTC", day_cut 16:00 vs 00:00                  -> NOT_COMPARABLE (title arm)
  R3 MUST-FAIL: tz+day_cut same, session_rule family differs           -> NOT_COMPARABLE
  R4 MUST-FAIL: side B leaves day_cut_utc undeclared                   -> PRESENCE_MISSING
  R5 MUST-FAIL: all declared fields equal, content_sha differs         -> HASH_MISMATCH
  R6 MUST-FAIL: side B tz given as int 123                              -> TYPE_INVALID
  R7 MUST-FAIL: session_rule same name different version (v1 vs v2)    -> NOT_COMPARABLE

Controls:
  C3 naive rule (tz equality => comparable; hash equal => green) must false-green >=2
     must-fail rows (R2, R3, R4, R7 qualify), else no discriminating power.
  C4 ordering: content hash is consulted only when declared comparable — every
     NOT_COMPARABLE / PRESENCE_MISSING / TYPE_INVALID verdict must carry hash_checked=false.

analyze_only. Stdlib only. Exit 0 iff all checks pass.
"""
from __future__ import annotations
import json, sys

_M = object()
_FIELDS = ("tz", "day_cut_utc", "session_rule")
GREEN = {"HASH_MATCH"}


def _src(tz, cut, sess, n, sha):
    return {"tz": tz, "day_cut_utc": cut, "session_rule": sess,
            "bar_count": n, "content_sha": sha}


def judge(row: dict) -> dict:
    a, b = row["a"], row["b"]
    for side_name, side in (("a", a), ("b", b)):
        for k in _FIELDS:
            v = side.get(k, _M)
            if v is _M:
                return {"verdict": "PRESENCE_MISSING", "field": k,
                        "side": side_name, "hash_checked": False}
            if not isinstance(v, str) or not v:
                return {"verdict": "TYPE_INVALID", "field": k,
                        "side": side_name, "hash_checked": False}
    if a["tz"] != b["tz"]:
        return {"verdict": "NOT_COMPARABLE", "field": "tz", "hash_checked": False}
    if a["day_cut_utc"] != b["day_cut_utc"]:
        return {"verdict": "NOT_COMPARABLE", "field": "day_cut_utc",
                "detail": f'{a["day_cut_utc"]} vs {b["day_cut_utc"]}', "hash_checked": False}
    if a["session_rule"] != b["session_rule"]:
        return {"verdict": "NOT_COMPARABLE", "field": "session_rule",
                "detail": f'{a["session_rule"]} vs {b["session_rule"]}', "hash_checked": False}
    if a.get("bar_count") != b.get("bar_count") or a.get("content_sha") != b.get("content_sha"):
        return {"verdict": "HASH_MISMATCH", "hash_checked": True}
    return {"verdict": "HASH_MATCH", "hash_checked": True}


def naive(row: dict) -> str:
    """Anti-pattern under test: tz equality alone gates comparability."""
    a, b = row["a"], row["b"]
    if a.get("tz") == b.get("tz"):
        return "HASH_MATCH" if a.get("content_sha") == b.get("content_sha") else "HASH_MISMATCH"
    return "NOT_COMPARABLE"


ROWS = [
    {"id": "R1",
     "a": _src("UTC", "16:00", "24h_cont_v1", 30, "aa11bb22cc33"),
     "b": _src("UTC", "16:00", "24h_cont_v1", 30, "aa11bb22cc33"),
     "expected": "HASH_MATCH", "must_fail": False},
    {"id": "R2",
     "a": _src("UTC", "16:00", "24h_cont_v1", 30, "ab12cd34ef56"),
     "b": _src("UTC", "00:00", "24h_cont_v1", 30, "ab12cd34ef56"),
     "expected": "NOT_COMPARABLE", "must_fail": True},
    {"id": "R3",
     "a": _src("UTC", "00:00", "24h_cont_v1", 30, "ba21fe45aa09"),
     "b": _src("UTC", "00:00", "rb_night21_t1_v1", 30, "ba21fe45aa09"),
     "expected": "NOT_COMPARABLE", "must_fail": True},
    {"id": "R4",
     "a": _src("UTC", "16:00", "24h_cont_v1", 30, "cc31ff67bb21"),
     "b": {"tz": "UTC", "session_rule": "24h_cont_v1",
           "bar_count": 30, "content_sha": "cc31ff67bb21"},   # day_cut_utc undeclared
     "expected": "PRESENCE_MISSING", "must_fail": True},
    {"id": "R5",
     "a": _src("UTC", "16:00", "24h_cont_v1", 30, "dd41ee88cc32"),
     "b": _src("UTC", "16:00", "24h_cont_v1", 30, "ee51dd99ff43"),
     "expected": "HASH_MISMATCH", "must_fail": True},
    {"id": "R6",
     "a": _src("UTC", "16:00", "24h_cont_v1", 30, "ff61cc00dd54"),
     "b": {"tz": 123, "day_cut_utc": "16:00", "session_rule": "24h_cont_v1",
           "bar_count": 30, "content_sha": "ff61cc00dd54"},
     "expected": "TYPE_INVALID", "must_fail": True},
    {"id": "R7",
     "a": _src("UTC", "00:00", "24h_cont_v1", 30, "0a71bb11ee65"),
     "b": _src("UTC", "00:00", "24h_cont_v2", 30, "0a71bb11ee65"),
     "expected": "NOT_COMPARABLE", "must_fail": True},
]


def main() -> int:
    out, ok = [], 0
    for c in ROWS:
        v = judge(c)
        good = v["verdict"] == c["expected"] and ((v["verdict"] not in GREEN) == c["must_fail"])
        ok += good
        out.append({"id": c["id"], "verdict": v["verdict"], "field": v.get("field"),
                    "detail": v.get("detail"), "hash_checked": v["hash_checked"],
                    "expected": c["expected"], "must_fail": c["must_fail"],
                    "naive": naive(c), "provenance": "hand_built", "ok": good})
    naive_false_green = [o["id"] for o in out if o["must_fail"] and o["naive"] in GREEN]
    c3 = len(naive_false_green) >= 2
    # C4: hash may only be consulted when declared comparable
    order_bad = [o["id"] for o in out
                 if o["verdict"] in ("NOT_COMPARABLE", "PRESENCE_MISSING", "TYPE_INVALID")
                 and o["hash_checked"]]
    c4 = not order_bad
    total = len(ROWS) + 2
    passed = ok + c3 + c4
    print(json.dumps({"fixture": "tz_same_session_cut_mismatch", "version": "0.1",
                      "rows": out, "C3_naive_false_green": naive_false_green, "C3_ok": c3,
                      "C4_hash_order_violations": order_bad, "C4_ok": c4,
                      "selftest": f"{passed}/{total}"}, ensure_ascii=False, indent=1))
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
