# Loop Protocol

本协议定义 Agent runtimes、Loop Controller、CatsCo 和 GitHub 之间的最小稳定契约。

## 1. 设计原则

- Packet 是机器状态输入，不依赖自然语言解析才能推进核心生命周期；
- 所有实体使用稳定 ID，所有更新使用 revision；
- 所有 effect 使用幂等键；
- Agent 输出是 proposal，Kernel 才能提交 transition；
- packet 可作为 CatsCo card/message 传输，但其 canonical projection 进入 Loop Ledger；
- 大字段只保存引用和摘要，不复制完整 transcript 或原始日志。

## 1.1 Current Operational Profile

The protocol is entered only after the Human explicitly opts into Loop. Before registration, Review performs `opencli catsco me` auth preflight and checks `opencli catsco agents`; if no eligible Worker is visible, it asks the task author for an Agent UID and uses the owner's CatsCo friend relationship flow before continuing. Human input does not prescribe Worker count: Review prefers bounded fan-out for large, safely separable work and uses a single Work Item for small or tightly coupled work.

Normal execution uses separate Review and Worker P2P topics. A standard group is an explicit Review supervision surface only. CatsCo friendship provides addressability, not Kernel authority; only committed Controller Actions and trusted Candidate/Review events advance the Loop. Pi subagents, XiaoBa ToolManager, and ad-hoc Agent RPC are outside the production protocol.

## 2. Loop Definition

```json
{
  "loop_id": "loop_01",
  "profile_id": "product-work@1",
  "goal": {
    "id": "goal_buildsense",
    "summary": "持续发现、修复并验证项目问题"
  },
  "reference_snapshot": [
    {"kind": "git", "repo": "owner/repo", "revision": "<sha>"},
    {"kind": "document", "ref": "loop-system/ARCHITECTURE.md", "digest": "sha256:..."}
  ],
  "write_scope_upper_bound": ["src/**", "tests/**"],
  "declared_impact_class": "low|medium|high|protected",
  "protected_surface_policy_ref": "protected-surfaces@1",
  "acceptance_policy_ref": "acceptance/product-work@1",
  "promotion_policy_ref": "promotion/merge-only@1",
  "budget": {
    "max_attempts_per_item": 3,
    "max_parallel_items": 4,
    "max_meta_depth": 0
  }
}
```

## 3. Work Item

```json
{
  "work_item_id": "wi_01",
  "parent_work_item_id": null,
  "loop_id": "loop_01",
  "kind": "product|self_iteration",
  "revision": 1,
  "state": "ready",
  "title": "Fix stale notification suppression",
  "goal_summary": "...",
  "non_goals": ["..."],
  "dependencies": [],
  "profile_id": "product-work@1",
  "task_contract_ref": "task-contract:wi_01:r1",
  "task_contract_hash": "sha256:...",
  "reference_snapshot_hash": "sha256:...",
  "write_scope": ["src/**", "tests/**"],
  "acceptance_contract_ref": "acceptance:wi_01:r1",
  "acceptance_contract_hash": "sha256:...",
  "declared_impact_class": "low",
  "derived_impact_class": "medium",
  "required_authority": [],
  "github_issue": {
    "url": "https://github.com/owner/repo/issues/123",
    "node_id": "..."
  },
  "catsco": {
    "project_id": 12,
    "steward_topic_id": "grp_100",
    "worker_topic_id": "grp_101"
  },
  "next_action": "assign_worker",
  "waiting_on": null
}
```

## 4. Task Contract Packet

Steward Agent 在分配前产出，Controller 验证并冻结 revision。

```json
{
  "schema_version": "loop_task_contract_v0",
  "packet_id": "pkt_task_wi_01_r1",
  "work_item_id": "wi_01",
  "work_item_revision": 1,
  "task_contract_hash": "sha256:canonical-packet-without-this-field",
  "title": "...",
  "objective": "...",
  "non_goals": ["..."],
  "reference_snapshot": [
    {"kind": "git", "repo": "owner/repo", "revision": "<sha>"}
  ],
  "write_scope": ["src/**", "tests/**"],
  "required_capabilities": ["git", "filesystem_write", "test_runner"],
  "acceptance_contract": {
    "version": 1,
    "criteria": [
      {"id": "ac_1", "statement": "Focused regression test fails before and passes after"},
      {"id": "ac_2", "statement": "No unrelated schema or migration changes"}
    ],
    "required_evidence": ["commit_sha", "focused_test", "ci_run"],
    "hash": "sha256:..."
  },
  "artifact_refs": [],
  "suggested_agent_uid": 574,
  "created_by": {"role": "steward", "agent_uid": 42},
  "created_at": "2026-08-04T00:00:00Z"
}
```

