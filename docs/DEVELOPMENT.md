---
status: current
updated: 2026-08-17
issue: https://github.com/ariga39/usine/issues/1
---

# 开发 Usine 的工作协议

本文约束的是我们如何开发 Usine，而不是 Usine 将来如何编排用户项目。它直接针对上一轮实施暴露的问题：compact 后原则丢失、未使用 Git、局部底层细节吞噬主路线、任务无法真正并排、review 无界扩张，以及大量文档彼此争夺权威。

## 1. 权威文档与恢复顺序

只有 `AGENTS.md`、`docs/DESIGN.md`、本文和 `docs/DECISIONS.md` 可以定义当前方向。README 只做导航和诚实的实现状态说明。Issue/PR 定义一项具体开发工作的授权范围，但不能静默推翻 canonical design。

任何 agent 在以下时刻必须重新执行 context bootstrap：新 session、compact 后、从其他 agent 接手、用户纠偏后、切换 Issue 或工作树后：

```text
read AGENTS + DESIGN + DEVELOPMENT + DECISIONS
        ↓
read active Issue / PR / unresolved review threads
        ↓
inspect branch + base SHA + status + diff
        ↓
restate current outcome and next observable action
```

如果 summary、旧 handoff、自然语言记忆和 Git/Issue 不一致，以 Git、Issue 和 canonical docs 为准。先报告冲突，再继续；不依靠猜测补全。

### Compact 后的机械提醒

仓库规则是正确性的第一层；Codex hook 是低成本提醒层：

- `PostCompact` 应提醒主 agent 重新读取四份 canonical 文档、当前 Issue/PR 和 Git 状态；
- hook 不自动修改文件、不总结设计，也不把旧 session summary 提升为权威；
- hook 丢失只意味着少一次提醒，不能让流程失去恢复能力；
- 方向发生重大变化或同一工作经历多次 compact 时，优先生成短 handoff 并开新 session，不无限延长已被旧假设污染的 thread。

Handoff 放在临时 `.tasks/HANDOFF.md`，只记录：当前 Issue/PR、branch/base/head、已完成的可验证事实、未完成 outcome、blocker、下一条命令或动作。重要决定必须先进入 `DECISIONS.md` 或 Issue，不能只留在 handoff。

### Context 与模型配置边界

Context window 和 model catalog 会随客户端、账户和供应商变化，不属于 canonical architecture。主编排者可以在 task-local profile 中选择当前支持且成本可接受的较大 window；implementer 和 reviewer 使用 role-sized context，不继承主编排 thread。具体 model slug、window 数值、订阅容量和 benchmark 结论只进入本地配置或当前 Issue evidence，并在客户端/model 升级后重新验证。

更大的 window 只是性能优化，可能同时保留更多过期讨论并增加输入成本。原则恢复始终依赖 canonical files + GitHub/Git bootstrap；policy 保持单一来源，不靠重复 prompt 或固定模型参数维持。

## 2. GitHub Issue → branch/worktree → PR

除空仓库 root commit 外，不在 main 直接开发。

1. 创建一个有明确 outcome、scope、non-goals、acceptance 和 `first_merge_checkpoint` 的 GitHub Issue。Outcome 必须是最小可独立使用、验证和回滚的行为；更大的 product milestone 通过后续串行 Issue/PR 继续，不得成为一次大 PR 的理由。
2. 从最新 main 创建 `agent/<issue>-<slug>` branch；并排任务使用独立 worktree。
3. 每个 branch 只实现一个 Issue。实现 agent 只写该任务声明的 surfaces。
4. 以小 commit 推进；第一个可检查状态立即提交并 push，不把数小时工作只留在本地。
5. 首次 push 后立即创建小而聚焦的 draft PR。PR 必须引用 Issue，并说明变化、原因、用户影响和验证；后续 checkpoint 持续 push，不能等最终 review 才让代码可见。
6. scoped review/fix 在同一 PR 收敛；checks 与 fresh semantic verdict 通过后由 orchestrator 自动 merge，并继续下一项已授权 Issue，不等待用户监督。

