# ADR 0002: Steward User Owns Projects, Loop Namespace, and Dynamic Artifacts

- Status: Accepted
- Date: 2026-08-04

## Context

CatsCo 的基本权限边界是 user：Project 已由 `owner_uid` 隔离；friendship、sessions 和 Agent identity 也围绕用户建立。Steward/Review Agent 在产品中应当像人类一样拥有独立 CatsCo user identity，而不是成为 system-global service principal。

人类需要在与 Steward User 的 session 中查看“做了什么、做到哪里、阻塞在哪里、下一步是什么”，但不应获得该 Steward 的完整私有 Project、Worker topics、runtime identity 或内部错误。

如果为 Loop 单独建立 system-owned Artifact API、全局 Publisher 或共享 owner token，会破坏 CatsCo 已有的 user ownership，并扩大凭据与跨租户风险。

## Decision

### User Workspace 是所有权边界

每个 Steward User Workspace 拥有自己的：

- friend graph 与 Worker address book；
- CatsCo Projects；
- Loop Ledger/inbox/outbox/action namespace；
- Controller delegation；
- Artifacts 与 viewer grants；
- sessions。

所有持久 key、idempotency key、cache 和 credentials 都必须绑定 `owner_uid`。一个物理进程或数据库可以多租户共享，但不能拥有 system-global Loop authority。

### Project 保持 owner-private

CatsCo Project 继续作为 Steward User 的 Internal Operator View。普通人类 viewer 不直接读取 Project。

### Artifact 是 Steward User 创建的动态资源

MVP 使用 generic user-owned Dynamic Artifact，而不是 system-created report 或每次上传静态文件：

1. Steward User 在人类 session 中调用 `/api/me/artifacts` create-or-find；
2. Artifact 绑定 `(owner_uid, external_key)`、generic renderer 和 viewer topic；
3. 交互式创建/刷新由 Steward User 通过自身认证的 OpenCLI 完成；
4. 物质状态转换后的自动更新由该用户的 Controller 生成脱敏 snapshot，并以限定到该 owner/artifact 的 delegation 调用 `/api/me/artifacts/{id}/state`；
5. Artifact Host 只接受单调 `source_ledger_revision`；
6. 稳定 URL 动态渲染 current snapshot；打开中的页面以 ETag polling 更新。

物理上可以使用共享 CatsCo Artifact Host，但它只提供通用 user capability：identity、state storage、viewer ACL、stable URL 和 renderer。它不知道 Work Item、Attempt、Candidate、Review 或 Loop transitions。

`source_ledger_revision` 是 MVP 的更新版本：

- 相同 revision + 相同 digest：幂等；
- 相同 revision + 不同 digest：冲突；
- 旧 revision：拒绝；
- 新 revision：原子替换 current snapshot。

Loop Ledger 已保存历史。第一版 Artifact Host 不再复制完整 revision history；需要 HTML/PDF/审计时，从固定 `source_ledger_revision + content_digest` 导出 immutable snapshot。

## Consequences

### Positive

- 与 CatsCo 原生 user ownership、Project scope 和 friend graph 一致；
- Steward User 可以像人类一样创建、维护和分享自己的 Artifact；
- 不需要 system-global publisher、跨用户 owner token 或 Loop-specific dashboard；
- 共享基础设施仍可高效承载多用户；
- 一个稳定 URL 即可动态展示最新 Projection；
- `source_ledger_revision` 取代额外 publish-version 协议，减少 MVP 工作量。

### Negative

- Artifact state 是最终一致的 Projection，可能短暂落后于 Ledger；
- Shared Artifact Host 必须严格测试 owner partition、cache key 和 viewer ACL；
- 当前 OpenCLI 只有 read-only artifacts 命令，需要增加只作用于当前登录用户的 create/update-state commands；
- 当前 `project-sessions` 字段不足，高可信 snapshot 仍需补强 read model；
- 动态页面依赖 CatsCo/Artifact Host 可用性。

## Rejected Alternatives

### A. System-global Loop/Artifact Service

拒绝。它与 CatsCo 的 user ownership 不一致，需要全站凭据并放大跨租户风险。

### B. 每个用户启动独立 Artifact Server

拒绝作为 MVP。逻辑上 user-scoped 不要求物理上一用户一进程；共享 multi-tenant host 更省部署与运维。

### C. 每次状态变化上传静态 Artifact Revision

不作为默认进度视图。它引入 object storage、publish CAS、latest pointer 和历史清理，而 Loop Ledger 已保存历史。静态版本仅用于导出和审计。

### D. 直接共享 CatsCo Project

拒绝作为 MVP。它会引入 Project members、角色、邀请、撤销和内部字段脱敏问题。

### E. 让 LLM 自由阅读聊天并写报告

拒绝。LLM narrative 只能建立在确定性 canonical snapshot 之上。

## Security and Correctness Invariants

- Artifact owner 只能从 authenticated principal 推导；客户端不得指定任意 `owner_uid`；
- Steward User 可以直接写自己的 Artifact；自动 Controller delegation 限定 `owner_uid + artifact_id + update-state`；
- 普通 Worker User 不继承 Steward User 的 Artifact write capability；
- viewer 必须是 owner 或被授权 topic 的合法成员；
- Ledger/inbox/outbox/action/artifact/cache/idempotency 均按 `owner_uid` 分区；
- Visibility Policy 使用字段 allowlist，缺失字段显式 unavailable；
- state update 只推进 Projection，不创建 Action、不改变 Work Item；
- Artifact feedback 必须通过认证 typed command 回到该 User Workspace 的 Kernel；
- 相同 source snapshot + policy + renderer version 产生相同 canonical digest。
