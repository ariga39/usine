---
status: current
design_version: 0.3
updated: 2026-08-18
issue: https://github.com/ariga39/usine/issues/1
---

# Usine 当前设计

## 1. 我们真正要解决的问题

个人开发者可以让 coding agent 完成单个明确任务，但人仍然承担着形成任务、分配任务、催促继续、判断是否完成、安排 review、处理返修和交付的工作。增加 agent 数量后，如果这些协调动作仍由人完成，人会更快成为瓶颈；如果让 agent 通过自由对话互相激活，又容易形成通信风暴、偏离共同目标或无人拥有最终责任。

Usine 要把这段重复协调从人类手中移出。V0 由用户或现有项目流程直接提供一个足够完整且已授权的 Task Contract；admission 后用户可以离线，系统让有界任务持续、有序地流过实现、验证、独立 review、返修和交付，只在需要新增权限、不可逆决定或真实产品分叉时找人。Requirement Proxy 和 Planner 属于手工 contract delivery loop 跑通后的 admission 扩展，不是第一项行为的前置角色。

长期 north star 是每天形成 300 个有效、有价值并最终合并的 PR。这个数字是扩展方向，不是第一版的虚假验收指标。系统实际优化：

```text
accepted delivery outcomes
────────────────────────────────────────────
human interventions × elapsed time × cost
```

提交数、agent turn、测试数和 PR 数只有在推动 accepted outcome 时才有价值。

## 2. 第一项有用行为

Usine 的第一个完整产品行为是：接收一项已经授权、边界明确的真实开发任务，在无人再次发送“继续”的情况下，产出一个经过项目检查和独立 reviewer 明确批准、绑定 exact SHA 的 PR；若实现者提前停止、协调器重启或 reviewer 要求修改，系统能够在预算内恢复并继续。

这是一条持续投入真实工作的路径，不是先做完才允许继续建设的孤立实验。它定义的是产品必须尽早具备的纵向行为，而不是旧式任务分解。

第一项行为不包含：

- 自动从模糊 wish 生成完整任务树；
- 同一仓库多个并发 writer；
- 任意 DAG、插件市场或动态 provider router；
- 分布式调度、跨主机迁移或多 forge 同步；
- Web dashboard、Mem0、session 向量数据库；
- 对 Git 对象库、PostgreSQL catalog 或敌对 host 的穷举式证明；
- 无条件自动 merge。

这些能力并未被永久否决。只有观察到明确需求穿透现有边界时，才按 `DECISIONS.md` 中的 re-entry trigger 重新讨论。

## 3. 端到端模型

```text
authorized task contract
        │
        ▼
deterministic coordinator (DBOS)
  durable lifecycle + retry
        │
        ▼
isolated Codex implementer workspace
        │ proposes commit
        ▼
immutable candidate SHA
        ├──────────────┐
        ▼              ▼
project checks    fresh independent reviewer
        └──────┬───────┘
               ▼
       exact-SHA gate reducer
        │              │
        │ approved     │ changes requested
        ▼              └── one aggregated fix activation
credential-scoped GitHub delivery
        ▼
reviewed PR + explicit approval attestation
```

这张图描述产品目标，不是对当前实现路线的接受声明。Issue #12 / PR #38 只验证了一条弱样本连接路径：一个写文档的 Task 能组成 candidate、check、review 和 GitHub delivery evidence。它没有验证 representative executable code task、module locality 或 live coordinator restart recovery。

Issue #65 随后在普通任务中复现 Herdr agent settled、没有 prompt/observation、协调器不能继续；这正是此前 decision 定义的 route falsifier。局部 pure-move acceptance 仍被合并，进一步证明 task selection 与 merge gate 本身也失效。

Issue #76 选择 `clean_implementation`：保留已经证明有价值的 authority invariants 和 effect-reconciliation algorithm，但不保留当前 monolith、Herdr/transcript lifecycle、shallow helper packages 或 implementation-coupled test shape。当前分类从 `stop_and_redesign` 进入 `correct_before_expansion`。只有一项 full-refactor implementation eligible；它必须用小提交在同一 PR 中建立下述深模块，并以 representative executable task 和 induced coordinator restart 清除 route falsifier。设计完成本身不算清除。

