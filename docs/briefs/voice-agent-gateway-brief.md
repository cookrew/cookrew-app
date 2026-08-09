【新项目立项：语音 → Agent 网关（Voice Agent Gateway）】

请你作为 Conductor 制定开发计划并分配给 workspace 内的 Claude / Codex teammates。方案选型未定死，欢迎在你那边继续讨论后再定。

## 背景与目标
在我的 M1 Pro 16GB Mac 上，让家里的语音入口能够分级驱动三类"大脑"：
- L0 简单控制 → Home Assistant 内置意图直接执行（不经 LLM）
- L1 复杂控制 → 本地 llama.cpp + Qwen3.5-4B 工具调用（关窗帘+调灯+电视退画框这类组合动作）
- L3 长时任务 → 云端 code agent（claude -p / codex exec）**以及 Cookrew teammates**，异步执行、完成后语音播报、支持口头追问与中途反问

最终形态：对着语音入口说"让 Codex 看看昨天 bitvm2 构建为什么挂了"，十分钟后音箱开口播报结论并问"要提 PR 吗"，我口头回答后同一会话继续。

## 已完成的调研（两份报告在本机，请先读）
- /private/tmp/voice-agent-gateway-research.html —— 本项目主调研：社区现成方案盘点、可复用组件清单、自建边界、Cookrew 对接面
- /private/tmp/home-hybrid-deployment.html —— 家庭设备与分层推理部署方案（设备矩阵、内存预算、实施顺序）

## 现状（已就绪的部分）
- HA Core 2026.7.2（Container，OrbStack）+ Mosquitto，局域网 192.168.2.0/24
- 已接入 HA 的实体：三星 The Frame 55 电视、Android 盒子、小爱音箱mini（含 notify.play_text 播报能力）、飞碟灯、Hooeasy 灯、小米智能插座、Roborock 扫地机、HASSMART 窗帘 x2
- 尚未部署：Whisper / Piper / openWakeWord 语音栈、llama.cpp + Qwen3.5-4B、本网关

## 调研核心结论（可直接作为设计前提）
1. 社区确认此桥接是空白（HA 论坛帖 941896，2026-03 结论：无可用成品），但周边全是成熟件，**净自建量约 200–400 行 + 少量 YAML**
2. 可复用：
   - 调度器内核参考 siteboon/claudecodeui（★12.9k，AGPL，注意许可）；或直接跑 slopus/happy 的 daemon
   - ask-back 原语用 mbailey/voicemode 的 converse 工具（MIT，说出问题并阻塞等口头回答）
   - TTS 播报用 disler/claude-code-hooks-mastery 的 Stop/Notification 钩子范式
   - 会话映射抄 claude-code-telegram 的 SQLite (user, cwd) → session_id
   - agent 反向控家用 homeassistant-ai/ha-mcp（Codex 侧走 stdio，其 HTTP MCP 有 bug）
   - HA 侧 announce / ask_question / start_conversation / webhook 全是官方原语，2026.7 已具备
3. 关键技术点：Claude Code 的 PreToolUse `defer` 决策（v2.1.89）——进程带着未决工具调用退出，语音里问完用户再 `claude -p --resume` 续跑，等人说话期间不占资源。**这是没人为语音实现过的部分，是本项目的技术核心**
4. 反面教材：不要做 PTY/tmux 抓屏或按键注入（omnara 已因"脆弱难维护"弃用该路线并改写为 SDK）
5. Claude Code 约束：会话查找绑 cwd（+其 git worktree），派活需固定工作目录；allowedTools 约束不了 bypass 权限模式；裸 allow 条目会静默屏蔽 canUseTool 回调

## Cookrew 作为派发目标（本 workspace 自己的能力）
调研已核实的对接面：
- 派活：POST http://localhost:8639/api/terminal/<nodeId>/ask  body {"text":"..."} （同步阻塞至安静，2.5s 静默判定，120s 超时）
- 不等待：POST /api/terminal/<id>/input
- 进度：GET /api/events (SSE)，activity 事件的 phase 字段：thinking / waiting（卡在权限或提问，**正是 agent 反问的触发信号**）/ replied（完成带 reply 文本）
- 恢复会话：POST /api/agents/<id>/recover
- events.jsonl 只有元数据无对话文本，完成信号请走 SSE 或 ask 的同步返回

**安全问题（本项目前置任务）**：该 API 监听 0.0.0.0:8639/8643、CORS *、**无任何鉴权**，而 teammate 以跳过权限确认的模式运行 ⇒ 局域网任意设备可驱动全部 agent。接入自动化派活前必须收紧（绑 127.0.0.1 或加共享密钥），请把这个纳入计划。

## 待决策项（请组织讨论后给建议）
1. **语音输入端**：小爱 LX01 走云端桥接已被否定（LX01 缺 ubus 播放状态 ⇒ 无法静音其原生回答，无接话，1–2s 延迟无解；mi-gpt/open-xiaoai/migpt-next 于 2026-04-04 集体归档）。候选：① HA Voice PE（$59，Wyoming 原生）② xiaozhi-esp32（约 ¥100，★28k 活跃，完全离线）③ 刷机 duhow/xiaoai-patch（LX01 在支持列表，需焊 USB-TTL，未 OTA 机器可能免焊）。小爱保留为播报端。
2. **Codex CLI 无头编排未核实**：codex exec 的 JSON/事件流、是否有稳定 thread id、resume/--last、sandbox 与 approval 语义、notify 钩子、@openai/codex-sdk 成熟度，均需对照 developers.openai.com/codex 核实。**另有待证线索**：第三方变更日志称 Codex CLI 已支持语音输入乃至实时双向音频与后台 agent 进度流——若属实可大幅缩减 Codex 侧管道工作量。建议派 Codex teammate 自查自己这条线。
3. **网关技术栈**：Python FastAPI vs Node/TS（后者与 Agent SDK、Cookrew 同生态）；许可上是否要避开 AGPL 参考实现。
4. **是否复用 Cookrew 自身作为编排层**：网关只做协议转换，把多 agent 编排交给 Conductor 你自己（POST ask 给编排位，你再 cookrew ask 分发），而不是网关内自建 job 队列。这条路线请重点评估。

## 期望交付
1. 一份分阶段开发计划（建议 P1 最小可用 → P2 完整反问闭环 → P3 多 agent 编排），每阶段有明确验收标准
2. 任务拆解并分配给具体 teammates（Claude 系做实现，Codex 系可负责 Codex CLI 侧核实与并行实现）
3. 对上述 4 个待决策项给出你的建议与理由
4. 风险清单（尤其：Voice PE ~5s TTS 传输计时器 ⇒ 任何工具调用超 10s 必须 fire-and-forget；agent 沙箱隔离，绝不允许直接改 HA 配置；设备操作一律过 HA 白名单脚本）

先读那两份 HTML 报告再动手。有疑问直接问我。
