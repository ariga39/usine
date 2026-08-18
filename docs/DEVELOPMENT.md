---
status: current
updated: 2026-08-18
issue: https://github.com/ariga39/usine/issues/1
---

# 开发 Usine 的工作协议

本文约束的是我们如何开发 Usine，而不是 Usine 将来如何编排用户项目。它直接针对上一轮实施暴露的问题：compact 后原则丢失、未使用 Git、局部底层细节吞噬主路线、任务无法真正并排、review 无界扩张，以及大量文档彼此争夺权威。

## 1. 权威文档与恢复顺序

只有 `AGENTS.md`、`docs/DESIGN.md`、本文和 `docs/DECISIONS.md` 可以定义当前方向。`docs/agent-software-factory/codex-unattended-development-harness.md` 是从外部 harness 选择性提炼的简短操作指南，primary development orchestrator 每次 bootstrap/compact 后必须完整读取；它不是第五份设计权威，也不导入外部 harness 的完整命令、工具版本或流程。它与 canonical files、active Issue 或 Git state 冲突时以后者为准。README 只做导航和诚实的实现状态说明。Issue/PR 定义一项具体开发工作的授权范围，但不能静默推翻 canonical design。

任何 agent 在以下时刻必须重新执行 context bootstrap：新 session、compact 后、从其他 agent 接手、用户纠偏后、切换 Issue 或工作树后：

```text
read AGENTS + DESIGN + DEVELOPMENT + DECISIONS
        ↓
primary orchestrator reads unattended-development harness
        ↓
read active Issue / PR / unresolved review threads
        ↓
inspect branch + base SHA + status + diff
        ↓
identify active falsifier + eligible task class + cluster owner
        ↓
restate why the task is eligible and its next observable action
```

如果 summary、旧 handoff、自然语言记忆和 Git/Issue 不一致，以 Git、Issue 和 canonical docs 为准。先报告冲突，再继续；不依靠猜测补全。

### Compact 后的机械提醒

仓库规则是正确性的第一层；Codex hook 是低成本提醒层：

- `PostCompact` 应提醒主 agent 重新读取四份 canonical 文档、repository unattended-development harness、当前 Issue/PR 和 Git 状态；
- hook 不自动修改文件、不总结设计，也不把旧 session summary 提升为权威；
- hook 丢失只意味着少一次提醒，不能让流程失去恢复能力；
- 方向发生重大变化或同一工作经历多次 compact 时，优先生成短 handoff 并开新 session，不无限延长已被旧假设污染的 thread。

Handoff 放在临时 `.tasks/HANDOFF.md`，只记录：当前 Issue/PR、branch/base/head、已完成的可验证事实、未完成 outcome、active falsifier、eligible task class、behavior-cluster owner、blocker、下一条命令或动作。重要决定必须先进入 `DECISIONS.md` 或 Issue，不能只留在 handoff。

### 两次失败留下的控制约束

第一次实现把未知 seam 过早写成详细 package/interface/test contract，得到局部完整但距离交付很远的 admission。第二次实现把最短纵切、小 PR、测试全绿和文件变短提升为控制指标，第一个纵切形成 runtime/test monolith，后续任务只能机械搬移或继续补丁。两次失败的共同原因不是模型、TDD、monorepo 或 Herdr 单独失效，而是没有角色对 behavior cluster 的 module depth、seam 和 change locality 负责，且局部 Issue acceptance 可以覆盖全局证伪证据。

因此 compact 后不加载外部历史报告或旧 task tree，但必须从本 corpus 恢复四项约束：未知 seam 不事前过度规定；纵切不能成为 monolith 豁免；active falsifier 控制调度资格；小 PR、绿测试、文件和提交数量都只是 evidence，不是 outcome。

### Context 与模型配置边界

Context window 和 model catalog 会随客户端、账户和供应商变化，不属于 canonical architecture。主编排者可以在 task-local profile 中选择当前支持且成本可接受的较大 window；implementer 和 reviewer 使用 role-sized context，不继承主编排 thread。具体 model slug、window 数值、订阅容量和 benchmark 结论只进入本地配置或当前 Issue evidence，并在客户端/model 升级后重新验证。

更大的 window 只是性能优化，可能同时保留更多过期讨论并增加输入成本。原则恢复始终依赖 canonical files + GitHub/Git bootstrap；policy 保持单一来源，不靠重复 prompt 或固定模型参数维持。

## 2. GitHub Issue → branch/worktree → PR

除空仓库 root commit 外，不在 main 直接开发。

