import { parseArgs } from 'node:util'
import { context, output } from './common.js'
import { tick } from '../controller/tick.js'
import { Ed25519RuntimeProofAdapter } from '../adapters/runtime-ed25519.js'
import { GhGitHubAdapter } from '../adapters/github-gh.js'
import { OpenCliCatscoAdapter } from '../adapters/catsco-opencli.js'
import { CatscoReviewerAuthorityAdapter, UnavailableReviewerAuthorityAdapter } from '../adapters/reviewer.js'
import { ExplicitRuntimeProofAdapter } from '../adapters/runtime-explicit.js'
export async function tickCommand(args:string[]){const {values}=parseArgs({args,options:{'max-events':{type:'string'},'max-effects':{type:'string'},'no-effects':{type:'boolean'}},strict:true});const {config,db}=await context();try{output(await tick(db,config.ownerUid,{runtime:new ExplicitRuntimeProofAdapter(new Ed25519RuntimeProofAdapter()),github:new GhGitHubAdapter(config.ghCommand),reviewer:new CatscoReviewerAuthorityAdapter(new UnavailableReviewerAuthorityAdapter()),catsco:new OpenCliCatscoAdapter(config.opencliCommand)},{maxEvents:Number(values['max-events']??100),maxEffects:Number(values['max-effects']??100),effects:!values['no-effects']}))}finally{db.close()}}
