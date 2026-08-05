import type { TransitionPlan } from './types.js'
export function assertPlan(plan: TransitionPlan): void {
  if (plan.kind === 'reject' && (plan.actions.length || plan.effects.length)) throw new Error('rejected transitions cannot emit effects')
  for (const effect of plan.effects) {
    const action = plan.actions.find(item => item.actionId === effect.actionId)
    if (!action || action.workItemRevision !== effect.actionWorkItemRevision || action.targetDigest !== effect.targetDigest) throw new Error('wake is not bound to its action')
  }
}