Profile 的 `write_scope_upper_bound` 是权限上限；Task Contract 的 `write_scope` 是其冻结子集。Kernel 必须验证子集关系，并将完整 Task Contract hash 保存在 Work Item 与 Attempt 中。

## 5. Attempt 与租约

```json
{
  "attempt_id": "att_wi_01_1",
  "work_item_id": "wi_01",
  "attempt_number": 1,
  "control_state": "allocated|dispatch_pending|active|suspect|candidate_committed|failed|cancelled|superseded",
  "reported_state": "none|running|waiting|completion_reported|failure_reported",
  "connection_state": "unknown|connected|disconnected",
  "profile_id": "product-work@1",
  "task_contract_hash": "sha256:...",
  "reference_snapshot_hash": "sha256:...",
  "write_scope_hash": "sha256:...",
  "acceptance_contract_hash": "sha256:...",
  "agent_uid": 574,
  "runtime_id": "tiny-agent",
  "body_id": "body-abc",
  "session_id": "session-xyz",
  "lease": {
    "token_hash": "sha256:...",
    "proof_key_id": "runtime-key:body-abc",
    "generation": 1,
    "expires_at": "2026-08-04T06:00:00Z"
  },
  "workspace": {
    "kind": "git_worktree",
    "branch": "loop/wi_01/a1",
    "base_commit": "<sha>"
  },
  "started_at": "2026-08-04T00:05:00Z"
}
```

只有同时满足当前 `attempt_id + lease_generation`、经过认证的 runtime principal 和有效 `lease_proof` 的事件能推进 Work Item。CatsCo 消息可作为唤醒或内容载体，但不能独立证明 session/body identity。

## 6. Progress Packet

用于更新 Attempt，不改变验收状态。

```json
{
  "schema_version": "loop_progress_v0",
  "event_id": "evt_...",
  "work_item_id": "wi_01",
  "attempt_id": "att_wi_01_1",
  "lease_generation": 1,
  "runtime_principal": "runtime:body-abc:session-xyz",
  "lease_proof": "signed-or-mac-proof",
  "reported_state": "running|waiting|failed|completed",
  "connection_observation": "connected|disconnected|unknown",
  "summary": "Focused test added; implementing fix",
  "waiting_on": null,
  "evidence_refs": [],
  "created_at": "2026-08-04T00:30:00Z"
}
```

Worker Runtime Adapter 以 Worker 的 CatsCo bot/service 身份发布 `sendTaskStatus`；Controller 消费并映射到 `reported_state`，但不借用 Worker 凭据发布。`completed` 只形成 `completion_reported` observation，绝不直接终止 Attempt 或创建下一轮 Action。

## 7. Candidate Packet

```json
{
  "schema_version": "loop_candidate_v0",
  "event_id": "candidate-event-wi_01-a1",
  "idempotency_key": "candidate:wi_01:attempt-1",
  "candidate_id": "cand_wi_01_a1",
  "work_item_id": "wi_01",
  "work_item_revision": 1,
  "attempt_id": "att_wi_01_1",
  "lease_generation": 1,
  "runtime_principal": "runtime:body-abc:session-xyz",
  "lease_proof": "signed-or-mac-proof",
  "task_contract_hash": "sha256:...",
  "acceptance_contract_hash": "sha256:...",
  "deliverable": {
    "kind": "github_pr|git_commit|immutable_artifact",
    "url": "https://github.com/owner/repo/pull/456",
    "commit_sha": "<sha>",
    "base_sha": "<sha>",
    "digest": "sha256:..."
  },
  "summary": "...",
  "declared_changed_paths": ["src/...", "tests/..."],
  "evidence_refs": [
    {"kind": "ci", "url": "https://github.com/.../actions/runs/...", "commit_sha": "<sha>"},
    {"kind": "artifact", "url": "...", "digest": "sha256:..."}
  ],
  "residual_risks": ["..."],
  "submitted_at": "2026-08-04T01:00:00Z"
}
```

