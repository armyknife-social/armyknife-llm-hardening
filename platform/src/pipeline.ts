import { Env, PipelineConfig, PipelineJob } from "./types";
import { HuggingFaceClient } from "./huggingface";

// Pipeline orchestrator — the air traffic controller
// Dispatches work to HuggingFace, tracks state in D1 + KV

export async function startPipeline(
  env: Env,
  tenantId: string,
  modelId: string,
  hfOrg: string,
  config: PipelineConfig = {}
): Promise<PipelineJob> {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();

  const job: PipelineJob = {
    id: jobId,
    tenant_id: tenantId,
    model_id: modelId,
    status: "queued",
    hf_org: hfOrg,
    config: JSON.stringify(config),
    total_findings: null,
    autotrain_job_id: null,
    fix_rate: null,
    regression_count: null,
    verdict: null,
    hardened_model_id: null,
    r2_key: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    error_message: null,
    created_at: now,
  };

  // Insert job into D1
  await env.DB.prepare(
    `INSERT INTO pipeline_jobs (id, tenant_id, model_id, status, hf_org, config, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(jobId, tenantId, modelId, "queued", hfOrg, JSON.stringify(config), now)
    .run();

  // Store initial state in KV for fast polling
  await env.JOB_STATE.put(
    `job:${jobId}`,
    JSON.stringify({ status: "queued", step: "initializing" }),
    { expirationTtl: 86400 } // 24h TTL
  );

  // Kick off the pipeline asynchronously
  // In production, this would use Cloudflare Queues or Durable Objects
  // For now, we use waitUntil to run in the background
  return job;
}

export async function executePipeline(env: Env, jobId: string): Promise<void> {
  const hf = new HuggingFaceClient(env.HF_TOKEN, env.HF_API_BASE);
  const startTime = Date.now();

  try {
    // Load job from D1
    const job = await env.DB.prepare("SELECT * FROM pipeline_jobs WHERE id = ?")
      .bind(jobId)
      .first<PipelineJob>();
    if (!job) throw new Error(`Job ${jobId} not found`);

    const config: PipelineConfig = JSON.parse(job.config || "{}");
    const hfOrg = job.hf_org || "";

    // Update status: scanning
    await updateJobStatus(env, jobId, "scanning", "Running security scan via HF Inference");
    await env.DB.prepare("UPDATE pipeline_jobs SET started_at = datetime('now') WHERE id = ?").bind(jobId).run();

    // Step 1: Scan — run attack probes against the model
    // In production, this calls the armyknife-llm-redteam scan engine
    // For the control plane, we orchestrate via HF Inference API
    const scanResult = await runScan(hf, job.model_id);
    await env.DB.prepare("UPDATE pipeline_jobs SET total_findings = ? WHERE id = ?")
      .bind(scanResult.totalFindings, jobId)
      .run();

    // Store findings in D1
    for (const finding of scanResult.findings) {
      await env.DB.prepare(
        `INSERT INTO findings (id, job_id, tenant_id, probe_id, category, severity, owasp_category, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          jobId,
          job.tenant_id,
          finding.probeId,
          finding.category,
          finding.severity,
          finding.owaspCategory || null,
          finding.description
        )
        .run();
    }

    if (scanResult.totalFindings === 0) {
      await completeJob(env, jobId, startTime, {
        verdict: "CLEAN",
        fix_rate: 1.0,
        regression_count: 0,
        hardened_model_id: job.model_id,
      });
      return;
    }

    // Step 2: Harden — generate DPO pairs and submit AutoTrain job
    await updateJobStatus(env, jobId, "hardening", "Generating DPO training data and submitting to AutoTrain");

    const hardenedName = job.model_id.split("/").pop()!.replace(/\./g, "-") + "-Hardened";
    const autotrainJobId = await hf.createAutoTrainJob({
      model: job.model_id,
      trainingData: scanResult.findings.map((f) => f.dpoPair).filter(Boolean),
      hfOrg,
      outputName: hardenedName,
      hardware: config.hf_hardware || "a10g-large",
      epochs: config.epochs || 3,
    });

    await env.DB.prepare("UPDATE pipeline_jobs SET autotrain_job_id = ? WHERE id = ?")
      .bind(autotrainJobId, jobId)
      .run();

    // Poll AutoTrain until complete
    await updateJobStatus(env, jobId, "hardening", `AutoTrain job ${autotrainJobId} running`);
    let trainStatus = await hf.getAutoTrainJobStatus(autotrainJobId);
    let pollCount = 0;
    const maxPolls = 360; // 6 hours at 60s intervals

    while (trainStatus.status === "pending" || trainStatus.status === "running") {
      if (pollCount >= maxPolls) throw new Error("AutoTrain job timed out after 6 hours");
      // In production, use Cloudflare Durable Objects alarm() instead of polling
      await new Promise((r) => setTimeout(r, 60000));
      trainStatus = await hf.getAutoTrainJobStatus(autotrainJobId);
      pollCount++;
      await env.JOB_STATE.put(
        `job:${jobId}`,
        JSON.stringify({ status: "hardening", step: `training (poll ${pollCount})` })
      );
    }

    if (trainStatus.status === "failed") {
      throw new Error(`AutoTrain failed: ${trainStatus.error}`);
    }

    // Step 3: Verify — re-scan the hardened model
    await updateJobStatus(env, jobId, "verifying", "Re-scanning hardened model");
    const hardenedModelId = `${hfOrg}/${hardenedName}`;
    const verifyResult = await runVerification(hf, hardenedModelId, scanResult.findings);

    await env.DB.prepare(
      "UPDATE pipeline_jobs SET fix_rate = ?, regression_count = ?, verdict = ?, hardened_model_id = ? WHERE id = ?"
    )
      .bind(verifyResult.fixRate, verifyResult.regressionCount, verifyResult.verdict, hardenedModelId, jobId)
      .run();

    // Mark fixed findings
    for (const fixedProbe of verifyResult.fixedProbes) {
      await env.DB.prepare("UPDATE findings SET fixed = 1 WHERE job_id = ? AND probe_id = ?")
        .bind(jobId, fixedProbe)
        .run();
    }

    // Step 4: Publish — store in R2 and register in model catalog
    const minFixRate = config.min_fix_rate || 0.30;
    if (verifyResult.fixRate >= minFixRate) {
      await updateJobStatus(env, jobId, "publishing", "Publishing hardened model");

      // Register in model catalog
      await env.DB.prepare(
        `INSERT INTO models (id, tenant_id, job_id, name, base_model, hardened_model, fix_rate, total_findings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          job.tenant_id,
          jobId,
          hardenedName,
          job.model_id,
          hardenedModelId,
          verifyResult.fixRate,
          scanResult.totalFindings
        )
        .run();
    }

    await completeJob(env, jobId, startTime, {
      verdict: verifyResult.verdict,
      fix_rate: verifyResult.fixRate,
      regression_count: verifyResult.regressionCount,
      hardened_model_id: hardenedModelId,
    });
  } catch (error: any) {
    await env.DB.prepare(
      "UPDATE pipeline_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now'), duration_ms = ? WHERE id = ?"
    )
      .bind(error.message, Date.now() - startTime, jobId)
      .run();
    await env.JOB_STATE.put(`job:${jobId}`, JSON.stringify({ status: "failed", error: error.message }));
  }
}

async function updateJobStatus(env: Env, jobId: string, status: string, step: string): Promise<void> {
  await env.DB.prepare("UPDATE pipeline_jobs SET status = ? WHERE id = ?").bind(status, jobId).run();
  await env.JOB_STATE.put(`job:${jobId}`, JSON.stringify({ status, step }));
}

async function completeJob(
  env: Env,
  jobId: string,
  startTime: number,
  results: { verdict: string; fix_rate: number; regression_count: number; hardened_model_id: string }
): Promise<void> {
  const durationMs = Date.now() - startTime;
  await env.DB.prepare(
    `UPDATE pipeline_jobs SET status = 'completed', verdict = ?, fix_rate = ?,
     regression_count = ?, hardened_model_id = ?, completed_at = datetime('now'), duration_ms = ? WHERE id = ?`
  )
    .bind(results.verdict, results.fix_rate, results.regression_count, results.hardened_model_id, durationMs, jobId)
    .run();
  await env.JOB_STATE.put(
    `job:${jobId}`,
    JSON.stringify({ status: "completed", verdict: results.verdict, fix_rate: results.fix_rate })
  );
}

// Stub implementations — in production these call the full armyknife-llm-redteam engine
// via HF Inference or a dedicated endpoint

interface ScanFinding {
  probeId: string;
  category: string;
  severity: string;
  owaspCategory?: string;
  description: string;
  dpoPair?: { prompt: string; chosen: string; rejected: string };
}

interface ScanResult {
  totalFindings: number;
  findings: ScanFinding[];
}

interface VerifyResult {
  fixRate: number;
  regressionCount: number;
  verdict: string;
  fixedProbes: string[];
}

async function runScan(_hf: HuggingFaceClient, _modelId: string): Promise<ScanResult> {
  // TODO: Wire to armyknife-llm-redteam scan engine via HF Inference
  // This will call the redteam probes against the model's inference endpoint
  throw new Error("Scan engine not yet wired — use CLI for now");
}

async function runVerification(
  _hf: HuggingFaceClient,
  _hardenedModelId: string,
  _originalFindings: ScanFinding[]
): Promise<VerifyResult> {
  // TODO: Wire to armyknife-llm-redteam verify engine
  throw new Error("Verify engine not yet wired — use CLI for now");
}
