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

### Context window 决策

截至 2026-08-17，本机 Codex 0.147.0 的 Luna catalog 默认 context window 为 272k，允许的最大值为 872k；OpenAI 对 GPT‑5.6 模型标注的总 context 为 1.05M。更大的 window 能减少 compact 次数，但不能保证关键原则被保留，还会保留更多过期讨论并增加输入成本。

因此：

- 主编排者/设计者使用独立的 `usine-orchestrator` Codex profile，可以把 `model_context_window` 提高到本机 catalog 允许的上限；
- implementer 和 reviewer 使用默认或更小的 task context，不继承主编排 thread；
- 不全局提高 window，也不把 window 大小写成产品依赖；
- 每次 Codex/model 升级重新读取 catalog 后再调整 profile，不硬编码超过当前 `max_context_window` 的值；
- 大 window 是性能优化，canonical files + Git/Issue bootstrap 才是原则恢复机制。

OpenAI 官方模型指南也建议把 policy 放在一个位置、避免重复 prompt，并跟踪长 session 中不断增长的 context；本协议据此选择“小而权威的文件 + 分角色 context”，而不是反复粘贴同一套规则。

## 2. GitHub Issue → branch/worktree → PR

除空仓库 root commit 外，不在 main 直接开发。

1. 创建一个有明确 outcome、scope、non-goals 和 acceptance 的 GitHub Issue。
2. 从最新 main 创建 `agent/<issue>-<slug>` branch；并排任务使用独立 worktree。
3. 每个 branch 只实现一个 Issue。实现 agent 只写该任务声明的 surfaces。
4. 在能形成可检查状态时提交，不把数小时工作只留在未提交目录。
5. 推送后创建 draft PR，PR 必须引用 Issue，并说明变化、原因、用户影响和验证。
6. review/fix 在同一 PR 收敛；merge 后 Issue 才完成。

GitHub Issue 是任务事实源。`.tasks/*.md` 只是给 agent 的本地执行投影，必须包含 Issue URL、exact base SHA、目标、允许写入范围、non-goals、验收与停止条件；它被 gitignore，不积累成第二套任务系统。

## 3. 有界并排开发

主编排者初期最多同时拥有两个 active implementation PR。这不是产品容量限制，而是当前单一 orchestrator 的注意力 fence。

只有满足以下条件才并排：

- 两项工作具有独立 user-visible outcome；
- writable file/package ownership 不重叠；
- 共享接口已经在 main 或先行 PR 中固定；
- 两个 agent 使用不同 worktree、branch、task file 和 commit；
- 任一任务失败不会要求另一个 agent 重写未合并基础。

若只是把一个紧耦合功能机械拆给两个 agent，会把节省的墙钟时间变成 merge、沟通和返工成本，应串行。主编排者不亲自同时深写两个任务；它负责边界、进度、integration 和纠偏。每完成一项才从 Issue 队列补下一项。

## 4. Library-first，而不是 abstraction-first

在编写 scheduler、queue、retry、migration、ORM、GitHub auth、process runner、logging、schema validation 或测试容器代码前：

1. 查看 canonical dependency decision；
2. 读取候选库当前官方文档；
3. 用最薄调用路径确认它覆盖当前行为；
4. 只为产品特有 policy 写代码。

如果决定自写，PR 必须列出被拒绝的成熟库、当前缺口和自写代码的删除边界。“可能以后更灵活”不是理由。不要为了包数量制造接口；一个 module 只有在隐藏复杂度、稳定 caller 或允许真正独立开发时才成立。

数据库默认使用 Prisma schema、Client 和 Migrate。DBOS system state 由 DBOS 管理；Usine 只保存产品需要查询和展示的少量领域事实。避免 hand-written repository boilerplate、重复 JSON shape checks、触发器状态机和 catalog fingerprint 测试。

## 5. 纵切优先与复杂度预算

每个 PR 应尽量完成一个可从公共入口观察到的行为。内部基础工作只有在下一条纵切直接使用它时才单独存在。

出现以下情况时停止扩张，先提交 decision note 或缩小方案：

- 为当前 Issue 新增第二种 runtime、forge、database 或 sandbox adapter；
- 创建没有当前生产 caller 的通用 interface；
- 测试数量增长，但 Issue 的端到端状态没有前进；
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

## 8. 文档生命周期

不复制旧任务树和旧实现报告。本仓库从零开始，历史 clean-room archive 保存在仓库外，只用于追溯，不参与 agent 默认 context。

- 当前架构变化：修改 `DESIGN.md`；
- 持久技术选择：修改 `DECISIONS.md`，明确 supersedes/re-entry；
- 开发流程变化：修改本文和必要的 `AGENTS.md`；
- 一项具体工作：GitHub Issue/PR；
- 临时 prompt、checkpoint、handoff：`.tasks/`，不提交；
- 研究笔记和 benchmark 原始输出：只在当前 decision 需要时作为 PR evidence，不成为新的权威设计。

每次 compact 后重读的是这套小 corpus，而不是不断增长的历史。文档的价值在于降低恢复成本和防止漂移，不以数量衡量。