Kernel 在进入 `candidate` 前验证：

- Attempt、runtime principal、lease generation 与 lease proof 仍有效；
- Work Item revision 和完整 Task Contract hash 未变化；
- Acceptance Contract hash 相同；
- 对 GitHub PR/commit：GitHub Adapter 读取的真实 head SHA、base SHA 和 diff 与 evidence 一致；
- 对 immutable artifact：digest、存储 receipt 与 artifact policy 一致；
- 可信 adapter 观察到的实际 changed paths/operations 未越过 Write Scope；Worker 声明只用于说明，不作为授权证据。

### 7.1 Candidate Commit Transaction

Candidate Packet 进入 durable inbox 后，Controller 为每个 Work Item 分配单调 `ingress_sequence` 和 trusted server ingress time。Candidate 与 timeout/supersede 事件按该 sequence 处理，而不是比较客户端 wall-clock。Kernel 验证 Candidate 在可信 ingress 点对应当前 generation 且 lease 有效，并在一个 transaction 中保存 Candidate、将 Attempt 置为 `candidate_committed`、将 Work Item 置为 `candidate`、创建 `review_candidate` Action，并追加 Steward wake 与 artifact projection effects。

```json
{
  "schema_version": "loop_candidate_commit_receipt_v0",
  "event_id": "candidate-event-wi_01-a1",
  "candidate_id": "cand_wi_01_a1",
  "work_item_id": "wi_01",
  "attempt_id": "att_wi_01_1",
  "lease_generation": 1,
  "ingress_sequence": 19,
  "committed_ledger_revision": 43,
  "review_action_id": "action-review-wi_01-r1-cand1",
  "deliverable_digest": "sha256:...",
  "committed_at": "2026-08-04T01:00:02Z"
}
```

ACK 丢失时，Worker 使用相同 event/idempotency key 查询或重试，得到同一 receipt。没有 commit receipt 就是 unknown；存在 PR、artifact、`completed` status 或自然语言消息均不足以推断 Candidate committed。

## 8. Review Packet 与 Decision

Controller 根据 Candidate 构建 Review Packet，送给 Steward Agent。

```json
{
  "schema_version": "loop_review_packet_v0",
  "review_id": "review_cand_wi_01_a1",
  "work_item_id": "wi_01",
  "candidate_id": "cand_wi_01_a1",
  "acceptance_contract_hash": "sha256:...",
  "candidate_ref": {
    "kind": "github_pr|git_commit|immutable_artifact",
    "value": "github:owner/repo#456@<sha>|artifact:sha256:..."
  },
  "criteria": ["ac_1", "ac_2"],
  "evidence_refs": ["..."],
  "required_gates": []
}
```

Steward 返回：

```json
{
  "schema_version": "loop_review_decision_v0",
  "decision_id": "decision_review_01",
  "review_id": "review_cand_wi_01_a1",
  "decision": "accepted|changes_requested|rejected|needs_human",
  "criteria_results": [
    {"criterion_id": "ac_1", "result": "pass", "evidence_ref": "..."}
  ],
  "feedback": "...",
  "required_gate": null,
  "reviewer": {
    "principal_id": "catsco-agent:42",
    "role": "steward",
    "agent_uid": 42,
    "authentication_ref": "catsco:event:..."
  },
  "reviewed_commit_sha": "<sha-or-null>",
  "reviewed_artifact_digest": "sha256:...-or-null",
  "decided_at": "2026-08-04T01:20:00Z"
}
```

若 Candidate 在 review 后更新 commit 或 artifact digest，旧 Decision 自动失效。任何 GitHub review/merge effect 都必须携带 `expected_head_sha=reviewed_commit_sha`；Adapter 在执行前重新读取 head，若不相同则拒绝 effect 并回到 `under_review`。Artifact effect 同理绑定 `reviewed_artifact_digest`。