GitHub Issue 是任务事实源。`.tasks/*.md` 只是给 agent 的本地执行投影，必须包含 Issue URL、exact base SHA、目标、允许写入范围、non-goals、验收、`first_merge_checkpoint` 证据与停止条件；它被 gitignore，不积累成第二套任务系统。

## 3. 有界并排开发

主编排者初期最多同时拥有两个 active implementation PR。这不是产品容量限制，而是当前单一 orchestrator 的注意力 fence。

在第一条完整 user-visible 纵切进入 main、共享 seam 仍未由代码固定之前，实施必须串行。两项上限只是允许并排的 fence，不是当前已经具备并行开发能力的声明。

只有满足以下条件才并排：

- 两项工作具有独立 user-visible outcome；
- writable file/package ownership 不重叠；
- 共享接口已经在 main 或先行 PR 中固定；
- 两个 agent 使用不同 worktree、branch、task file 和 commit；
- 任一任务失败不会要求另一个 agent 重写未合并基础。

若只是把一个紧耦合功能机械拆给两个 agent，会把节省的墙钟时间变成 merge、沟通和返工成本，应串行。主编排者不亲自同时深写两个任务；它负责边界、进度、integration 和纠偏。每完成一项才从 Issue 队列补下一项。

### Continuation 与完成条件

用户不需要发送 Codex `/goal` 或重复“继续”。GitHub Issue、canonical docs、Git state 和 PR gate 定义 durable continuation；主编排者负责跨 turn、验证 checkpoint、review/fix、merge 和下一项工作的自主推进。Codex `/goal` 只可作为内部运行机制，不能成为用户监督前置条件，也不得覆盖 Issue scope、自动吸收 backlog 或绕过 Git/PR 流程。

每项工作仍须明确 objective、non-goals、可验证进展、最终停止条件和真正需要暂停的 blocker。状态汇报不是停止；只有 acceptance 已验证，或确实出现新的 product/authority decision、不可逆外部选择或缺失必要输入时才找用户。

### Role model routing

- implementation：每个 Issue 新建一个 Herdr pane 和新 Codex agent，并通过 `-p usine-implementer` 启动；profile 固定 GPT-5.6 Luna high、default service tier、workspace-write，禁止 fast；Issue 的 first merge checkpoint 合并后释放该 agent/pane，绝不跨 Issue 复用 implementer；
- semantic review：fresh Sol session，只读 exact candidate，不继承 implementer chat；
- bounded research：需要独立 read-only evidence 时可用 Terra；
- 仅当 Herdr 本身不可用时，才直接运行 `codex exec -p usine-implementer`；authentication、permission、model 或 profile failure 不得绕过既定 launcher，也不得静默退回默认模型或 fast。

## 4. Library-first，而不是 abstraction-first

在编写 scheduler、queue、retry、migration、ORM、GitHub auth、process runner、logging、schema validation 或测试容器代码前：

1. 查看 canonical dependency decision；
2. 读取候选库当前官方文档；
3. 用最薄调用路径确认它覆盖当前行为；
4. 只为产品特有 policy 写代码。

如果决定自写，PR 必须列出被拒绝的成熟库、当前缺口和自写代码的删除边界。“可能以后更灵活”不是理由。不要为了包数量制造接口；一个 module 只有在隐藏复杂度、稳定 caller 或允许真正独立开发时才成立。

数据库默认使用 Drizzle schema、ORM 和 Drizzle Kit migration，并通过 DBOS 官方 Drizzle datasource 执行需要 exactly-once checkpoint 的领域 transaction。DBOS system state 由 DBOS 管理；Usine 只保存产品需要查询和展示的少量领域事实。生产和 CI 使用 committed migration，不使用 `drizzle-kit push` 代替可审查的 migration。避免 hand-written repository boilerplate、重复 JSON shape checks、触发器状态机和 catalog fingerprint 测试。

