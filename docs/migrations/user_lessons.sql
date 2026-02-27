-- Migration: create user_lessons table
-- Run once against the finalcut database.

CREATE TABLE IF NOT EXISTS user_lessons (
  id         BIGINT       PRIMARY KEY AUTO_INCREMENT,
  user_id    BIGINT       NOT NULL,
  lesson     VARCHAR(255) NOT NULL,
  created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  INDEX (user_id, created_at)
);