Artifact coupling 很强：Task Contract、base SHA、candidate SHA、check evidence、review verdict 和投影出的 attestation 都可追溯且不可被聊天静默改写。

Activation coupling 仍应很弱：普通消息不会广播唤醒其他角色；只有持久化状态变化让协调器激活一个明确 next owner。Codex SDK 负责一个 coding turn 的结构化生命周期；Herdr、hook、transcript 和 App Server 都不参与 coordinator authority。SDK adapter 仍须通过代表性任务证明，不因文档选择而自动可信。

## 4. 权威与状态

### 4.1 确定性控制面

顶层不需要 LLM 界面，也不存在永久 Chief Agent。协调器是普通 TypeScript 程序；DBOS 提供 durable workflow、queue、timer、checkpoint 和 restart recovery。协调器只做机械且可审计的决定：admit、lease、activate、wait、retry、invalidate stale evidence、reduce gates 和 publish effects。

V0 的 LLM 只承担必须依赖语义判断的 Implementer、Reviewer，以及出现冲突时的有界诊断。轻量的 transcript extraction、classification、normalization 和 short summary 由协调器通过成熟的 `ai` + `@ai-sdk/openai` provider 直接调用配置的 schema-constrained OpenAI-compatible API；除非确实需要 repository、tool 或 session 能力，不通过 Herdr、Codex 或 OpenCode agent runtime。协调器仍负责输入投影、schema 校验、exact-SHA 校验和 lifecycle authority。未来的 Requirement Proxy 和 Planner 只能从同一个 admission seam 生成待授权 contract，不能绕过授权或直接修改 task lifecycle。任何 LLM 都不能用自然语言宣布终态。

正常推进由持久化事件触发；一个 DBOS scheduled reconciler 定期扫描 nonterminal lane，作为丢事件、agent 静默退出和外部 effect 未回报时的零模型后备。它只重新观察事实并恢复一个明确 next action，不广播唤醒多个角色，也不重复授予 write generation。这就是系统的“定期激发”：保证 liveness，但不制造对话风暴。

### 4.2 最小状态事实

- **Task Contract**：任务意义、范围、non-goals、acceptance、授权来源、预算和风险；admission 后不可原地修改。
- **Run**：一次 agent/process 尝试及其 context、workspace、模型、预算和 observation。
- **Candidate**：从记录的 base 产生、由 host 验证并冻结的 Git commit SHA。
- **Check Result**：项目原生命令在该 Candidate 上产生的机器事实。
- **Review Verdict**：fresh non-author reviewer 对该 Candidate 的 `approved`、`changes_requested` 或 `inconclusive`；其中 exact-SHA `approved` 是 Usine 的 semantic approval 事实。
- **Delivery Effect**：branch、push、PR、review attestation projection 和未来 merge 的外部副作用及 probe 结果。

进程退出、Codex hook、agent 最后一条消息、测试命令 exit 0 和 CI job 正常结束都只是一项 evidence。Task 的终态只能由完整 gate 对同一 SHA 的事实归并得到。

### 4.3 恢复

恢复路径和正常路径相同。协调器重启后读取 DBOS workflow 与少量领域状态，再观察进程、workspace、Git 和 GitHub 的当前事实：

- 确认已发生的 effect，记录成功；
- 可证明未发生的 effect，按相同 identity 重试；
- 无法确定的 effect，先 probe，仍不确定则 quarantine；
- agent 已停止而 Task 未到 terminal gate，按预算恢复或重新激活；
- 不因 timeout 自动授予第二个 writer。

Codex Stop hook 可以缩短一次 run 内的继续延迟，但只能发出 signal，不能创建新 writer 或决定完成。系统在 hook 完全缺失时仍必须正确。

## 5. 并发与隔离

当前 `correct_before_expansion` checkpoint 只运行一个 full-refactor Task。代表性 executable code task 与 induced live coordinator restart recovery 都有证据后，最先允许的并发分片才是项目：不同 repository 可以同时推进，同一 repository 只有一个有效 write generation。每个 generation 使用独立 writable workspace 和 monotonic fence；review 使用另一个 fresh checkout，不继承 implementer 对话、未提交文件和可写 ref。

