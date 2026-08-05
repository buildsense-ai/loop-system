import type { TrustedEvidence } from '../protocol/events.js'

export interface GitHubPullRequestObservation extends Omit<TrustedEvidence, 'digest'> {
  state: 'open' | 'closed'
  merged: boolean
}

export interface GitHubReadAdapter {
  readPullRequest(repository: string, prNumber: number): Promise<GitHubPullRequestObservation>
}
