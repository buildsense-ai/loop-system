import { spawn } from 'node:child_process'

export interface ProcessResult { stdout: string; stderr: string; code: number }
export class ProcessFailure extends Error {
  constructor(message: string, readonly result?: Partial<ProcessResult>) { super(message) }
}
export async function runProcess(command: string, args: readonly string[], options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBytes = options.maxBytes ?? 1_000_000
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const output: Buffer[] = []; const errors: Buffer[] = []; let size = 0; let done = false
    const finish = (error?: Error, result?: ProcessResult) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result!) }
    const take = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) { child.kill('SIGKILL'); finish(new ProcessFailure('subprocess output exceeded limit')) }
      else target.push(chunk)
    }
    child.stdout.on('data', take(output)); child.stderr.on('data', take(errors))
    child.on('error', error => finish(new ProcessFailure(`failed to spawn ${command}: ${error.message}`)))
    child.on('close', code => {
      const result = { stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8'), code: code ?? -1 }
      if (result.code !== 0) finish(new ProcessFailure(`${command} exited ${result.code}`, result)); else finish(undefined, result)
    })
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new ProcessFailure(`${command} timed out`)) }, timeoutMs)
  })
}
