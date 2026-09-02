# DeepSeek Harness（Team 模式版）安装与使用说明

本仓库是 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的个人分支
（基于 `v0.1.0-rc.7`），额外加入了：

- `packages/team/team-comm`：跨会话团队协作工具集
  （`team_inbox` / `team_send` / `team_list` / `team_memory` / `team_task` /
  `team_review` / `team_barrier` / `team_broadcast` / `team_collect` / `team_status`）。
- 针对**对话丢失 / 消息写丢失**与**对话删除异常**的可靠性修复
  （跨进程文件锁 `withFileLock`、原子写入 `writeJsonl`、安全删除保护等），
  详见 [packages/team/team-comm/REVIEW.md](packages/team/team-comm/REVIEW.md)。
- `packages/github/tool-github`：GitHub 工具集成。
- `apps/cli/config/agent-presets/team/`：Team 模式的 Agent 预设。

> 注意：`dsh` 仍处于 **developer preview**，可能存在破坏性变更（兼容性随时变化）。

---

## 一、环境要求

| 依赖 | 版本要求 |
|------|----------|
| **Node.js** | `^22.19.0` 或 `>=24.0.0`（推荐 24.x） |
| **pnpm** | `11.x`（仓库在 `packageManager` 中锁定 `pnpm@11.7.0`） |
| **git** | 任意较新版本 |
| **操作系统** | Windows / macOS / Linux 均可（仓库自带 Windows 专用补丁） |

查看你的 Node 版本：

```sh
node --version      # 应为 v22.19+ 或 v24+
```

### 安装 / 启用 pnpm（推荐用 Corepack）

```sh
# 启用 corepack
corepack enable

# 使用仓库锁定的 pnpm 版本
corepack prepare pnpm@11.7.0 --activate

# 验证
pnpm --version      # 11.x
```

> PowerShell 下如提示“禁止运行脚本(pnpm.ps1)”，请先执行一次：
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，然后重新打开终端。

---

## 二、克隆 + 安装依赖

```sh
# 克隆你自己的私有仓库
git clone https://github.com/JXTTNN/deepseek-harness.git
cd deepseek-harness

# 用 pnpm 安装全部依赖（含 vendor/ 工作区）
pnpm install
```

> 安装耗时较长（数百个包）。如遇网络问题可设置镜像：
> `pnpm config set registry https://registry.npmmirror.com`

---

## 三、构建源码

`dsh` 运行需要先把 `src/` 编译到 `lib/`：

```sh
pnpm run build
```

该命令会：
1. 编译 host/client 两套库（`tsc` + `tsdown`）；
2. 构建 Web 前端（`apps/web`）。

> 若仅需命令行/库，可用 `pnpm run build:lib`。

---

## 四、运行

### 4.1 启动 Web UI（推荐）

```sh
pnpm dsh web
```

默认地址：**http://127.0.0.1:3080**

启动后浏览器打开上述地址即可使用图形界面。

### 4.2 纯命令行

```sh
pnpm dsh
```

---

## 五、使用 Team 模式

Team 模式让多个**独立会话**在共享工作区（默认 `.team/` 目录）中协作，工具包括：

- **`team_inbox`** — 每轮开始时读取发给本会话的新消息（`msgId` 去重）。
- **`team_send`** — 给指定 peer 会话发消息，可用 `reply_to` 串连对话。
- **`team_list`** — 发现当前存活的 peer 会话。
- **`team_memory`** — 跨会话持久化关键事实/决策（`.team/memory.jsonl`）。
- **`team_task`** — 共享任务看板（`.team/tasks.jsonl`，含优先级/截止/指派通知）。
- **`team_review` / `team_review_collect`** — 独立评审与结果收集。
- **`team_broadcast` / `team_collect`** — 广播派发与聚集回收。
- **`team_barrier`** — 多 peer 相位同步。
- **`team_status`** — 一键团队健康快照。

启用示例：使用 Team 模式的 Agent 预设

```sh
pnpm dsh --preset team web
# 或直接以团队预设构建/启动你的 agent
```

> 预设文件：`apps/cli/config/agent-presets/team/preset.yml` 与 `agent.cordis.yml`。

Team 会话的运行时数据（presence、inbox、tasks、memory、review）全部落在
工作区 `.team/` 目录下，并被 `.gitignore` 忽略（不会污染源码仓库）。

---

## 六、关于“对话丢失 / 删除异常”修复

原始实现存在跨进程并发写导致的**消息/对话丢失**（及删除竞态）。本分支在
`packages/team/team-comm/src/index.ts` 中修复，关键机制：

| 缺陷 | 修复 |
|------|------|
| 跨进程写互相覆盖 → 静默丢消息 | 新增 `withFileLock()`：`.lock` 原子排他文件锁 + 陈旧锁清理 + 超时，叠加进程内锁 |
| `think.log` 并发无锁 → 丢条目 | 接入同一把 `withFileLock` |
| `writeJsonl` 在 Windows 上非健壮（rename 可能 `EPERM/EBUSY/EEXIST`） | 新增 `fsync` + 5 次重试 + 兜底直写 + 父目录 `mkdir` |
| `team_send` 输出 schema 与 `execute` 返回值不一致 | 补齐 `duplicate`/`error` 字段 |
| `session_delete` 可误删自身 | 增加自删拒绝守卫 |
| 空转 peer 过早被判离线 | `PRESENCE_STALE_MS` 从 5 分钟放宽到 15 分钟 |

详见 [packages/team/team-comm/REVIEW.md](packages/team/team-comm/REVIEW.md)。

---

## 七、常见问题排查

| 现象 | 处理 |
|------|------|
| `pnpm.ps1` 无法加载 | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重开终端 |
| `pnpm install` 网络慢/失败 | 换源 `pnpm config set registry https://registry.npmmirror.com` |
| 构建报 Node 版本不符 | 升级/切换 Node 到 `v24`（如用 `nvm use 24`） |
| 端口被占用 | `pnpm dsh web` 前设 `DSH_PORT` 环境变量换端口 |
| 想恢复成上游原版 | 与 `deepseek-ai/deepseek-harness` 官方代码对比即可 |

---

## 八、许可证

沿用上游 **MIT**（见仓库 `LICENSE`）。Team 模式扩展包（`packages/team`、`packages/github`）同样以 MIT 授权。