## 9. Gate Packet 与 Gate Decision

```json
{
  "schema_version": "loop_gate_v0",
  "gate_id": "gate_wi_01_1",
  "work_item_id": "wi_01",
  "work_item_revision": 1,
  "candidate_id": "cand_wi_01_a1",
  "kind": "human_approval|authority|semantic_decision",
  "question": "是否允许修改 protected routing policy？",
  "blocked_scope": "promotion",
  "required_principal": "human:owner",
  "target_digest": "sha256:..."
}
```

```json
{
  "schema_version": "loop_gate_decision_v0",
  "decision_id": "gate-decision-01",
  "gate_id": "gate_wi_01_1",
  "decision": "approved|rejected|deferred",
  "principal_id": "human:owner",
  "principal_role": "operator",
  "authentication_ref": "github-review:...|catsco-authenticated-action:...",
  "target_digest": "sha256:...",
  "decided_at": "2026-08-04T01:30:00Z"
}
```

Kernel 验证 `required_principal`、目标 revision/digest 和主体分离策略。自然语言“同意”消息不自动等同于 Gate Decision。

## 10. Self-iteration Activation / Promotion Packet

Protected self-iteration 在 acceptance 后仍需独立 canary activation；观察通过后才能 promoted-to-default：

```json
{
  "schema_version": "loop_activation_plan_v0",
  "candidate_id": "cand_loop_01",
  "candidate_digest": "sha256:...",
  "from_profile": "loop-core@7",
  "to_profile": "loop-core@8",
  "declared_impact_class": "medium",
  "derived_impact_class": "high",
  "baseline_evaluator_ref": "evaluator@7",
  "principals": {
    "proposer": "catsco-agent:42",
    "reviewer": "catsco-agent:84",
    "approver": "human:owner",
    "activator": "controller:production"
  },
  "approval": {
    "required_principal": "human:owner",
    "gate_decision_id": "gate-decision-01",
    "target_digest": "sha256:..."
  },
  "activation": {
    "epoch": 8,
    "mode": "canary",
    "canary_share": 0.1,
    "observation_window": "10 representative work items",
    "rollback_ref": "loop-core@7"
  },
  "promotion": {
    "target": "default",
    "requires_observation_result": "pass"
  }
}
```

## 11. Event Envelope

所有输入事件统一封装：

```json
{
  "schema_version": "loop_event_v0",
  "event_id": "provider-stable-id",
  "idempotency_key": "catsco:topic:seq|github:delivery-id|timer:key",
  "source": "catsco|github|runtime|timer|human",
  "principal": {
    "principal_id": "runtime:body-abc:session-xyz",
    "authentication_ref": "runtime-signature:..."
  },
  "entity_ref": "work_item:wi_01",
  "observed_at": "2026-08-04T01:20:01Z",
  "payload_ref": "inbox:...",
  "payload_digest": "sha256:..."
}
```

重复事件必须返回已有 transition receipt，不能执行第二次 effect。

## 12. Action 与 Agent Wake

```json
{
  "schema_version": "loop_action_v0",
  "action_id": "action-review-wi_01-r1-cand1",
  "action_key": "loop_01:wi_01:r1:review_candidate:sha256:...",
  "kind": "execute_attempt|review_candidate|resolve_gate|recover_attempt|plan_next",
  "work_item_id": "wi_01",
  "work_item_revision": 1,
  "target_principal": "catsco-agent:42",
  "target_digest": "sha256:...",
  "state": "ready|claimed|satisfied|expired|cancelled",
  "claim": {
    "session_id": null,
    "generation": 0,
    "expires_at": null
  },
  "created_by_event_id": "candidate-event-wi_01-a1",
  "created_at": "2026-08-04T01:00:02Z"
}
```

仅当 Ledger transaction 首次提交一个满足精确 revision/digest 前置条件的 `ready` Action，且不存在等价 ready/claimed/satisfied Action 时，Controller 才投递 Agent wake。投递至少一次，claim/satisfaction 幂等并受 generation fencing。

- `review_candidate` 只来自 Candidate Commit receipt；
- `recover_attempt` 来自 suspect grace + reconciliation；
- `plan_next` 只来自 profile-defined Work Item terminal；
- watch/timer/reconnect/task status/user Artifact state update 不直接创建语义 Action。

