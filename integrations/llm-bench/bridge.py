"""JSON-lines, stdin-only credential bridge to the preserved upstream runner."""
from __future__ import annotations

import asyncio
import dataclasses
import ipaddress
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "upstream"))
import httpx
from llm_bench import runner
from llm_bench.models import build_stats_dict, BenchSummary, ErrorKind


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def safe_ip(value):
    address = ipaddress.ip_address(value)
    address = getattr(address, "ipv4_mapped", None) or address
    return not (address.is_link_local or address.is_multicast or address.is_unspecified
                or str(address) in {"100.100.100.200", "fd00:ec2::254"})


def protocol_failure(data):
    if not isinstance(data, dict):
        return None
    kind = data.get("type")
    response = data.get("response") if isinstance(data.get("response"), dict) else {}
    if data.get("error") or kind in {"error", "response.failed", "response.incomplete"} or data.get("status") in {"failed", "incomplete"} or response.get("status") in {"failed", "incomplete"} or response.get("error"):
        return json.dumps(data.get("error") or response.get("error") or data,
                          ensure_ascii=False)[:500]
    return None


def has_model_output(data):
    """Usage or an arbitrary JSON object alone is not a model result."""
    if not isinstance(data, dict):
        return False
    if any(isinstance(data.get(k), str) and data[k].strip()
           for k in ("text", "output_text", "refusal", "reasoning_content")):
        return True
    if data.get("tool_calls") or data.get("function_call"):
        return True
    if data.get("type") in {"function_call", "tool_call", "computer_call", "web_search_call"}:
        return True
    content = data.get("content")
    if isinstance(content, str) and content.strip():
        return True
    if isinstance(content, list) and any(has_model_output(x) for x in content):
        return True
    return any(has_model_output(x) for key in ("choices", "output")
               for x in (data.get(key) or []) if isinstance(x, dict)) or has_model_output(data.get("message"))


class BoundedStream(httpx.AsyncByteStream):
    def __init__(self, response, content_type, status, responses=False):
        self.response = response
        self.sse = "text/event-stream" in content_type
        self.check = 200 <= status < 300
        self.responses = responses

    async def __aiter__(self):
        size = 0
        pieces = []
        pending = b""
        terminal = False

        def check_line(line):
            nonlocal terminal
            if line.strip().startswith(b"data:"):
                payload = line.strip()[5:].strip()
                if payload == b"[DONE]":
                    if not self.responses:
                        terminal = True
                    return
                try:
                    data = json.loads(payload)
                    failure = protocol_failure(data)
                    if failure:
                        raise httpx.ReadError("api_protocol_error: " + failure)
                    if isinstance(data, dict):
                        if self.responses:
                            terminal = terminal or data.get("type") == "response.completed"
                        else:
                            terminal = terminal or any(isinstance(c, dict) and c.get("finish_reason") is not None
                                                       for c in (data.get("choices") or []))
                except (ValueError, UnicodeDecodeError):
                    pass

        # Bound decoded bytes too: a small compressed response can otherwise expand
        # past the memory limit after the transport returns it to the runner.
        async for chunk in self.response.aiter_bytes():
            size += len(chunk)
            if size > 4 * 1024 * 1024:
                raise httpx.ReadError("Benchmark response exceeds 4 MiB limit")
            if self.check:
                if self.sse:
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        check_line(line)
                else:
                    pieces.append(chunk)
            yield chunk
        if self.check and self.sse and pending:
            check_line(pending)
        if self.check and self.sse and not terminal:
            raise httpx.ReadError("api_protocol_error: stream ended before its completion event; partial output is not a successful result")
        if self.check and not self.sse:
            try:
                data = json.loads(b"".join(pieces))
                failure = protocol_failure(data)
                if failure:
                    raise httpx.ReadError("api_protocol_error: " + failure)
                if not has_model_output(data):
                    raise httpx.ReadError("api_protocol_error: response contains no model output or tool call")
            except (ValueError, UnicodeDecodeError):
                pass

    async def aclose(self):
        await self.response.aclose()


