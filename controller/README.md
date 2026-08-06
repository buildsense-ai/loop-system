# loopctl MVP

`loopctl` is a short-lived, deterministic Loop Controller for one CatsCo owner namespace. It stores ingress, Work Items, Attempts, Candidates, Actions, outbox effects, receipts, and reconciliation cursors in SQLite. It is a focused control-plane slice, not an Agent or a network service.

## Current capability boundary

Implemented:

- owner-bound SQLite state with durable, idempotent ingress;
- `work_item_registered → work_bundle_proposed → runtime_started → candidate_submitted → authenticated review_decided`;
- Candidate Commit as the only transition from execution to review;
- exact revision, insert-only Attempt identity, generation, principal, contract, GitHub head/base/diff, and deliverable-digest checks;
- durable rejection of conflicting event/idempotency identifiers and transactional obsolescence of stale wakes;
- authenticated reviewer authority plus reviewed head/digest/acceptance-contract fencing;
- profile terminals at `accepted`, or at exact-head readback-confirmed merged `closed`;
- unique Action-gated `execute_attempt`, `review_candidate`, and terminal `plan_next` wakes;
- transactional state + Candidate + Action + outbox + transition receipt commits;
- outbox claims, exponential retry, postcondition lookup, and durable effect receipts;
- explicit, durable runtime proof modes: default Ed25519 or trusted CatsCo-message attestation, plus read-only `gh api` PR evidence;
- trusted CatsCo envelope attestations (`topicId`, `seqId`, `senderUid`, `serverReceivedAt`) stored separately from message-controlled JSON;
- stored Steward principal/topic authorization for attested CatsCo review decisions;
- CLI commands: `init`, `ingest`, `tick`, `status`, `receipt`, `reconcile`, `doctor`, and local-only `local-pilot`.

Explicitly unavailable:

- automatic Kernel-owned task/topic creation or project assignment; Review may create or reuse a standard collaboration group through OpenCLI, then register its verified `grp_*` topic in the Plan;
- real runtime launch/resume/cancel;
- a production authority bridge for unattested/manual reviews; the pilot accepts reviews only through trusted CatsCo message attestation unless another explicit adapter is installed;
- Dynamic Artifact writes from loopctl; Artifact discovery exists, while interactive create/update remains the Steward Agent's responsibility;
- parallel Attempts and self-activation;

Available with explicit P0 limits:

- owner/Worker discovery and stable P2P topic resolution through `catsco me`, `catsco agents`, and `catsco open`;
- idempotent sends to an existing CatsCo topic through `opencli catsco send --client-message-id ... --format json`; group sends additionally carry a structured `--mention usr<uid>` derived from the committed Action target;
- bounded polling of each unique active Worker and Steward P2P topic through `opencli catsco messages --after-seq ... --limit 200 --format json`;
- read-only operator projection through `catsco projects`, `project-sessions`, and `artifacts`.

The P2P-topic pilot treats only the server-observed message envelope returned by the installed OpenCLI CatsCo `messages --after-seq` surface as transport attestation. `senderUid`, `topicId`, `seqId`, and `serverReceivedAt` are canonicalized and stored outside `raw_json`; identifier/deduplication digests bind both the event and attestation. The polling lane has a strict content allowlist: only `candidate_submitted` and `review_decided` can become ingress events. Plain text, malformed/unrecognized JSON, and all control events—including `runtime_started` and registration/bundle events—are skipped while the verified envelope cursor advances. Message content, including claimed principals, signatures, task status, and read-side `contentDigest`, remains untrusted. Manual `loopctl ingest` has no attestation and cannot exercise CatsCo-message authority.

