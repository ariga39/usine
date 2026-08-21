---
status: current
design_version: 0.7
updated: 2026-08-22
issue: https://github.com/ariga39/usine/issues/199
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

Usine 的第一个完整产品行为是：接收一项已经授权、边界明确的真实开发任务，在无人再次发送“继续”的情况下，产出一个经过项目检查和独立 reviewer 明确批准、绑定 exact SHA 的 PR；若 Task Contract 明确授予 merge authority，系统还会重新验证 live PR 并合并该 exact approved head，持久化 `merged` 结果；没有该 authority 时则停在 `reviewed_pr`。若实现者提前停止、协调器重启或 reviewer 要求修改，系统能够在预算内恢复并继续。

这是一条持续投入真实工作的路径，不是先做完才允许继续建设的孤立实验。它定义的是产品必须尽早具备的纵向行为，而不是旧式任务分解。

第一项行为不包含：

- 自动从模糊 wish 生成完整任务树；
- 同一仓库多个并发 writer；
- 任意 DAG、插件市场或动态 provider router；
- 分布式调度、跨主机迁移或多 forge 同步；
- Web dashboard、Mem0、session 向量数据库；
- 对 Git 对象库、SQLite catalog 或敌对 host 的穷举式证明；
- 不受 Task Contract 明确 authority 约束的自动 merge。

这些能力并未被永久否决。只有观察到明确需求穿透现有边界时，才按 `DECISIONS.md` 中的 re-entry trigger 重新讨论。

## 3. 端到端模型

```text
authorized task contract
        │
        ▼
typed local API
        │
        ▼
server-owned Effect scope
  deterministic coordinator
  SQLite facts + reconcile loop
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
        │
        ├── no merge authority ──▶ reviewed_pr
        │
        └── explicit merge authority
                    │
                    ▼
         live exact-head revalidation
                    │
                    ▼
            GitHub merge endpoint
                    │
                    ▼
                 merged
```

当前实现保留上述 authority invariants、deterministic reconciliation 和六个行为模块。PR #82/#83 提供真实 Codex executable delivery 与 restart evidence；Issue #153 只用 stubbed Codex adapter 验证 server-hosted lifecycle fixture。它们不证明第二 runtime、额外容量或 production Codex turn。

Artifact coupling 很强：Task Contract、base SHA、candidate SHA、check evidence、review verdict 和投影出的 attestation 都可追溯且不可被聊天静默改写。

Activation coupling 仍应很弱：普通消息不会广播唤醒其他角色；只有持久化状态变化让协调器激活一个明确 next owner。Herdr、hook、transcript 和 App Server 都不参与 coordinator authority；app-server 即使作为 adapter，也不能取得 Task authority。

## 4. 权威与状态

### 4.1 确定性控制面

顶层不需要 LLM 界面，也不存在永久 Chief Agent。协调器是普通 TypeScript 程序；本地 SQLite 保存最小领域事实，Drizzle transaction 原子地保留 lease、attempt fence 和 effect identity，Delivery Run 根据这些事实一次决定一个 next action。协调器只做机械且可审计的决定：admit、lease、activate、observe、retry、invalidate stale evidence、reduce gates 和 publish effects。

V0 的 LLM 只承担 Implementer 和 Reviewer 的 coding-agent work。`ai` + `@ai-sdk/openai` 只在配置时作为 optional final role-output normalization adapter；它不承担一般 classification、extraction 或 summary，也不取得 lifecycle authority。协调器仍负责输入投影、schema 校验、exact-SHA 校验和 lifecycle authority。未来的 Requirement Proxy 和 Planner 只能从同一个 admission seam 生成待授权 contract，不能绕过授权或直接修改 task lifecycle。任何 LLM 都不能用自然语言宣布终态。

