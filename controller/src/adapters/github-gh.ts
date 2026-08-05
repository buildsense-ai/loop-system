import { z } from 'zod'
import { runProcess } from '../lib/process.js'
import type { GitHubReadAdapter } from './github.js'

const prSchema = z.object({
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string() }),
  state: z.enum(['open', 'closed']),
  merged: z.boolean()
}).passthrough()
const fileSchema = z.object({ filename: z.string().min(1) }).passthrough()

export class GhGitHubAdapter implements GitHubReadAdapter {
  constructor(private readonly command = 'gh') {}

  async readPullRequest(repository: string, prNumber: number) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid repository')
    const endpoint = `repos/${repository}/pulls/${prNumber}`
    const pr = prSchema.parse(JSON.parse((await runProcess(this.command, ['api', endpoint])).stdout))
    const pages = JSON.parse((await runProcess(this.command, [
      'api', '--paginate', '--slurp', `${endpoint}/files?per_page=100`
    ])).stdout) as unknown
    const raw = Array.isArray(pages) ? pages.flat() : []
    const files = z.array(fileSchema).parse(raw)
    return {
      repository, prNumber, headSha: pr.head.sha, baseSha: pr.base.sha,
      changedPaths: files.map(file => file.filename).sort(), state: pr.state, merged: pr.merged
    }
  }
}
