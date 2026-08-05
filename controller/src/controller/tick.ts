import type { SqliteDatabase } from '../store/sqlite.js'
import type { ProcessingAdapters } from './process-inbox.js'
import { processPending } from './process-inbox.js'
import type { CatscoAdapter } from '../adapters/catsco.js'
import { runOutbox, type OutboxProviders } from './outbox.js'
export async function tick(db:SqliteDatabase,ownerUid:string,adapters:ProcessingAdapters & {catsco:CatscoAdapter},options:{maxEvents?:number;maxEffects?:number;effects?:boolean;outboxProviders?:OutboxProviders}={}){
  const receipts=await processPending(db,ownerUid,adapters,options.maxEvents??100)
  const effects=options.effects===false?{satisfied:0,retried:0,obsolete:0,ownerMismatch:false}:await runOutbox(db,ownerUid,{catsco:adapters.catsco},options.maxEffects??100,options.outboxProviders)
  return{processed:receipts.length,receipts,effects}
}
