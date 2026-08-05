#!/usr/bin/env node
import { initCommand } from './commands/init.js'
import { ingestCommand } from './commands/ingest.js'
import { tickCommand } from './commands/tick.js'
import { statusCommand } from './commands/status.js'
import { reconcileCommand } from './commands/reconcile.js'
import { receiptCommand } from './commands/receipt.js'
import { doctorCommand } from './commands/doctor.js'
import { localPilotCommand } from './commands/local-pilot.js'
import { packetCommand } from './commands/packet.js'
const [command,...args]=process.argv.slice(2)
const commands:Record<string,(args:string[])=>Promise<void>>={init:initCommand,ingest:ingestCommand,tick:tickCommand,status:statusCommand,reconcile:reconcileCommand,receipt:receiptCommand,doctor:doctorCommand,'local-pilot':localPilotCommand,packet:packetCommand}
if(!command||!commands[command]){console.error('usage: loopctl <init|ingest|tick|status|reconcile|receipt|doctor|local-pilot|packet> [options]');process.exitCode=2}else commands[command](args).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1})
