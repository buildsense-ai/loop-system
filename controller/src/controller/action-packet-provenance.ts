import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { constants, chmodSync, closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { SqliteDatabase } from '../store/sqlite.js'
import { canonicalize } from '../lib/canonical-json.js'
import { digestJson } from '../lib/digest.js'

const SIGNING_ALGORITHM = 'ed25519'
const KEY_FILE_PREFIX = 'controller-action-signing-v1-'

type Packet = Record<string, unknown>

interface StoredSigningIdentity {
  version: 1
  ownerUid: string
  keyId: string
  publicKey: string
  privateKey: string
}

interface ControllerActionProvenance {
  controllerSignatureAlgorithm: typeof SIGNING_ALGORITHM
  controllerKeyId: string
  controllerPublicKey: string
  controllerSignature: string
}

function keyIdFor(publicKey: string): string {
  return `controller-ed25519:${createHash('sha256').update(publicKey).digest('base64url')}`
}

function keyPath(db: SqliteDatabase, ownerUid: string): string {
  const databasePath = String(db.name)
  if (!databasePath || databasePath === ':memory:') {
    throw new Error('Controller action signing requires a durable owner-scoped database path')
  }
  const ownerKey = createHash('sha256').update(ownerUid).digest('hex')
  return join(dirname(resolve(databasePath)), `${KEY_FILE_PREFIX}${ownerKey}.json`)
}

function assertStoredIdentity(value: unknown, ownerUid: string): StoredSigningIdentity {
  if (!value || typeof value !== 'object') throw new Error('invalid Controller action signing identity')
  const identity = value as Partial<StoredSigningIdentity>
  if (identity.version !== 1 || identity.ownerUid !== ownerUid ||
    typeof identity.keyId !== 'string' || typeof identity.publicKey !== 'string' || typeof identity.privateKey !== 'string') {
    throw new Error('invalid Controller action signing identity')
  }
  const privateKey = createPrivateKey(identity.privateKey)
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  if (publicKey !== identity.publicKey || identity.keyId !== keyIdFor(publicKey)) {
    throw new Error('Controller action signing identity integrity check failed')
  }
  return identity as StoredSigningIdentity
}

function readIdentity(path: string, ownerUid: string): StoredSigningIdentity | undefined {
  let descriptor: number | undefined
  try {
    let pathStats: ReturnType<typeof lstatSync>
    try {
      pathStats = lstatSync(path)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (pathStats.isSymbolicLink()) throw new Error('Controller action signing identity must not be a symbolic link')
    if (!pathStats.isFile()) throw new Error('Controller action signing identity must be a regular file')
    if ((pathStats.mode & 0o077) !== 0) {
      throw new Error('Controller action signing identity must not be readable or writable by group or others')
    }

    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const descriptorStats = fstatSync(descriptor)
    if (!descriptorStats.isFile()) throw new Error('Controller action signing identity must be a regular file')
    if ((descriptorStats.mode & 0o077) !== 0) {
      throw new Error('Controller action signing identity must not be readable or writable by group or others')
    }
    // Owner-only files that merely lack owner-write (or retain owner-execute)
    // are repaired through the descriptor, never by following a pathname.
    fchmodSync(descriptor, 0o600)
    if ((fstatSync(descriptor).mode & 0o777) !== 0o600) {
      throw new Error('Controller action signing identity must have mode 0600')
    }
    return assertStoredIdentity(JSON.parse(readFileSync(descriptor, 'utf8')), ownerUid)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function pinnedKeyId(db: SqliteDatabase, ownerUid: string): string | undefined {
  const row = db.prepare('SELECT key_id FROM controller_action_signing_pins WHERE owner_uid=?').get(ownerUid) as { key_id: string } | undefined
  return row?.key_id
}

function pinIdentity(db: SqliteDatabase, ownerUid: string, identity: StoredSigningIdentity): void {
  db.prepare('INSERT OR IGNORE INTO controller_action_signing_pins(owner_uid,key_id) VALUES(?,?)').run(ownerUid, identity.keyId)
  const keyId = pinnedKeyId(db, ownerUid)
  if (keyId !== identity.keyId) {
    throw new Error('Controller action signing identity does not match the worker-pinned key; rotation is not automatic')
  }
}

function writeIdentityExclusively(path: string, identity: StoredSigningIdentity): boolean {
  const temporaryPath = `${path}.${process.pid}.${createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex')}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    fchmodSync(descriptor, 0o600)
    writeSync(descriptor, `${JSON.stringify(identity)}\n`)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    try {
      linkSync(temporaryPath, path)
      return true
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

/**
 * Load the owner-scoped Controller signing identity, provisioning it once in
 * the database's mode-0700 owner directory. Its public-key fingerprint is
 * pinned in SQLite after first use; a missing or mismatched private key then
 * fails closed so workers never receive a silently rotated identity. The
 * private key never enters an Action packet or SQLite row.
 */
function signingIdentity(db: SqliteDatabase, ownerUid: string): StoredSigningIdentity {
  const path = keyPath(db, ownerUid)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  chmodSync(dirname(path), 0o700)

  const existing = readIdentity(path, ownerUid)
  if (existing) {
    pinIdentity(db, ownerUid, existing)
    return existing
  }
  if (pinnedKeyId(db, ownerUid)) {
    throw new Error('Controller action signing identity is missing after worker pinning; restore the original key because rotation is not automatic')
  }

  const pair = generateKeyPairSync(SIGNING_ALGORITHM)
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const identity: StoredSigningIdentity = {
    version: 1,
    ownerUid,
    keyId: keyIdFor(publicKey),
    publicKey,
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
  if (writeIdentityExclusively(path, identity)) {
    pinIdentity(db, ownerUid, identity)
    return identity
  }
  const racedIdentity = readIdentity(path, ownerUid)
  if (!racedIdentity) throw new Error('Controller action signing identity disappeared while being provisioned')
  pinIdentity(db, ownerUid, racedIdentity)
  return racedIdentity
}

/** The exact canonical bytes signed by Controller Action packets. */
export function controllerActionPacketPayload(packet: Packet): string {
  const { controllerSignature: _signature, ...unsignedPacket } = packet
  return canonicalize(unsignedPacket)
}

function requiredBoundFields(packet: Packet): boolean {
  const action = packet.action
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false
  const actionRecord = action as Record<string, unknown>
  return typeof packet.actionId === 'string' && actionRecord.id === packet.actionId &&
    actionRecord.kind === packet.kind &&
    typeof packet.targetPrincipal === 'string' && actionRecord.targetPrincipal === packet.targetPrincipal &&
    typeof packet.targetTopicId === 'string' && packet.targetTopicId.length > 0 &&
    actionRecord.targetTopicId === packet.targetTopicId &&
    actionRecord.workItemRevision === packet.workItemRevision &&
    typeof packet.leaseExpiresAt === 'string' && Number.isFinite(Date.parse(packet.leaseExpiresAt)) &&
    typeof packet.catscoProjectId === 'string' && packet.catscoProjectId.length > 0
}

/**
 * Verify the public key and signature carried in a preflight/execute packet.
 * Consumers must still obtain the packet from their authenticated Controller
 * transport/trust boundary; this proves the exact packet bytes were emitted
 * by the Controller key named in the packet.
 */
export function verifyControllerActionPacket(packet: unknown): boolean {
  try {
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return false
    const candidate = packet as Packet
    if (!['preflight_attempt', 'execute_attempt'].includes(String(candidate.kind)) || !requiredBoundFields(candidate)) return false
    if (candidate.controllerSignatureAlgorithm !== SIGNING_ALGORITHM ||
      typeof candidate.controllerKeyId !== 'string' || typeof candidate.controllerPublicKey !== 'string' ||
      typeof candidate.controllerSignature !== 'string' || typeof candidate.packetDigest !== 'string') return false
    if (candidate.controllerKeyId !== keyIdFor(candidate.controllerPublicKey)) return false

    const { controllerSignature: _signature, packetDigest, ...withoutDigest } = candidate
    if (packetDigest !== digestJson(withoutDigest)) return false
    return verify(null, Buffer.from(controllerActionPacketPayload(candidate)), createPublicKey(candidate.controllerPublicKey), Buffer.from(candidate.controllerSignature, 'base64'))
  } catch {
    return false
  }
}

export function signControllerActionPacket(db: SqliteDatabase, ownerUid: string, packet: Packet): Packet {
  if (!['preflight_attempt', 'execute_attempt'].includes(String(packet.kind))) return packet
  if (!requiredBoundFields(packet)) throw new Error('Controller action packet missing action, target topic, lease, or project binding')
  const identity = signingIdentity(db, ownerUid)
  const unsignedPacket = {
    ...packet,
    controllerSignatureAlgorithm: SIGNING_ALGORITHM,
    controllerKeyId: identity.keyId,
    controllerPublicKey: identity.publicKey
  }
  const packetWithDigest = { ...unsignedPacket, packetDigest: digestJson(unsignedPacket) }
  const provenance: ControllerActionProvenance = {
    controllerSignatureAlgorithm: SIGNING_ALGORITHM,
    controllerKeyId: identity.keyId,
    controllerPublicKey: identity.publicKey,
    controllerSignature: sign(null, Buffer.from(controllerActionPacketPayload(packetWithDigest)), createPrivateKey(identity.privateKey)).toString('base64')
  }
  return { ...packetWithDigest, controllerSignature: provenance.controllerSignature }
}
