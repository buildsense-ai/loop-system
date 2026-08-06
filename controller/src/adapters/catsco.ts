export interface CatscoIdentity { uid: string }
export interface CatscoMessageReceipt {
  messageId: string
  clientMsgId: string
  duplicate: boolean
  seqId?: string
  contentDigest?: string
  serverConfirmed?: boolean
  serverReceivedAt?: string
}
export interface CatscoMessageAttestation {
  topicId: string
  seqId: string
  senderUid: string
  serverReceivedAt: string
}
export interface CatscoObservation {
  event: unknown
  attestation: CatscoMessageAttestation
}
export interface CatscoPollResult {
  observations: CatscoObservation[]
  nextCursor: unknown
}
export interface CatscoSendRequest {
  topicId: string
  content: string
  clientMsgId: string
  mention?: string
}
export interface CatscoAdapter {
  me(): Promise<CatscoIdentity>
  sendExistingTopic(request: CatscoSendRequest): Promise<CatscoMessageReceipt>
  findMessage(topicId: string, clientMsgId: string): Promise<CatscoMessageReceipt | null>
  poll?(topicId: string, cursor: unknown): Promise<CatscoPollResult>
}

export interface EffectAdapterRegistry {
  catsco: CatscoAdapter
}