### TypeScript 工具链

- 根 workspace 统一提供 `lint`（oxlint）、`format`/`format:check`（oxfmt）、`typecheck`（TypeScript `--noEmit`）和 `build`（tsdown）；实现 PR 的默认 checks 复用这些命令。
- oxlint 与 oxfmt 使用各自一份 root config。没有当前规则或语言缺口的证据，不引入 ESLint、Prettier 或第二套 formatter/linter。
- tsdown 是唯一的 emit/build 工具，但不是 typechecker。Build 和 typecheck 是两个独立信号；不得因为 tsdown 成功而省略 `typecheck`。
- 普通 library package 可使用 tsdown 默认 external dependency 行为；包含 DBOS workflow/runtime registry 的 package 必须使用 `unbundle: true`，保持逐模块输出，不得把 workflow bundle 到单文件。
- 初期直接使用 pnpm workspace scripts 编排 checks/build。只有观测到 monorepo task latency 或 cache 成为瓶颈时，才考虑 Turborepo、Nx 或另一层 build orchestrator。

## 5. 纵切优先与复杂度预算

每个 PR 应尽量完成一个可从公共入口观察到的行为。内部基础工作只有在下一条纵切直接使用它时才单独存在。

默认选择最小可合并 PR，而不是把一条路线的所有后续能力塞进一次“大而全”交付。若一个 diff 已经包含多个可独立验证、可独立回滚的 outcome，应拆成串行小 Issue/PR；不要用 stacked-PR 管理本身制造新的协调负担。

`first_merge_checkpoint` 是确定性切分点：一旦它的 scoped tests/checks 通过，必须先 commit、push、开 PR、focused review 和 merge；later recovery mode、相邻 adapter 或更完整 product milestone 进入下一 Issue。Reviewer 只能用当前 Issue acceptance 和 canonical invariant 阻塞该 PR；不使当前 claim 失真的 concern 必须另开 Issue，不能延长当前 branch。

出现以下情况时停止扩张，先提交 decision note 或缩小方案：

- 为当前 Issue 新增第二种 runtime、forge、database 或 sandbox adapter；
- 创建没有当前生产 caller 的通用 interface；
- 测试数量增长，但 Issue 的端到端状态没有前进；
- first merge checkpoint 已 green，但代码仍只在本地或 reviewer 正按最终 milestone 扩大当前 PR；
- reviewer 要求证明部署威胁模型之外的敌对环境；
- 一个修复引入新的 task tree 才能解释它；
- agent 连续长时间 reasoning 而没有 tool call、diff、测试结果或其他可验证进展。

对容易无限规划的模型，bootstrap 任务必须缩成一个可落地制品；若约十分钟或约 8k reasoning tokens 仍无 action，终止 run，保留诊断并用更小 task 或更果断的模型重启。不要继续为已经失去收敛性的 session 付 token。

## 6. 测试哲学

TDD 是工具，不是宗教：

- 已知 contract、纯 domain policy、状态不变量和 bug regression：先写失败测试；
- 第三方 integration 或尚不确定的 API shape：先建立最薄 smoke/characterization，再固定真正依赖的行为；
- subprocess、Git、database 和 forge：大多数测试通过 adapter fake，保留少量真实 integration；
- 测试公共行为和 authority boundary，不锁死内部函数、SQL 文本、migration catalog 或每一种想象中的 hostile fixture；
- 发现真实 failure class 后再增加对应测试，不预付无限 threat matrix。

一个绿测试不能证明用户 outcome，测试套件也不能代替独立 review。反过来，reviewer 不负责解释 pipeline 失败；机器失败先聚合给 implementer。

## 7. Review 与 clean-room 预算

Review 要求高于实现，但 review 本身也必须有 scope 和成本预算。

