# team-comm 团队协作层 — 漏洞审查与增强报告

> 审查对象：`packages/team/team-comm/src/index.ts`（team 模式跨会话协作的全部工具实现）。
> 编译产物：`packages/team/team-comm/lib/index.js`（运行时经 pnpm workspace 链接加载）。
> 结论：修复了 8 类缺陷，新增 3 个协作工具 + 2 项机制扩展，全部通过类型检查与 24 项冒烟测试。

---

## 一、审查发现的漏洞 / 缺陷（含修复状态）

| # | 缺陷 | 影响 | 处理 |
|---|------|------|------|
| 1 | **跨进程写丢失**：`inboxLocks` 仅为进程内 `Map`，`lockedAppend/lockedUpdate/team_inbox` 的读-改-写在多 server 进程共享同一 cwd 时可能互相覆盖，静默丢消息/丢任务 | 高（数据丢失） | ✅ 新增 `withFileLock`：`.lock` 原子排他文件 + 陈旧锁打破 + 超时，叠加进程内锁，覆盖所有读-改-写路径 |
| 2 | **think() 无锁**：共享 `think.log` 的读-改-写未加任何锁，并发 peer 互相覆盖丢条目 | 中 | ✅ 包裹进 `withFileLock` |
| 3 | **writeJsonl 在 Windows 上非健壮**：`renameSync` 覆盖已存在目标时可能瞬时 `EPERM/EBUSY/EEXIST`；无 fsync、无父目录 `mkdir`、无重试，可能让工具调用崩溃或残留 `.tmp` | 中 | ✅ 新增 fsync + 5 次重试 + 兜底直写 + 父目录 mkdir |
| 4 | **team_send 输出 schema 不一致**：`execute` 返回 `error`/`duplicate` 字段，但 schema 声明 `additionalProperties:false` 且未声明这俩字段（契约漂移） | 低 | ✅ schema 补齐 `duplicate`/`error`，render 区分三种结果 |
| 5 | **team_review 未闭环**：`reviews.jsonl` 写入评审请求，但没有工具能收集回 verdict，评审结果只能靠人工读收件箱 | 中 | ✅ 新增 `team_review_collect` |
| 6 | **team_task 无优先级/截止时间、无指派通知**：带 assignee 创建任务不通知被指派者；claim/完成不通知创建者，任务可能被"静默孤儿化" | 中 | ✅ 新增 `priority`/`deadline` 字段 + create/claim/terminal 三类自动通知 |
| 7 | **无团队健康快照**：只能分别调用 team_list + team_inbox + team_task(list)，无法一眼看到存活、未读、挂起广播/评审、任务分布 | 低 | ✅ 新增 `team_status` |
| 8 | **PRESENCE_STALE_MS 过短（5 分钟）**：空闲等待回复的 peer 会被判过期并从 team_list 消失 | 低 | ✅ 放宽到 15 分钟 |
| 9 | **session_delete 可删自身**：运行中会话可被自己删除（危险）；zstd 兜底仅按目录名匹配 | 中 | ✅ 增加自删拒绝守卫 |
| 10 | **无扇入屏障**：无"等待 N 个 peer 到达再继续"的相位同步原语 | 低 | ✅ 新增 `team_barrier` |
| 11 | triggerSession 端口硬编码 `DSH_PORT ?? 8300`，若服务跑在其他端口则唤醒失败（best-effort） | 低 | ⚠️ 记录，未改（唤醒本就是尽力而为，非正确性依赖） |

**安全**：路径穿越防护已具备且经测试仍有效（`assertSafeTeamId` 阻断 `/ \ . .. NUL`，冒烟测试 #11 验证 `../evil` 被拒）。

---

## 二、参考 GitHub 优秀案例引入的机制映射

