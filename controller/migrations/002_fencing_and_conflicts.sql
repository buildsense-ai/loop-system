CREATE TABLE IF NOT EXISTS ingress_conflicts(
  owner_uid TEXT NOT NULL, conflict_id TEXT NOT NULL, event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, raw_digest TEXT NOT NULL, canonical_json TEXT NOT NULL,
  conflict_code TEXT NOT NULL, transition_receipt_json TEXT NOT NULL,
  ingress_sequence INTEGER NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY(owner_uid,conflict_id), UNIQUE(owner_uid,raw_digest),
  FOREIGN KEY(owner_uid) REFERENCES owner_namespaces(owner_uid)
);

DROP TRIGGER IF EXISTS outbox_wake_action_ready;

ALTER TABLE effect_receipts RENAME TO effect_receipts_v1;
ALTER TABLE outbox RENAME TO outbox_v1;

CREATE TABLE outbox(
  owner_uid TEXT NOT NULL, outbox_id TEXT NOT NULL, effect_key TEXT NOT NULL,
  effect_type TEXT NOT NULL CHECK(effect_type='wake_agent'), adapter TEXT NOT NULL,
  action_id TEXT NOT NULL, action_work_item_revision INTEGER NOT NULL, action_target_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL, precondition_json TEXT NOT NULL, postcondition_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','satisfied','obsolete')),
  attempt_count INTEGER NOT NULL DEFAULT 0, claim_token TEXT, claim_expires_at TEXT,
  next_attempt_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, satisfied_at TEXT,
  PRIMARY KEY(owner_uid,outbox_id), UNIQUE(owner_uid,effect_key),
  FOREIGN KEY(owner_uid,action_id,action_work_item_revision,action_target_digest)
    REFERENCES actions(owner_uid,action_id,work_item_revision,target_digest)
);

INSERT INTO outbox(
  owner_uid,outbox_id,effect_key,effect_type,adapter,action_id,action_work_item_revision,
  action_target_digest,payload_json,precondition_json,postcondition_json,state,attempt_count,
  claim_token,claim_expires_at,next_attempt_at,last_error,created_at,satisfied_at
)
SELECT
  owner_uid,outbox_id,effect_key,effect_type,adapter,action_id,action_work_item_revision,
  action_target_digest,payload_json,precondition_json,postcondition_json,state,attempt_count,
  claim_token,claim_expires_at,next_attempt_at,last_error,created_at,satisfied_at
FROM outbox_v1;

CREATE TABLE effect_receipts(
  owner_uid TEXT NOT NULL, effect_key TEXT NOT NULL, outbox_id TEXT NOT NULL, outcome TEXT NOT NULL,
  external_id TEXT, request_digest TEXT NOT NULL, response_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY(owner_uid,effect_key),
  FOREIGN KEY(owner_uid,outbox_id) REFERENCES outbox(owner_uid,outbox_id)
);

INSERT INTO effect_receipts(
  owner_uid,effect_key,outbox_id,outcome,external_id,request_digest,response_digest,receipt_json,recorded_at
)
SELECT
  owner_uid,effect_key,outbox_id,outcome,external_id,request_digest,response_digest,receipt_json,recorded_at
FROM effect_receipts_v1;

DROP TABLE effect_receipts_v1;
DROP TABLE outbox_v1;

CREATE TRIGGER outbox_wake_action_ready
BEFORE INSERT ON outbox WHEN NEW.effect_type='wake_agent'
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM actions a WHERE a.owner_uid=NEW.owner_uid AND a.action_id=NEW.action_id
      AND a.work_item_revision=NEW.action_work_item_revision AND a.target_digest=NEW.action_target_digest
      AND a.state='ready'
  ) THEN RAISE(ABORT,'wake_agent requires matching ready action') END;
END;