隔离按能力而不是 agent 名字定义：

| 角色 | 代码写入 | 网络 | GitHub delivery credential |
|---|---:|---:|---:|
| Implementer | 自己的 workspace | 按 task profile | 无 |
| Project checks | disposable candidate checkout | 默认无 | 无 |
| Reviewer | read-only candidate + scratch | 文档查询可选 | 仅提交内部 verdict 的短期 capability |
| Delivery executor | 不运行 candidate code | GitHub only | 短期 GitHub App installation token |

优先使用 Codex sandbox 和 host 目录/进程权限。容器、轻量 VM 或远端 sandbox 是 adapter 选择，不进入领域模型；只有现有隔离无法满足某个项目的实际风险时才引入。

## 6. Review、checks 与交付

Project checks 和 reviewer 是两个独立事实。Reviewer 可以读取完整 codebase、Task Contract、diff 和 check evidence，但不继承 implementer 的辩护性对话。它必须提交结构化 verdict；review process 正常退出但没有合法 verdict 时结果是 `inconclusive`，不是批准。

所有 gate 绑定 exact Candidate SHA。新 commit 自动使旧 check、review verdict 和 attestation stale。`changes_requested` 先聚合为一个 finding batch，再激活一次 implementer；不会让每条评论分别激活 agent。重复不收敛按预算进入 blocker/diagnosis，不形成无限 review 风暴。

GitHub 是当前 forge 与交付 surface，不是核心 task domain。Octokit 使用 GitHub App 生成短期 installation token；worker 不接触该凭据。branch、PR 和 review attestation projection 都有稳定 identity，crash 后先查询 GitHub 再决定是否重试。

fresh reviewer 提交的 exact-SHA `approved` verdict 是必要的 semantic approval；review process 成功退出或 delivery executor 的文字都不能替代它。Delivery executor 只能把这个已存在的 verdict 投影为 PR 上可追溯的 attestation，不能制造或改写语义批准。若仓库 ruleset 还要求 GitHub 原生 `APPROVE` review，必须由不同于 PR author/delivery identity 的 reviewer capability 提交，并作为额外 platform fact；同一 GitHub App 不得自批。第一项产品行为停在带 exact-SHA approval attestation 的 reviewed PR；未来自动 merge 仍须重新读取 live head，并验证 checks、verdict、attestation 与任何 platform approval 都绑定该 head。

## 7. Context 模型

Agent session 是可丢弃的执行缓存，不是记忆数据库。每次 activation 都从 durable artifacts 构造有界 context pack：当前 Task Contract、canonical design、repo rules、exact Git state、未解决 findings、最近一次有效 checkpoint 和本次 failure delta。

不向新 agent 倾倒整个历史 chat、旧任务树或全部研究 archive。实现者在一个连贯 run 内可以保持 warm；reviewer 默认 fresh；recovery agent 读取最后有效 checkpoint，而不是重放所有对话。长期向量记忆只有在这些 artifact 无法支撑重复恢复、且有实际遗漏数据时才考虑。

Clean-room 不等于失忆。Compact 或新实现不加载历史 archive，但 canonical corpus 必须保留：两次失败的 causal chain、已 falsified route、仍有效的 evidence、曾误导的 proxy metrics，以及当前 eligible work。这样可以删除旧代码而不重复相同的控制机制。

## 8. 深模块与 library-first 边界

模块是行为边界，不预先等同于 npm package。V0 只有六个生产模块；CLI 是 composition root，不算第七个 module：

