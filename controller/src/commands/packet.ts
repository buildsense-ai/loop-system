import { parseArgs } from 'node:util'
import { context, output } from './common.js'
import { actionPacket, packetForWorkItem } from '../controller/action-packets.js'

export async function packetCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { 'action-id': { type: 'string' }, 'work-item': { type: 'string' } },
    strict: true
  })
  if ((values['action-id'] ? 1 : 0) + (values['work-item'] ? 1 : 0) !== 1) {
    throw new Error('packet requires exactly one of --action-id ID or --work-item ID')
  }
  const { config, db } = await context()
  try {
    output(values['action-id']
      ? actionPacket(db, config.ownerUid, values['action-id'])
      : packetForWorkItem(db, config.ownerUid, values['work-item']!))
  } finally { db.close() }
}
