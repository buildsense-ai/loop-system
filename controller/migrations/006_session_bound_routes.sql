-- A CatsCo Agent UID is an addressable principal, not a unique runtime session.
-- New Attempts bind Worker execution and Coordinator review sessions explicitly.
ALTER TABLE work_items ADD COLUMN coordinator_session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE work_items ADD COLUMN coordinator_session_topic_id TEXT NOT NULL DEFAULT '';
ALTER TABLE attempts ADD COLUMN worker_session_id TEXT NOT NULL DEFAULT '';
