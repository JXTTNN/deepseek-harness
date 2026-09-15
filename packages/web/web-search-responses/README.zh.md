# @deepseek-ai/dsh-web-search-responses

[English](README.md) | 中文

由 OpenAI 兼容的 **Responses API**（`POST /responses`）+ 服务器端 `web_search` 工具支持的 `WebSearchProvider`。网关在服务器端执行真实联网搜索，返回生成的答案和它访问过的页面，映射为 seam 规范化的 `WebSearchResult`（`content` + `sources`）。

这正是让**自定义模型网关**（任何支持 Responses 格式 + `web_search` 工具的 OpenAI 兼容中继，例如 `https://your-gateway/v1`）驱动 harness `web_search` 工具获得真实联网能力的方式：无需官方 DeepSeek 密钥，无需自托管 SearXNG，也无需付费的 Perplexity/Exa 订阅。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$RESPONSES_API_KEY` 再 `$DEEPSEEK_API_KEY` | 网关 API 密钥。为空或缺失时提供方不可用。 |
| `baseURL` | `$RESPONSES_BASE_URL` 再 `$DEEPSEEK_BASE_URL` 再 `https://api.deepseek.com/v1` | 端点基址；追加 `/responses`。无法解析时提供方不可用。 |
| `model` | `$RESPONSES_MODEL` 再 `deepseek-v4-flash` | Responses 请求发送的模型名。 |
| `maxTokens` | `4096` | 生成 token 上限（`max_output_tokens`）。必须是正整数。 |

```yaml
- id: web-search-responses
  name: '@deepseek-ai/dsh-web-search-responses'
  config:
    baseURL: https://your-gateway/v1
    apiKey: !!js process.env.RESPONSES_API_KEY
```

要让它成为生效的搜索后端，还需把 web seam 的 `searchProvider` 设为 `responses`。

## 映射

Responses API 返回带类型的 `output[]`。每个 `web_search_call` 项中 action 为 `open_page` 的 URL（剥掉网关的 `#ws_call_id=…` 跟踪片段）贡献一个 `WebSearchSource`；重复 URL 去重。`message` 项的文本块拼接为 `content`（生成的答案）。只有 `search` 的调用不带 URL，被跳过。当响应既没有访问过的页面也没有答案文本时，提供方以 `WEB_PROVIDER_ERROR` 失败（端点很可能不支持 `web_search` 工具）。提供方失败（HTTP 错误、网络失败、响应体无法解析）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向被拒绝并以 `WEB_PROVIDER_ERROR` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL 和生成的答案，或将确切的错误消息置于消费方的错误包装层内。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **来源只带 URL**：Responses 的 `web_search_call` 项不暴露每页的标题或摘要，因此 `title`／`snippet` 保持未设置（工具渲染 `title ?? hostname(url)`）。
- **只公开 `model`／`maxTokens`**：Responses API 的其他控制项（`search_context_size`、`user_location`、推理力度）等待提供方无关的 Service Definition 字段。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`。
