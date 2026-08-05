export interface TransitionReceipt {
  eventId: string
  idempotencyKey: string
  status: 'pending' | 'committed' | 'rejected'
  ingressSequence: number
  ledgerRevision?: number
  workItemId?: string
  workItemRevision?: number
  candidateId?: string
  actionIds?: string[]
  rejectionCode?: string
  conflictId?: string
}