| 来源框架 | 借鉴机制 | 在 team-comm 中的落地 |
|---|---|---|
| [Microsoft AutoGen](https://github.com/microsoft/autogen) | GroupChat / speaker selection / 显式交接 | 只读一次收件箱 + 强制 `reply_to` 线程；coordinator-only 委派协议；`team_barrier` 相位同步 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | supervisor 模式 + checkpoint + send/receive | `team_task` 看板（谁拥有什么/阻塞在什么上）+ `team_memory` 持久决策 + goal 工具跨轮记忆 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | hierarchical 流程（协调者委派→成员汇报） | 协议规则 (3)「仅协调者委派」+ `subagent`/`team_send` 委派与回传 |
| [MetaGPT](https://github.com/geekan/MetaGPT) | 共享消息池 + SOP 流水线 + 角色化 | `.team/inbox/*.jsonl` 共享邮箱 + `think.log` 共享推理 + `team_broadcast/team_collect` map-reduce 并行 |
| [OpenAI Swarm](https://github.com/openai/swarm) | 显式 handoff（控制权转移） | `team_task` assignee + 自动通知 + `reply_to` 线程化 |
| [ChatDev](https://github.com/OpenBMB/ChatDev) | 分阶段瀑布 + 评审关卡 | `team_review` + `team_review_collect` 独立验证 + `team_barrier` 阶段门 |

**核心设计原则**（借鉴 MetaGPT / LangGraph）：以文件系统为唯一事实来源（shared state），所有写路径走「进程内锁 + 跨进程文件锁 + 原子 rename」，所有读路径容忍半写（跳过坏行），保证并发下的最终一致与不丢数据。

---

## 三、本次改动清单（`src/index.ts`）

**机制（健壮性/一致性）**
1. `withFileLock()` — 跨进程 `.lock` 排他锁（`wx` 原子创建 + 陈旧打破 + 超时），叠加进程内 `withInboxLock`。
2. `writeJsonl()` — fsync 临时文件、5 次 rename 重试、兜底直写、父目录 mkdir。
3. `notifyPeer()` — 统一的「投递 + 唤醒」助手。
4. `PRESENCE_STALE_MS` 5min → 15min。

**框架（协作原语）**
5. `team_task` — 新增 `priority`(low/normal/high/urgent) 与 `deadline`(ISO)；create 指派自动通知被指派者；claim 通知创建者；进入 done/blocked 终态通知创建者。
6. `team_send` — 输出 schema 补 `duplicate/error`；写入 `sent.jsonl` 投递台账（幂等，供 status 查询）。

**能力（新增工具）**
7. `team_review_collect` — 按 `reviewId` 收集 verdict（正则解析 `VERDICT:`），报告 pending。
8. `team_status` — 单次健康快照：peer 存活（最近心跳年龄）、未读数、挂起广播/评审数、任务状态分布。
9. `team_barrier` — 命名扇入屏障（`arrive`/`wait`/`reset`），按不同 peer 去重计数。

**守卫**
10. `session_delete` 拒绝删除调用方自身会话。

---

## 四、验证（切实有效）

1. **类型检查**：`node node_modules/typescript/bin/tsc -b packages/team/team-comm` → `EXIT=0`。
2. **构建产物**：tsdown 重新打包 → `lib/index.js`（58531 字节），14 个工具全部注册（grep 逐一确认 `name:` 存在，末尾 `export { apply, inject, name }`）。
3. **冒烟测试**：`team-comm-smoke.mjs` 直接加载编译产物、调用真实 `apply()` + 各工具 `execute()`，在临时目录跑通全链路 —— **24 passed, 0 failed**。覆盖：收发/只读一次/去重/任务(优先级+自动通知)/记忆/广播收集/评审闭环/屏障/健康快照/think 日志/自删守卫/路径穿越阻断/JSONL 落盘。

> 注：运行时 `dsh web`（`apps/cli/lib/bin.js`）通过 pnpm workspace 链接在运行时解析 `@deepseek-ai/dsh-team-comm` → `packages/team/team-comm/lib/index.js`（已在编译产物中确认未内联），故重打包该包即可生效，无需重建 CLI。

---

## 五、协作任务实测发现的缺陷（并已修复）

用「1 协调者 + 3 工人」跑完整协作剧本（发现→任务板→广播→收集→评审→屏障→共享思考日志→汇总）+ 并发压力 + 跨进程争用，实测发现并修复 2 个真实缺陷：

| # | 缺陷 | 实测表现 | 修复 |
|---|------|---------|------|
| 11 | **跨进程锁 `wx` 打开在 Windows 上抛 `EPERM`**（不止 `EEXIST`），原代码只认 `EEXIST`，遇 `EPERM` 直接抛出 → 会话崩溃、丢消息 | 8 进程 × 20 条并发写同一收件箱：**152/160 送达，8 条丢失**，子进程 `EPERM: open sent.jsonl.lock` 崩溃 | `withFileLock` 将 `EEXIST/EPERM/EBUSY/EACCES/ENOTEMPTY` 全部视为可重试争用 + 抖动退避；`sent.jsonl` 台账改为 best-effort（写失败绝不拖垮发送）。复测 **160/160 送达、0 崩溃** |
| 12 | **内容去重误杀合法重复短消息**：`(from,message)` 在最近 10 条内即被吞掉 | 工人两次发 `"OK"`（两次不同任务确认）→ 第二次被静默丢弃，协调者只收到 1 条 | 去重加 **5 秒时间窗**：仅抑制窗口内的意外重复发送，之后的合法重复正常送达。复测：紧邻重复=抑制，5 秒后重复=送达，协调者收到 2 条 |

**最终回归**（修复后全绿）：
- 完整协作剧本 `team-comm-collab.mjs`：**28 passed, 0 failed**
- 跨进程争用 `team-comm-crossproc.mjs`：**160/160，0 丢失、0 崩溃**（连跑 3 次稳定）
- 原冒烟 `team-comm-smoke.mjs`：**29 passed, 0 failed**
- 运行时解析 + 4 步思考 `team-comm-resolve-smoke.mjs`：**all pass**

---

## 六、全面对抗测试补充发现（并已修复）

对全部 14 个工具的错误路径、边界、损坏数据、跨进程共享文件做了对抗测试（`team-comm-full.mjs`，46 项断言 + 共享文件跨进程测试），又发现并修复 4 个缺陷：

| # | 缺陷 | 表现 | 修复 |
|---|------|------|------|
| 13 | **首个 task/memory 操作 ENOENT**：`withFileLock` 在 `.team/` 目录尚未创建时先写锁文件 `tasks.jsonl.lock`，父目录不存在 → `ENOENT` 崩溃（team_task/team_memory 在全新工作区首调用必崩） | 全新 cwd 直接 `team_task create` → `ENOENT: open .team/tasks.jsonl.lock` | `withFileLock` 开头 `mkdirSync(dirname(file))` 确保父目录存在 |
| 14 | **读错误吞掉导致覆盖丢数据**：`readJsonl` 对整文件读错误返回 `[]`，`lockedAppend/lockedUpdate/team_inbox` 随后 `writeJsonl` 用 `[]` 覆盖，把未读到的记录全部抹掉 | 瞬时读失败（AV 锁等）→ 任务/记忆/收件箱被清空 | 新增 `readJsonlStrict`（读错误即抛），三个读-改-写路径改用之，绝不覆盖未读成功的数据 |
| 15 | **任务改派不通知新负责人**：`update` 改 assignee 只通知创建者，新负责人不知道 | 改派后新 assignee 收不到任何消息 | update 检测 assignee 变更，自动 `notifyPeer` 新负责人 |
| 16 | **team_think_read limit 边界错误**：`limit=0` 时 `slice(-0)` 返回全部、负数越界 | `limit:0` 返回整份日志而非 0 条 | limit 夹取到 `[1,200]`，非有限值回退默认 |

**剩余低危观察（未改，记录备查）**：`triggerSession` 端口硬编码 8300；`team_broadcast` 无 peer 时仍写空 outbox；>100KB 消息 `deliverMessage` 抛错而 `team_send` 返回 `{ok:false}`（错误风格不一致，广播/评审会中途抛）；`team_barrier` 的 `expect` 后写覆盖、reset 未加锁（极低频竞态）。

---

## 七、大项目性能与长时保持（本轮实测 + 优化）

**基准发现问题**：`lockedAppend` 每次「读全量 + 全量原子重写」= O(n)，n 次追加 = **O(n²)**；`team_memory set` 同理；`sent.jsonl/outbox.jsonl/reviews.jsonl` 永不裁剪。N=2000 时：任务创建 **12.8s**、发消息 **18.8s**、写记忆 **12.2s** —— 大项目下明显退化。

**优化**（`lockedAppend` 改为 O(1) 追加 + 超阈值摊还裁剪；`team_memory set` 改追加式 + `list` 按 key 取最新；`team_send` 去重只读尾部 10 行；`inboxLocks` 回收；presence 清理损坏 ts/id）：

| 操作 × N | 修复前 | 修复后 | 提速 |
|---|---|---|---|
| team_task create ×2000 | 12.8s | **2.7s** | 4.7× |
| team_send ×2000 | 18.8s | **7.7s** | 2.4× |
| team_memory set ×2000 | 12.2s | **2.6s** | 4.7× |

**线性扩展验证**：任务创建 2000→2.7s，4000→5.2s（≈2×），确认每操作 O(1)、随项目规模线性而非平方增长。

**回归**：修复后 6 套测试全绿（29/28/46 passed + 跨进程 inbox 160/160 + tasks/mem 80/80 + resolve all pass）。
