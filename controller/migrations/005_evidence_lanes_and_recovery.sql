-- A per-Attempt evidence lane keeps trusted Worker/Review packets out of noisy
-- Runtime execution and Review conversations. Empty retains legacy routes.
ALTER TABLE work_items ADD COLUMN evidence_topic_id TEXT NOT NULL DEFAULT '';
