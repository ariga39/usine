# Usine

Usine 是一个面向自主软件交付的确定性协调器。它的目标不是让一个 agent 更会写代码，而是让多个项目中的已授权任务在无人持续催促的情况下，有序地经过实现、验证、独立 review 和交付。

当前仓库处于全新设计阶段，尚无可运行实现。历史实现和旧任务分解均不属于本仓库的当前基线。

当前权威文档只有：

- [`AGENTS.md`](AGENTS.md)：所有 coding agent 必须遵守的工程宪章与 context 恢复协议；
- [`docs/DESIGN.md`](docs/DESIGN.md)：产品目标、边界和当前架构；
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)：我们开发 Usine 自身时采用的 Git、并行、依赖、测试和 review 流程；
- [`docs/DECISIONS.md`](docs/DECISIONS.md)：当前生效的技术决策与延期事项的重新进入条件。

GitHub Issue 是开发任务的事实源；每个实现任务使用独立 branch/worktree，并以一个 PR 交付。