Receipt reconciliation is not server-authoritative by client message ID. `message-receipt` reads this machine's shared local OpenCLI registry, then confirms its stored seq is present in the server's latest history window. Client message IDs bind transport version, authenticated owner UID, target topic, effect key, and exact canonical content digest; this prevents normal cross-owner registry-key collisions even when owners use the same topic/effect. Only a `serverConfirmed: true` receipt with the exact expected send digest satisfies the pre-send postcondition; otherwise loopctl safely resends with the same content-addressed ID. This requires one controller/OpenCLI host and topics whose unread/latest window stays within 200 messages. `hasMore: true`, missing seq/time fields, or inconsistent cursor metadata fails closed without cursor advance. Read-side `contentDigest` is not used to prove send/read equality.

Task status `completed`, disconnects, reconciliation ticks, and orphan PR observations never create a Candidate or `plan_next` Action.

## Architecture

```text
JSON event → durable inbox → pure decide(snapshot,event)
                            ↓ one SQLite transaction
             Work Item / Attempt / Candidate / Action / outbox / receipt
                                                        ↓ after commit
                                  adapter registry → effect receipt or retry
```

SQLite uses WAL, foreign keys, full synchronous commits, a busy timeout, and `BEGIN IMMEDIATE`. Every operational primary/unique/foreign key is owner-scoped. A `wake_agent` outbox row has a composite foreign key to its Action plus a trigger requiring an exact ready Action revision and digest.

The runtime database is outside the repository:

```text
$LOOPCTL_STATE_ROOT/config.json
$LOOPCTL_STATE_ROOT/catsco/<verified-owner-uid>/loop.db
```

No command accepts an owner UID. `init` derives it from the authenticated `opencli catsco me` result. Tokens, passwords, and runtime private keys are never stored.

## Install and build

Requires Node 20+ and pnpm 10.15.

```bash
pnpm install
pnpm check
pnpm build
node dist/cli.js
```

The package bin target is `dist/cli.js`. From this standalone checkout, invoke it as `node dist/cli.js`; a linked/installed package receives the normal `loopctl` shim.

## Deterministic local pilot

Run the accepted-terminal controller lifecycle without OpenCLI, CatsCo writes, or GitHub writes:

```bash
pnpm pilot:local
```

The equivalent built CLI command is:

```bash
node dist/cli.js local-pilot [--state-root DIR] [--keep-state]
```

By default the command creates a mode-0700 temporary state root and removes it on success or failure. `--keep-state` retains it for inspection. A supplied `--state-root` must be empty and is also removed unless kept. The concise JSON result identifies itself with `localOnly: true` and records that `runtime_started` came from a simulated control bridge.

This proves **only the local controller pipeline**: real migrations, durable ingest/processing/reconciliation/outbox receipts, kernel transitions, trusted-envelope validation, and terminal assertions against local-only adapters. It does **not** prove live CatsCo delivery or polling, GitHub read/write behavior, task/topic creation, or a runtime bridge. A live pilot still requires an authenticated CatsCo/OpenCLI session, ambient `gh` authentication, and the missing runtime launch/control bridge.

## CLI workflow

An authenticated CatsCo browser/OpenCLI session is required for `init`, `doctor`, attempted effects, and reconciliation. Reconciliation calls `catsco me` once, verifies the authenticated UID before polling or cursor changes, then deduplicates all active Worker and Steward topics. Each topic has one durable seq cursor, advanced only after durable attested ingest. Ambient `gh` authentication is required for Candidate, review, and merge/close readback. Unattested review authority remains deliberately unavailable by default.

```bash
export LOOPCTL_STATE_ROOT="$HOME/.local/state/loopctl"
node dist/cli.js init --state-root "$LOOPCTL_STATE_ROOT"
node dist/cli.js ingest --file work-item.json
node dist/cli.js ingest --file work-bundle.json
node dist/cli.js ingest --file runtime-started.json
node dist/cli.js tick --no-effects
node dist/cli.js ingest --file signed-candidate.json
node dist/cli.js tick --no-effects
node dist/cli.js status --include-outbox --json
node dist/cli.js receipt candidate:wi-1:a1 --json
node dist/cli.js reconcile --enqueue-only
node dist/cli.js doctor --json
```

