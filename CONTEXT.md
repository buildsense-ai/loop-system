# Domain Context

本文件只定义领域语言，不描述具体实现。

## 核心术语

### Loop

围绕一个 Goal，持续把观察转化为有界 Work Item、候选结果、验收决定和后续观察的生命周期。

Loop 不等于一个长期存活的 Agent 进程。Agent session 可以结束和替换，Loop 仍然存在。

### Goal

可能跨越多个任务、Agent session、PR 和版本的长期目标。Goal 决定“为什么做”，不直接授权任意操作。

### Work Item

从 Goal 拆出的、具有明确范围和 Acceptance Contract 的有界工作单元。

一个 Work Item 可以对应：

- 一个 Worker 私有 CatsCo P2P topic；
- 可选的 Review 人类监督 group topic；
- 零个或一个 GitHub issue;
- 一个或多个执行 Attempt；
- 零个或一个当前候选 PR。

### Conversation

CatsCo 中持久存在的通信容器（topic）。Conversation 可以跨越断线、重连和多个 Runtime Session；它不是一次执行 Attempt。

### Collaboration Group

由 Steward User 创建或复用、包含人类、Review Agent 和一个或多个 Worker Agent 的 CatsCo standard group Conversation。

Collaboration Group 是人类与 Steward/Review Agent 的共享可见性容器，不是 Worker 执行队列、Kernel 状态或完成证据。在多成员群中，只有 CatsCo message envelope 的结构化 mention 才能唤醒目标 Review Agent；可见文本中的 `@名字` 不构成 activation、authority 或 Evidence。并发 Worker execution 使用专属 `agent_task` Conversation：每个 Attempt 创建一个仅含 Review User 与一个 Worker Agent 的 `grp_<id>` topic；它不是人类协作群。每个 committed Action 只指向一个 Principal，Controller 在目标 Conversation 为 group 时将该 Principal 映射为结构化 mention。

### Runtime Session

某个 Agent runtime 的短命执行实例。它可以连接、断线、重连或被替换。一个 Agent identity 可以同时拥有多个 Runtime Session；Runtime Session 的在线状态不表示 Work Item 是否完成。

### Attempt

某个 Worker Runtime Session 对 Work Item 的一次执行尝试。Attempt 具有独立 ID、generation、租约和运行时绑定。Agent UID 只提供消息路由和认证 principal，不是单 session 锁；同一 Agent 可以并发执行多个独立 Attempt，前提是每个 Attempt 使用独立的 generation、lease、Worktree 和 workspace lease。

Worker 报告 `completed` 只是一个 observation。只有 Candidate Submission 被 durable commit 后，Attempt 才进入 `candidate_committed`；这仍不表示 Work Item 已被验收。

### Steward User Workspace

以一个持久 CatsCo user identity 为所有权边界的工作空间。它拥有自己的 friend graph、Projects、Loop Ledger namespace、Controller delegation、Artifacts 和 sessions。资源必须以 `owner_uid` 分区；即使底层由共享进程或数据库承载，也不存在跨用户的 system-global Loop 或 Artifact writer。

### Steward Agent

运行在 Steward User Workspace 中的规划验收语义角色。Loop 仅在 Human 明确选择时启用；进入 Loop 前 Steward 必须验证 CatsCo/OpenCLI 登录并发现可用 Worker。没有可用 Worker 时，它请求作者提供 Agent UID，通过 owner 的 friend graph 建立 addressability、重新发现并验证后再编排。负责：

- 发现和定义问题；
- 拆解 Work Items；
- 起草 GitHub issue 的语义内容；
- 起草 Acceptance Contract；
- 审查候选 PR；
- 给出接受、打回或阻塞决定。

Steward Agent 是语义角色，不负责可靠消息投递、幂等重试或持久调度。

### Worker Agent

执行一个已分配 Work Item 的 Agent。Worker 可以分析、编辑、验证并提交 Candidate，但不能自行将 Work Item 标记为 accepted。

### Loop Controller

在一个 Steward User Workspace 内跨 CatsCo topics、Agent runtimes 和 GitHub 进行可靠转接的确定性控制角色。

Controller 不是 system-global scheduler。每个 Ledger/inbox/outbox/action/credential 都绑定 `owner_uid`；物理实现可以多租户共享，但授权与状态机必须保持 user-scoped。Controller 不承担问题拆解或代码评审等语义判断。

### Loop Kernel

根据当前状态、事件和 Loop Profile 计算允许状态转换的纯控制逻辑。

Kernel 不直接调用 CatsCo、GitHub 或 Agent runtime。

### Loop Profile

约束一次 Loop 的版本化策略集合，至少规定：

- Goal Context；
- Reference Snapshot；
- Write Scope；
- Impact Class；
- Acceptance Policy；
- Promotion Policy；
- Budget 与递归限制。

业务工作与自迭代共享 Kernel，但可以使用不同 Loop Profile。

### Goal Context

本次工作必须理解的目标、边界、已知事实和约束。

### Reference Snapshot

Agent 可以读取并用于推理的、固定到具体版本或摘要的参考资料集合。

Reference Snapshot 与 Write Scope 不同：能读取某个来源不代表可以修改它。

### Write Scope

本次 Work Item 明确允许修改的目标范围。Write Scope 之外的修改必须被拒绝或升级为新的审批。

### Task Contract

