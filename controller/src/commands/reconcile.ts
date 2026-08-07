import { parseArgs } from 'node:util'
import { context, output } from './common.js'
import { OpenCliCatscoAdapter } from '../adapters/catsco-opencli.js'
import { reconcile } from '../controller/reconcile.js'
export async function reconcileCommand(args:string[]){const {values}=parseArgs({args,options:{'work-item':{type:'string'},'worker-only':{type:'boolean'},'enqueue-only':{type:'boolean'}},strict:true});const {config,db}=await context();try{output(await reconcile(db,config.ownerUid,new OpenCliCatscoAdapter(config.opencliCommand),undefined,values['work-item'],{topicScope:values['worker-only']?'worker':'all'}))}finally{db.close()}}
