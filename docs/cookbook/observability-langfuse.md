# LLM Observability with Langfuse

English | [中文](observability-langfuse.zh.md)

The harness emits OpenTelemetry session telemetry through `@deepseek-ai/dsh-session-telemetry-otel` (mounted in the base bundle). Langfuse self-hosts OTLP-compatible ingestion, so a deployment gets token accounting, latency histograms, and per-request traces with no code change: point the exporter at Langfuse's OTel endpoint.

## Why this pairing

| Concern | Langfuse self-hosted | SaaS OTel bridges |
| --- | --- | --- |
| Cost | MIT, self-host-able on one VM [1] | Usually paid (Braintrust, LangSmith) |
| Format | OTLP (gRPC + HTTP), native DNS-side | some require custom exporters |
| Manual spans | JS SDK `langfuse-core` is separately usable [2] | n/a inside harness deltas |

The session projection tables (sessions, messages, turns, steps, tokens) stay local/persistent in `session-persistence-sqlite` regardless of tracing; tracing is observability, not the source of truth.

## Compose it

Set the exporter endpoint to your Langfuse instance's OTel route:

```sh
export DSH_OTEL_EXPORTER_OTLP_BASE_URL=http://localhost:3000
export DSH_OTEL_EXPORTER_OTLP_HEADERS="$DSH_CRED_LANGFUSE_DISPLAYPUBLICKEY:$DSH_CRED_LANGFUSE_DISPLAYSECRETKEY"
```

(The exact token header shape follows your langfuse deployment; consult [3].)

`dsh web` then streams session events: the UI's trajectory panel shows agent turns as spans, and Langfuse's dashboard aggregates latency by provider/model/route — useful when a shared gateway (for example the fork's `DSH_BASE_URL`) throttles a key; spot 429-driven retries without reading logs.

## Self-host checklist

1. Launch Langfuse with the official self-host compose (PostgreSQL + ClickHouse + Redis).
2. Create a project and generate credentials (`langfuse init` / UI) — belongs to the same security border as your LLM API keys.
3. Point the OTLP base URL and headers at it as above; restart the web shell (config is read once at boot).
4. Optional: enable remote routing checks against a synthetic prompt (10 tok) to prove the trace chain end-to-end.

## References

[1] <https://github.com/langfuse/langfuse> (self-host docs)
[2] <https://js.langfuse.com/docs> (`langfuse-core` npm)
[3] <https://langfuse.com/docs/ocicl-sdk/rest-endpoints>
