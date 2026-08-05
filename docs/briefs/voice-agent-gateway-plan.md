# 语音 → Agent 网关：分阶段开发计划（草案 v1）

> 状态：**草案，待 Conductor 评审**。
> 由 Claude Code（Playground 编排位）代拟于 2026-07-30 —— 原计划由本 workspace 的 Conductor 制定，但连续三次派发均撞上 Anthropic API 500/529 过载（03:45 / 04:00 / 04:40），整轮丢弃。为不阻塞进度，先以调研素材代拟骨架。
> Conductor 恢复后请：① 评审并修订本计划 ② 按 §6 建议正式分配 teammates ③ 覆盖或合并本文件。
> 需求来源：`docs/briefs/voice-agent-gateway-brief.md`
> 调研依据：`/private/tmp/voice-agent-gateway-research.html`、`/private/tmp/home-hybrid-deployment.html`

---

## 1. 一句话目标

家里说一句话 → 简单指令 HA 直接执行，复杂指令本地 4B 模型编排设备，长任务派给 code agent / Cookrew teammate 异步执行 → 完成后音箱播报，中途 agent 有疑问能开口问、人能口头答、同一会话继续。

## 2. 设计前提（调研已确认，不再讨论）

| 前提 | 依据 |
|---|---|
| 社区无成品，但净自建量仅 ~200–400 行 + YAML | HA 论坛 941896（2026-03）确认空白；周边组件均成熟 |
| 不做 PTY / tmux 抓屏或按键注入 | omnara 建过最精巧的 PTY 封装，以「脆弱难维护」弃用改 SDK；claude-code-webui / cui 已归档 |
| 任何工具调用 > 10s 必须 fire-and-forget | Voice PE 有 ~5s TTS 传输计时器 |
| 给本地 4B 只挂 3–5 个工具 | 社区实测：工具过多显著劣化小模型；ha-mcp 的 87 工具是给云端 agent 的 |
| 进度回传走 webhook / SSE，不走 MCP | 官方两个 MCP 集成均不支持 Notifications |
| Claude 会话查找绑 cwd（+其 worktree） | 派活必须固定工作目录；建议每 job 一个 git worktree 沙箱 |
| `AskUserQuestion` 在 `dontAsk` 模式下被直接拒绝 | 「完全锁死的无头配置」与「反问能力」互斥；优先用 `defer` |

## 3. 目标架构

```
语音入口（待定，见 §7-决策1）
  → HA Assist
      ├─ L0 内置意图 → 直接执行（不碰 LLM）
      └─ L1 llama.cpp Qwen3.5-4B（仅 4 个工具）
             dispatch_agent / job_status / cancel_job / answer_agent
             ↓ rest_command（脚本立即返回 job_id + 口头回执）
  ┌─ Agent Gateway ──────────────────────────────────┐
  │  REST: POST /jobs · GET /jobs/{id}                │
  │        POST /jobs/{id}/cancel · /jobs/{id}/answer │
  │  派发目标:                                          │
  │   ① Cookrew teammate（P1，最简单）                  │
  │   ② claude -p --output-format stream-json（P2）    │
  │   ③ codex exec（P2，待核实）                        │
  │  事件源: Cookrew SSE phase / Claude 钩子            │
  │  状态: SQLite (satellite, job) → session_id/nodeId │
  └───────────┬──────────────────────────────────────┘
              ↓ POST HA webhook {job_id,status,message,device_id}
  → 完成: assist_satellite.announce / notify.play_text（小爱播报）
  → 反问: ask_question（受限选项）/ start_conversation + extra_system_prompt
  ⇢ 反向: agent 经 ha-mcp 控家（白名单，与 L1 工具集分离）
```

---

## 4. 分阶段计划

### P0 · 前置与地基（预计 1 天）

**必须先做，否则后面都不稳。**

