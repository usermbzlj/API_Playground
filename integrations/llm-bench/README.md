# llm-bench integration

Source: https://github.com/usermbzlj/llm-bench, commit `480148e3cf772b73b22a4c89e7474e3114c150f3`, fetched 2026-10-24. Upstream project metadata declares MIT. `upstream/` preserves the original Python engine, GUI, CLI, tests and evidence fixtures. The GUI's optional dependencies remain documented in its original `pyproject.toml`.

`bridge.py` calls the original `run_benchmark` / `build_stats_dict` functions. Node owns connection credentials, validation, persistence and API lifecycle. The bridge receives one JSON configuration line on stdin, and subsequent `cancel` lines request cancellation. It emits JSON lines containing progress, stages and completion; credentials are absent from process arguments, report files and exports. Its HTTP transport pins the validated destination address, preserves TLS hostname verification, refuses redirects, and bounds each response and overall request count. Prompt rotation for Responses is adapted at the request boundary; scheduling, retries and statistics remain upstream code.

Install the headless environment from the repository root:

```powershell
uv venv integrations/llm-bench/.venv
uv pip install --python integrations/llm-bench/.venv/Scripts/python.exe -r integrations/llm-bench/requirements.txt
```

On Unix use `.venv/bin/python`. A working Python 3.11+ with `httpx[http2]` also works; `LLM_BENCH_PYTHON` can select an interpreter. Runtime discovery never downloads dependencies during a benchmark. `python bridge.py --probe` verifies runtime availability. Tests use local deterministic HTTP mocks only.

The web API supports total, duration, fixed RPS and concurrency sweep modes, warmup, retries, streaming, HTTP/2, weighted prompt rotation, custom JSON bodies and Chat/Responses endpoints. Server restart marks active history `interrupted`; it never silently restarts billable work. Cancellation stores the latest partial statistics and completed stages, terminates outstanding requests, and falls back to killing an unresponsive child. Duration/RPS runs also have a hard logical request ceiling of 10,000 across sweep stages; warmup is separately bounded. No benchmark starts without explicit cost confirmation. Local inference targets are allowed; cloud metadata/link-local/multicast/unspecified destinations are blocked. Configured proxies receive a pinned target address and the original Host/SNI.

Reports keep every per-request numeric result plus full aggregate timing percentiles and timeline. To keep reports bounded, the first 32 rows also preserve structured `request_body` for replay and up to 4000 response characters; first 500 rows preserve a 1000-character output excerpt, and per-row ITL lists keep the first 16 values. The original aggregate statistics use the full ITL sample. Structured credential fields and known connection secrets are removed before report persistence. The bridge additionally treats explicit HTTP-200 vendor errors, failed/incomplete Responses SSE and heartbeat-only streams as failures. Its 4 MiB response limit applies after decompression.

`tests/localhost-cert.pem` and `localhost-key.pem` are public, local-only test fixtures; they have no production use. Integration tests verify TLS hostname/SNI handling and reject hostname mismatch with certificate verification enabled.