正常推进和恢复使用同一条 deterministic reconcile 路径：读取持久事实与外部 observation，事务性保留一个带 stable identity 的 next action，执行后再记录 observation。Persistent local server 拥有 Effect scope、HTTP resource、task fibers、durable re-entry、cleanup invocation 和 AbortSignal propagation；provider execution semantics 由 Coding Session adapter 拥有。CLI 通过 loopback typed API 提供 `server`、`register`、`inspect`、`submit`、`status` 和 `follow`，提交进程退出不改变已 admission 的 task。server 启动时从 SQLite 重新进入 nonterminal Task，不延长 durable deadline，也不维护第二套 operation-index replay 或 scheduler control plane。只有出现多个独立 runner、durable delayed scheduling 或数据库 polling/竞争成为实测瓶颈时，才引入成熟 queue/workflow library。

### 4.2 最小状态事实

- **Task Contract**：任务意义、范围、non-goals、acceptance、授权来源、不可变的 delivery/merge authority、预算和风险；admission 后不可原地修改。
- **Run**：一次 agent/process 尝试及其 context、workspace、模型、预算和 observation。
- **Candidate**：从记录的 base 产生、由 host 验证并冻结的 Git commit SHA。
- **Check Result**：项目原生命令在该 Candidate 上产生的机器事实。
- **Review Verdict**：fresh non-author reviewer 对该 Candidate 的 `approved`、`changes_requested` 或 `inconclusive`；其中 exact-SHA `approved` 是 Usine 的 semantic approval 事实。
- **Delivery Effect**：branch、push、PR、review attestation projection，以及在显式 merge authority 下产生的 exact-head merge effect 和 probe 结果。

进程退出、Codex hook、agent 最后一条消息、测试命令 exit 0 和 CI job 正常结束都只是一项 evidence。Task 的终态只能由完整 gate 对同一 SHA 的事实归并得到。

### 4.3 恢复

恢复路径和正常路径相同。server 重启后读取 SQLite 中的冻结 Task Contract、执行输入和领域状态，再观察 workspace、Git 和 GitHub 的当前事实：

- 确认已发生的 effect，记录成功；
- 可证明未发生的 effect，按相同 identity 重试；
- 无法确定的 effect，先 probe，仍不确定则 quarantine；
- merge 前重新读取 live PR 和 exact-head attestation；GitHub merge endpoint 是平台 policy 的最终 gate，refusal 只产生 concrete blocker，不产生 delivery fact；
- 丢失 merge response 时 probe 已合并的 exact PR，成功观察后只记录一个 merge effect；
- agent 已停止而 Task 未到 terminal gate，按预算恢复或重新激活；
- 不因 timeout 自动授予第二个 writer。

Codex Stop hook 可以缩短一次 run 内的继续延迟，但只能发出 signal，不能创建新 writer 或决定完成。系统在 hook 完全缺失时仍必须正确。

## 5. 并发与隔离

当前 evidence 仍是 serial：每个 repository 只有一个有效 writer lease。每个 activation 使用独立 writable workspace 和 monotonic fence；review 使用另一个 fresh checkout，不继承 implementer 对话、未提交文件和可写 ref。产品不据此宣称多 Task capacity；第二 runtime/forge、分布式 runner 或更高并发须由授权 Issue 和实证支持。

隔离按能力而不是 agent 名字定义：

| 角色 | 代码写入 | 网络 | GitHub delivery credential |
|---|---:|---:|---:|
| Implementer | 自己的 workspace | 按 task profile | 无 |
| Project checks | disposable exact-SHA checkout | host filesystem/network permissions | Forge credentials 不传入环境 |
| Reviewer | read-only candidate + scratch | 文档查询可选 | 仅提交内部 verdict 的短期 capability |
| Delivery executor | 不运行 candidate code | GitHub only | 短期 GitHub App installation token |

Project checks 使用 reduced explicit environment，但仍共享 host filesystem/network permissions；只有 Forge credentials 不传入环境。优先使用 Codex sandbox 和 host 目录/进程权限。容器、轻量 VM 或远端 sandbox 是 adapter 选择，不进入领域模型；只有现有隔离无法满足某个项目的实际风险时才引入。

