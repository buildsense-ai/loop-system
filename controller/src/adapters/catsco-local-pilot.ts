import type {
  CatscoAdapter,
  CatscoMessageAttestation,
  CatscoMessageReceipt,
  CatscoObservation,
  CatscoPollResult
} from './catsco.js'
import { sha256 } from '../lib/digest.js'

interface LocalMessage {
  seq: number
  observation: CatscoObservation
}

export interface LocalPilotSend {
  topicId: string
  clientMsgId: string
  content: string
  receipt: CatscoMessageReceipt
}

function cursorNumber(cursor: unknown): number {
  if (cursor === null || cursor === undefined) return 0
  const value = typeof cursor === 'object' && cursor !== null && 'seqId' in cursor
    ? (cursor as { seqId: unknown }).seqId
    : cursor
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('local pilot cursor must be a non-negative safe integer seq')
  return parsed
}

/** Local-pilot-only transport. It is never installed as a production fallback. */
export class LocalPilotCatscoAdapter implements CatscoAdapter {
  private readonly messages = new Map<string, LocalMessage[]>()
  private readonly receipts = new Map<string, CatscoMessageReceipt>()
  readonly sends: LocalPilotSend[] = []

  constructor(
    private readonly ownerUid: string,
    private readonly serverTimes: readonly string[]
  ) {}

  async me() { return { uid: this.ownerUid } }

  enqueueObservation(topicId: string, senderUid: string, event: unknown, serverReceivedAt: string): CatscoMessageAttestation {
    const topic = this.messages.get(topicId) ?? []
    const attestation = { topicId, seqId: String(topic.length + 1), senderUid, serverReceivedAt }
    topic.push({ seq: topic.length + 1, observation: { event, attestation } })
    this.messages.set(topicId, topic)
    return attestation
  }

  async poll(topicId: string, cursor: unknown): Promise<CatscoPollResult> {
    const afterSeq = cursorNumber(cursor)
    const topic = this.messages.get(topicId) ?? []
    const selected = topic.filter(message => message.seq > afterSeq)
    return {
      observations: selected.map(message => message.observation),
      nextCursor: String(selected.at(-1)?.seq ?? afterSeq)
    }
  }

  async findMessage(topicId: string, clientMsgId: string): Promise<CatscoMessageReceipt | null> {
    return this.receipts.get(this.receiptKey(topicId, clientMsgId)) ?? null
  }

  async sendExistingTopic(topicId: string, content: string, clientMsgId: string): Promise<CatscoMessageReceipt> {
    const key = this.receiptKey(topicId, clientMsgId)
    const existing = this.receipts.get(key)
    if (existing) return { ...existing, duplicate: true }

    const serverReceivedAt = this.serverTimes[this.sends.length]
    if (!serverReceivedAt) throw new Error('local pilot exhausted deterministic send timestamps')
    const attestation = this.enqueueObservation(topicId, this.ownerUid, JSON.parse(content), serverReceivedAt)
    const receipt: CatscoMessageReceipt = {
      messageId: `local-message:${topicId}:${attestation.seqId}`,
      clientMsgId,
      duplicate: false,
      seqId: attestation.seqId,
      contentDigest: sha256(content),
      serverConfirmed: true,
      serverReceivedAt
    }
    this.receipts.set(key, receipt)
    this.sends.push({ topicId, clientMsgId, content, receipt })
    return receipt
  }

  private receiptKey(topicId: string, clientMsgId: string): string {
    return `${topicId}\u0000${clientMsgId}`
  }
}
