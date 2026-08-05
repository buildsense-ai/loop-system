import { createHash } from 'node:crypto'
import { canonicalize } from './canonical-json.js'

export const sha256 = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex')
export const digestJson = (value: unknown): string => sha256(canonicalize(value))
