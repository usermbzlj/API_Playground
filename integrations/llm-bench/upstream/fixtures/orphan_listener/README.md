# ORPHAN_LISTENER v0.1

Synthetic listener-liveness fixture. The question it pins down: **does a port that accepts a TCP connection prove that the service is alive?**

Closed verdict set: `PASS`, `UNKNOWN`, `ORPHAN_LISTENER_ACCEPTED`, `CONNECTED_ONLY`, `CONNECT_FAILED`. `expected_verdict` and `expected_reason` are their own fields and are never inputs to the judge.

Run: `python3 orphan_listener_v0_1.py` (exit 0 iff every selftest check passes). Rows live in `expected.json`; the receipt is sha256 of the raw bytes of `run_out_v0_1.json`.

| arm | condition | expected_verdict |
| --- | --- | --- |
| positive | request answered, body carries `price_version`, owner pid alive | `PASS` |
| negative | port still `LISTEN`, owner pid dead, `connect_ok` but no answer | `UNKNOWN` (`LISTEN_NO_ANSWER`) |
| negative | orphan accepts and answers a valid body while the owner pid is gone | `ORPHAN_LISTENER_ACCEPTED` |
| negative | probe stops at `connect()` and never sends a request | `CONNECTED_ONLY` |
| negative | request answered but the body omits `price_version` | `UNKNOWN` (`BODY_INVALID_PRICE_VERSION`) |
| positive | nothing listening, `connect()` refused | `CONNECT_FAILED` |

The pinned naive baseline treats `connect_ok` as `PASS`. It returns `PASS` on all four negative arms, so each of them is a must-fail for the baseline; `selftest` requires that the honest judge disagrees there.

Two columns matter and are never merged: `connect_ok` and `request_answered`. A listener that accepts but does not answer is `UNKNOWN`, never `PASS`. An orphaned socket that still answers is `ORPHAN_LISTENER_ACCEPTED`, never `PASS` — answering is not the same as having a process that maintains state.

`probe_mode: connect_only` caps the verdict at `CONNECTED_ONLY` by construction. That is the arm that makes "we only checked the port" visible in the ledger instead of silently green.

Every judged row carries `spec_version` and `criteria_digest` (sha256 of the canonical criteria body for that spec version), plus `injection_receipt {action, effect_evidence, expected_code}`. A row stamped with an unregistered version, a digest from another body, or an incomplete receipt is **not judged**: it is not `PASS` and it does not enter a pass-rate denominator. `run_out` reports it as `criteria_bound: false` with an `unjudged_reason`.

Binding probes are included on purpose: an old sample stamped `v0.0` keeps its own verdict (`PASS`) under v0.1 bytes that would be `UNKNOWN`; a body stamped `v0.2` exists but is deliberately unregistered, and a judge that always applies the newest text fails the selftest.

`analyze_only`. `synthetic`. Stdlib only. No credentials, no network I/O: every listener state is a row.
