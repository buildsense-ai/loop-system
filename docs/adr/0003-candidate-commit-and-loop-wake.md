# ADR 0003: Candidate Commit Determines Attempt Submission; Disconnect Does Not

- Status: Accepted
- Date: 2026-08-04

## Context

CatsCo conversation、Agent Task、runtime session 和 Loop Work Item 不是同一对象：

- conversation/topic 持久存在；
- Bot SDK 在 ping timeout/socket close 后自动重连；
- bot body lease 约两分钟，只说明当前 runtime route；
- `running/waiting` task status 默认六小时过期；
- task status 支持 `completed/failed/cancelled/stale`，但 `completed` 仍由 Worker runtime 报告；
- GitHub PR 或 artifact 可能已存在，但对应完成事件可能因网络中断未提交。

如果系统把 offline、沉默或 task `completed` 直接当成 Work Item 完成，会提前唤醒 review/next loop。若把所有断线直接当失败，又会产生重复任务和晚到结果竞争。

## Decision

正确性路径不判断网络断开与进程崩溃的具体原因，只区分：

1. Candidate Submission 已经 durable commit；
2. 尚未观察到 committed Candidate，状态 unknown/suspect。

### Candidate Commit

Worker 通过稳定 event/idempotency key 提交 Candidate Packet。Kernel 在一个 transaction 中：

- 验证当前 Work Item revision、Attempt ID/generation、authenticated runtime principal、lease proof、contract hashes、write scope 和 deliverable digest/SHA；
- 保存 Candidate 与 trusted ingress sequence；
- 将 Attempt 置为 `candidate_committed`；
- 将 Work Item 置为 `candidate`；
- 创建唯一 `review_candidate` Action；
- 追加 Agent wake 和 artifact projection outbox effects；
- 返回可查询 commit receipt。

ACK 丢失时，相同 event ID 返回同一 receipt。没有 receipt 就不是 committed Candidate submission；Work Item 是否完成仍由后续 authenticated review 和 profile-defined terminal policy 决定。

CatsCo `completed` status 映射为 `completion_reported` observation，不直接终止 Attempt。

### Orthogonal Attempt State

```text
control_state:
  allocated → dispatch_pending → active ↔ suspect
  active|suspect → candidate_committed | failed | cancelled | superseded

reported_state:
  none | running | waiting | completion_reported | failure_reported

connection_state:
  unknown | connected | disconnected
```

### Recovery

- socket/ping 断开：只更新 connection observation；
- body lease 过期：进入 suspect，执行 reconciliation 和 bounded grace；
- 同一 authenticated session 在 generation 未变化时可恢复原 Attempt；
- grace 后仍无 Candidate：原子 revoke generation，再创建 recovery Attempt；
- 旧 generation 晚到结果：记录 `late_orphaned`，不推进当前 Work Item；
- 发现 PR/artifact 但无合法 Candidate Packet：记录 `orphan_deliverable_observed`；
- late result 只有作为新 Attempt 重新验证完整 contract/diff/evidence 后才能采用。

### Wake Rule

只有 Ledger transaction 新提交 actionable Action 才唤醒 Agent：

- `execute_attempt`：已提交 Attempt/contract/lease；
- `review_candidate`：Candidate committed；
- `resolve_gate`：需要认证主体决策；
- `recover_attempt`：suspect reconciliation 已决定恢复；
- `plan_next`：Work Item 达到 profile-defined terminal，依赖与预算满足。

watch、timer、reconnect、online/offline、task status 和 user Artifact state update 只唤醒对应 owner 的 Controller。

## Consequences

### Positive

- 网络抖动不会提前完成或立即重派任务；
- late session 被 generation fencing 隔离；
- ACK 丢失可通过幂等 receipt 恢复；
- review 和 next loop 有唯一、可审计的唤醒来源；
- artifact renderer 失败不会影响核心生命周期。

### Negative

- 需要 durable Candidate ingress 与 queryable receipt；
- 需要 per-Work-Item sequence、lease proof 和 recovery grace；
- 孤立 PR/artifact 不能自动算完成，需要 reconciliation 或重新提交；
- 外部不可逆副作用仍需 per-attempt credentials/branches，Ledger fencing 无法撤销已执行副作用。

## Rejected Alternatives

### A. Conversation 安静一段时间即完成

拒绝。无法区分等待、网络断开、runtime 崩溃和长时间工具调用。

### B. Agent offline/body lease 过期即失败

拒绝。Bot SDK 会自动重连，body lease 只是 failure detector input。

### C. task status `completed` 即 Work Item 完成

拒绝。它是 Worker 自报，未绑定 Candidate commit、验收或 review。

### D. 发现 PR/artifact 即完成

拒绝。可能是旧 generation、越界输出、未完成 evidence 或孤立副作用。

### E. Artifact 更新事件驱动下一轮

拒绝。Artifact 是 Projection。它会形成 renderer failure/retry 与语义 Loop 的自触发环。

## Invariants

- Conversation identity 不替代 Attempt/session identity；
- Candidate commit receipt 是 Attempt 成功提交的唯一 commit point；
- Work Item acceptance/terminal 独立于 Attempt completion；
- superseded generation 永久失去推进权限；
- artifact/watch/reconnect 不直接创建语义 Action；
- `plan_next` 只在 profile-defined terminal 后创建；
- self-iteration 同样遵守 Candidate Commit、独立 review 和 promotion gates。
