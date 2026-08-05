import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { LocalPilotCatscoAdapter } from '../adapters/catsco-local-pilot.js'
import { LocalPilotGitHubAdapter } from '../adapters/github-local-pilot.js'
import { CatscoReviewerAuthorityAdapter, UnavailableReviewerAuthorityAdapter } from '../adapters/reviewer.js'
import { Ed25519RuntimeProofAdapter } from '../adapters/runtime-ed25519.js'
import { ExplicitRuntimeProofAdapter } from '../adapters/runtime-explicit.js'
import { databasePath, saveConfig } from '../config.js'
import { ingest, type Providers } from '../controller/ingest.js'
import { reconcile } from '../controller/reconcile.js'
import { tick } from '../controller/tick.js'
import { digestJson } from '../lib/digest.js'
import { initializeOwner, migrate } from '../store/migrate.js'
import { loadSnapshot } from '../store/repositories.js'
import { openDatabase, type SqliteDatabase } from '../store/sqlite.js'
import { output } from './common.js'

const DATA = {
  ownerUid: 'local-pilot-owner',
  workItemId: 'local-pilot-work-item',
  workerUid: 'local-pilot-worker',
  stewardUid: 'local-pilot-steward',
  workerTopicId: 'local-pilot-worker-topic',
  stewardTopicId: 'local-pilot-steward-topic',
  repository: 'local/pilot',
  prNumber: 7,
  headSha: 'local-pilot-head-sha',
  baseSha: 'local-pilot-base-sha',
  hashes: {
    taskContractHash: 'local-task-contract-hash',
    referenceSnapshotHash: 'local-reference-snapshot-hash',
    writeScopeHash: 'local-write-scope-hash',
    acceptanceContractHash: 'local-acceptance-contract-hash'
  }
} as const

const TIMES = {
  initialized: '2026-08-05T00:00:00.000Z',
  registered: '2026-08-05T00:00:10.000Z',
  bundled: '2026-08-05T00:01:00.000Z',
  executeWake: '2026-08-05T00:01:30.000Z',
  runtimeStarted: '2026-08-05T00:02:00.000Z',
  candidate: '2026-08-05T00:03:00.000Z',
  reviewWake: '2026-08-05T00:03:30.000Z',
  review: '2026-08-05T00:04:00.000Z',
  planWake: '2026-08-05T00:04:30.000Z',
  leaseExpires: '2026-08-06T00:00:00.000Z',
  tick: '2026-08-05T00:10:00.000Z'
} as const

export interface LocalPilotOptions {
  stateRoot?: string
  keepState?: boolean
}

export interface LocalPilotReport {
  localOnly: true
  stateRoot: string | 'removed'
  databasePath: string | 'removed'
  finalState: { workItem: string; revision: number; attempt: string }
  actionCounts: Record<string, number>
  candidateCount: number
  outbox: { total: number; satisfied: number }
  cursorPositions: Record<string, string>
  sendSummary: { topicId: string; count: number; actionIds: string[] }[]
  runtimeStartedSource: 'simulated-control-bridge'
  idempotencyVerified: true
  livePrerequisites: {
    requiredForLocalPilot: string[]
    requiredForLivePilot: string[]
  }
}

const event = (type: string, key: string, source: string, payload: unknown) => ({
  type,
  eventId: `local-pilot-event:${key}`,
  idempotencyKey: `local-pilot:${key}`,
  source,
  entityRef: `work_item:${DATA.workItemId}`,
  payload
})

async function prepareRoot(requested?: string): Promise<string> {
  if (!requested) return mkdtemp(join(tmpdir(), 'loopctl-local-pilot-'))
  const root = resolve(requested)
  try {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('local pilot state root must be a real directory')
    if ((await readdir(root)).length !== 0) throw new Error('local pilot state root must be empty')
    await chmod(root, 0o700)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(root, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
  }
  return root
}

function providers(at: string, suffix: string): Providers {
  return { now: () => at, id: prefix => `${prefix}:local-pilot:${suffix}` }
}

function count(db: SqliteDatabase, sql: string, ...params: unknown[]): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count)
}

function requirePilot(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`local pilot assertion failed: ${message}`)
}