1. 创建一个有明确 outcome、scope、non-goals、acceptance、draft checkpoint 和 merge gate 的 GitHub Issue。Outcome 通常是最小 coherent module behavior 或 user-observable behavior，可独立使用、验证和回滚。Issue #76 授权其后唯一一次 full-refactor Issue/PR：用小提交逐 cluster 替换并删除旧 seam，不拆成会固化过渡接口的新 backlog；这不是以后大 PR 的通用先例。
2. 从最新 main 创建 `agent/<issue>-<slug>` branch；并排任务使用独立 worktree。
3. 每个 branch 只实现一个 Issue。实现 agent 只写该任务声明的 surfaces。
4. 以小 commit 推进；第一个可检查状态立即提交并 push，不把数小时工作只留在本地。第一处 green 只满足 draft checkpoint，不自动满足 merge gate。
5. 首次 push 后立即创建小而聚焦的 draft PR。PR 必须引用 Issue，并说明变化、原因、用户影响和验证；后续 checkpoint 持续 push，不能等最终 review 才让代码可见。
6. scoped review/fix 在同一 PR 收敛；coherent outcome、checks、spec/correctness verdict 和适用的 design verdict 全部通过后由 orchestrator 自动 merge，并继续下一项 eligible Issue，不等待用户监督。

GitHub Issue 是任务事实源。`.tasks/*.md` 只是给 agent 的本地执行投影，必须包含 Issue URL、exact base SHA、目标、允许写入范围、non-goals、active falsifier 状态、behavior-cluster owner、draft checkpoint、merge gate 与停止条件；它被 gitignore，不积累成第二套任务系统。

所有 committed files 与 GitHub durable surfaces 都必须使用 repository-relative paths 或明确占位符；不得写入本地绝对路径、用户名、home-directory name、hostname 或其它 machine-specific identifier。运行所需的本地路径只允许留在未提交的 `.tasks/` 或进程参数中，任何复制到 Issue、PR、review/comment 或 completion evidence 的内容都必须先清理。

## 3. 有界并排开发

当前 classification 是 `correct_before_expansion`。只允许一个 full-refactor implementation PR 串行运行；完成 representative executable code task 与 induced live coordinator restart recovery 后，最多同时拥有两个 active implementation PR。这不是产品容量限制，而是当前单一 orchestrator 的注意力 fence。

恢复 implementation 后，在完成 representative executable code task 与 induced live coordinator restart recovery 之前必须串行。两项上限只是满足该证据门槛及下列条件后允许并排的 fence，不是当前已经具备并行开发能力的声明。

只有满足以下条件才并排：

- 两项工作具有独立 user-visible outcome；
- writable file/package ownership 不重叠；
- 共享接口已经在 main 或先行 PR 中固定；
- 两个 agent 使用不同 worktree、branch、task file 和 commit；
- 任一任务失败不会要求另一个 agent 重写未合并基础。

若只是把一个紧耦合功能机械拆给两个 agent，会把节省的墙钟时间变成 merge、沟通和返工成本，应串行。主编排者不亲自同时深写两个任务；它负责边界、进度、integration 和纠偏。每完成一项才从 Issue 队列补下一项。

### Continuation 与完成条件

用户不需要发送 Codex `/goal` 或重复“继续”。GitHub Issue、canonical docs、Git state 和 PR gate 定义 durable continuation；主编排者负责跨 turn、验证 checkpoint、review/fix、merge 和下一项工作的自主推进。Codex `/goal` 只可作为内部运行机制，不能成为用户监督前置条件，也不得覆盖 Issue scope、自动吸收 backlog 或绕过 Git/PR 流程。

当授权中的 active Issue 尚未达到 stopping condition 时，回答任何 interim status、confirmation 或 clarification interruption 后，必须在同一 turn 恢复下一项安全且仍在 scope 内的动作。

每项工作仍须明确 objective、non-goals、可验证进展、最终停止条件和真正需要暂停的 blocker。状态汇报不是停止；只有 acceptance 已验证，或确实出现新的 product/authority decision、不可逆外部选择或缺失必要输入时才找用户。

### Role model routing

- implementation：只允许 Issue #76 后的一个 full-refactor task；fresh worker、GPT-5.6 Luna high、default service tier、workspace-write、禁止 fast。Model slug 是当前用户指定的 deployment/task constraint，不是跨模块 runtime type。Provider-neutral Coding Session 的当前 production adapter使用 Codex SDK；Herdr/transcript 不参与 completion authority；
- semantic review：fresh Sol session，只读 exact candidate，不继承 implementer chat；
- bounded research：需要独立 read-only evidence 时可用 Terra；
- 轻量 classification/extraction/normalization 使用 schema-constrained OpenAI-compatible API，不加载 coding-agent runtime；它不能承担 repository work、completion authority 或 semantic review。

## 4. Falsifier、任务优先级与设计责任

任务不是 flat backlog。调度顺序固定为：

```text
active falsifier / safety-authority defect
> accepted-outcome critical path
> representative real task
> measured bottleneck
> cleanup / aesthetics
```