Use `--no-effects` for dry control-plane operation. Without it, `tick` may send idempotent wakes to already-existing topics. Review can create and verify a standard collaboration group before registration; the deterministic Controller itself does not create topics. Receipt semantics remain limited to the local registry plus bounded server sequence confirmation.

### Event examples

All external JSON is strict schema-validated. Hash values below are illustrative but must remain identical across Work Item, Attempt, and Candidate.

```json
{
  "type": "work_item_registered",
  "eventId": "evt-register-wi-1",
  "idempotencyKey": "register:wi-1:r1",
  "source": "operator",
  "entityRef": "work_item:wi-1",
  "payload": {
    "workItemId": "wi-1",
    "loopId": "loop-1",
    "profileId": "product@1",
    "terminalState": "accepted",
    "taskContractHash": "task-hash-0001",
    "referenceSnapshotHash": "reference-hash-1",
    "writeScopeHash": "write-scope-hash",
    "acceptanceContractHash": "acceptance-hash",
    "writeScope": ["src/**", "tests/**"],
    "githubRepo": "owner/repo",
    "catscoProjectId": "existing-project",
    "workerTopicId": "example-worker-topic",
    "stewardTopicId": "example-steward-topic",
    "stewardPrincipal": "catsco-user:example-steward"
  }
}
```

```json
{
  "type": "work_bundle_proposed",
  "eventId": "evt-bundle-wi-1-a1",
  "idempotencyKey": "bundle:wi-1:a1",
  "source": "operator",
  "entityRef": "work_item:wi-1",
  "payload": {
    "workItemId": "wi-1",
    "expectedRevision": 1,
    "attemptId": "attempt-1",
    "attemptNumber": 1,
    "generation": 1,
    "runtimePrincipal": "catsco-user:example-worker",
    "proofMode": "catsco-message",
    "leaseExpiresAt": "2030-01-01T00:00:00.000Z",
    "workBundle": {
      "contractDigest": "bundle-digest-1",
      "instructions": "Implement the frozen task contract",
      "deliverables": ["GitHub pull request"]
    },
    "taskContractHash": "task-hash-0001",
    "referenceSnapshotHash": "reference-hash-1",
    "writeScopeHash": "write-scope-hash",
    "acceptanceContractHash": "acceptance-hash"
  }
}
```

A Worker posts this content to the registered Worker P2P topic; the envelope fields are supplied by CatsCo, not copied into this JSON:

```json
{
  "type": "candidate_submitted",
  "eventId": "evt-candidate-wi-1-a1",
  "idempotencyKey": "candidate:wi-1:a1",
  "source": "catsco",
  "entityRef": "work_item:wi-1",
  "payload": {
    "ownerUid": "example-owner",
    "workItemId": "wi-1",
    "workItemRevision": 3,
    "attemptId": "attempt-1",
    "generation": 1,
    "runtimePrincipal": "catsco-user:example-worker",
    "proofMode": "catsco-message",
    "candidateId": "candidate-1",
    "deliverable": { "kind": "github_pr", "repository": "owner/repo", "prNumber": 7, "headSha": "abc123", "baseSha": "def456", "digest": "deliverable-digest" },
    "taskContractHash": "task-hash-0001",
    "referenceSnapshotHash": "reference-hash-1",
    "writeScopeHash": "write-scope-hash",
    "acceptanceContractHash": "acceptance-hash"
  }
}
```

A Steward review uses the same attested-message path on the registered Steward P2P topic:

```json
{
  "type": "review_decided",
  "eventId": "evt-review-candidate-1",
  "idempotencyKey": "review:candidate-1",
  "source": "catsco",
  "entityRef": "work_item:wi-1",
  "payload": {
    "workItemId": "wi-1",
    "expectedRevision": 4,
    "candidateId": "candidate-1",
    "outcome": "accepted",
    "reviewerPrincipal": "catsco-user:example-steward",
    "reviewedHeadSha": "abc123",
    "reviewedDeliverableDigest": "deliverable-digest",
    "acceptanceContractHash": "acceptance-hash"
  }
}
```

