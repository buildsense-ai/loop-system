-- Worker plugins may pin the Controller action-signing key. Keep only the
-- non-secret key identifier durable so a missing private key cannot trigger
-- an unannounced replacement identity.
CREATE TABLE controller_action_signing_pins(
  owner_uid TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  FOREIGN KEY(owner_uid) REFERENCES owner_namespaces(owner_uid)
);
