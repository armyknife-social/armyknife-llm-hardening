import { Hono } from "hono";
import { cors } from "hono/cors";
import { AppEnv, Env, PipelineJob, Tenant, TelemetryEvent } from "./types";
import { authMiddleware, generateApiKey } from "./auth";
import { startPipeline, executePipeline } from "./pipeline";
import { HuggingFaceClient } from "./huggingface";

const app = new Hono<AppEnv>();

// CORS for dashboard frontend
app.use("/*", cors({ origin: ["https://app.armyknifelabs.com", "http://localhost:3000"] }));

// Health check (no auth)
app.get("/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

// Anonymous telemetry endpoint (no auth, opt-in only)
app.post("/v1/telemetry", async (c) => {
  const event = await c.req.json<TelemetryEvent>();
  const country = c.req.header("CF-IPCountry") || "unknown";

  await c.env.DB.prepare(
    "INSERT INTO telemetry (event, cli_version, model_category, duration_ms, finding_count, country) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(event.event, event.cli_version || null, event.model_category || null, event.duration_ms || null, event.finding_count || null, country)
    .run();

  return c.json({ ok: true });
});

// HuggingFace webhook receiver (verified by WEBHOOK_SECRET)
app.post("/v1/webhooks/huggingface", async (c) => {
  const signature = c.req.header("X-Webhook-Secret");
  if (signature !== c.env.WEBHOOK_SECRET) {
    return c.json({ error: "Invalid webhook secret" }, 401);
  }

  const payload = await c.req.json<any>();
  const event = payload.event?.action;

  if (event === "autotrain:completed" || event === "autotrain:failed") {
    const jobId = payload.repo?.name; // AutoTrain uses repo name as job ref
    if (jobId) {
      // Update job state — the pipeline polling loop will pick this up
      await c.env.JOB_STATE.put(
        `autotrain:${jobId}`,
        JSON.stringify({ status: event === "autotrain:completed" ? "completed" : "failed" })
      );
    }
  }

  return c.json({ ok: true });
});

// --- Authenticated routes ---
const api = new Hono<AppEnv>();
api.use("/*", authMiddleware);

// Pipeline operations
api.post("/pipeline/start", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{ model_id: string; hf_org?: string; config?: any }>();

  if (!body.model_id) {
    return c.json({ error: "model_id is required" }, 400);
  }

  const hfOrg = body.hf_org || tenant.hf_namespace;
  if (!hfOrg) {
    return c.json({ error: "hf_org is required (set in tenant config or pass explicitly)" }, 400);
  }

  // Check plan limits
  const jobCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM pipeline_jobs WHERE tenant_id = ? AND created_at > datetime('now', '-30 days')"
  )
    .bind(tenant.id)
    .first<{ count: number }>();

  const limits: Record<string, number> = { free: 3, pro: 50, enterprise: 999999 };
  if ((jobCount?.count || 0) >= (limits[tenant.plan] || 3)) {
    return c.json({ error: `Plan limit reached (${tenant.plan}: ${limits[tenant.plan]} jobs/month)` }, 429);
  }

  const job = await startPipeline(c.env, tenant.id, body.model_id, hfOrg, body.config || {});

  // Audit log
  await auditLog(c.env.DB, tenant.id, c.get("actor"), "pipeline.start", "pipeline_job", job.id, {
    model_id: body.model_id,
  });

  // Execute pipeline in background
  c.executionCtx.waitUntil(executePipeline(c.env, job.id));

  return c.json(job, 201);
});

api.get("/pipeline/:jobId", async (c) => {
  const tenant = c.get("tenant");
  const jobId = c.req.param("jobId");

  // Fast path: check KV for current status
  const kvState = await c.env.JOB_STATE.get(`job:${jobId}`);

  const job = await c.env.DB.prepare("SELECT * FROM pipeline_jobs WHERE id = ? AND tenant_id = ?")
    .bind(jobId, tenant.id)
    .first<PipelineJob>();

  if (!job) return c.json({ error: "Job not found" }, 404);

  return c.json({
    ...job,
    live_status: kvState ? JSON.parse(kvState) : null,
  });
});

api.get("/pipeline", async (c) => {
  const tenant = c.get("tenant");
  const status = c.req.query("status");
  const limit = parseInt(c.req.query("limit") || "20");

  let query = "SELECT * FROM pipeline_jobs WHERE tenant_id = ?";
  const params: any[] = [tenant.id];

  if (status) {
    query += " AND status = ?";
    params.push(status);
  }

  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const stmt = c.env.DB.prepare(query);
  const result = await stmt.bind(...params).all<PipelineJob>();

  return c.json({ jobs: result.results });
});

