# REQUEST_REPLAY v0.1

Synthetic nonce-replay fixture. Closed verdict set: `PASS`, `REQUEST_REPLAY`. Columns: `nonce`, `seen_before` (bool), `expected_verdict`. Every judged row carries `spec_version` and `criteria_digest` (sha256 of the canonical criteria body for that spec version). A row is judged only by the body it stamps.

Run: `python3 request_replay_v0_1.py` (exit 0). Rows live in `expected.json`. The receipt is sha256 of the raw bytes of `run_out_v0_1.json`.

| arm | nonce | seen_before | expected_verdict |
| --- | --- | --- | --- |
| positive r1..r4 | `n-0001` .. `n-0004`, each unique | false | PASS |
| negative | `n-0002` replayed after r1..r4 | true | REQUEST_REPLAY |
| boundary | `n-0005`, well-formed and never seen | false | PASS |

The pinned naive baseline returns PASS for any well-formed nonce and ignores `seen_before`. On the negative arm it returns PASS, so that arm must fail the naive baseline. The boundary arm is well-formed and stays PASS.