export async function runLocalPilot(options: LocalPilotOptions = {}): Promise<LocalPilotReport> {
  const root = await prepareRoot(options.stateRoot)
  const keepState = options.keepState === true
  const config = { ownerUid: DATA.ownerUid, stateRoot: root, opencliCommand: 'local-only-disabled', ghCommand: 'local-only-disabled' }
  const dbPath = databasePath(config)
  let db: SqliteDatabase | undefined

  try {
    await saveConfig(config)
    db = openDatabase(dbPath)
    migrate(db)
    initializeOwner(db, DATA.ownerUid, TIMES.initialized)

    const catsco = new LocalPilotCatscoAdapter(DATA.ownerUid, [TIMES.executeWake, TIMES.reviewWake, TIMES.planWake])
    const deliverableBody = {
      kind: 'github_pr' as const,
      repository: DATA.repository,
      prNumber: DATA.prNumber,
      headSha: DATA.headSha,
      baseSha: DATA.baseSha
    }
    const deliverableDigest = digestJson(deliverableBody)
    const github = new LocalPilotGitHubAdapter({
      repository: DATA.repository,
      prNumber: DATA.prNumber,
      headSha: DATA.headSha,
      baseSha: DATA.baseSha,
      changedPaths: ['src/local-pilot.ts', 'tests/local-pilot.test.ts'],
      state: 'open',
      merged: false
    })
    const adapters = {
      catsco,
      github,
      runtime: new ExplicitRuntimeProofAdapter(new Ed25519RuntimeProofAdapter()),
      reviewer: new CatscoReviewerAuthorityAdapter(new UnavailableReviewerAuthorityAdapter())
    }
    const tickOptions = {
      maxEvents: 100,
      maxEffects: 100,
      outboxProviders: { now: () => TIMES.tick, token: () => 'local-pilot-claim-token' }
    }

    const registration = event('work_item_registered', 'register', 'operator', {
      workItemId: DATA.workItemId,
      loopId: 'local-pilot-loop',
      profileId: 'local-pilot@1',
      terminalState: 'accepted',
      ...DATA.hashes,
      writeScope: ['src/**', 'tests/**'],
      githubRepo: DATA.repository,
      catscoProjectId: 'local-pilot-project',
      workerTopicId: DATA.workerTopicId,
      stewardTopicId: DATA.stewardTopicId,
      stewardPrincipal: `catsco-user:${DATA.stewardUid}`
    })
    const bundle = event('work_bundle_proposed', 'bundle', 'operator', {
      workItemId: DATA.workItemId,
      expectedRevision: 1,
      attemptId: 'local-pilot-attempt-1',
      attemptNumber: 1,
      generation: 1,
      runtimePrincipal: `catsco-user:${DATA.workerUid}`,
      proofMode: 'catsco-message',
      leaseExpiresAt: TIMES.leaseExpires,
      workBundle: {
        contractDigest: 'local-pilot-bundle-digest',
        instructions: 'Execute the deterministic local pilot bundle',
        deliverables: ['GitHub pull request']
      },
      ...DATA.hashes
    })
    ingest(db, DATA.ownerUid, registration, providers(TIMES.registered, 'register'))
    ingest(db, DATA.ownerUid, bundle, providers(TIMES.bundled, 'bundle'))
    await tick(db, DATA.ownerUid, adapters, tickOptions)

    const runtimeStarted = event('runtime_started', 'runtime-started', 'control', {
      workItemId: DATA.workItemId,
      expectedRevision: 2,
      attemptId: 'local-pilot-attempt-1',
      generation: 1,
      runtimePrincipal: `catsco-user:${DATA.workerUid}`,
      signature: 'catsco-message-attested'
    })
    const runtimeStartedAttestation = catsco.enqueueObservation(DATA.workerTopicId, DATA.workerUid, runtimeStarted, TIMES.runtimeStarted)
    await reconcile(db, DATA.ownerUid, catsco, providers(TIMES.runtimeStarted, 'runtime-started-reconcile'))
    await tick(db, DATA.ownerUid, adapters, tickOptions)

    const candidate = event('candidate_submitted', 'candidate', 'catsco', {
      ownerUid: DATA.ownerUid,
      workItemId: DATA.workItemId,
      workItemRevision: 3,
      attemptId: 'local-pilot-attempt-1',
      generation: 1,
      runtimePrincipal: `catsco-user:${DATA.workerUid}`,
      proofMode: 'catsco-message',
      candidateId: 'local-pilot-candidate-1',
      deliverable: { ...deliverableBody, digest: deliverableDigest },
      ...DATA.hashes
    })
    const candidateAttestation = catsco.enqueueObservation(DATA.workerTopicId, DATA.workerUid, candidate, TIMES.candidate)
    await reconcile(db, DATA.ownerUid, catsco, providers(TIMES.candidate, 'candidate-reconcile'))
    await tick(db, DATA.ownerUid, adapters, tickOptions)

    const review = event('review_decided', 'review', 'catsco', {
      workItemId: DATA.workItemId,
      expectedRevision: 4,
      candidateId: 'local-pilot-candidate-1',
      outcome: 'accepted',
      reviewerPrincipal: `catsco-user:${DATA.stewardUid}`,
      reviewedHeadSha: DATA.headSha,
      reviewedDeliverableDigest: deliverableDigest,
      acceptanceContractHash: DATA.hashes.acceptanceContractHash
    })
    const reviewAttestation = catsco.enqueueObservation(DATA.stewardTopicId, DATA.stewardUid, review, TIMES.review)
    await reconcile(db, DATA.ownerUid, catsco, providers(TIMES.review, 'review-reconcile'))
    await tick(db, DATA.ownerUid, adapters, tickOptions)

    const duplicateRegistration = ingest(db, DATA.ownerUid, registration, providers(TIMES.registered, 'duplicate-register'))
    const duplicateBundle = ingest(db, DATA.ownerUid, bundle, providers(TIMES.bundled, 'duplicate-bundle'))
    const duplicateStarted = ingest(db, DATA.ownerUid, runtimeStarted, providers(TIMES.runtimeStarted, 'duplicate-started'), runtimeStartedAttestation)
    const duplicateCandidate = ingest(db, DATA.ownerUid, candidate, providers(TIMES.candidate, 'duplicate-candidate'), candidateAttestation)
    const duplicateReview = ingest(db, DATA.ownerUid, review, providers(TIMES.review, 'duplicate-review'), reviewAttestation)
    requirePilot([duplicateRegistration, duplicateBundle, duplicateStarted, duplicateCandidate, duplicateReview]
      .every(receipt => receipt.status === 'committed'), 'exact duplicate ingress did not return committed receipts')

    const snapshot = loadSnapshot(db, DATA.ownerUid, DATA.workItemId)
    const actionRows = db.prepare(`SELECT kind,count(*) count FROM actions WHERE owner_uid=? GROUP BY kind`)
      .all(DATA.ownerUid) as { kind: string; count: number }[]
    const actionCounts = Object.fromEntries(actionRows.map(row => [row.kind, Number(row.count)]))
    const candidateCount = count(db, 'SELECT count(*) count FROM candidates WHERE owner_uid=?', DATA.ownerUid)
    const outboxTotal = count(db, 'SELECT count(*) count FROM outbox WHERE owner_uid=?', DATA.ownerUid)
    const outboxSatisfied = count(db, "SELECT count(*) count FROM outbox WHERE owner_uid=? AND state='satisfied'", DATA.ownerUid)
    const cursorRows = db.prepare(`SELECT scope_key,cursor_json FROM source_cursors WHERE owner_uid=? AND source='catsco'`)
      .all(DATA.ownerUid) as { scope_key: string; cursor_json: string }[]
    const cursorPositions = Object.fromEntries(cursorRows.map(row => [row.scope_key, String(JSON.parse(row.cursor_json))]))
    const sendSummary = [DATA.workerTopicId, DATA.stewardTopicId].map(topicId => {
      const sends = catsco.sends.filter(send => send.topicId === topicId)
      return {
        topicId,
        count: sends.length,
        actionIds: sends.map(send => String((JSON.parse(send.content) as { actionId: string }).actionId))
      }
    })

    requirePilot(snapshot.workItem?.state === 'accepted', 'Work Item is not accepted')
    requirePilot(snapshot.workItem.revision === 5, 'Work Item revision is not 5')
    requirePilot(snapshot.attempt?.controlState === 'accepted', 'Attempt is not accepted')
    requirePilot(candidateCount === 1, 'Candidate count is not one')
    for (const kind of ['execute_attempt', 'review_candidate', 'plan_next']) {
      requirePilot(actionCounts[kind] === 1, `${kind} Action count is not one`)
    }
    requirePilot(outboxTotal === 3 && outboxSatisfied === outboxTotal, 'not all outbox effects are satisfied')
    requirePilot(cursorPositions[DATA.workerTopicId] === '3', 'Worker cursor did not advance through the Candidate')
    requirePilot(cursorPositions[DATA.stewardTopicId] === '2', 'Steward cursor did not advance through the review')
    requirePilot(sendSummary[0]?.count === 1 && sendSummary[1]?.count === 2, 'wakes were not sent to expected topics')

    const report: LocalPilotReport = {
      localOnly: true,
      stateRoot: keepState ? root : 'removed',
      databasePath: keepState ? dbPath : 'removed',
      finalState: { workItem: snapshot.workItem.state, revision: snapshot.workItem.revision, attempt: snapshot.attempt.controlState },
      actionCounts,
      candidateCount,
      outbox: { total: outboxTotal, satisfied: outboxSatisfied },
      cursorPositions,
      sendSummary,
      runtimeStartedSource: 'simulated-control-bridge',
      idempotencyVerified: true,
      livePrerequisites: {
        requiredForLocalPilot: [],
        requiredForLivePilot: [
          'authenticated CatsCo/OpenCLI session',
          'ambient gh authentication',
          'runtime launch/control bridge'
        ]
      }
    }
    db.close()
    db = undefined
    return report
  } finally {
    db?.close()
    if (!keepState) await rm(root, { recursive: true, force: true })
  }
}

export async function localPilotCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      'state-root': { type: 'string' },
      'keep-state': { type: 'boolean' }
    },
    strict: true
  })
  output(await runLocalPilot({
    ...(values['state-root'] ? { stateRoot: values['state-root'] } : {}),
    keepState: values['keep-state'] === true
  }))
}