// Findings
api.get("/pipeline/:jobId/findings", async (c) => {
  const tenant = c.get("tenant");
  const jobId = c.req.param("jobId");
  const severity = c.req.query("severity");

  let query = "SELECT * FROM findings WHERE job_id = ? AND tenant_id = ?";
  const params: any[] = [jobId, tenant.id];

  if (severity) {
    query += " AND severity = ?";
    params.push(severity);
  }

  query += " ORDER BY severity DESC, created_at ASC";

  const result = await c.env.DB.prepare(query).bind(...params).all();
  return c.json({ findings: result.results });
});

// Model registry
api.get("/models", async (c) => {
  const tenant = c.get("tenant");
  const result = await c.env.DB.prepare(
    "SELECT * FROM models WHERE tenant_id = ? ORDER BY created_at DESC"
  )
    .bind(tenant.id)
    .all();

  return c.json({ models: result.results });
});

// Model download — presigned R2 URL
api.get("/models/:modelId/download", async (c) => {
  const tenant = c.get("tenant");
  const modelId = c.req.param("modelId");

  const model = await c.env.DB.prepare("SELECT * FROM models WHERE id = ? AND tenant_id = ?")
    .bind(modelId, tenant.id)
    .first<any>();

  if (!model) return c.json({ error: "Model not found" }, 404);

  if (!model.r2_key) {
    // Model is on HuggingFace, not R2
    return c.json({ download_url: `https://huggingface.co/${model.hardened_model}` });
  }

  // Increment download counter
  await c.env.DB.prepare("UPDATE models SET download_count = download_count + 1 WHERE id = ?")
    .bind(modelId)
    .run();

  // For R2, we stream the object directly (zero egress cost)
  const object = await c.env.MODEL_STORE.get(model.r2_key);
  if (!object) return c.json({ error: "Model file not found in storage" }, 404);

  await auditLog(c.env.DB, tenant.id, c.get("actor"), "model.download", "model", modelId, {});

  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${model.name}.safetensors"`,
    },
  });
});

// Dashboard stats
api.get("/dashboard", async (c) => {
  const tenant = c.get("tenant");
  const tid = tenant.id;

  const [jobStats, modelCount, findingStats] = await Promise.all([
    c.env.DB.prepare(
      `SELECT status, COUNT(*) as count FROM pipeline_jobs WHERE tenant_id = ? GROUP BY status`
    )
      .bind(tid)
      .all(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM models WHERE tenant_id = ?").bind(tid).first<{ count: number }>(),
    c.env.DB.prepare(
      `SELECT severity, COUNT(*) as count, SUM(fixed) as fixed
       FROM findings WHERE tenant_id = ? GROUP BY severity`
    )
      .bind(tid)
      .all(),
  ]);

  return c.json({
    jobs: Object.fromEntries((jobStats.results || []).map((r: any) => [r.status, r.count])),
    models: modelCount?.count || 0,
    findings: (findingStats.results || []).map((r: any) => ({
      severity: r.severity,
      total: r.count,
      fixed: r.fixed,
    })),
  });
});

// Audit log
api.get("/audit", async (c) => {
  const tenant = c.get("tenant");
  const limit = parseInt(c.req.query("limit") || "50");

  const result = await c.env.DB.prepare(
    "SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?"
  )
    .bind(tenant.id, limit)
    .all();

  return c.json({ events: result.results });
});

// API key management
api.post("/keys", async (c) => {
  const tenant = c.get("tenant");
  const body = await c.req.json<{ name: string; scopes?: string[] }>();

  const apiKey = await generateApiKey(c.env.DB, tenant.id, body.name, body.scopes);
  await auditLog(c.env.DB, tenant.id, c.get("actor"), "key.create", "api_key", "", { name: body.name });

  // Return the key only once — it's hashed in the DB
  return c.json({ api_key: apiKey, name: body.name }, 201);
});

// Mount authenticated routes
app.route("/v1", api);

// Audit log helper
async function auditLog(
  db: D1Database,
  tenantId: string,
  actor: string,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: any
) {
  await db
    .prepare(
      "INSERT INTO audit_log (tenant_id, actor, action, resource_type, resource_id, metadata) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(tenantId, actor, action, resourceType, resourceId, JSON.stringify(metadata))
    .run();
}

export default app;