`proofMode` is stored on the Attempt and never inferred or changed. Omit it for backwards-compatible `ed25519`, which requires `proofKeyId`, `proofPublicKey`, and a Candidate `signature`. `catsco-message` requires those key/signature fields to be absent. Its Candidate must arrive with trusted attestation on the registered Worker topic, before lease expiry, from the sender whose `catsco-user:<senderUid>` principal exactly matches the enrolled runtime principal. Attempt, generation, principal, and all contract fences remain mandatory; there is no cross-mode fallback.

After a matching `runtime_started`, a Candidate packet binds `ownerUid`, the current Work Item revision, Attempt ID, generation, proof mode, runtime principal, all four contract hashes, and an exact GitHub PR head/base/digest. In Ed25519 mode the signature covers the canonical packet excluding `signature`. `gh api` independently reads the PR and changed paths; declared paths are not trusted.

An attested review must arrive on `stewardTopicId` from the sender whose `catsco-user:<senderUid>` equals both stored `stewardPrincipal` and the decision's `reviewerPrincipal`. It remains bound to the exact Candidate ID, reviewed head SHA, deliverable digest, and Acceptance Contract hash, with independent GitHub readback. `outcome: "changes_requested"` returns to a new, higher-generation work bundle. `outcome: "accepted"` creates `plan_next` only for an `accepted` terminal profile. A `closed` terminal profile waits for a `deliverable_closed_observed` event whose exact Candidate head is independently read back as merged and closed; only that transition creates `plan_next`.

## Operations and recovery

- Re-submit only the byte-equivalent canonical event with the same event ID and idempotency key to obtain the original receipt. Reused or cross-aliased identifiers with a different digest receive a durable `identifier_conflict` receipt.
- Back up the database plus WAL/SHM consistently, or stop ticks before copying.
- A transient Candidate validation failure remains pending and blocks later inbox processing to preserve ingress order.
- A rejected Candidate has a durable rejection code and no Candidate/Action/outbox mutations. Reusing an owner-local Candidate ID through any different event/idempotency path yields `candidate_id_conflict` and does not poison ordered inbox processing.
- Effects execute outside the state transaction. A retry performs message postcondition lookup before sending and again after an ambiguous send error. Outbox transport identity, Action bindings, payload/destination, precondition, postcondition, and creation time are SQLite-trigger immutable. Pre-v3 pending effects are obsoleted during migration because their IDs were not owner/topic/version bound. Revision advances cancel predecessor Actions and mark their outbox rows obsolete; the executor rechecks current revision and semantic state immediately before send.
- Run one process per owner database and keep reconciliation on the same host/OpenCLI receipt registry. SQLite serializes writers, but this MVP is operationally scoped to a single-owner, single-instance chain.
- CatsCo `serverReceivedAt` is the trusted ingress time only when it is part of a complete server-observed attestation. A cursor is written only after durable inbox ingest; a crash between those commits safely causes duplicate ingest on restart.
- Topic membership and the OpenCLI/browser session are inside the pilot trust boundary. Compromise of CatsCo, the authenticated browser profile, the OpenCLI adapter process, or this controller process can forge transport authority. Message authors cannot gain authority by putting envelope-like fields in JSON content.

## Integration gaps

The P0 OpenCLI transport enables P2P wakes and structured-mention wakes in a verified standard collaboration group, but CatsCo still lacks a server-authoritative lookup by client message ID and the backend history window is bounded. Crash-safe automatic task creation still needs an owner-scoped external Work Item create-or-find contract. Task/topic creation, Dynamic Artifact writes, a runtime launch/resume/cancel wrapper, and unattested reviewer authority remain unavailable. The controller does not use `run_id`/`body_id` as authority and never treats task status `completed` as completion. Ed25519 remains the default proof mode; CatsCo-message authority is explicit and retains the same GitHub, revision, generation, lease, principal, and contract fencing.
