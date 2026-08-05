import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { defaultStateRoot, databasePath, saveConfig } from '../config.js'
import { OpenCliCatscoAdapter } from '../adapters/catsco-opencli.js'
import { openDatabase } from '../store/sqlite.js'
import { initializeOwner, migrate } from '../store/migrate.js'
import { output } from './common.js'
export async function initCommand(args:string[]){const {values}=parseArgs({args,options:{'state-root':{type:'string'}},strict:true});const stateRoot=resolve(values['state-root']??defaultStateRoot());const catsco=new OpenCliCatscoAdapter();const {uid}=await catsco.me();const config={ownerUid:uid,stateRoot,opencliCommand:'opencli',ghCommand:'gh'};await saveConfig(config);const db=openDatabase(databasePath(config));migrate(db);initializeOwner(db,uid);db.close();output({initialized:true,ownerUid:uid,databasePath:databasePath(config)})}
