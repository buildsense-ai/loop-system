PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS owner_namespaces(
  owner_uid TEXT PRIMARY KEY, ledger_revision INTEGER NOT NULL DEFAULT 0,
  next_ingress_sequence INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox(
  owner_uid TEXT NOT NULL, inbox_id TEXT NOT NULL, event_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, source TEXT NOT NULL, entity_ref TEXT NOT NULL,
  ingress_sequence INTEGER NOT NULL, trusted_ingress_at TEXT NOT NULL,
  raw_json TEXT NOT NULL, raw_digest TEXT NOT NULL, canonical_json TEXT NOT NULL,
  validation_receipt_json TEXT, status TEXT NOT NULL CHECK(status IN ('pending','committed','rejected')),
  transition_receipt_json TEXT, rejection_code TEXT, committed_at TEXT,
  PRIMARY KEY(owner_uid,inbox_id), UNIQUE(owner_uid,idempotency_key), UNIQUE(owner_uid,event_id),
  FOREIGN KEY(owner_uid) REFERENCES owner_namespaces(owner_uid)
);
CREATE TABLE IF NOT EXISTS work_items(
  owner_uid TEXT NOT NULL, work_item_id TEXT NOT NULL, revision INTEGER NOT NULL,
  ledger_revision INTEGER NOT NULL, state TEXT NOT NULL, loop_id TEXT NOT NULL, profile_id TEXT NOT NULL,
  terminal_state TEXT NOT NULL, task_contract_hash TEXT NOT NULL, reference_snapshot_hash TEXT NOT NULL,
  write_scope_json TEXT NOT NULL, write_scope_hash TEXT NOT NULL, acceptance_contract_hash TEXT NOT NULL,
  github_repo TEXT NOT NULL, catsco_project_id TEXT NOT NULL, worker_topic_id TEXT NOT NULL,
  steward_topic_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_uid,work_item_id), FOREIGN KEY(owner_uid) REFERENCES owner_namespaces(owner_uid)
);
CREATE TABLE IF NOT EXISTS attempts(
  owner_uid TEXT NOT NULL, attempt_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
  work_item_revision INTEGER NOT NULL, attempt_number INTEGER NOT NULL, generation INTEGER NOT NULL,
  control_state TEXT NOT NULL, reported_state TEXT NOT NULL, connection_state TEXT NOT NULL,
  runtime_principal TEXT NOT NULL, proof_key_id TEXT NOT NULL, proof_public_key TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL, task_contract_hash TEXT NOT NULL, reference_snapshot_hash TEXT NOT NULL,
  write_scope_hash TEXT NOT NULL, acceptance_contract_hash TEXT NOT NULL, work_bundle_json TEXT NOT NULL,
  started_at TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_uid,attempt_id), UNIQUE(owner_uid,work_item_id,generation),
  FOREIGN KEY(owner_uid,work_item_id) REFERENCES work_items(owner_uid,work_item_id)
);
CREATE TABLE IF NOT EXISTS candidates(
  owner_uid TEXT NOT NULL, candidate_id TEXT NOT NULL, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL,
  work_item_id TEXT NOT NULL, work_item_revision INTEGER NOT NULL, source_event_id TEXT NOT NULL,
  ingress_sequence INTEGER NOT NULL, deliverable_json TEXT NOT NULL, deliverable_digest TEXT NOT NULL,
  trusted_evidence_json TEXT NOT NULL, commit_receipt_json TEXT NOT NULL, committed_at TEXT NOT NULL,
  PRIMARY KEY(owner_uid,candidate_id), UNIQUE(owner_uid,attempt_id,generation),
  FOREIGN KEY(owner_uid,attempt_id) REFERENCES attempts(owner_uid,attempt_id),
  FOREIGN KEY(owner_uid,work_item_id) REFERENCES work_items(owner_uid,work_item_id)
);
CREATE TABLE IF NOT EXISTS actions(
  owner_uid TEXT NOT NULL, action_id TEXT NOT NULL, action_key TEXT NOT NULL, kind TEXT NOT NULL,
  work_item_id TEXT NOT NULL, work_item_revision INTEGER NOT NULL, target_principal TEXT NOT NULL,
  target_digest TEXT NOT NULL, target_topic_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','claimed','satisfied','expired','cancelled')),
  claim_session_id TEXT, claim_generation INTEGER, claim_expires_at TEXT,
  created_by_event_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(owner_uid,action_id), UNIQUE(owner_uid,action_key),
  UNIQUE(owner_uid,action_id,work_item_revision,target_digest),
  FOREIGN KEY(owner_uid,work_item_id) REFERENCES work_items(owner_uid,work_item_id)
);
CREATE TABLE IF NOT EXISTS outbox(
  owner_uid TEXT NOT NULL, outbox_id TEXT NOT NULL, effect_key TEXT NOT NULL,
  effect_type TEXT NOT NULL CHECK(effect_type='wake_agent'), adapter TEXT NOT NULL,
  action_id TEXT NOT NULL, action_work_item_revision INTEGER NOT NULL, action_target_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL, precondition_json TEXT NOT NULL, postcondition_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','satisfied')),
  attempt_count INTEGER NOT NULL DEFAULT 0, claim_token TEXT, claim_expires_at TEXT,
  next_attempt_at TEXT NOT NULL, last_error TEXT, created_at TEXT NOT NULL, satisfied_at TEXT,
  PRIMARY KEY(owner_uid,outbox_id), UNIQUE(owner_uid,effect_key),
  FOREIGN KEY(owner_uid,action_id,action_work_item_revision,action_target_digest)
    REFERENCES actions(owner_uid,action_id,work_item_revision,target_digest)
);
CREATE TRIGGER IF NOT EXISTS outbox_wake_action_ready
BEFORE INSERT ON outbox WHEN NEW.effect_type='wake_agent'
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM actions a WHERE a.owner_uid=NEW.owner_uid AND a.action_id=NEW.action_id
      AND a.work_item_revision=NEW.action_work_item_revision AND a.target_digest=NEW.action_target_digest
      AND a.state='ready'
  ) THEN RAISE(ABORT,'wake_agent requires matching ready action') END;
END;
CREATE TABLE IF NOT EXISTS effect_receipts(
  owner_uid TEXT NOT NULL, effect_key TEXT NOT NULL, outbox_id TEXT NOT NULL, outcome TEXT NOT NULL,
  external_id TEXT, request_digest TEXT NOT NULL, response_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL, recorded_at TEXT NOT NULL,
  PRIMARY KEY(owner_uid,effect_key),
  FOREIGN KEY(owner_uid,outbox_id) REFERENCES outbox(owner_uid,outbox_id)
);
CREATE TABLE IF NOT EXISTS source_cursors(
  owner_uid TEXT NOT NULL, source TEXT NOT NULL, scope_key TEXT NOT NULL,
  cursor_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_uid,source,scope_key), FOREIGN KEY(owner_uid) REFERENCES owner_namespaces(owner_uid)
);