高优先级 failure class 未解除时，低优先级 Issue 不 eligible；不能以局部 acceptance、non-goal、测试全绿或“本 PR 只做移动”绕过。一个 falsifier 只能由其 decision 指定的真实 evidence 解除。方向审计发现 blocker 后，必须同步改变 eligible queue，而不是只生成更多 flat Issues。

每个 active behavior cluster 指定一名临时 design owner。Owner 维护一个小的 module map、external interface、internal seams、interface-level tests、待删除旧 code/tests，以及 PR slice 的 coherence；不要求 owner 亲自实现全部 PR，但 ownership 必须明确交接。

以下事件触发一次独立 design review，而不是每个 PR 都做架构审批：首次实现 behavior cluster；新增 package/interface；同一大文件连续三个 PR 被修改；同一 policy 在三个位置出现；真实 falsifier 要求改变 transport/lifecycle。Design reviewer 可以跨当前 Issue non-goals，只回答 seam、interface depth、caller knowledge、change locality 和 replacement/deletion plan。Spec/correctness reviewer 仍回答当前功能和回归；两个 verdict 不能互相替代。

## 5. Library-first，而不是 abstraction-first

在编写 scheduler、queue、retry、migration、ORM、GitHub auth、process runner、logging、schema validation 或测试容器代码前：

1. 查看 canonical dependency decision；
2. 读取候选库当前官方文档；
3. 用最薄调用路径确认它覆盖当前行为；
4. 只为产品特有 policy 写代码。

如果决定自写，PR 必须列出被拒绝的成熟库、当前缺口和自写代码的删除边界。“可能以后更灵活”不是理由。不要为了包数量制造接口；一个 module 只有在隐藏复杂度、稳定 caller 或允许真正独立开发时才成立。

数据库默认使用 Drizzle schema、ORM 和 Drizzle Kit migration，并直接使用 PostgreSQL transaction 原子地保留 task lease、attempt fence、effect identity 和领域 observation。Delivery Run 每次只根据已持久化事实决定并执行一个 next action；进程重启重走同一 reconcile 路径，不保存第二套 operation replay。生产和 CI 使用 committed migration，不使用 `drizzle-kit push` 代替可审查的 migration。避免 hand-written repository boilerplate、重复 JSON shape checks、触发器状态机和 catalog fingerprint 测试。当前单 Task/单 runner 不引入 queue/workflow engine；多个 runner、durable delayed scheduling 或实测 polling/竞争瓶颈出现时，先评估成熟库，不扩张自制 scheduler。

### TypeScript 工具链

- 根 workspace 统一提供 `lint`（oxlint）、`format`/`format:check`（oxfmt）、`typecheck`（TypeScript `--noEmit`）和 `build`（tsdown）；实现 PR 的默认 checks 复用这些命令。
- oxlint 与 oxfmt 使用各自一份 root config。没有当前规则或语言缺口的证据，不引入 ESLint、Prettier 或第二套 formatter/linter。
- tsdown 是唯一的 emit/build 工具，但不是 typechecker。Build 和 typecheck 是两个独立信号；不得因为 tsdown 成功而省略 `typecheck`。
- 普通 library package 使用 tsdown 默认 external dependency 行为；只有真实 runtime 约束需要逐模块输出时才开启 `unbundle`，不为已经删除的 framework 保留 build 特例。
- 初期直接使用 pnpm workspace scripts 编排 checks/build。只有观测到 monorepo task latency 或 cache 成为瓶颈时，才考虑 Turborepo、Nx 或另一层 build orchestrator。

## 6. 纵切优先与复杂度预算

每个 PR 应尽量完成一个可从公共入口观察到的行为。内部基础工作只有在下一条纵切直接使用它时才单独存在。

默认选择最小 coherent PR，而不是把一条路线的所有后续能力塞进一次“大而全”交付。若一个 diff 已经包含多个可独立验证、可独立回滚的 outcome，应拆成串行小 Issue/PR；不要用 stacked-PR 管理本身制造新的协调负担。小并不等于 mergeable：package/file movement、机械等价和行数下降只有在删除旧 seam、减少 caller knowledge 或显著集中 future change 时才构成 outcome。

Draft checkpoint 与 merge gate 分离：第一处 scoped green 必须先 commit、push、开 draft PR，使工作可见且可恢复；它不自动授权 merge。只有 Issue 的 coherent module behavior 或 user-observable behavior 完成，且适用的 spec/correctness 与 design gate 都通过，才可 merge。相邻独立 outcome 仍进入下一 Issue；但 active falsifier、module-depth blocker 和使当前 seam 不值得继续承载行为的 finding 不能降级为 later concern。

出现以下情况时停止扩张，先提交 decision note 或缩小方案：