## 13. Controller Tick

```text
handle(event):
  inbox.put_if_absent(event)

  transaction:
    snapshot = ledger.load(event.entity_ref)
    plan = kernel.decide(snapshot, event)
    ledger.apply(plan.transition, expected_revision=plan.expected_revision)
    outbox.append(plan.effects)
    inbox.mark_committed(event.idempotency_key)

  for effect in outbox.pending():
    receipt = adapter.execute(effect, idempotency_key=effect.key)
    outbox.record(receipt)

reconcile():
  for active work item:
    compare ledger with CatsCo topic/status and GitHub issue/PR/CI
    emit synthetic observation events for every missing material transition
```

每个 external effect 还必须携带 postcondition/precondition：

- CatsCo create task：owner-scoped `external_work_item_id` 唯一；
- CatsCo send：稳定 `client_message_id`；
- Runtime start：`attempt_id + generation` 唯一；
- GitHub issue：隐藏 stable marker 或 node mapping；
- GitHub review/merge：`expected_head_sha`；
- Activation：`expected_from_epoch + candidate_digest`。

Adapter 在无法确认 effect 是否已发生时不得盲目重放非幂等操作，必须先执行 postcondition readback。

## 14. Internal CatsCo Project Projection

每个 Work Item 投影为：

```json
{
  "work_item_id": "wi_01",
  "title": "...",
  "state": "under_review",
  "owner": "worker:574",
  "attempt": 1,
  "progress_summary": "PR opened; CI passed",
  "waiting_on": "steward_review",
  "next_action": "review_candidate",
  "updated_at": "...",
  "stale": false,
  "membership_drift": false,
  "links": {
    "catsco_topic": "grp_101",
    "github_issue": "...",
    "github_pr": "...",
    "ci": "..."
  }
}
```

Internal Operator View 不得直接修改 Kernel 状态。操作按钮必须转换成 typed command，并经过相同 Kernel 校验。

## 15. User-owned Dynamic Project Artifact

### User-scoped Artifact API

Create-or-find 的 owner 永远来自当前 authenticated CatsCo user：

```http
POST /api/me/artifacts
Idempotency-Key: artifact:create:loop-project-buildsense-status
Content-Type: application/json

{
  "external_key": "loop-project:project-buildsense:status",
  "title": "BuildSense Project Status",
  "renderer_ref": "project-status@1",
  "viewer_topic_id": "p2p_human_steward",
  "visibility_policy_ref": "project-report/customer@1"
}
```

客户端不得提交 `owner_uid`。服务端以 `(authenticated_owner_uid, external_key)` 建立唯一约束。

Share/revoke 也只能由 owner 执行：

```http
POST /api/me/artifacts/project-buildsense-status/viewer-grants
Content-Type: application/json

{"topic_id": "p2p_human_steward"}
```

```http
DELETE /api/me/artifacts/project-buildsense-status/viewer-grants/p2p_human_steward
```

Viewer grant 表达 CatsCo topic membership scope；读取时仍需验证当前 requester 是该 topic 的合法成员。

Update state：

```http
PUT /api/me/artifacts/project-buildsense-status/state
Idempotency-Key: artifact-state:project-buildsense-status:ledger-r42
Content-Type: application/json

{
  "source_ledger_revision": 42,
  "source_event_watermark": 109,
  "content_digest": "sha256:...",
  "snapshot": {"$ref": "loop_project_report_v0 below"}
}
```

更新规则：

- 新 revision 大于 current：原子替换 current snapshot；
- 相同 revision + 相同 digest：幂等返回原 receipt；
- 相同 revision + 不同 digest：`409 projection_conflict`；
- 更旧 revision：`409 stale_projection`；
- writer principal 必须是 owner User 或该 User 委托且限定到此 Artifact 的 capability。

OpenCLI 对应 user-level commands：

```text
opencli catsco my-artifact create ...
opencli catsco my-artifact update-state <artifact-id> --source-revision 42 --snapshot ...
opencli catsco my-artifact refresh <artifact-id>
opencli catsco my-artifact share <artifact-id> --topic <topic-id>
opencli catsco my-artifact revoke <artifact-id> --topic <topic-id>
opencli catsco my-artifact show <artifact-id>
```

