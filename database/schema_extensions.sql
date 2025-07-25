-- Database schema extensions for chunked uploads and file sharing

-- Table to track upload sessions
CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    total_size BIGINT NOT NULL,
    chunk_size INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    original_hash CHAR(64) NOT NULL,
    encrypted_hash CHAR(64),
    password_hint TEXT,
    password_type TEXT NOT NULL DEFAULT 'custom',
    storage_upload_id TEXT,
    storage_id VARCHAR(36),  -- UUID v4 for storage backend
    padded_size BIGINT,      -- Size after padding
    status TEXT NOT NULL DEFAULT 'in_progress',
    multi_key BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    FOREIGN KEY (owner_email) REFERENCES users(email)
);

-- Index for looking up upload sessions by user
CREATE INDEX IF NOT EXISTS idx_upload_sessions_owner ON upload_sessions(owner_email);
-- Index for looking up upload sessions by status
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions(status);

-- Table to track individual chunk uploads
CREATE TABLE IF NOT EXISTS upload_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    chunk_number INTEGER NOT NULL,
    chunk_hash CHAR(64) NOT NULL,
    chunk_size BIGINT NOT NULL,
    iv TEXT NOT NULL,
    etag TEXT NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES upload_sessions(id) ON DELETE CASCADE,
    UNIQUE(session_id, chunk_number)
);

-- Index for looking up chunks by session
CREATE INDEX IF NOT EXISTS idx_upload_chunks_session ON upload_chunks(session_id);

-- Table to store file sharing information
CREATE TABLE IF NOT EXISTS file_shares (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    is_password_protected BOOLEAN NOT NULL DEFAULT false,
    password_hash TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,
    last_accessed TIMESTAMP,
    FOREIGN KEY (owner_email) REFERENCES users(email)
);

-- Index for finding shares by owner
CREATE INDEX IF NOT EXISTS idx_file_shares_owner ON file_shares(owner_email);
-- Index for finding shares by file
CREATE INDEX IF NOT EXISTS idx_file_shares_file ON file_shares(file_id);

-- Table to track encryption keys for files
CREATE TABLE IF NOT EXISTS file_encryption_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    key_type TEXT NOT NULL,  -- 'account' or 'custom'
    key_label TEXT NOT NULL, -- User-friendly name
    password_hint TEXT,      -- Optional hint for custom passwords
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_primary BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (file_id) REFERENCES file_metadata(filename) ON DELETE CASCADE
);

-- Index for finding encryption keys by file
CREATE INDEX IF NOT EXISTS idx_file_encryption_keys_file ON file_encryption_keys(file_id);
-- Index for finding encryption keys by key ID
CREATE INDEX IF NOT EXISTS idx_file_encryption_keys_key ON file_encryption_keys(key_id);

-- Table for refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    user_email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_revoked BOOLEAN DEFAULT FALSE,
    is_used BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Indexes for refresh tokens
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_email);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token_hash);

-- Table for revoked JWT tokens
CREATE TABLE IF NOT EXISTS revoked_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id TEXT NOT NULL UNIQUE,  -- the jti claim value
    user_email TEXT NOT NULL,
    revoked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    reason TEXT,
    FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Indexes for revoked tokens
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_jti ON revoked_tokens(token_id);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_user ON revoked_tokens(user_email);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);

-- Note: password_salt columns are now part of the base schema
-- Users table: password_hash, password_salt
-- File_shares table: password_hash, password_salt

