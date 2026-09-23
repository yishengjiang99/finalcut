-- Migration: allow persisted chat/xAI error events.
-- Run once against the finalcut database.

ALTER TABLE chat_interactions
  MODIFY interaction_type ENUM('human2ai', 'ai2human', 'error') NOT NULL;
