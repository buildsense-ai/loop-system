-- P0 transport identity and payload are immutable once an effect is committed.
-- Rows created before this migration lack the owner/topic/version-bound postcondition,
-- so pending work is failed closed instead of being retried indefinitely under a
-- weaker client-message identity.
UPDATE actions
SET state='cancelled'
WHERE state IN ('ready','claimed')
  AND EXISTS (
    SELECT 1 FROM outbox o
    WHERE o.owner_uid=actions.owner_uid
      AND o.action_id=actions.action_id
      AND o.state IN ('pending','claimed')
  );

UPDATE outbox
SET state='obsolete', claim_token=NULL, claim_expires_at=NULL,
    satisfied_at=COALESCE(satisfied_at, created_at),
    last_error='obsolete: pre-v3 transport postcondition is not owner/topic/version bound'
WHERE state IN ('pending','claimed');

CREATE TRIGGER outbox_effect_identity_immutable
BEFORE UPDATE OF
  effect_key,effect_type,adapter,action_id,action_work_item_revision,
  action_target_digest,payload_json,precondition_json,postcondition_json,created_at
ON outbox
BEGIN
  SELECT RAISE(ABORT,'outbox effect identity, bindings, payload, destination, and postconditions are immutable');
END;
