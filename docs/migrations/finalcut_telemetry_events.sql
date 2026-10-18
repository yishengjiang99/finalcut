-- First-party anonymous telemetry (POST /api/telemetry, src/server/telemetry.js).
-- The server creates this table on first use (CREATE TABLE IF NOT EXISTS); this file documents it
-- and can be run by hand against the finalcut database. No IP address or IP hash is stored.
CREATE TABLE IF NOT EXISTS finalcut_telemetry_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  app VARCHAR(32) NOT NULL DEFAULT 'finalcut',
  platform VARCHAR(16) NOT NULL,
  event VARCHAR(64) NOT NULL,
  anon_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(64) NULL,
  app_version VARCHAR(32) NULL,
  props_json JSON NULL,
  KEY idx_fc_tel_created (created_at),
  KEY idx_fc_tel_event_time (event, created_at),
  KEY idx_fc_tel_anon_time (anon_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