| 模块 | 隐藏的 policy | 外部 caller 只知道 | 允许的内部 seams 与 change locality |
|---|---|---|---|
| **Task Authority** | contract admission/immutability、repository writer lease、合法状态转移、接受或拒绝领域事实、exact-SHA evidence invalidation | `admit`、读取当前 Run、提交一个待验证领域事实 | 纯 reducer + Drizzle persistence；独占 stale-evidence acceptance policy，不 import DBOS、Git、Codex、GitHub 或 subprocess |
| **Delivery Run** | DBOS checkpoint 顺序、activation/review budget、retry、restart recovery、next action | `run(authorized contract)` 返回 durable task result | DBOS workflow 和 operation handlers 集中在这里；它不解析 agent stream、不拼 Git argv、不调用 Octokit endpoint |
| **Coding Session** | role/model/sandbox policy、受限 environment、prompt/context projection、structured turn lifecycle、cancel/timeout | 在一个已准备 workspace 中运行 implementer 或 fresh reviewer，并取得 provider-neutral typed observation | 当前唯一 production adapter 使用官方 Codex SDK；SDK event、thread ID、structured output 和 optional read-only MCP 都留在 adapter 内，agent result 永不授予 task terminal authority |
| **Candidate Workspace** | isolated writer worktree、credential-free Git、host-side commit/finalize、ancestry/cleanliness、disposable exact-SHA checkout | prepare writer、freeze Candidate、以 SHA 提供 disposable checkout | 系统 Git CLI 的窄 argv adapter；不拥有 retry、review 或 delivery policy |
| **Quality Gate** | 一次 candidate evaluation 内的 project check、fresh exact-SHA review 与 finding aggregation | `evaluate(candidate, contract)` 返回 check + review facts | 通过 Candidate Workspace 取得 checkout，通过 Coding Session 启动 reviewer；它不拥有 retry、activation 或 stale-evidence policy。Check failure 作为 fact 交给 Delivery Run，后者决定下一次 implementer activation |
| **Forge Delivery** | GitHub App auth、branch/PR/attestation identity、probe-before-retry、ambiguous effect reconciliation | `deliver(approved exact-SHA bundle)` | Octokit 与 credential-scoped Git push；不运行 candidate code，也不能制造 semantic approval |

依赖只向产品 policy 内侧流动：CLI 组合 Delivery Run；Delivery Run 独占 activation/retry/budget policy并使用其余五个接口；Quality Gate 可以使用 Coding Session 和 Candidate Workspace。跨模块传递 Task Contract、Candidate、Check Result、Review Verdict、Delivery Effect 和 provider-neutral SessionRef，不传递 Herdr pane、Codex thread/event/argv、Octokit response 或 DBOS context。需要独立发布、独立 caller 或独立 deployment 前，这些模块留在少量 workspace package 内，不以 package 数量证明设计。

### 8.1 Coding Session 的最小 contract

Coordinator 只提供：role、workspace/candidate、冻结的 Task Contract 与未解决 findings、role policy、deadline，以及可选 provider-neutral continuation identity。Coding Session 只返回：opaque session identity、可验证的 turn terminal status、schema-valid role output、usage/progress observation 和 typed failure。它必须支持 cancellation/timeout，并允许 host 用受控 environment 和 config 注入只读 capabilities。当前 Codex adapter 在边界内把 SessionRef 映射到 thread ID、把 AbortSignal 映射到 SDK turn、把 SDK events 映射为 observation；其它模块看不到这些类型。

Candidate SHA、workspace cleanliness、project checks、review freshness、delivery eligibility 和 Task terminal state都不由该 contract 决定。Codex `turn.completed` 是一次 semantic worker attempt 的完成证据，不是 Task 完成。

Implementer 的 private Issue/PR authority 仍由冻结 Task Contract 提供。补充的 live read-only Issue/repository context 通过 deployment-owned MCP capability 提供：使用与 delivery App 分离的 read-only credential、tool allowlist 和 Codex shell environment policy，credential 不进入 worker shell。MCP 不可用时，完整 Task Contract 仍足以执行；worker 不自行实现 GitHub API client，也不因无法读取 GitHub 而等待用户。

对 critical seam 比较两种 external contract：

| Contract shape | Caller knowledge | 决定 |
|---|---|---|
| **Task-oriented turn port**：`run(request) -> typed observation`，continuation 是 opaque optional hint | role、workspace、deadline、schema 和 domain output；不知道 process、pane、event protocol 或 provider command | **选择**。它让 SDK 吞掉 session lifecycle，Delivery Run 只根据 durable domain fact retry；当前只有一个 Codex adapter。 |
| **Session supervisor handle**：`start / observe / prompt / interrupt / resume / stop` | caller 必须拥有 session state、event ordering、process cleanup 和 provider error mapping | 拒绝。它会把 Gas City/Herdr 的通用 runtime surface重新搬进 coordinator，并诱发自写 supervisor；只有同时出现第二个 runtime 和交互式 session caller 才 re-enter。 |

