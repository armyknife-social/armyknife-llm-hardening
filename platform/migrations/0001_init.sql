-- Multi-tenant schema for ArmyKnife Labs Enterprise Control Plane

-- Tenants (organizations or personal accounts)
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free', -- free, pro, enterprise
  hf_namespace TEXT, -- HuggingFace org or username
  sso_provider TEXT, -- okta, azure_ad, google, etc.
  sso_config TEXT, -- JSON SSO configuration
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API keys for tenant authentication
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the API key
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["read"]', -- JSON array of scopes
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hardening pipeline jobs
CREATE TABLE IF NOT EXISTS pipeline_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, -- e.g., "Qwen/Qwen3-Coder-30B-A3B-Instruct"
  status TEXT NOT NULL DEFAULT 'queued', -- queued, scanning, hardening, verifying, publishing, completed, failed
  hf_org TEXT, -- target HF namespace for output
  config TEXT NOT NULL DEFAULT '{}', -- JSON pipeline config
  -- Scan results
  total_findings INTEGER,
  -- Hardening results
  autotrain_job_id TEXT, -- HuggingFace AutoTrain job ID
  -- Verification results
  fix_rate REAL,
  regression_count INTEGER,
  verdict TEXT, -- FULL_FIX, PARTIAL_FIX, NO_FIX, CLEAN
  -- Published model
  hardened_model_id TEXT, -- e.g., "ArmyknifeLabs/Qwen3-Coder-30B-A3B-Instruct-Hardened"
  r2_key TEXT, -- R2 object key for stored model weights
  -- Timing
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  -- Error info
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scan findings for audit trail
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  probe_id TEXT NOT NULL, -- e.g., "prompt_injection_basic"
  category TEXT NOT NULL, -- e.g., "Prompt Injection"
  severity TEXT NOT NULL, -- critical, high, medium, low
  owasp_category TEXT, -- e.g., "LLM01"
  description TEXT,
  fixed INTEGER NOT NULL DEFAULT 0, -- 0 = not fixed, 1 = fixed after hardening
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Model registry (hardened models stored in R2)
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES pipeline_jobs(id),
  name TEXT NOT NULL, -- display name
  base_model TEXT NOT NULL, -- original model ID
  hardened_model TEXT NOT NULL, -- HF model ID or R2 path
  r2_key TEXT, -- R2 object key
  size_bytes INTEGER,
  fix_rate REAL,
  total_findings INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log for compliance (SOC2)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor TEXT NOT NULL, -- user email or API key name
  action TEXT NOT NULL, -- e.g., "pipeline.start", "model.download", "key.create"
  resource_type TEXT, -- e.g., "pipeline_job", "model", "api_key"
  resource_id TEXT,
  metadata TEXT, -- JSON with action-specific details
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Telemetry (anonymous, opt-in only)
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL, -- e.g., "pipeline_run", "scan_complete"
  cli_version TEXT,
  model_category TEXT, -- e.g., "7B", "30B", "70B" (size bucket, not exact model)
  duration_ms INTEGER,
  finding_count INTEGER,
  country TEXT, -- from CF-IPCountry header
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_tenant ON pipeline_jobs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_jobs_status ON pipeline_jobs(status);
CREATE INDEX IF NOT EXISTS idx_findings_job ON findings(job_id);
CREATE INDEX IF NOT EXISTS idx_findings_tenant ON findings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_models_tenant ON models(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
