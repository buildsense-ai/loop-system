# ADR 0001: One Kernel, Multiple Policy Profiles

- Status: Accepted
- Date: 2026-08-04

## Context

CatsCo 中存在两类长期工作：

1. 业务工作：发现问题、创建 issue、分配 Worker、提交和验收 PR；
2. 自迭代：发现 Loop 本身的问题，并修改提示词、路由、模板、验收器或控制模块。

两类工作都呈现相同生命周期：发现、定义、分配、执行、提交候选、评审、验收和观察。因此分别实现两个调度器会产生重复状态机和行为漂移。

然而自迭代能够修改自身的规则和评价方式。若只通过不同 context/reference path 区分，它可能降低验收标准、用候选 evaluator 评审自身，或把合并误当成安全激活。

CatsCo 已提供 Agent Task topics、Projects、Task Status 和文件消息；GitHub 提供 issues、PRs、CI 和 reviews。两者都不单独包含完整的跨运行时租约、冻结验收契约和自修改激活规则。

## Decision

采用一个通用 Loop Kernel，并为每个 Loop 绑定版本化 Loop Profile。

Loop Profile 至少包含：

- Goal Context；
- immutable Reference Snapshot；
- explicit Write Scope（受 Profile upper bound 限制）；
- 由可信 changed-surface policy 推导的 Impact Class；
- Acceptance Policy；
- Promotion Policy；
- Budget 与 meta-depth。

同时：

1. 为每个 Steward User Workspace 引入非 LLM 的 user-scoped Loop Controller，负责持久事件、状态推进、幂等 effect、跨 topic 路由和 reconciliation；
2. Steward Agent 作为独立 CatsCo user，负责发现、拆解、issue proposal 和最终语义 review；
3. Worker Agents 负责执行和提交 Candidate；
4. Steward User 私有 CatsCo Project 作为 Internal Operator View；外部用户通过该 Steward User 创建并维护的 Dynamic Artifact 查看脱敏进度；
5. Candidate Commit receipt 是 Attempt 成功提交的唯一 commit point；只有 committed Action 驱动 Agent wake；
6. GitHub 作为 issue/code/PR/CI/review/merge 的事实来源；
7. protected self-iteration 记录并校验 proposer、reviewer、approver、activator 的主体分离；
8. merge 不自动等于 canary activation；观察通过后才允许 promoted-to-default；
9. 第一版 self-iteration 保持 proposal-only，不自动激活。

## Consequences

### Positive

- 业务和自迭代共享状态机、恢复、重试和投影能力；
- 避免第三个 LLM 接线员和第二套语义决策；
- 复用 CatsCo 现有 user ownership、Project/Task Status 和 user-owned Dynamic Artifact 分享进度，而不是重写完整看板；
- 自迭代受到明确权限和激活策略约束；
- Agent runtime 可以替换，Goal 和 Work Item 仍可恢复；
- 可信 diff 和 protected-surface policy 防止提议者降低自身影响等级。

### Negative

- 需要一个小型持久 Ledger/inbox/outbox；
- 必须维护 CatsCo、GitHub 与 Ledger 的事实归属和 reconciliation；
- 需要维护 user-scoped Project Artifact schema、Visibility Policy、viewer ACL、digest 和 freshness 语义；
- 需要 Candidate Commit ingress/receipt、Action claim 和 suspect/reconnect recovery；
- `completed/accepted/canary_activated/observed/promoted` 的区分增加了状态数量；
- protected self-iteration 不可能做到完全无人审批；
- 不同 runtime 必须实现统一 Attempt/session identity 协议。

## Alternatives Considered

### A. 仅使用 Steward Agent 做全部转接

拒绝。LLM session 不是可靠租约、幂等和恢复机制；默认 Agent Task 创建流程也将 Steward 与 Worker 放在不同 topics。后续成员变更不构成可靠授权，不能替代 Controller。

### B. 使用 OpenCLI watch 作为 Scheduler

拒绝。watch 可用于降低延迟，但本地 cursor 和失败语义不足以承担 durable scheduling。仍需要 inbox 和 reconciliation。

### C. GitHub Issues/Projects 作为完整 Loop Kernel

拒绝。GitHub 很适合人类 issue/PR/review 和代码事实，但不适合保存 CatsCo session leases、runtime attempt identity 和高频内部状态。

### D. CatsCo conversation/task status 作为完整 Loop Kernel

拒绝。现有 Task Status 主要表达 Attempt 运行状态，缺少冻结验收、review、acceptance、promotion 和 observation。

### E. 分别实现业务 Loop 和 Self-iteration Loop

拒绝。两个状态机会快速产生行为漂移；真正的差异应由 Policy Profile 表达。

## Revisit Conditions

当以下条件成立时重新评估：

- CatsCo 原生提供完整 Work Item/Attempt/Gate/Acceptance/Promotion store；
- GitHub 原生支持所需 runtime lease 与 reliable workflow events；
- self-iteration 被产品明确限制为永不激活的 proposal-only 模式；
- 实际运行表明 Loop Profile interface 过宽或无法保持模块深度。
