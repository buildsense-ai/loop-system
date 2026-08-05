export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) result[key] = normalize(item)
    }
    return result
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`)
}
