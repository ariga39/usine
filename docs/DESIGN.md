---
status: current
design_version: 0.1
updated: 2026-08-17
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

这张图描述选定的最小目标，不是已经实现全部能力的声明。当前仓库已实现 runtime，fake-backed CLI seam 已覆盖 candidate→check→review→exact-SHA gate 全路径；live evidence 目前部分覆盖 candidate、check 和 reviewer execution，但 reviewed-PR/GitHub delivery 仍未证实。DBOS + Drizzle 恢复、Codex structured subprocess、workspace fence/sandbox 和 GitHub effect reconciliation 仍需继续用真实的薄纵切做 characterization 和 integration 验证。第一条纵切只运行一个 Task、一个 repository 和一个 writer；project queue/lane 与容量扩展不能成为它的前置工程。

Artifact coupling 很强：Task Contract、base SHA、candidate SHA、check evidence、review verdict 和投影出的 attestation 都可追溯且不可被聊天静默改写。

Activation coupling 很弱：普通消息不会广播唤醒其他角色；只有持久化状态变化让协调器激活一个明确的 next owner。系统借此保留 Raft 体验中“有序激发”的优点，并在首条纵切稳定后允许不同项目 lane 并行。

## 4. 权威与状态

### 4.1 确定性控制面

顶层不需要 LLM 界面，也不存在永久 Chief Agent。协调器是普通 TypeScript 程序；DBOS 提供 durable workflow、queue、timer、checkpoint 和 restart recovery。协调器只做机械且可审计的决定：admit、lease、activate、wait、retry、invalidate stale evidence、reduce gates 和 publish effects。

V0 的 LLM 只承担必须依赖语义判断的 Implementer、Reviewer，以及出现冲突时的有界诊断。未来的 Requirement Proxy 和 Planner 只能从同一个 admission seam 生成待授权 contract，不能绕过授权或直接修改 task lifecycle。任何 LLM 都不能用自然语言宣布终态。

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

第一条完整纵切串行运行一个 Task。它稳定后，最先允许的并发分片才是项目：不同 repository 可以同时推进，同一 repository 只有一个有效 write generation。每个 generation 使用独立 writable workspace 和 monotonic fence；review 使用另一个 fresh checkout，不继承 implementer 对话、未提交文件和可写 ref。

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

## 8. 深模块与 library-first 边界

以下是职责边界，不预先等同于 npm package。只有当边界能让两个任务独立开发或隐藏真实复杂度时才拆 package：

- **admission**：验证并冻结 Task Contract；
- **coordination**：DBOS workflow 与 gate policy；
- **workspace/runtime**：workspace lease、Codex process 和 observation；
- **quality**：project checks、review verdict 与 finding aggregation；
- **delivery**：GitHub App、PR/attestation/effect reconciliation；
- **operations**：首条纵切所需的配置、预算/kill switch 和最小可诊断日志。

默认依赖选择：

- DBOS TypeScript SDK：workflow、queue、timer、deduplication 和 restart recovery；
- PostgreSQL + Drizzle ORM/Drizzle Kit，并使用 DBOS 官方 Drizzle datasource：领域模型、查询、durable transaction 与 code-first SQL migration；
- Zod：外部 JSON/schema 边界；
- Octokit：GitHub App authentication 与 REST/GraphQL client；
- Execa：Codex、Git 和项目命令的有界 subprocess；
- Pino：结构化日志；
- Vitest：公共行为测试，Testcontainers 仅用于必要的真实 PostgreSQL integration；
- tsdown：所有 workspace package 的 TypeScript build；DBOS runtime package 使用 `unbundle: true`，不 bundle workflow；
- oxlint + oxfmt：仓库唯一的 lint 与 format 工具；TypeScript `--noEmit` 独立负责 typecheck。

Git 操作调用系统 Git CLI，通过一个窄 adapter 组装 argv 和解析结构化结果；不实现 Git object plumbing。原始 SQL 只允许用于 ORM 无法表达且有实际性能/一致性证据的局部语句，并必须在 PR 中说明原因。不得再用手写 trigger/catalog fingerprint 模拟 ORM、migration engine 或 DBOS 已提供的能力。

官方能力依据：DBOS 已提供可恢复 workflow、带并发控制的 durable queue 和 Drizzle datasource；Drizzle Kit 提供 schema-derived SQL migration；Octokit 可代管 GitHub App JWT 和 installation token 生命周期。DBOS workflow 依赖 runtime registry，不能被常规 bundler 合并；tsdown 因而只以 unbundle 模式编译 DBOS runtime 的逐模块输出。

## 9. 衡量与扩大

首条纵切只记录能回答核心优化目标的事实：是否形成 accepted outcome、human activation、端到端时间、成本、返修次数和 blocker。观察到具体瓶颈后再增加诊断指标，不预建通用 metrics surface，也不设置 10、30、50、100、300 之间的人工阶段门。

首条纵切稳定后，提高容量的默认顺序是增加互不冲突的项目 lane，而不是增加单个 task 内的 agent 发言者。只有单主机资源、DBOS queue 或 forge API 成为实测瓶颈时，才讨论更多 runner、分布式部署或 forge 替代。