| 任务 | 内容 | 验收标准 |
|---|---|---|
| P0-1 | **Cookrew API 安全加固**：当前 `0.0.0.0:8639/8643` 无鉴权 + CORS `*`，teammate 以跳过权限确认模式运行 ⇒ 局域网任意设备可驱动全部 agent | 绑 `127.0.0.1`，或保留 LAN 但加共享密钥/Bearer 校验；手机端仍可用；未授权请求返回 401 |
| P0-2 | **宿主机稳定性**：Mac 当前 `sleep=1` 分钟，睡眠即全线下线 | `sudo pmset -c sleep 0 displaysleep 10` 生效；`pmset -g custom` 可验证 |
| P0-3 | **Mosquitto 关匿名**：`allow_anonymous true` 且 1883 对局域网开放 | 账号密码 + ACL 生效，HA 侧 MQTT 集成重连正常，窗帘仍可控 |
| P0-4 | **语音栈落地**：ha-lab compose 平级加 `wyoming-whisper`(small-int8) / `wyoming-piper`(中文音色) / `wyoming-openwakeword` | HA Assist 管线选中三者；手机 Companion App 说「打开飞碟灯」能执行（L0 通路） |
| P0-5 | **L1 本地模型**：`llama-server -hf unsloth/Qwen3.5-4B-GGUF:Q4_K_M --port 8081 --ctx-size 8192 --jinja --host 127.0.0.1` | HA 添加 OpenAI 兼容会话集成指向 `:8081/v1`，设为 Assist 兜底 agent；「准备看电影」能触发多设备联动脚本 |

> 注意 P0-5 的 `--jinja`：Ollama 对 Qwen3.5+/GLM-4.7 的工具调用解析有已知 bug，llama.cpp 是有意选择。

---

### P1 · 最小可用：语音派活给 Cookrew（预计 2–3 天）

**为什么先接 Cookrew 而不是 claude -p**：Cookrew 的 `ask` 是一个同步 HTTP 接口，一行就能派活，是验证整条链路最快的路径。

| 任务 | 内容 | 验收标准 |
|---|---|---|
| P1-1 | 网关骨架：`POST /jobs` `GET /jobs/{id}`，SQLite 任务表 | curl 能建任务、查状态；重启后任务表不丢 |
| P1-2 | Cookrew 派发适配器：`POST :8639/api/terminal/<nodeId>/ask`（同步，2.5s 静默判定 / 120s 超时）；目标不活跃时先 `POST /api/agents/<id>/recover`；节点解析走 `GET /api/agents`（name + workspaceName） | 网关能把一句任务送达指定 teammate 并取回 reply |
| P1-3 | **代理绕过**：本机 `http_proxy=127.0.0.1:7897` 会劫持 localhost 请求返回 502 | 网关所有本地 HTTP 调用显式禁用代理（`NO_PROXY` / `ProxyHandler({})` / `agent:false`），单元测试覆盖 |
| P1-4 | **活动工作区约束处理**：PTY 类接口仅对活动 workspace 生效 | 目标不在活动 workspace 时返回明确错误（而非静默失败）；文档记录此限制；评估是否需要自动切换（有副作用，倾向不自动切） |
| P1-5 | HA 侧：`script.dispatch_agent`（rest_command，立即返回 job_id + 口头回执）+ webhook 自动化 → `assist_satellite.announce` / `notify.play_text` | 语音说「让 Codex 看看 X」→ 3 秒内听到「已派给 Codex」→ 任务完成后小爱播报结论 |
| P1-6 | ASR 文本清洗：派活前用 L1 模型把口语改写成干净 prompt | happy 项目证明此步必要；对比测试显示派活成功率提升 |

**P1 验收（端到端）**：对着语音入口说一句任务 → 听到受理回执 → 数分钟后听到结果播报。**不含反问能力**。

---

### P2 · 反问闭环 + 云端 agent（预计 3–5 天）

本阶段的技术核心是 **`defer`**：Claude Code 的 `PreToolUse` 第四种决策（v2.1.89），进程带着未决工具调用退出，等人答完再 `--resume` 续跑 —— **等用户说话期间不占任何资源**。这是没人为语音实现过的部分。