-- OPAQUE Authentication Tables
CREATE TABLE IF NOT EXISTS opaque_server_keys (
    id INTEGER PRIMARY KEY,
    server_secret_key BLOB NOT NULL,
    server_public_key BLOB NOT NULL,
    oprf_seed BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS opaque_user_data (
    user_email TEXT PRIMARY KEY,
    serialized_record BLOB NOT NULL,
    created_at DATETIME NOT NULL,
    FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Indexes for OPAQUE tables
CREATE INDEX IF NOT EXISTS idx_opaque_user_data_email ON opaque_user_data(user_email);

-- Phase 3: Security Hardening and Operational Infrastructure Tables

-- Security events with privacy-preserving entity identification
CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    event_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,           -- HMAC-based, privacy-preserving
    time_window TEXT NOT NULL,         -- "2025-06-20"
    user_email TEXT,                   -- Only for authenticated events
    device_profile TEXT,               -- Argon2ID profile
    severity TEXT NOT NULL DEFAULT 'INFO',
    details JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_window ON security_events(time_window, event_type);
CREATE INDEX IF NOT EXISTS idx_events_entity ON security_events(entity_id, time_window);
CREATE INDEX IF NOT EXISTS idx_events_severity ON security_events(severity, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON security_events(event_type, timestamp);

-- Rate limiting state with entity ID privacy protection
CREATE TABLE IF NOT EXISTS rate_limit_state (
    entity_id TEXT NOT NULL,
    time_window TEXT NOT NULL,         -- "2025-06-20"
    endpoint TEXT NOT NULL,
    device_profile TEXT,
    request_count INTEGER NOT NULL DEFAULT 0,
    last_request DATETIME NOT NULL,
    violation_count INTEGER NOT NULL DEFAULT 0,
    penalty_until DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (entity_id, time_window, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_cleanup ON rate_limit_state(time_window);
CREATE INDEX IF NOT EXISTS idx_rate_limit_entity ON rate_limit_state(entity_id, time_window);
CREATE INDEX IF NOT EXISTS idx_rate_limit_penalties ON rate_limit_state(penalty_until);

-- Entity ID configuration and master secret storage
CREATE TABLE IF NOT EXISTS entity_id_config (
    id INTEGER PRIMARY KEY,
    master_secret_hash TEXT NOT NULL,  -- Hash of master secret for health checks
    rotation_schedule TEXT NOT NULL,   -- "daily"
    last_rotation DATETIME,
    next_rotation DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Key health monitoring status
CREATE TABLE IF NOT EXISTS key_health_status (
    component TEXT PRIMARY KEY,
    status TEXT NOT NULL,              -- "healthy", "warning", "critical"
    last_checked DATETIME NOT NULL,
    next_check DATETIME NOT NULL,
    details JSON,
    alert_level TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Security alerts and escalation
CREATE TABLE IF NOT EXISTS security_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    entity_id TEXT,                    -- Optional entity association
    time_window TEXT,
    message TEXT NOT NULL,
    details JSON,
    acknowledged BOOLEAN DEFAULT FALSE,
    acknowledged_by TEXT,
    acknowledged_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON security_alerts(severity, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_unack ON security_alerts(acknowledged, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_entity ON security_alerts(entity_id, time_window);

-- Add missing columns to existing file_metadata table
-- Note: SQLite doesn't support adding NOT NULL columns to existing tables easily
-- So we'll add them as nullable and handle NULL values in the application
ALTER TABLE file_metadata ADD COLUMN storage_id VARCHAR(36);
ALTER TABLE file_metadata ADD COLUMN padded_size BIGINT;
ALTER TABLE file_metadata ADD COLUMN multi_key BOOLEAN DEFAULT FALSE;

-- Create indexes for file_metadata (existing indexes will be ignored)
CREATE INDEX IF NOT EXISTS idx_file_metadata_owner ON file_metadata(owner_email);
CREATE INDEX IF NOT EXISTS idx_file_metadata_upload_date ON file_metadata(upload_date);
CREATE INDEX IF NOT EXISTS idx_file_metadata_storage_id ON file_metadata(storage_id);

-- TOTP Authentication Tables
CREATE TABLE IF NOT EXISTS user_totp (
    user_email TEXT PRIMARY KEY,
    secret_encrypted BLOB NOT NULL,           -- AES-GCM encrypted with session key
    backup_codes_encrypted BLOB,              -- JSON array of codes, encrypted
    enabled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used TIMESTAMP,
    setup_completed BOOLEAN DEFAULT FALSE,    -- Two-phase setup
    FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- TOTP Usage Log for Replay Protection (90-second window)
CREATE TABLE IF NOT EXISTS totp_usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    code_hash TEXT NOT NULL,                  -- SHA-256 hash of used code
    used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    window_start INTEGER NOT NULL,            -- Unix timestamp of 30s window
    FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Backup Code Usage Log
CREATE TABLE IF NOT EXISTS totp_backup_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    code_hash TEXT NOT NULL,                  -- SHA-256 hash of used backup code
    used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Indexes for TOTP tables
CREATE INDEX IF NOT EXISTS idx_user_totp_email ON user_totp(user_email);
CREATE INDEX IF NOT EXISTS idx_totp_usage_cleanup ON totp_usage_log(used_at);
CREATE INDEX IF NOT EXISTS idx_totp_usage_user_window ON totp_usage_log(user_email, window_start);
CREATE INDEX IF NOT EXISTS idx_totp_backup_user ON totp_backup_usage(user_email);
CREATE INDEX IF NOT EXISTS idx_totp_backup_cleanup ON totp_backup_usage(used_at);