- 设计、架构、权限、安全和跨模块 PR 使用 fresh reviewer；普通局部 PR 可按风险选择 focused reviewer。
- 给 reviewer 完整 codebase 访问，但只提供 canonical docs、Issue、candidate diff 和相关 evidence；不要把作者 chat、全部历史 archive 和旧任务文档塞入 context。
- 第一次 review 检查 Issue outcome、canonical invariants、回归和明显缺口。
- 修复后只做 delta review：验证原 findings、修改 surfaces 和新回归。只有 correctness/security/authority blocker 可以扩大范围；其它建议进入新 Issue。
- 默认最多一次 primary review 和一次 delta review。重复同类分歧进入诊断或用户裁决，不继续开无界 reviewer 链。
- clean-room 方向审查按触发条件运行，而不是按每个 PR 运行：canonical design 大改、连续三个 PR 没有推进用户可见纵切、出现第二套权威文档、或主编排者经历多次 compact 后无法解释当前路线。
- 多模型审查不是投票。只有不同模型提供了真正独立的 failure lens 时才花费额外 quota；限额本身是系统约束，不以“再找一个 agent”掩盖。

### 独立方向审计 checkpoint

以下 checkpoint 必须完成一次 clean-room 方向审计：

1. 新的 canonical design 在标记 ready/merge 前；
2. 第一条完整的 task → implementation → checks → independent review → reviewed PR 纵切完成后，在增加通用架构、容量或自动 merge 权限前；
3. 增加第二种 runtime/forge、分布式 runner、扩大 worker/delivery 权限，或把主编排开发并发提高到两个以上之前；
4. 提前触发条件出现时：连续三个 PR 没有推进用户可见 outcome、canonical authority 冲突、重复 compact 后路线无法解释，或实现再次被底层基础设施/测试矩阵吞噬。

Checkpoint 不暂停已经安全、有效的真实任务流；它只阻止继续扩大架构、权限或容量，直到方向 blocker 被处理。

审计程序：

1. 主编排者在临时 clean-room 目录准备有界 evidence packet：四份 canonical 文档、当前 Issue/PR 索引、实际已实现能力、最近纵切证据与 metrics、待审问题。不得包含作者 chat、旧 task tree 或整个历史 archive。
2. 审计者必须是未参与当前设计/实现的 fresh session。设计方向审计默认只看 packet；若需要验证“代码确实这样工作”的 claim，再提供 exact SHA 的只读 checkout，而不是作者 worktree。
3. Prompt 固定要求检查：目标是否被 proxy goal 替代、哪些复杂度可以删除、library 是否被重复实现、开发是否真实可并排、证据是否支持当前 claim、下一条最短用户可见纵切是什么，以及反对当前路线的最强论据。
4. 报告输出 `continue`、`correct_before_expansion` 或 `stop_and_redesign`，并把 finding 区分为 direction blocker、current-PR defect 和 later concern。
5. 主编排者必须把 direction blocker 映射到当前 PR 修订、一个新 Issue 或用户 decision。完成后最多做一次 focused delta audit；later concern 不得无限延长当前 checkpoint。

Self-review、普通 code review、更多测试或一份主编排者总结都不能代替该 checkpoint。默认只用一个匹配能力的独立审计者；只有高风险分歧无法裁决时才增加第二视角，避免审计本身成为 quota 黑洞。

## 8. 文档生命周期

不复制旧任务树和旧实现报告。本仓库从零开始，历史 clean-room archive 保存在仓库外，只用于追溯，不参与 agent 默认 context。

- 当前架构变化：修改 `DESIGN.md`；
- 持久技术选择：修改 `DECISIONS.md`，明确 supersedes/re-entry；
- 开发流程变化：修改本文和必要的 `AGENTS.md`；
- 一项具体工作：GitHub Issue/PR；
- 临时 prompt、checkpoint、handoff：`.tasks/`，不提交；
- 研究笔记和 benchmark 原始输出：只在当前 decision 需要时作为 PR evidence，不成为新的权威设计。

每次 compact 后重读的是这套小 corpus，而不是不断增长的历史。文档的价值在于降低恢复成本和防止漂移，不以数量衡量。
