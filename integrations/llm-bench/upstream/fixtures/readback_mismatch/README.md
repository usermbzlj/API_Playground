# READBACK_MISMATCH v0.1

Synthetic read-back fixture. Closed verdict set: `PASS`, `READBACK_MISMATCH`. `expected_verdict` is its own field. Every judged row carries `spec_version` and `criteria_digest` (sha256 of the canonical criteria body for that spec version). A row is judged only by the body it stamps.

Run: `python3 readback_mismatch_v0_1.py` (exit 0). Rows live in `expected.json`. The receipt is sha256 of the raw bytes of `run_out_v0_1.json`.

| arm | condition | expected_verdict |
| --- | --- | --- |
| positive | written value `w` equals read-back value `r` | PASS |
| negative | truncated write, in-memory hash `h_mem` differs from on-disk hash `h_disk` | READBACK_MISMATCH |

The pinned naive baseline treats `write_ok` as PASS and does not compare the read-back. On the negative arm it returns PASS, so that arm must fail the naive baseline.
