# daily_grid_boundary_mismatch (v0.1)

Cross-source daily-grid boundary fixture: same symbol (BTC), same bar size (1D),
**different day boundaries** — OKX aligns 1D to 16:00 UTC, Binance to 00:00 UTC.

## Files
- `okx_btc_1d_30.csv` / `binance_btc_1d_30.csv` — 30 bars each, columns:
  `ts_open_utc,open,high,low,close,close_time_utc,source,day_boundary_utc` (no volume)
- `fail_case/okx_declared_00_actual_16.csv` — **must-fail case**: declares the same
  boundary (00:00) as Binance but its actual timestamps are 16:00-aligned. An engine
  that computes per-bar diffs here is broken.
- `expected.json` — expected verdicts (closed set: `COMPARABLE / NOT_COMPARABLE /
  EXCLUDED_FUTURE_BAR / UNDEFINED_BY_EMPTY_INPUT`).

## Rules under test
1. Declared `day_boundary_utc` must be validated against `ts_open_utc mod 86400000`.
2. Different boundaries -> `NOT_COMPARABLE`; resample to a common grid, alignment
   accepted only if residual == 0.
3. `close_time_utc > as_of` -> bar excluded from the denominator (`EXCLUDED_FUTURE_BAR`),
   report "processed N (expected M)".
4. Empty input -> `UNDEFINED_BY_EMPTY_INPUT` with a source, never silent zero-diff.

Origin: real-world incident — 1199 pure-grid-diff bars over 3.28 years from mixing
OKX 16:00-UTC and Binance 00:00-UTC daily bars of the same symbols.

Data: public exchange APIs, snapshot taken at fixture creation; observation-only,
no positions. Non-advice.
