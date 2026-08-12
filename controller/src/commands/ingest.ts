import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { context, output } from './common.js'
import { ingest } from '../controller/ingest.js'
async function stdin(){const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks).toString('utf8')}
export async function ingestCommand(args:string[]){
  const {values}=parseArgs({args,options:{file:{type:'string'}},strict:true})
  if(!values.file)throw new Error('ingest requires --file FILE|-')
  const raw=values.file==='-'?await stdin():await readFile(values.file,'utf8')
  const event=JSON.parse(raw) as { type?: string }
  if(event.type==='attempt_readiness_timed_out'||event.type==='attempt_dispatch_timed_out') {
    throw new Error('attempt timeout events are Controller-watchdog internal only')
  }
  const {config,db}=await context()
  try{output(ingest(db,config.ownerUid,event))}finally{db.close()}
}