这个 port 是替换边界，不是预建 provider framework：没有 registry、dynamic router、capability matrix或第二个 production/fake provider。未来只有在真实证据触发时才替换当前 adapter或增加一个 adapter，并复用同一 behavior contract；Task Authority、Delivery Run、Candidate、Quality 和 Forge 不随 provider 改变。

### 8.2 Reuse strategy decision

| 候选 | 可删除的自写 surface | 决定 |
|---|---|---|
| [OpenAI Codex SDK](https://developers.openai.com/codex/sdk/) | CLI argv、JSONL parser、output-schema temp plumbing、thread/turn event handling、resume wrapper、environment inheritance glue | **选择**。它直接服务 coding-focused local threads，提供 start/resume、streamed typed events、schema output、sandbox、working directory、controlled env、config 和 cancellation；Usine 只包 role policy 与 product evidence projection。 |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) `SandboxAgent` / MCP / tracing | agent loop、sandbox capability binding、session/tracing | 不作为 V0 runtime。它适合更广泛 agent application，但会在当前一个 Codex specialist 内重复 Codex agent loop，并与 DBOS task authority重叠；sandbox 与 MCP capability model 作为设计 donor。Experimental `codexTool` 不是生产依赖。 |
| Codex App Server | 最完整 thread/turn/item event、interrupt/read/resume | 不直接接入。它会要求 Usine 维护 JSON-RPC lifecycle client；Codex SDK 已覆盖当前 caller。只有 SDK 无法提供一次真实 recovery 所需 observation 时才 re-enter。 |
| [Gas City runtime/session design](https://github.com/gastownhall/gascity/blob/main/engdocs/architecture/session.md) + Herdr | stable session identity、idempotent stop、runtime/session bookkeeping 分离、provider conformance ideas | 作为 donor，不采用通用 provider。Gas City 需要多个交互式 runtime，Usine 当前只有一个 coding runtime。Herdr pane、prompt settlement、screen state 和 rendered transcript 从 production correctness path 删除；未来若 operator observation 成为实测需要，只能作为 Coding Session 内的可选 host/observer，不能成为 completion evidence。 |
| [AgentRouter](https://github.com/perixtar/AgentRouter) / [Cezar](https://github.com/open-mercato/cezar) | persisted run/event、sandbox、multi-provider examples、worktree/event UI patterns | 不采用。前者仍为 alpha 且引入 Daytona/R2/第二套 Postgres control plane，后者主要是本地 cockpit；两者都复制 DBOS/Forge ownership。只借鉴公开的 event mapping、credential separation 和 worktree examples。 |

选择 Codex SDK 作为当前 adapter，而不是更薄的 direct `codex exec`，因为 SDK 已经封装同一官方 CLI 的 structured lifecycle，能删除手写 parsing 并保留本地 Codex authentication/economics。Named profile 和 model slug 都不是 module contract；fresh/high/default-tier/no-fast 是当前 role property，当前用户指定的 Luna slug保留在 deployment/task policy。若 characterization 证明 SDK 无法维持这些设置、无法隔离 environment 或无法产生完整 turn terminal evidence，才降级为 direct exec、替换 adapter 或进入 App Server decision。

### 8.3 Salvage and deletion boundary

| 分类 | 当前 surface |
|---|---|
| **salvage unchanged** | Task Contract Zod shape；immutable exact-SHA evidence vocabulary；one-writer/repository identity；credential-free host commit与 ancestry/clean checks；GitHub probe-before-retry、head quarantine 和 attestation identity algorithms |
| **salvage behind a new seam** | Drizzle schema/migrations与 DBOS workflow facts进入 Task Authority/Delivery Run；worktree helpers进入 Candidate Workspace；project-check environment进入 Quality Gate；Octokit/Git delivery进入 Forge Delivery；CLI 只保留 parse、invoke、exit projection |
| **delete/replace** | `runtime.ts` composition monolith；`@usine/agent-runtime` shallow helper package；`@usine/review-extractor` whole rendered-transcript second-model path；全部 production Herdr pane/prompt/read/get/close；manual Codex JSONL/session parser、output artifact instruction和 fallback branch；把 Usine 自身 canonical corpus塞给 target implementer；`record://` production branch；one-function physical decomposition；动态 scattered env reads |
| **one characterization decides** | Codex SDK 对 Luna/high/default-tier/no-fast、controlled env、structured implementer/reviewer output 与 AbortSignal 的 config parity；现有 read-only MCP/capability 的具体接入配置；restart 后 fresh retry 与 optional thread resume 的成本差异。Characterization 可以替换 adapter/config，不取消 Coding Session 或其它必要模块 |

测试也 replace 而不是 layer：删除 `fake-herdr` 及其 command-count/mode matrix；删除 transcript line-wrap/extractor suite；把 1500 行 CLI suite 拆为 Task Authority reducer/persistence tests、Coding Session SDK-adapter contract tests、Candidate/Quality tests、Forge reconciliation tests和至多两条 CLI/PostgreSQL end-to-end。新 adapter fake 发 typed SDK events，不复刻 CLI/pane 实现；旧 test claim 被新 module behavior 覆盖后在同一 full-refactor PR 删除。

按当前文件的保守 deletion floor，两个 shallow packages 约 150 行 source、`fake-herdr` 约 220 行、`runtime.ts` 中 Herdr/transcript/manual lifecycle 分支约 350 行会直接消失；CLI suite 中对应 command-count、line-wrap、fallback mode cases 也整体替换，预计再删除数百行。该估算只证明 clean boundary 有真实删除空间，不把净行数作为 merge gate。六个 module 是本 PR 的 target map，不是六个预定 package：live caller 若证明某个 boundary 不隐藏 policy，重构 PR应合并或删除它；未经新的 design evidence 不得增加第七个。

### 8.4 Clean implementation decision and counterargument

决定为 **`clean_implementation`**，含义是围绕成熟 SDK 和上述六个 caller-owned boundary 重组生产代码与测试；不是从零重写 agent runtime，也不是丢弃已验证的 Git/DBOS/GitHub invariants。当前 monolith 让局部迁移继续继承错误 caller knowledge，保留它再逐个抽函数会让旧 tests 和 transport details 支配新接口，删除收益不足。

反对这一选择的最强论据是：一次 full refactor 会同时触碰 hard-won DBOS replay、Git candidate 和 GitHub uncertain-effect recovery，产生难以定位的回归；增量 strangler 更安全。用户已经明确决定目标架构需要 Coding Session 和其它五个模块，并选择一个完整重构 PR而不是重建 backlog。风险通过 PR 内小而可运行的提交控制：尽早 characterise task-oriented Coding Session，若 Codex SDK 不合格就替换该 adapter而不保护沉没成本；同时按模块迁移 hard-won policy，建立新 interface coverage 后删除旧入口，最后删除 monolith与旧 fakes。真实 executable task 与 hard-kill/restart是整个重构的最终 merge gate，不是其它必要模块开始重构的前置许可。不能用“仍在同一 PR”豁免 exact-SHA review。

反对整个路线的更强论据是：AgentRouter 或 Gas City 已经覆盖 agent session、event、retry、workspace 和多 provider，Usine 继续维护 DBOS coordinator 可能仍在重复基础设施。现有证据暂不支持整套替换：AgentRouter 自称 alpha，并要求 Daytona、R2 与自己的 Postgres run control；Gas City 的通用交互式 provider/runtime 远大于当前单 Codex caller，且不提供 Usine 的 immutable candidate、exact-SHA semantic gate 与 GitHub uncertain-effect authority。选择 Codex SDK 的目标正是把差异缩到这几项产品 policy；若 full-refactor 后自有代码仍主要是 session/process/event plumbing，而不是 authority、quality gate 和 delivery reconciliation，这将直接证伪本决定，应改为采用成熟 control plane 而非继续自建。

默认依赖选择：

- DBOS TypeScript SDK：workflow、queue、timer、deduplication 和 restart recovery；
- PostgreSQL + Drizzle ORM/Drizzle Kit，并使用 DBOS 官方 Drizzle datasource：领域模型、查询、durable transaction 与 code-first SQL migration；
- Zod：外部 JSON/schema 边界；
- Octokit：GitHub App authentication 与 REST/GraphQL client；
- `@openai/codex-sdk`：唯一 coding-agent lifecycle；Execa 只用于 Git 和项目命令；`ai` + `@ai-sdk/openai`：协调器拥有的 schema-constrained 轻量语义 transform；
- Pino：结构化日志；
- Vitest：公共行为测试，Testcontainers 仅用于必要的真实 PostgreSQL integration；
- tsdown：所有 workspace package 的 TypeScript build；DBOS runtime package 使用 `unbundle: true`，不 bundle workflow；
- oxlint + oxfmt：仓库唯一的 lint 与 format 工具；TypeScript `--noEmit` 独立负责 typecheck。

Git 操作调用系统 Git CLI，通过一个窄 adapter 组装 argv 和解析结构化结果；不实现 Git object plumbing。原始 SQL 只允许用于 ORM 无法表达且有实际性能/一致性证据的局部语句，并必须在 PR 中说明原因。不得再用手写 trigger/catalog fingerprint 模拟 ORM、migration engine 或 DBOS 已提供的能力。

官方能力依据：DBOS 已提供可恢复 workflow、带并发控制的 durable queue 和 Drizzle datasource；Drizzle Kit 提供 schema-derived SQL migration；Octokit 可代管 GitHub App JWT 和 installation token 生命周期。DBOS workflow 依赖 runtime registry，不能被常规 bundler 合并；tsdown 因而只以 unbundle 模式编译 DBOS runtime 的逐模块输出。

## 9. 衡量与扩大

首条纵切只记录能回答核心优化目标的事实：是否形成 accepted outcome、human activation、端到端时间、成本、返修次数和 blocker。观察到具体瓶颈后再增加诊断指标，不预建通用 metrics surface，也不设置 10、30、50、100、300 之间的人工阶段门。

下一项且唯一 eligible implementation 是一个 full-refactor Issue/PR，内部以小提交推进。它的 merge gate 包含两条 live evidence：

1. 用 Usine 在一个 private target repository 完成一项真实 executable TypeScript change（修改 production behavior、更新真实 test、运行目标项目原生 check），形成 immutable Candidate、fresh exact-SHA approval 和 reviewed PR；文档复制、fixture script 或只改测试不合格。
2. 对同一类任务，在 Coding Session 已记录 activation、尚未形成 terminal role output 时强制终止 coordinator；以同一 contract/workflow ID 重启。DBOS 必须恢复同一 writer generation，可 fresh retry 或复用已验证 thread identity，最终只形成一个有效 Candidate/PR/attestation，且没有 orphan writer 或 stale evidence。

Hard-kill recovery 不复用可能仍在写入的 workspace。每个 activation 取得 monotonic fence token 和独立 workspace；Task Authority 只接受当前 token 冻结的 Candidate。旧进程即使短暂存活也只能写旧 workspace，其 output/Candidate 被拒绝并 quarantine，随后由 host cleanup。Restart 恢复同一 Task/repository lease，但 fresh retry 使用新的 activation token；“同一 writer generation”表示只有一个 Task 拥有 repository publish authority，不表示两个进程并发共享目录或 Candidate 权限。Warm thread resume 只是 characterization 后的成本优化，不是 correctness requirement。

这两条证据才清除 Issue #65 lifecycle falsifier。完成后 classification 才可进入 `continue`，并讨论不同 repository 的第二条 lane。若 SDK characterization 缺少 turn terminal evidence、无法执行 role policy/environment separation，或 restart 必须新增自写 supervisor/protocol，替换 Coding Session adapter并重新比较 direct exec、App Server 或成熟 runtime；其它五个产品模块的目标架构不因此取消。不得悄悄补一个新的 agent runtime。