命令始终作用于当前登录的 CatsCo user，不接受任意 Agent UID 作为写目标。一个共享 Controller 进程也必须为每次 effect 装载单一 `owner_uid` delegation。

### Dynamic View

```http
GET /artifacts/project-buildsense-status
```

返回稳定 HTML shell。服务端验证当前 CatsCo user 是 owner，或是 `viewer_topic_id` 的合法成员。

```http
GET /api/artifacts/project-buildsense-status/snapshot
If-None-Match: "owner-42-artifact-project-buildsense-status-r42-sha256..."
```

无变化返回 `304`；有变化返回 current snapshot 与新 ETag。Shell 每 5–10 秒轮询并重绘；后续可替换为 SSE。Snapshot read/poll 不是 Kernel event，不创建 Action。

### Projection Update Request

```json
{
  "schema_version": "loop_project_projection_request_v0",
  "request_id": "projection-request-01",
  "owner_principal": "catsco-user:42",
  "trigger": "material_transition",
  "project": {"id": 12, "name": "BuildSense"},
  "artifact_id": "project-buildsense-status",
  "source_ledger_revision": 42,
  "visibility_policy_ref": "project-report/customer@1",
  "requested_at": "2026-08-04T02:00:00Z"
}
```

该请求只表示自动 material-transition 的 owner-scoped projection outbox effect；多个 pending revisions 可以 coalesce 到该 owner 的最新 source Ledger revision。

交互式 refresh 不伪装成 outbox event：Steward User 通过自身认证的 `my-artifact refresh/update-state` 直接读取当前 owner projection、运行同一确定性 renderer 并更新 Artifact。若 source revision 与 digest 未变则幂等 no-op。

### Canonical Projection Snapshot

```json
{
  "schema_version": "loop_project_report_v0",
  "artifact_id": "project-buildsense-status",
  "project": {"public_id": "project-buildsense", "name": "BuildSense"},
  "generated_at": "2026-08-04T02:00:05Z",
  "source_snapshot": {
    "project_updated_at": "2026-08-04T01:59:00Z",
    "ledger_revision": 42,
    "event_watermark": 109,
    "session_count": 8,
    "max_session_last_time": "2026-08-04T01:58:00Z",
    "digest": "sha256:..."
  },
  "renderer_version": "project-report-renderer@1",
  "visibility_policy_version": "project-report/customer@1",
  "freshness": {
    "state": "fresh|partial|stale",
    "unavailable_fields": ["task_status.summary"]
  },
  "summary": {
    "goal": "Improve notification reliability",
    "state_counts": {"running": 2, "waiting": 1, "review": 1, "done": 4},
    "public_next_action": "Review PR #456"
  },
  "items": [
    {
      "public_item_id": "task-3",
      "title": "Fix stale notification suppression",
      "state": "review",
      "progress_summary": "Implementation complete; checks passed",
      "waiting_on": "project review",
      "updated_at": "2026-08-04T01:50:00Z",
      "links": [{"kind": "github_pr", "url": "https://github.com/owner/repo/pull/456"}]
    }
  ],
  "narrative": {
    "kind": "agent_generated_optional",
    "text": "本周期完成 4 项任务，1 项等待评审。"
  }
}
```

Canonical JSON 由 owner workspace 的确定性 collector/renderer 生成。LLM 只能产生经过转义、明确标注的 `narrative`，不能改变结构化状态。

### State Update Receipt

```json
{
  "schema_version": "loop_project_artifact_state_receipt_v0",
  "owner_principal": "catsco-user:42",
  "artifact_id": "project-buildsense-status",
  "source_ledger_revision": 42,
  "source_event_watermark": 109,
  "content_digest": "sha256:...",
  "stable_url": "https://catsco.example/artifacts/project-buildsense-status",
  "writer_principal": "delegation:steward-42:artifact-project-buildsense-status",
  "idempotency_key": "artifact-state:project-buildsense-status:ledger-r42",
  "server_updated_at": "2026-08-04T02:00:08Z"
}
```

