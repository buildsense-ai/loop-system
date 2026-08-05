-- Trust the server-observed CatsCo envelope independently of message-controlled JSON.
ALTER TABLE inbox ADD COLUMN catsco_attestation_json TEXT;
ALTER TABLE inbox ADD COLUMN catsco_attestation_digest TEXT;
ALTER TABLE ingress_conflicts ADD COLUMN catsco_attestation_json TEXT;
ALTER TABLE ingress_conflicts ADD COLUMN catsco_attestation_digest TEXT;

-- Existing rows retain their original Ed25519/external-review semantics.
ALTER TABLE attempts ADD COLUMN proof_mode TEXT NOT NULL DEFAULT 'ed25519'
  CHECK(proof_mode IN ('ed25519','catsco-message'));
ALTER TABLE work_items ADD COLUMN steward_principal TEXT NOT NULL DEFAULT 'steward';