| 任务 | 内容 | 验收标准 |
|---|---|---|
| P2-1 | claude -p 适配器：`--output-format stream-json --include-partial-messages`，从 `result` 事件捕获 `session_id`（**每轮都变，必须重新捕获**） | 网关可派发一次性云端任务并流式取回文本 |
| P2-2 | **defer 循环**（~100 行，核心）：`PreToolUse` 钩子返回 `defer` → 进程退出并保留 `deferred_tool_use` → 网关播报问题 → 捕获下一句语音 → `claude -p --resume <sid>` 带答案续跑 | agent 中途提问能从音箱播出；口头回答后任务继续；可多轮 |
| P2-3 | HA 反问通路：受限选项走 `assist_satellite.ask_question`（2025.7），开放式走 `start_conversation` + `extra_system_prompt`（携带 job 上下文） | 「要提 PR 吗」→ 答「提」→ 正确路由回对应 job |
| P2-4 | Cookrew 侧反问：SSE `activity` 事件 `phase=waiting` 即「卡在权限或提问」信号 | teammate 卡住时能主动播报而非静默等待 |
| P2-5 | 沙箱：每 job 一个 git worktree；`--permission-mode` 选型需权衡（`dontAsk` 会直接拒绝 `AskUserQuestion`）；`disallowedTools` 硬拦 | agent 无法触碰 HA 配置目录；越权尝试被拒并记录 |
| P2-6 | `job_status` / `cancel_job` / `answer_agent` 三个 HA 脚本工具 | 语音问「进度如何」「停下」有效 |

> ⚠️ 已知 bug：claude-code #30983 / #50728 报告无头模式下 `AskUserQuestion` 会以空答案自动解决，且均被 stale 自动关闭未确认修复。**先测再依赖；`defer` 是更安全的路径。**

---

### P3 · 多 agent 编排（预计 3–5 天，方向待定）

**关键设计选择（见 §7-决策4）**：网关自建 job 队列做编排，还是只做协议转换、把编排交给 Conductor 自己？

倾向后者 —— 网关保持薄，`POST ask` 给编排位，Conductor 用 `cookrew ask` 分发给下游 teammates，这本就是 Cookrew 的设计姿势，且复用了已有的编排能力。

| 任务 | 内容 | 验收标准 |
|---|---|---|
| P3-1 | 语音 → Conductor → 多 teammate 分发链路 | 一句话触发多 agent 协作，进度分别可查 |
| P3-2 | ha-mcp 接入（Docker 版）：agent 反向控家，白名单实体 | agent 可在任务中执行「测完把灯闪三下」；越权实体不可见 |
| P3-3 | 并发任务的播报调度（避免多个任务同时抢音箱） | 播报排队，不重叠 |
| P3-4 | Codex teammate 接入（依赖 §7-决策2 的核实结论） | — |

---

## 5. 可复用组件（不要重复造）

| 用途 | 项目 | 备注 |
|---|---|---|
| 调度器内核参考 | `siteboon/claudecodeui`（★12.9k） | SDK query + resume + requestId 权限往返最完整；**AGPL-3.0，注意许可** |
| ask-back 原语 | `mbailey/voicemode`（★1.3k, MIT） | `converse` 工具＝说出问题并阻塞等口头回答 |
| TTS 播报范式 | `disler/claude-code-hooks-mastery` | Stop / Notification 钩子 |
| 会话映射 | `claude-code-telegram` | SQLite `(user, cwd) → session_id`，失败回退新会话 |
| 语音打断运行中会话 | `mcp-voice-hooks` | 队列 + 钩子轮询 |
| 流式 TTS | `RealtimeTTS` / `duck_talk` | 首音 ~1.5s |
| agent 控家 | `homeassistant-ai/ha-mcp`（★4.2k, MIT） | Codex 侧走 stdio（其 HTTP MCP 有 bug） |
| 本地模型工具调用兜底 | `acon96/home-llm` v0.4.6 | 若 llama.cpp 直连解析不稳 |

## 6. Teammate 分配建议（待 Conductor 确认）