Steward Agent 交给 Worker Agent 的结构化工作说明，包含目标、范围、参考资料、验收条件和限制。

### Acceptance Contract

在分配前冻结的验收标准。它绑定到 Work Item revision，并用于判断 Candidate 是否可接受。

Active Attempt 期间修改 Acceptance Contract 必须显式 rebase，并使旧验收绑定失效。

### Candidate

Worker Agent 为 Work Item 提交的待审结果，例如一个 Git commit、PR 或带摘要的不可变 artifact。

### Candidate Submission

将 Candidate Packet 以稳定 event ID 提交到 durable inbox，并由 Kernel transaction 验证当前 Attempt generation、runtime principal、contract hashes、deliverable digest 和 lease 后形成的记录。Candidate Submission receipt 是 Attempt 成功提交的唯一 commit point。

### Action

由 Kernel transaction 创建的、可被某个 Principal 认领的持久下一步，例如 `execute_attempt`、`review_candidate`、`resolve_gate` 或 `plan_next`。Action 的存在与状态决定是否唤醒 Agent。

### Evidence

支持某个状态转换的可验证事实，例如 commit SHA、CI run、测试结果、文件摘要、审查结论或人工决定。

聊天中的自然语言“完成了”不是充分 Evidence。

### Gate

要求特定主体作出决定后才能继续的显式阻塞条件。

### Principal

具有可验证身份与权限的决策或执行主体，例如某个人类账号、Agent runtime 或系统服务。角色名不等于 Principal 身份。

### Gate Decision

由经过认证的 Principal 对特定 Work Item revision、Candidate digest 或 Promotion 作出的结构化决定。

### Acceptance

Steward Agent 或授权主体根据 Acceptance Contract 对 Candidate 作出的决定。

### Activation

让已接受 Candidate 在受限范围内实际运行的动作，例如进入 canary activation epoch。Merge、Acceptance 和 Activation 是不同事件。

### Promotion

在观察通过后，将 canary Candidate 提升为默认运行版本的动作。

### Observation

在 canary Activation 之后，通过后续真实任务或指标判断变更是否产生预期效果。Observation 通过后才允许 Promotion。

### Self-iteration

Loop 把自身的模板、路由、检索、Kernel、验收器或其他运行机制作为 Goal Context 和写入目标的一类工作。

Self-iteration 与业务工作共享生命周期，但不能因此获得自我授权。

### Projection

为人或外部系统展示当前状态的派生视图。Projection 不自动成为 Kernel 的事实来源。

### Internal Operator View

仅对项目 owner/内部 operator 可见的完整控制投影。CatsCo Project 当前属于这一类型。

### Project Reporter

在一个 Steward User Workspace 内读取 owner 私有 Project/Ledger，并按固定 schema 生成脱敏 Projection 的受限 capability。数据收集和结构化状态渲染必须确定性执行。

### User-owned Dynamic Artifact

由 Steward CatsCo User 创建、更新和分享的动态 Projection。它绑定 `owner_uid + external_key + viewer grant`，通过稳定 URL 渲染 current state。底层 Artifact Host 可以物理共享，但资源和 writer authority 是 user-scoped。它不是 Candidate evidence 或下一轮 Loop 的触发输入。

### Artifact Projection State

Dynamic Artifact 当前保存的 canonical snapshot，绑定单调 `source_ledger_revision`、source event watermark、content digest、renderer 和 Visibility Policy version。Loop Ledger 保存历史；需要时可从固定 state 导出 immutable snapshot。

### Projection Update Request

由某个 Steward User Workspace 的 material transition 产生的 owner-scoped outbox effect。交互式 refresh 是 Steward User 通过自身认证 OpenCLI 发出的直接 Artifact action，不伪装成 Kernel/outbox event。

### Visibility Policy

规定哪些任务字段、证据、消息摘要和外部链接可以进入 User-owned Dynamic Artifact 的版本化策略。

## 关系与不变量

- 一个 Goal 包含多个 Work Items。
- 一个 Work Item 同时最多有一个持有有效租约的 Attempt。
- 一个 Attempt 绑定一个 Runtime Session 和一个隔离工作空间；Conversation 只提供地址和历史。
- 一个 Candidate 必须绑定精确的 Work Item revision、Attempt 和 Acceptance Contract。
- Worker 产生 Candidate；Steward 或授权主体决定 Acceptance。
- Protected self-iteration 的 Proposal、Approval、Activation 和 Promotion 必须满足策略要求的主体分离。
- Projection 可以丢失并重建；事实状态不能依赖浏览器本地 UI 状态。
- CatsCo Project 的 owner 权限不能隐式授予给外部用户。
- User-owned Dynamic Artifact 默认排除内部 topic/session identity、原始消息、prompt、本地路径、凭据和私有 artifact。
- Artifact owner 只能由 authenticated CatsCo principal 推导；所有 state、cache、idempotency 和 credentials 以 `owner_uid` 分区。
- Artifact state 只接受单调 source Ledger revision；update 失败只能留下该 owner 的 `projection_dirty` 并重试，不能回滚事实状态或唤醒 Agent。
- 用户对 artifact 的反馈必须转化为经过认证的 typed command，而不是直接修改投影或 Ledger。
- 断线、offline、ping timeout 和 body lease expiry 都不是完成证据。
- 只有 committed Action 可以唤醒下一轮 Agent；artifact/watch/timer 只唤醒 Controller。