class PinnedTransport(httpx.AsyncBaseTransport):
    """Pin both direct and proxy destinations; TLS keeps the original hostname."""
    def __init__(self, payload):
        self.origin = httpx.URL(payload["url"])
        self.address = payload["addresses"][0]
        if not safe_ip(self.address):
            raise ValueError("Forbidden destination address")
        self.responses = payload["config"].get("endpoint") == "responses"
        self.attempts = 0
        self.budget_exhausted = False
        self.max_attempts = payload["maxAttempts"]
        self.transport = httpx.AsyncHTTPTransport(
            proxy=payload.get("proxy"), http2=payload["config"].get("http2", False),
            retries=0, limits=runner.limits_for_concurrency(max(payload["concurrencies"])))

    async def handle_async_request(self, request):
        if (request.url.scheme, request.url.host, request.url.port) != (
                self.origin.scheme, self.origin.host, self.origin.port):
            raise httpx.RequestError("Cross-origin benchmark request refused")
        if self.attempts >= self.max_attempts:
            self.budget_exhausted = True
            raise httpx.RequestError("Hard HTTP attempt budget reached")
        self.attempts += 1
        body = await request.aread()
        if self.responses:
            data = json.loads(body)
            messages = data.pop("messages", None)
            if messages:
                data["input"] = next((m.get("content", "") for m in messages
                                      if isinstance(m, dict) and m.get("role") == "user"), data.get("input", ""))
            body = json.dumps(data, ensure_ascii=False).encode()
        headers = dict(request.headers)
        headers["host"] = self.origin.netloc.decode()
        headers.pop("content-length", None)
        pinned = httpx.Request(request.method, request.url.copy_with(host=self.address),
                               headers=headers, content=body,
                               extensions={**request.extensions, "sni_hostname": self.origin.host})
        response = await self.transport.handle_async_request(pinned)
        # Follow redirects is disabled in the client. Reject them explicitly, including same-origin.
        if 300 <= response.status_code < 400:
            await response.aclose()
            raise httpx.RequestError("Benchmark redirects refused to protect credentials")
        response_headers = dict(response.headers)
        response_headers.pop("content-encoding", None)
        response_headers.pop("content-length", None)
        return httpx.Response(response.status_code, headers=response_headers,
            extensions=response.extensions,
            stream=BoundedStream(response, response.headers.get("content-type", ""), response.status_code, self.responses))

    async def aclose(self):
        await self.transport.aclose()


def install_responses_adapter():
    original_usage = runner._extract_usage
    original_sse = runner._sse_process_line
    original_body = runner._body_for_index

    def body_for_index(*args, **kwargs):
        body = original_body(*args, **kwargs)
        messages = body.pop("messages", None)
        if messages:
            body["input"] = next((m.get("content", "") for m in messages
                                  if isinstance(m, dict) and m.get("role") == "user"), body.get("input", ""))
        return body

    def usage(data):
        data = dict(data)
        u = dict(data.get("usage") or {})
        u.setdefault("prompt_tokens", u.get("input_tokens"))
        u.setdefault("completion_tokens", u.get("output_tokens"))
        data["usage"] = u
        return original_usage(data)

    def sse(line, **kwargs):
        if line.strip().startswith("data:"):
            try:
                data = json.loads(line.strip()[5:].strip())
                kind = data.get("type", "")
                if kind == "response.output_text.delta":
                    line = "data: " + json.dumps({"choices": [{"delta": {"content": data.get("delta", "")}}]})
                elif kind == "response.completed":
                    u = data.get("response", {}).get("usage", {})
                    line = "data: " + json.dumps({"usage": {"prompt_tokens": u.get("input_tokens"),
                        "completion_tokens": u.get("output_tokens"), "total_tokens": u.get("total_tokens")}})
            except (ValueError, AttributeError):
                pass
        return original_sse(line, **kwargs)

    runner._extract_usage = usage
    runner._sse_process_line = sse
    runner._body_for_index = body_for_index


def install_protocol_guard():
    original = runner.one_chat_request

    async def guarded(*args, **kwargs):
        result = await original(*args, **kwargs)
        if result.error and "api_protocol_error:" in result.error:
            result.error_kind = ErrorKind.OTHER
        # A heartbeat-only SSE is a live transport, but produced no model result.
        if result.ok and kwargs.get("stream") and not result.response_text and not result.completion_tokens:
            raw = result.raw_response_text or ""
            if not any(marker in raw for marker in ('"tool_calls"', '"function_call"', '"function_call_arguments"')):
                result.ok = False
                result.error = "api_protocol_error: stream ended without model output or tool call"
                result.error_kind = ErrorKind.PARSE
        return result

    runner.one_chat_request = guarded