| 阶段/任务 | 建议承担 | 理由 |
|---|---|---|
| P0-1 安全加固 | Claude 系（Forge / Tinker） | 改动在 `mobile-server.ts` / `mobile-api.ts`，熟悉本仓库 |
| P0-4/5 语音栈 + L1 | Claude 系（Magpie / Beacon） | 基础设施编排，compose + HA 配置 |
| P1 网关骨架 + Cookrew 适配 | Claude 系主力 + Codex 系并行评审 | 核心实现 |
| P2-2 defer 循环 | Claude 系（最熟 Claude Code 内部机制） | 技术核心 |
| **Codex CLI 无头编排核实** | **Codex 系（Sol / Pixel / Probe）** | 让 Codex 自查自己那条线最合理，含「疑似已支持实时语音」的待证线索 |
| 全程只读审查 | Codex 系一位 | 跨模型交叉验证 |

## 7. 待决策项与建议

**决策 1 · 语音输入端** —— 建议 **HA Voice PE**（$59）。
小爱 LX01 云端桥接已否定（LX01 缺 ubus 播放状态 ⇒ **无法静音其原生回答**，无接话，1–2s 延迟无解；mi-gpt/open-xiaoai/migpt-next 于 2026-04-04 集体归档）。Voice PE 原生 Wyoming、零折腾；`xiaozhi-esp32`（★28k，约 ¥100）是更便宜的替代但需自建服务；刷机 `duhow/xiaoai-patch` 仅在你愿意折腾且 LX01 从未 OTA 时考虑。**小爱保留为播报端**（`notify.play_text` 已验证可用）。

**决策 2 · Codex CLI 无头编排** —— **先核实再设计**。
本次调研该线未返回，`codex exec` 的事件流、thread id、resume、sandbox/approval 语义、`notify` 钩子、`@openai/codex-sdk` 成熟度均未验证。**待证线索**：第三方变更日志称 Codex CLI 已支持语音输入乃至实时双向音频与后台 agent 进度流 —— 若属实可大幅缩减 Codex 侧工作量，应最先查证。建议 P1 期间由 Codex teammate 并行完成，不阻塞主线。

**决策 3 · 网关技术栈** —— 建议 **Node/TypeScript**。
与 Cookrew 同生态、与 Agent SDK（TS 版）一致、便于复用本仓库既有工具链。许可上避免直接抄 AGPL 的 claudecodeui 代码，仅作架构参考；或直接以子进程方式跑 `happy daemon`。

**决策 4 · 编排层归属** —— 建议 **网关保持薄，编排交给 Conductor**。
网关只做「协议转换 + 任务台账 + 回调」，多 agent 编排走 `POST ask` 给编排位再由其 `cookrew ask` 分发。理由：复用 Cookrew 既有编排能力、避免两套调度逻辑、P3 工作量大幅下降。代价：编排质量依赖 Conductor 会话稳定性（本次三连 API 过载即是提醒 —— 需要降级路径：编排位不可用时网关可直接派给具体 teammate）。

## 8. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| **上游 API 过载**（本次已连续三次） | 云端 agent 与 Conductor 编排均不可用 | 网关必须有重试 + 降级：云端不可用时回落本地模型或排队；**关键：中断前把已完成部分落盘，别整轮丢弃** |
| Voice PE ~5s TTS 计时器 | 同步等待即失败 | 所有派活 fire-and-forget，先回执后播报 |
| Cookrew API 无鉴权 + bypass 权限 | 局域网任意设备可驱动全部 agent | P0-1 前置修复 |
| 本机代理劫持 localhost（`127.0.0.1:7897`） | 本地 HTTP 调用返回 502 | 所有本地调用显式绕过代理 |
| 活动工作区约束 | 目标 teammate 不在活动 workspace 时 PTY 接口失效 | 明确报错；不建议自动切换（会打断用户界面） |
| 小模型工具过载 | 4B 工具调用质量骤降 | 严格限制 3–5 个工具；ha-mcp 只给云端 agent |
| agent 误操作家居/配置 | 生产事故 | 设备操作一律过 HA 白名单脚本；agent 在 worktree 沙箱；禁止任意 shell；**禁止任何让 Mac 睡眠的指令**（会连带杀死 HA） |
| `AskUserQuestion` 无头模式空答案 bug | 反问闭环失效 | 优先 `defer`；上线前实测 |
| Claude 会话 id 每轮变化 | 续会话失败 | 每轮从 `result` 重新捕获并落库；失败回退新会话 |
