# 用 Langfuse 做 LLM 可观测性

[English](observability-langfuse.md) | 中文

Harness 自研 `@deepseek-ai/dsh-session-telemetry-otel`（已在 base bundle 里挂载）以 OpenTelemetry 形态上报会话遥测。Langfuse 自托管自带 OTLP 接收，因此不是改代码：把 导出器指向 Langfuse 的 OTel 路由即可获得 token 使用量、延迟直方图和逐请求的 trace。

## 为什么这套配对

| 关注点 | Langfuse 自托管 | SaaS OTel 桥 |
| --- | --- | --- |
| 成本 | MIT，单 VM 可起 [1] | 多要付费（Braintrust、LangSmith） |
| 格式 | OTLP（gRPC 和 HTTP）,原生 DNS 边 | 写死定制导出器 |
| 手动 span | 可以另接 langfuse-core 用到 JS SDK [2] | 伀内都放在 harness 不传 |

session 投影表永远留在本地并持久的 (`session-persistence-sqlite`)，tracing 只做观测不是 source of truth。

## 接入步骤（镜像）

将 OTLP 出口指向 Langfuse：

```sh
export DSH_OTEL_EXPORTER_OTLP_BASE_URL=http://localhost:3000
export DSH_OTEL_EXPORTER_OTLP_HEADERS="$DSH_CRED_LANGFUSE_DISPLAYPUBLICKEY:$DSH_CRED_LANGFUSE_DISPLAYSECRETKEY"
```

(具体 header 字段名以你部署的 Langfuse 版本为准，见 [3]。)

启动 `dsh web` 后，主要 session 事件流：UI 的 trajectory 面板按 agent turn 展开 span，Langfuse 面板按 provider/model/route 聚合延迟——当某个共享网关（例如本 fork 的 `DSH_BASE_URL`）按 key 限速时，可以不用翻日志直接看 429 重试热点。

## 自托管清单

1. 用官方 self-host compose 起 Langfuse（PostgreSQL + ClickHouse + Redis）。
2. 建项目并生成凭据（`langfuse init`/UI）——与 LLM API key 同级处理。
3. 设置上述 OTLP 环境变量，重启 web shell（配置只启时读一次）。
4. 可选：按 10-token 的 ping 跨端验个来回 trace 链路。

## Applied resources

[1] <https://github.com/langfuse/langfuse> (self-host docs)
[2] <https://js.langfuse.com/docs>（`langfuse-core` npm)
[3] <https://langfuse.com/docs/ocicl-sdk/rest-endpoints>