## 6. Review、checks 与交付

Project checks 和 reviewer 是两个独立事实。Reviewer 可以读取完整 codebase、Task Contract、diff 和 check evidence，但不继承 implementer 的辩护性对话。它必须提交结构化 verdict；review process 正常退出但没有合法 verdict 时结果是 `inconclusive`，不是批准。

所有 gate 绑定 exact Candidate SHA。新 commit 自动使旧 check、review verdict 和 attestation stale。`changes_requested` 先聚合为一个 finding batch，再激活一次 implementer；不会让每条评论分别激活 agent。重复不收敛按预算进入 blocker/diagnosis，不形成无限 review 风暴。

GitHub 是当前 forge 与交付 surface，不是核心 task domain。每个 registered Repository 只保存一个 opaque `forgeProfile` 名称；local host 在 execution boundary 将它解析为该 Repository 绑定的 GitHub App capability。Octokit 使用 GitHub App 生成短期 installation token；worker 不接触该凭据，profile secrets 不进入 Task Contract、durable facts、history、logs 或 status。branch、PR 和 review attestation projection 都有稳定 identity，crash 后先查询 GitHub 再决定是否重试。

fresh reviewer 提交的 exact-SHA `approved` verdict 是必要的 semantic approval；review process 成功退出或 delivery executor 的文字都不能替代它。Delivery executor 只能把这个已存在的 verdict 投影为 PR 上可追溯的 attestation，不能制造或改写语义批准。若仓库 ruleset 还要求 GitHub 原生 `APPROVE` review，必须由不同于 PR author/delivery identity 的 reviewer capability 提交，并作为额外 platform fact；同一 GitHub App 不得自批。Task Contract 的 `authorization.merge` 必须是 admission 时冻结的显式 authority；delivery authority 不隐含 merge authority。没有它，第一项产品行为在带 exact-SHA approval attestation 的 `reviewed_pr` 终止；有它，Forge Delivery 在 merge 前重新读取 live head、attestation 和诊断性 platform fields，向 GitHub merge endpoint 提交 approved SHA，由平台 policy 最终决定。changed head、attestation/App identity 不匹配或 proved platform refusal 都 quarantine 为 concrete blocker；lost response 先 probe，只有观察到 exact merged PR 才记录 `merged`。

## 7. Context 模型

Agent session 是可丢弃的执行缓存，不是记忆数据库。每次 activation 都从 durable artifacts 构造有界 context pack：当前 Task Contract、canonical design、repo rules、exact Git state、未解决 findings、最近一次有效 checkpoint 和本次 failure delta。

不向新 agent 倾倒整个历史 chat、旧任务树或全部研究 archive。实现者在一个连贯 run 内可以保持 warm；reviewer 默认 fresh；recovery agent 读取最后有效 checkpoint，而不是重放所有对话。长期向量记忆只有在这些 artifact 无法支撑重复恢复、且有实际遗漏数据时才考虑。

Clean-room 不等于失忆。Compact 或新实现不加载历史 archive，但 canonical corpus 必须保留：两次失败的 causal chain、已 falsified route、仍有效的 evidence、曾误导的 proxy metrics，以及当前 eligible work。这样可以删除旧代码而不重复相同的控制机制。

## 8. 深模块与 library-first 边界

模块是行为边界，并由六个真实 pnpm workspace package 物理执行：`@usine/task-authority`、`@usine/delivery-run`、`@usine/coding-session`、`@usine/candidate-workspace`、`@usine/quality-gate` 和 `@usine/forge-delivery`。CLI 与 `@usine/runtime` 只负责组合，不是第七个行为 module：