- 为当前 Issue 新增第二种 runtime、forge、database 或 sandbox adapter；
- 创建没有当前生产 caller 的通用 interface；
- 测试数量增长，但 Issue 的端到端状态没有前进；
- draft checkpoint 已 green，但代码仍只在本地；
- merge claim 只有文件变短、物理移动、测试数量或机械等价 evidence；
- active falsifier 存在，而当前任务不 characterize、delete、replace 或 repair 它；
- reviewer 要求证明部署威胁模型之外的敌对环境；
- 一个修复引入新的 task tree 才能解释它；
- agent 连续长时间 reasoning 而没有 tool call、diff、测试结果或其他可验证进展。

对容易无限规划的模型，bootstrap 任务必须缩成一个可落地制品；若约十分钟或约 8k reasoning tokens 仍无 action，终止 run，保留诊断并用更小 task 或更果断的模型重启。不要继续为已经失去收敛性的 session 付 token。

## 7. 测试哲学

TDD 是工具，不是宗教：

- 已知 contract、纯 domain policy、状态不变量和 bug regression：先写失败测试；
- 第三方 integration 或尚不确定的 API shape：先建立最薄 smoke/characterization，再固定真正依赖的行为；
- subprocess、Git、database 和 forge：大多数测试通过 adapter fake，保留少量真实 integration；
- 测试公共行为和 authority boundary，不锁死内部函数、SQL 文本、migration catalog 或每一种想象中的 hostile fixture；
- 发现真实 failure class 后再增加对应测试，不预付无限 threat matrix。
- 建立深 module 后，新 behavior tests 穿过其 interface；adapter wire fixtures 单独验证协议；CLI end-to-end 只保留少量主路径与恢复路径。新 interface tests 覆盖旧行为后必须删除锁定旧 shallow implementation 的 tests，不把 fake modes 永久叠加到一个 suite。

一个绿测试不能证明用户 outcome，测试套件也不能代替独立 review。反过来，reviewer 不负责解释 pipeline 失败；机器失败先聚合给 implementer。

## 8. Review 与 clean-room 预算

Review 要求高于实现，但 review 本身也必须有 scope 和成本预算。

- Spec/correctness review 与 design review 是不同 verdict。前者检查 Issue outcome、canonical invariants、回归与 exact SHA；后者只在上一节触发条件出现时检查 seam、depth、caller knowledge、locality 与删除计划。
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
3. Prompt 固定要求主动挑战所选机制：如果今天只从用户 outcome 出发是否仍会选择同一路线、最便宜的可信替代方案是什么、哪些复杂度可以删除、是否重复实现了 library、开发是否真实可并排、什么证据会证伪当前路线、证据是否支持当前 claim、下一条最短用户可见纵切是什么，以及反对当前路线的最强论据。Evidence packet 必须包含上次失败的 causal chain、已 falsified approach、仍有效的 module/seam evidence、曾误导的 proxy metrics，以及新方案如何避免相同 mechanism。审计可以跨越当前 Issue non-goals，报告 deletion、replacement、`correct_before_expansion` 或 `stop_and_redesign` 建议。
4. 报告输出 `continue`、`correct_before_expansion` 或 `stop_and_redesign`，并把 finding 区分为 direction blocker、current-PR defect 和 later concern。
5. 主编排者必须把 direction blocker 映射到当前 PR 修订、一个新 Issue 或用户 decision。完成后最多做一次 focused delta audit；later concern 不得无限延长当前 checkpoint。

Self-review、普通 code review、更多测试或一份主编排者总结都不能代替该 checkpoint。默认只用一个匹配能力的独立审计者；只有高风险分歧无法裁决时才增加第二视角，避免审计本身成为 quota 黑洞。

## 9. 文档生命周期

不复制旧任务树和旧实现报告。本仓库从零开始，历史 clean-room archive 保存在仓库外，只用于追溯，不参与 agent 默认 context。

- 当前架构变化：修改 `DESIGN.md`；
- 持久技术选择：修改 `DECISIONS.md`，明确 supersedes/re-entry；
- 开发流程变化：修改本文和必要的 `AGENTS.md`；
- 一项具体工作：GitHub Issue/PR；
- 临时 prompt、checkpoint、handoff：`.tasks/`，不提交；
- primary orchestrator 选择性提炼的恢复/交付约束、task templates 与 review schema：`docs/agent-software-factory/`；不复制完整外部 harness，且必须服从 canonical files 与 active Issue/Git；
- 研究笔记和 benchmark 原始输出：只在当前 decision 需要时作为 PR evidence，不成为新的权威设计。

每次 compact 后重读的是这套小 corpus，而不是不断增长的历史。文档的价值在于降低恢复成本和防止漂移，不以数量衡量。
