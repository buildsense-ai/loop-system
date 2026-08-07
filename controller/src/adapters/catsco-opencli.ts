import { z } from 'zod'
import { ProcessFailure, runProcess, type ProcessResult } from '../lib/process.js'
import { ingressEventSchema } from '../protocol/events.js'
import type { CatscoAdapter, CatscoMessageReceipt, CatscoPollResult, CatscoSendRequest } from './catsco.js'

const meSchema = z.object({ uid: z.union([z.string(), z.number()]) }).passthrough()
const receiptSchema = z.object({
  found: z.boolean().optional(),
  messageId: z.union([z.string(), z.number()]).optional(),
  id: z.union([z.string(), z.number()]).optional(),
  clientMsgId: z.string().optional(),
  client_msg_id: z.string().optional(),
  duplicate: z.boolean().optional(),
  seqId: z.union([z.string(), z.number()]).optional(),
  seq_id: z.union([z.string(), z.number()]).optional(),
  contentDigest: z.string().optional(),
  serverConfirmed: z.boolean().optional(),
  serverReceivedAt: z.string().nullable().optional()
}).passthrough()
const pollItemSchema = z.object({
  seqId: z.union([z.string(), z.number()]),
  topicId: z.string().min(1),
  senderUid: z.union([z.string(), z.number()]),
  content: z.string(),
  serverReceivedAt: z.string().min(1)
}).passthrough()
const pollSchema = z.object({
  items: z.array(pollItemSchema),
  nextCursor: z.union([z.string(), z.number()]),
  hasMore: z.boolean()
}).passthrough()

type Runner = (command: string, args: readonly string[]) => Promise<ProcessResult>

function unwrap(value: unknown): unknown {
  let current = value
  for (let depth = 0; depth < 3; depth++) {
    if (current && typeof current === 'object' && !Array.isArray(current) && 'data' in current) {
      current = (current as { data: unknown }).data
      continue
    }
    break
  }
  return current
}

function one(value: unknown): unknown {
  const unwrapped = unwrap(value)
  if (!Array.isArray(unwrapped)) return unwrapped
  if (unwrapped.length !== 1) throw new Error(`expected one OpenCLI row, received ${unwrapped.length}`)
  return unwrapped[0]
}

function cursorNumber(cursor: unknown): number {
  if (cursor === null || cursor === undefined) return 0
  const value = typeof cursor === 'object' && cursor !== null && 'seqId' in cursor
    ? (cursor as { seqId: unknown }).seqId
    : cursor
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('CatsCo cursor must be a non-negative safe integer seq')
  return parsed
}

/** Existing-topic P0 transport. Receipts are limited by the OpenCLI plugin's local registry semantics. */
export class OpenCliCatscoAdapter implements CatscoAdapter {
  constructor(private readonly command = 'opencli', private readonly runner: Runner = runProcess) {}

  private async json(args: string[]): Promise<unknown> {
    try {
      const result = await this.runner(this.command, [...args, '--format', 'json'])
      return JSON.parse(result.stdout)
    } catch (error) {
      if (error instanceof ProcessFailure && error.result?.stderr?.trim()) {
        const stderr = error.result.stderr.trim().slice(0, 4_000)
        throw new Error(`${error.message}: ${stderr}`, { cause: error })
      }
      throw error
    }
  }

  async me() {
    const row = meSchema.parse(one(await this.json(['catsco', 'me'])))
    return { uid: String(row.uid) }
  }

  private receipt(raw: unknown, fallbackClientId: string): CatscoMessageReceipt {
    const row = receiptSchema.parse(one(raw))
    const messageId = String(row.messageId ?? row.id ?? '')
    if (!messageId) throw new Error('CatsCo receipt has no message id')
    const seq = row.seqId ?? row.seq_id
    return {
      messageId,
      clientMsgId: row.clientMsgId ?? row.client_msg_id ?? fallbackClientId,
      duplicate: row.duplicate ?? false,
      ...(seq === undefined ? {} : { seqId: String(seq) }),
      ...(row.contentDigest === undefined ? {} : { contentDigest: row.contentDigest }),
      ...(row.serverConfirmed === undefined ? {} : { serverConfirmed: row.serverConfirmed }),
      ...(row.serverReceivedAt == null ? {} : { serverReceivedAt: row.serverReceivedAt })
    }
  }

  async sendExistingTopic(request: CatscoSendRequest): Promise<CatscoMessageReceipt> {
    const args = [
      'catsco', 'send', request.topicId, request.content,
      '--client-message-id', request.clientMsgId
    ]
    if (request.mention) args.push('--mention', request.mention)
    return this.receipt(await this.json(args), request.clientMsgId)
  }

  async findMessage(topicId: string, clientMsgId: string): Promise<CatscoMessageReceipt | null> {
    const raw = one(await this.json(['catsco', 'message-receipt', topicId, '--client-message-id', clientMsgId]))
    const parsed = receiptSchema.parse(raw)
    if (parsed.found === false) return null
    return this.receipt(parsed, clientMsgId)
  }

  async poll(topicId: string, cursor: unknown): Promise<CatscoPollResult> {
    const afterSeq = cursorNumber(cursor)
    const raw = one(await this.json([
      'catsco', 'messages', topicId, '--after-seq', String(afterSeq), '--limit', '200'
    ]))
    const envelope = pollSchema.parse(raw)
    // A bounded page is a durable prefix, not an overflow failure. Reconcile
    // ingests this page before advancing its cursor; a later cycle continues
    // from nextCursor until the topic is caught up.
    const nextCursor = cursorNumber(envelope.nextCursor)
    const items = envelope.items.map(item => {
      const seq = cursorNumber(item.seqId)
      const senderUid = String(item.senderUid)
      if (seq <= afterSeq) throw new Error(`CatsCo poll returned seq ${seq} at/before cursor ${afterSeq}`)
      if (item.topicId !== topicId) {
        throw new Error(`CatsCo poll returned topic ${item.topicId} while polling ${topicId}`)
      }
      if (!senderUid.trim()) throw new Error(`CatsCo poll returned empty senderUid for seq ${seq}`)
      if (!Number.isFinite(Date.parse(item.serverReceivedAt))) {
        throw new Error(`CatsCo poll returned invalid serverReceivedAt for seq ${seq}`)
      }
      return {
        seq,
        content: item.content,
        attestation: {
          topicId: item.topicId,
          seqId: String(item.seqId),
          senderUid,
          serverReceivedAt: item.serverReceivedAt
        }
      }
    }).sort((a, b) => a.seq - b.seq)

    for (let index = 1; index < items.length; index++) {
      if (items[index]!.seq === items[index - 1]!.seq) {
        throw new Error(`CatsCo poll returned duplicate seq ${items[index]!.seq}`)
      }
    }
    const expectedNext = items.length ? items[items.length - 1]!.seq : afterSeq
    if (nextCursor !== expectedNext) {
      throw new Error(`CatsCo cursor envelope mismatch: nextCursor=${nextCursor}, expected=${expectedNext}`)
    }

    const observations = items.flatMap(item => {
      let json: unknown
      try { json = JSON.parse(item.content) } catch { return [] }
      const parsed = ingressEventSchema.safeParse(json)
      if (!parsed.success || (parsed.data.type !== 'candidate_submitted' && parsed.data.type !== 'review_decided' && parsed.data.type !== 'runtime_started')) return []
      return [{ event: parsed.data, attestation: item.attestation }]
    })
    return { observations, nextCursor: String(nextCursor) }
  }
}