| 模块 | 隐藏的 policy | 外部 caller 只知道 | 允许的内部 seams 与 change locality |
|---|---|---|---|
| **Task Authority** | contract admission/immutability、repository writer lease、合法状态转移、接受或拒绝领域事实、exact-SHA evidence invalidation | `admit`、读取当前 Run、事务性保留或提交一个待验证领域事实 | 纯 reducer + Drizzle persistence；独占 stale-evidence acceptance policy，不 import Git、Codex、GitHub 或 subprocess |
| **Delivery Run** | deterministic reconcile 顺序、activation/review budget、retry、restart recovery、next action | `run(authorized contract)` 返回 durable task result | 一次只根据 durable facts 执行一个已保留 action；它不解析 provider events、不拼 Git argv、不调用 Octokit endpoint，也不维护第二套 replay log |
| **Coding Session** | role/profile/sandbox policy、受限 environment、prompt/context projection、structured turn lifecycle、cancel/timeout | 在一个已准备 workspace 中运行 implementer 或 fresh reviewer，并取得 provider-neutral typed observation | 当前唯一 supported adapter 使用官方 Codex SDK；thread start/run、thread ID、final schema output、usage、cancellation 和 failure 留在 adapter 内，agent result 永不授予 task terminal authority |
| **Candidate Workspace** | isolated writer worktree、explicit Git environment、host-side commit/finalize、ancestry/cleanliness、disposable exact-SHA checkout | prepare writer、freeze Candidate、以 SHA 提供 disposable checkout | 系统 Git CLI 的窄 argv adapter；不拥有 retry、review 或 delivery policy |
| **Quality Gate** | 分别产生 project check 与 fresh exact-SHA review facts，并聚合 findings | `check(candidate, contract)` 返回 exact-SHA Check Result；`review(candidate, contract, check)` 返回 fresh exact-SHA Review Verdict | 通过 Candidate Workspace 取得 checkout，通过 Coding Session 启动 reviewer；它不拥有 retry、activation 或 stale-evidence policy。Check failure 作为 fact 交给 Delivery Run，后者决定下一次 implementer activation |
| **Forge Delivery** | GitHub App auth、branch/PR/attestation identity、exact-head merge authority、probe-before-retry、ambiguous effect reconciliation | `deliver(approved exact-SHA bundle)` 返回 reviewed-PR 或 merged effect | Octokit 与 credential-scoped Git push/merge；不运行 candidate code，也不能制造 semantic approval |

依赖只向产品 policy 内侧流动：runtime 中的 local server 组合 Delivery Run 与 adapter，CLI 只依赖 typed server client；Delivery Run 独占 activation/retry/budget policy 并使用其余五个 package；Quality Gate 可以使用 Coding Session 和 Candidate Workspace。依赖图必须有向无环，生产代码和测试只能使用声明依赖的 package exports，不能穿透其它 package 的 `src` 或 `dist`。跨模块传递 Task Contract、Candidate、Check Result、Review Verdict、Delivery Effect 和 provider-neutral typed observation，不传递 HTTP request、Effect Fiber、Herdr pane、Codex thread/event/argv、Octokit response 或数据库 transaction context。每个 package 必须拥有真实 caller 与有意义的 policy；共享 option/type 归消费它的 module，Delivery Run 不接收无关的 environment 或 credential capability bundle。

### 8.1 Coding Session 的最小 contract

Coordinator 只提供 role、workspace/candidate、冻结的 Task Contract 与未解决 findings、role policy、deadline 和 output schema。Coding Session 只返回 task-oriented `run(request) -> typed observation` 的 terminal status、schema-valid final role output、usage、cancellation 或 failure。它必须支持 cancellation/timeout；provider execution lifecycle 由 adapter 拥有，其他模块看不到 Codex thread 或 event 类型。

Candidate SHA、workspace cleanliness、project checks、review freshness、delivery eligibility 和 Task terminal state都不由该 contract 决定。Codex `turn.completed` 是一次 semantic worker attempt 的完成证据，不是 Task 完成。

Implementer 的 Task/PR authority 由冻结 Task Contract 提供。可选的 GitHub context 不可用时，Task Contract 仍是足够的 authority；Coding Session 不因此等待用户，也不把 app-server 或其它 adapter 变成 task authority。

