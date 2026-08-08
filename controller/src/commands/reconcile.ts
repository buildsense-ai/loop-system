import { parseArgs } from 'node:util'
import { context, output } from './common.js'
import { OpenCliCatscoAdapter } from '../adapters/catsco-opencli.js'
import { reconcile } from '../controller/reconcile.js'
import { Ed25519RuntimeProofAdapter } from '../adapters/runtime-ed25519.js'
import { GhGitHubAdapter } from '../adapters/github-gh.js'
import { CatscoReviewerAuthorityAdapter, UnavailableReviewerAuthorityAdapter } from '../adapters/reviewer.js'
import { ExplicitRuntimeProofAdapter } from '../adapters/runtime-explicit.js'
export async function reconcileCommand(args:string[]){
  const {values}=parseArgs({args,options:{'work-item':{type:'string'},'worker-only':{type:'boolean'},drive:{type:'boolean'},'enqueue-only':{type:'boolean'}},strict:true})
  if(values.drive&&values['enqueue-only']) throw new Error('reconcile accepts either --drive or --enqueue-only, not both')
  if(values.drive&&(values['work-item']||values['worker-only'])) throw new Error('reconcile --drive cannot be combined with --work-item or --worker-only until processing is scope-filtered')
  const {config,db}=await context()
  try {
    const catsco=new OpenCliCatscoAdapter(config.opencliCommand)
    output(await reconcile(db,config.ownerUid,catsco,undefined,values['work-item'],{
      topicScope:values['worker-only']?'worker':'all', mode:values.drive?'drive':'enqueue-only',
      processingAdapters:{runtime:new ExplicitRuntimeProofAdapter(new Ed25519RuntimeProofAdapter()),github:new GhGitHubAdapter(config.ghCommand),reviewer:new CatscoReviewerAuthorityAdapter(new UnavailableReviewerAuthorityAdapter())}
    }))
  } finally { db.close() }
}
