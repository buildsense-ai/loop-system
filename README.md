# Loop System

面向 CatsCo 多 Agent 工作流的统一循环控制系统设计。

> 状态：设计文档与可运行的 `loopctl` MVP。核心事务、Candidate Commit、Agent Action packet、CatsCo P0 传输和本地端到端 Pilot 已实现并测试；自动创建 CatsCo task/topic、Dynamic Artifact 写入和生产级常驻 Supervisor 仍未实现。

## 结论

业务工作与系统自迭代可以复用同一个状态转换内核和阶段语言：

```text
discover → specify → assign → execute → candidate → review → accept → observe
```

具体 Loop Profile 只开放与自身风险相符的合法路径；并非每种工作都必须经过所有阶段。

二者不只是 `context` 和 `reference_path` 不同。自迭代会触及自身的提示词、路由、验收器、权限和部署，因此还必须由版本化的 **Loop Profile** 约束：

- 不可变的参考快照；
- 明确的写入范围；
- 风险与影响等级；
- 验收与审批策略；
- 激活、灰度、观察和回滚策略；
- 预算、递归深度和并发限制。

推荐方案是：

1. **Steward User Workspace**：一个独立 CatsCo user identity 是所有权边界，拥有自己的 friend graph、Projects、Loop namespace、Artifacts 和 sessions；
2. **规划验收 Agent**：运行在该 User Workspace 中，发现问题、拆解工作、起草 GitHub issue、定义验收标准、审查最终 PR；
3. **Worker Agents**：作为 Steward User 的朋友，在各自 CatsCo `agent_task` topic 和 session runtime 中执行一个有界任务；
4. **User-scoped Loop Controller**：非 LLM 的确定性控制模块，只在该 `owner_uid` namespace 内负责跨 topic 转接、状态推进、幂等重试、租约和对账；
5. **CatsCo Project**：Steward User 私有的内部 operator 投影；
6. **User-owned Dynamic Artifact**：Steward User 创建并维护的动态 Artifact，稳定 URL 读取其最新脱敏 Projection；
7. **GitHub**：代码、issue、PR、CI、review 和 merge 的事实来源，而不是完整运行时账本。

不新增第三个常驻“接线员 Agent”，也不从零实现一套写权威看板。

## 为什么仍然需要 Loop Controller

CatsCo 已经支持：

- 默认使用 Review 与 Worker 各自的 P2P topic；只有多人需要共同监工时，才显式选择已有的 CatsCo group 作为 Review 的 steward topic；
- 创建时要求人类 owner + 一个 Agent，但后续成员变更仍需 Controller 对账，不能把该限制当成授权边界；
- Project 对多个 task topics 进行归组；
- Bot 发布 `running/waiting/completed/failed/...` task status；
- Bot 上传并发送文件；
- WebSocket 消息和 OpenCLI watch 触发。

默认创建流程会将规划验收 Agent 与 Worker 放在不同任务 topics。每个 Steward User Workspace 都需要一个运行在自身授权范围内的 Controller delegation，将规划结果分发给朋友 Worker，再将候选结果送回 Steward。它不是跨用户的 system controller。

物理上一个进程可以承载多个用户，但 Ledger/inbox/outbox/action/credential 必须按 `owner_uid` 分区。产品上仍表现为“Steward Agent 通过 OpenCLI 分配任务”，owner credential、幂等发送和 readback 由该用户委托的 Controller sidecar 执行。

## 人类如何查看进度

现有 CatsCo Project 由 `owner_uid` 隔离，保留为内部 operator view。外部用户不需要获得 Project 权限：

1. 人类在 CatsCo session 中要求 Steward User 创建一个属于自己的 Project Artifact；
2. Artifact 绑定 `owner_uid + external_key + viewer topic`，系统不创建全局 Project Artifact；
3. 每次任务分配、Candidate committed、review、acceptance、waiting/stale/reassign 后，该用户的 Controller 更新 Artifact state；
4. 稳定 Artifact URL 动态读取最新脱敏 Projection，打开中的页面用 ETag polling 自动刷新；
5. 人类也可以在 session 中要求 Steward User 立即 reconcile/refresh。

Artifact 展示项目目标、里程碑、任务状态、已验证进展、公开阻塞、下一步和允许公开的链接，并记录 `owner_uid/source_ledger_revision/content_digest/updated_at`。它是 user-owned Projection，不是 Kernel 输入或下一轮唤醒信号。

MVP 实现一个可热更新、可回滚的只读 Project Artifact，不实现共享 Project 或新的可写 Kanban。

## 如何判断完成与中断

不需要可靠地区分“网络断开”与“进程崩溃”的具体原因；必须区分的是：

- **Candidate 已经被 durable inbox 接收并提交**；
- **尚未观察到 Candidate，状态未知**。

Conversation/topic 是持久通信容器，runtime session 是短命执行实例，Attempt 是一次带 generation/lease 的执行。断线、offline 或 ping timeout 只更新 `connection=disconnected` 并触发 reconciliation；只有 lease/liveness 阈值失效才进入 `control=suspect`。两者都绝不等于完成或失败。

只有 Candidate Commit transaction 才会创建 `review_candidate` Action；只有 Work Item 达到 policy-defined terminal state 才会创建 `plan_next` Action。artifact 更新、watch、timer 和 reconnect 只唤醒 Controller，不能直接唤醒下一轮语义 Loop。

## 快速验证

```bash
cd controller
pnpm install
pnpm check
pnpm pilot:local
```

Agent 通过配套的 [opencli-plugin-loopctl](https://github.com/buildsense-ai/opencli-plugin-loopctl) 使用 Bash 调用 Controller；Review 与 Worker 不需要新增 XiaoBa Tool 或 RPC。

## 文档

- [领域词汇](CONTEXT.md)
- [总体架构](ARCHITECTURE.md)
- [协议与数据模型](PROTOCOL.md)
- [ADR：一个内核，多种策略配置](docs/adr/0001-one-kernel-multiple-policy-profiles.md)
- [ADR：Steward User Workspace 与 Dynamic Artifact](docs/adr/0002-owner-project-and-report-artifacts.md)
- [ADR：Candidate Commit 决定完成，断线不决定](docs/adr/0003-candidate-commit-and-loop-wake.md)
- [loopctl Controller MVP](controller/README.md)

## 非目标

第一阶段不做：

- 一个能够自由重写并激活自身规则的全自治系统；
- 另一个持有语义决策权的“接线员 Agent”；
- 复制 CatsCo 对话或 GitHub 代码事实的第二套完整数据库；
- 从零构建功能完整的项目管理产品；
- 仅凭 Agent 的“完成了”消息判定工作已验收。
