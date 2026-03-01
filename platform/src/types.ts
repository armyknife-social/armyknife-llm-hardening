export interface AppVariables {
  tenant: Tenant;
  actor: string;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };

export interface Env {
  DB: D1Database;
  JOB_STATE: KVNamespace;
  MODEL_STORE: R2Bucket;
  HF_TOKEN: string;
  JWT_SECRET: string;
  WEBHOOK_SECRET: string;
  ENVIRONMENT: string;
  HF_API_BASE: string;
  HF_AUTOTRAIN_API: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: "free" | "pro" | "enterprise";
  hf_namespace: string | null;
  sso_provider: string | null;
  sso_config: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineJob {
  id: string;
  tenant_id: string;
  model_id: string;
  status: "queued" | "scanning" | "hardening" | "verifying" | "publishing" | "completed" | "failed";
  hf_org: string | null;
  config: string;
  total_findings: number | null;
  autotrain_job_id: string | null;
  fix_rate: number | null;
  regression_count: number | null;
  verdict: string | null;
  hardened_model_id: string | null;
  r2_key: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

export interface Finding {
  id: string;
  job_id: string;
  tenant_id: string;
  probe_id: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  owasp_category: string | null;
  description: string | null;
  fixed: number;
  created_at: string;
}

export interface Model {
  id: string;
  tenant_id: string;
  job_id: string;
  name: string;
  base_model: string;
  hardened_model: string;
  r2_key: string | null;
  size_bytes: number | null;
  fix_rate: number | null;
  total_findings: number | null;
  download_count: number;
  created_at: string;
}

export interface PipelineConfig {
  min_fix_rate?: number;
  epochs?: number;
  hf_hardware?: string;
  probes?: string;
  fail_on_regression?: boolean;
}

export interface TelemetryEvent {
  event: string;
  cli_version?: string;
  model_category?: string;
  duration_ms?: number;
  finding_count?: number;
}