对 critical seam 比较两种 external contract：

| Contract shape | Caller knowledge | 决定 |
|---|---|---|
| **Task-oriented turn port**：`run(request) -> typed observation` | role、workspace、deadline、schema 和 domain output；不知道 process、pane、event protocol 或 provider command | **选择**。provider lifecycle 留在 adapter；Delivery Run 只根据 durable domain fact retry。 |
| **Session supervisor handle**：`start / observe / prompt / interrupt / stop` | caller 必须拥有 session state、event ordering、process cleanup 和 provider error mapping | 拒绝。它会把 Gas City/Herdr 的通用 runtime surface重新搬进 coordinator，并诱发自写 supervisor；只有同时出现第二个 runtime 和交互式 session caller 才 re-enter。 |

这个 port 是当前 domain-facing seam，不是兼容性承诺或预建 provider framework。当前 supported adapter 是 Codex；#195 已授权以验证一个静态共存的 App Server adapter，但尚未证明。Coordinator config 在 activation 前把一个 opaque named profile 解析为 exactly one supported adapter；没有 automatic fallback、registry、capability negotiation 或 automatic routing。Task Authority、Delivery Run、Candidate、Quality 和 Forge 不随 provider execution semantics 改变。

### 8.2 Reuse strategy decision

| 候选 | 可删除的自写 surface | 决定 |
|---|---|---|
| [OpenAI Codex SDK](https://developers.openai.com/codex/sdk/) | CLI argv、JSONL parser、output-schema temp plumbing、provider execution lifecycle glue | **选择**。当前 adapter 使用 thread start/run、thread ID、final schema output、usage、cancellation 和 failure；Usine 只包 role policy 与 product evidence projection。 |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) `SandboxAgent` / tracing | agent loop、sandbox capability binding、session/tracing | 不作为 V0 runtime。它适合更广泛 agent application，但会在当前一个 Codex specialist 内重复 Codex agent loop，并与 Usine task authority 重叠；sandbox capability model 只作为设计 donor。Experimental `codexTool` 不是生产依赖。 |
| Codex App Server | 独立的 JSON-RPC lifecycle client | #195 已授权但尚未证明；它可作为静态共存的 adapter，由 named profile 在 activation 前明确选择。没有 automatic fallback 或 routing，且 app-server 不能取得 task authority。 |
| [Gas City runtime/session design](https://github.com/gastownhall/gascity/blob/main/engdocs/architecture/session.md) + Herdr | runtime/session ownership ideas | 作为 donor，不采用通用 provider。Herdr pane、prompt settlement、screen state 和 rendered transcript 不进入 production correctness path；它们不能成为 completion evidence。 |
| [AgentRouter](https://github.com/perixtar/AgentRouter) / [Cezar](https://github.com/open-mercato/cezar) | persisted run/event、sandbox、multi-provider examples、worktree/event UI patterns | 不采用。前者仍为 alpha 且引入 Daytona/R2/第二套 remote database control plane，后者主要是本地 cockpit；两者都会复制当前 Task Authority/Forge ownership。只借鉴公开的 event mapping、credential separation 和 worktree examples。 |

选择 Codex SDK 作为当前 adapter，因为 #192 已证明当前 SDK lifecycle。Repository 只向 Coding Session 提供不透明的 named profile；profile 内的 model、provider、reasoning、service tier 和 credentials 不进入 Usine contract。Usine 仍独立强制 role sandbox、workspace、freshness 和 credential separation。#195 已获授权以验证静态共存的 app-server adapter，但尚未证明；它不能宣称非-Codex compatibility或取得 task authority。

默认依赖选择：

- Node 24 `node:sqlite` + Drizzle ORM/Drizzle Kit：领域模型、查询、durable transaction、attempt/effect reservation 与 code-first SQL migration；
- Zod：现有 Task Contract 外部 JSON/schema 边界；Effect 4 RC Schema：Task Authority 的不可信 durable-state decode boundary；Effect Scope、FiberMap 与 cancellation：local server composition root 的 task lifecycle、资源释放与 AbortSignal propagation。六个领域 package 不机械迁移为 Effect Service/Layer；Promise/SDK/subprocess/HTTP adapter 只在 Effect 边界桥接；
- Octokit：GitHub App authentication 与 REST/GraphQL client；
- `@openai/codex-sdk`：当前唯一 supported coding-agent adapter；Execa 只用于 Git 和项目命令；`ai` + `@ai-sdk/openai`：可选的 final role-output normalization；
- Vitest：公共行为测试，SQLite public-seam tests 覆盖独立连接与 hard-kill recovery；
- Vite+：workspace 唯一的 format、lint、type-check、test 与 package command/config surface；其内部使用 tsdown、Oxlint、Oxfmt 与 Vitest；`vp check` 的 type-check 独立于 `vp pack`。

Git 操作调用系统 Git CLI，通过一个窄 adapter 组装 argv 和解析结构化结果；不实现 Git object plumbing。原始 SQL 只允许用于 ORM 无法表达且有实际性能/一致性证据的局部语句，并必须在 PR 中说明原因。不得用手写 trigger/catalog fingerprint 模拟 ORM 或 migration engine，也不得把 deterministic reconciler扩张成通用 scheduler、queue 或 workflow engine。

官方能力依据：Node 24 `node:sqlite` transaction 和 SQLite file locking 提供当前单 Task/单 writer 所需的原子事实保留；Drizzle Kit 提供 schema-derived SQL migration；Octokit 可代管 GitHub App JWT 和 installation token 生命周期。恢复由同一 Delivery Run reconcile 函数重读这些事实完成，不另存 operation-index replay。

## 9. 衡量与扩大

首条纵切只记录能回答核心优化目标的事实：是否形成 accepted outcome、human activation、端到端时间、成本、返修次数和 blocker。观察到具体瓶颈后再增加诊断指标，不预建通用 metrics surface，也不设置 10、30、50、100、300 之间的人工阶段门。

Hard-kill recovery 不复用可能仍在写入的 workspace。每个 activation 取得 monotonic fence token 和独立 workspace；Task Authority 只接受当前 token 冻结的 Candidate。旧进程即使短暂存活也只能写旧 workspace，其 output/Candidate 被拒绝并 quarantine，随后由 host cleanup。Restart 恢复同一 Task/repository lease，但 fresh retry 使用新的 activation token；一个 lease 只允许一个 Task 拥有 repository publish authority，不允许两个进程并发共享目录或 Candidate 权限。

当前状态与 eligible work：

| Evidence / outcome | 当前边界 |
|---|---|
| #82/#83 | 真实 Codex executable delivery 与 restart evidence；不证明第二 runtime 或多 Task capacity。 |
| #153 | stubbed Codex adapter 的 persistent-server lifecycle fixture；不证明 production Codex turn。 |
| #192/#193 | 已合并，证明当前 SDK lifecycle 与 attestation facts。 |
| #195 | 已授权的 app-server runtime outcome，尚未证明；app-server 不能取得 Task authority。 |
| #176 | 第一项真实 persistent-server delivery 的 falsifier；当前 classification 为 `correct_before_expansion`。 |
| #178 / #151 | 分别在 pilot/measured need、真实 retryable sample 出现前不 eligible。 |
| #187 / #188 / #189 | 分别拥有独立 future outcome；transient order 不构成永久 architecture。#188 resource CLI 尚未完成。 |

Eligibility 仍按 active falsifier/safety-authority defect > accepted-outcome critical path > representative real task > measured bottleneck > cleanup；证据保持 serial，每个 repository 一个 writer lease。Herdr、transcript、process state 和 adapter prose 不能恢复 product completion authority；probe-before-retry 与 deterministic reconciliation 仍由 durable facts 决定。
