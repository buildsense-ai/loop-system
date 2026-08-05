import type { GitHubPullRequestObservation, GitHubReadAdapter } from './github.js'

/** Fixed, read-only evidence source for the local pilot. It never delegates to or replaces the production adapter. */
export class LocalPilotGitHubAdapter implements GitHubReadAdapter {
  constructor(private readonly observation: GitHubPullRequestObservation) {}

  async readPullRequest(repository: string, prNumber: number): Promise<GitHubPullRequestObservation> {
    if (repository !== this.observation.repository || prNumber !== this.observation.prNumber) {
      throw new Error(`local pilot has no GitHub observation for ${repository}#${prNumber}`)
    }
    return { ...this.observation, changedPaths: [...this.observation.changedPaths] }
  }
}