async def run(payload):
    cfg = payload["config"]
    install_protocol_guard()
    stop = threading.Event()
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()

    def commands():
        for line in sys.stdin:
            if line.strip() == "cancel":
                stop.set()
                loop.call_soon_threadsafe(task.cancel)
                return
        # Parent exit closes stdin. Never leave a billable orphan behind.
        stop.set()
        loop.call_soon_threadsafe(task.cancel)

    threading.Thread(target=commands, daemon=True).start()
    if cfg.get("endpoint") == "responses":
        install_responses_adapter()
    stages = []
    latest = None
    total = 0
    transport = PinnedTransport(payload)
    started = time.perf_counter()
    raw = []
    stage_started = started
    current_summary = BenchSummary()
    monitor_task = None
    concurrency = payload["concurrencies"][0]
    stage_start_attempts = 0

    def stage_stats(summary):
        stats = build_stats_dict(summary)
        stats["http_attempts_including_warmup"] = transport.attempts - stage_start_attempts
        return stats

    def rows():
        result = []
        for index, item in enumerate(raw):
            row = dataclasses.asdict(item)
            # Preserve exact replayable wire bodies for a bounded sample. The parent
            # structurally redacts credential fields before any persistence/export.
            request = row.pop("raw_request_body", None)
            if index < 32 and request:
                try:
                    row["request_body"] = json.loads(request)
                except ValueError:
                    pass
            if index < 32:
                row["raw_response_text"] = (row.get("raw_response_text") or "")[:4000]
            else:
                row.pop("raw_response_text", None)
            row["response_text"] = (row.get("response_text") or "")[:1000] if index < 500 else ""
            row["error"] = (row.get("error") or "")[:500]
            row["itl_ms"] = row.get("itl_ms", [])[:16]
            result.append(row)
        return result

    try:
        async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False) as client:
            for index, concurrency in enumerate(payload["concurrencies"]):
                raw = []
                stage_started = time.perf_counter()
                current_summary = BenchSummary()
                stage_start_attempts = transport.attempts
                last_emit = 0.0

                def publish(force=False):
                    nonlocal latest, last_emit
                    if not force and time.perf_counter() - last_emit < 0.5:
                        return
                    summary = current_summary
                    summary.wall_seconds = time.perf_counter() - (summary.wall_t0 or stage_started)
                    stats = stage_stats(summary)
                    latest = {"stage": index + 1, "stages": len(payload["concurrencies"]),
                              "concurrency": concurrency, "stats": stats,
                              "elapsedSeconds": time.perf_counter() - started,
                              "message": f"已完成 {summary.total} 个逻辑请求；含预热共发出 {transport.attempts} 次 HTTP 尝试。"}
                    emit({"type": "progress", "progress": latest})
                    last_emit = time.perf_counter()

                def progress(summary):
                    nonlocal current_summary
                    current_summary = summary
                    publish()

                async def monitor():
                    while True:
                        publish(force=True)
                        await asyncio.sleep(1)

                monitor_task = asyncio.create_task(monitor())

                budget_reached = False

                def should_stop():
                    nonlocal budget_reached
                    # Reserve space for currently in-flight logical requests. This
                    # deliberately stops slightly early rather than exceeding the cap.
                    budget_reached = (cfg["mode"] in ("duration", "rps") and total + len(raw) + concurrency > payload["maxRequests"]) or transport.budget_exhausted
                    return stop.is_set() or budget_reached

                summary = await runner.run_benchmark(
                    url=payload["url"], headers=payload["headers"], body_template=payload["body"],
                    concurrency=concurrency,
                    total_requests=cfg["totalRequests"] if cfg["mode"] in ("total", "sweep") else None,
                    duration_s=cfg["durationSeconds"] if cfg["mode"] == "duration" else None,
                    target_rps=cfg["targetRps"] if cfg["mode"] == "rps" else None,
                    rps_duration_s=cfg["durationSeconds"] if cfg["mode"] == "rps" else None,
                    stream=cfg["stream"], timeout_s=cfg["timeoutSeconds"], http2=cfg["http2"],
                    warmup_requests=cfg["warmup"], timeline_bucket_s=1.0,
                    prompts=cfg["prompts"], prompt_strategy=cfg["promptStrategy"],
                    prompt_weights=cfg.get("promptWeights"), retry_on_429=cfg["retries429"],
                    retry_on_network=cfg["retriesNetwork"], retry_on_5xx=cfg["retries5xx"],
                    progress_callback=progress, raw_results=raw, shared_client=client,
                    should_stop=should_stop,
                )
                monitor_task.cancel()
                await asyncio.gather(monitor_task, return_exceptions=True)
                monitor_task = None
                total += summary.total
                stage = {"concurrency": concurrency, "stats": stage_stats(summary), "results": rows()}
                stages.append(stage)
                emit({"type": "stage", "stage": stage})
                if stop.is_set() or budget_reached:
                    break
        emit({"type": "done", "cancelled": stop.is_set(), "budgetReached":
              budget_reached})
    except asyncio.CancelledError:
        if current_summary is not None:
            current_summary.wall_seconds = time.perf_counter() - (current_summary.wall_t0 or stage_started)
            emit({"type": "stage", "stage": {"concurrency": concurrency,
                  "stats": stage_stats(current_summary), "results": rows()}})
        emit({"type": "done", "cancelled": True})
    finally:
        if monitor_task is not None:
            monitor_task.cancel()
            await asyncio.gather(monitor_task, return_exceptions=True)


if __name__ == "__main__":
    try:
        if "--probe" in sys.argv:
            if sys.version_info < (3, 11):
                raise RuntimeError("Python 3.11+ is required")
            import h2  # optional httpx dependency, required when users enable HTTP/2
            emit({"available": True, "engine": "llm-bench", "version": "0.3.0", "python": sys.version.split()[0]})
        else:
            payload = json.loads(sys.stdin.readline())
            asyncio.run(run(payload))
    except Exception as exc:
        # Parent redacts any reflected credentials before persistence or UI delivery.
        emit({"type": "error", "error": str(exc)[:2000]})
        sys.exit(1)