Artifact Host 是共享 infrastructure，但 receipt、row key、ETag、cache key 和 authorization 都绑定 owner namespace。它不拥有 system-global Loop state 或全站 publisher credential。

生成器执行 allowlist。topic/session/body identity、prompt/transcript、内部 error stack、本地路径、凭据和未授权 artifacts 永不进入默认 snapshot。缺失字段显式标记 unavailable。

State update 只完成该 User Workspace 的 projection outbox effect，绝不创建 Action 或改变 Work Item。需要静态归档时，再从固定 `source_ledger_revision + content_digest` 导出 immutable HTML/PDF。用户审批/反馈仍必须提交认证的 typed Gate/Feedback command。

## 16. 最低验证用例

1. 重复收到 Steward Work Bundle，不重复创建 issue/task；
2. Controller 在 CatsCo create/send 后崩溃，重启通过 postcondition readback 不重复创建或发送；
3. Worker 报告 `completed` 但没有 Candidate Commit receipt 时，不创建 review 或 next-loop Action；
4. Candidate commit ACK 丢失后以同一 event ID 重试，返回原 receipt 且只存在一个 review Action；
5. socket/ping 断开只进入 `connection=disconnected`；lease/liveness 阈值失效后才进入 `control=suspect`，两者都不完成、失败或立即重分配；
6. 同一 session 在 generation 未变化时重连并恢复原 Attempt；
7. grace 后 generation 被 superseded，旧 session 晚到 Candidate 被记录为 `late_orphaned`；
8. Worker lease 过期后提交 Candidate，被 fencing 拒绝；
9. 伪造 `attempt_id/generation` 但没有有效 runtime principal/lease proof 的事件被拒绝；
10. PR/artifact 已存在但没有合法 Candidate Packet 时记录 orphan，不推断完成；
11. `plan_next` 只在 Work Item profile-defined terminal 后创建；
12. PR head 更新后旧 Review Decision 和待执行 merge effect 失效；
13. Worker 声明路径合法但真实 PR diff 越界时，Candidate 被拒绝；
14. human Gate 缺少认证 principal 或 target digest 不匹配时被拒绝；
15. Artifact-only Candidate 可沿合法 profile 路径从 Accepted 进入 Closed；
16. `agent_task` 成员漂移被标记，但不会获得租约或验收权限；
17. watch 漏掉消息后，reconcile 能发现 Candidate；
18. CatsCo/GitHub 临时不可用时，outbox 重试且状态不回滚；
19. Self-iteration 声明 Low 但真实 diff 命中 High/Protected surface 时按更高等级处理；
20. Self-iteration 修改 evaluator 时，候选 evaluator 不能验收自身；
21. 合并 self-change 不会影响已开始 Attempt；canary 回归能恢复旧 epoch；
22. 普通 Worker User 无法使用 Steward User 的 Dispatcher/Reporter/Artifact delegation；
23. 任意 client-supplied `owner_uid` 被忽略或拒绝，写入 namespace 只来自 authenticated principal；
24. 一个共享 Controller/Artifact Host 上不同 `owner_uid` 的 Ledger、cache、idempotency key 和 Artifact 不发生串租户；
25. viewer 不属于授权 topic 时无法读取 Steward User 的 Artifact snapshot；
26. Dynamic Artifact 不包含 topic/session/prompt/path/private-artifact 字段；
27. `project-sessions` 缺失字段被标为 unavailable，而不是由 Agent 猜测；
28. 相同 source snapshot/policy/renderer 生成相同 canonical digest；
29. 相同 revision + 相同 digest 幂等成功；相同 revision + 不同 digest 冲突；旧 revision 不覆盖新 snapshot；
30. state update 失败只保留该 owner 的 projection dirty，不创建 Agent Action；
31. assignment/waiting/reassign/candidate/review/acceptance 等物质转换最终更新该 Steward User 的 Artifact；
32. 非 owner 不能创建、share、revoke 或更新 Artifact；viewer grant 仍要求 requester 是对应 topic 成员；
33. owner interactive refresh 直接更新 Artifact 或幂等 no-op，不创建 Kernel Action；
34. 用户对 Artifact 的反馈不能绕过 typed Gate/Feedback command 直接修改 Ledger。
