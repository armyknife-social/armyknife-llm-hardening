import { Env } from "./types";

// HuggingFace API client for orchestrating the hardening pipeline

export interface HfScanResult {
  total_findings: number;
  findings: HfFinding[];
}

export interface HfFinding {
  probe_id: string;
  category: string;
  severity: string;
  owasp_category?: string;
  description: string;
}

export interface AutoTrainJobStatus {
  job_id: string;
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
}

export class HuggingFaceClient {
  private token: string;
  private apiBase: string;

  constructor(token: string, apiBase: string = "https://huggingface.co/api") {
    this.token = token;
    this.apiBase = apiBase;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  // Validate the token works
  async whoami(): Promise<{ username: string; orgs: string[] }> {
    const resp = await fetch(`${this.apiBase}/whoami-v2`, {
      headers: this.headers(),
    });
    if (!resp.ok) throw new Error(`HF auth failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    return {
      username: data.name,
      orgs: (data.orgs || []).map((o: any) => o.name),
    };
  }

  // Check if a model exists on the Hub
  async modelExists(modelId: string): Promise<boolean> {
    const resp = await fetch(`${this.apiBase}/models/${modelId}`, {
      headers: this.headers(),
    });
    return resp.ok;
  }

  // Get model info
  async modelInfo(modelId: string): Promise<any> {
    const resp = await fetch(`${this.apiBase}/models/${modelId}`, {
      headers: this.headers(),
    });
    if (!resp.ok) throw new Error(`Model not found: ${modelId}`);
    return resp.json();
  }

  // Trigger inference for scanning (serverless)
  async inference(modelId: string, inputs: string): Promise<string> {
    const resp = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ inputs, parameters: { max_new_tokens: 512 } }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Inference failed: ${resp.status} ${err}`);
    }
    const data = (await resp.json()) as any;
    return Array.isArray(data) ? data[0]?.generated_text || "" : data.generated_text || "";
  }

  // Create AutoTrain DPO training job
  async createAutoTrainJob(params: {
    model: string;
    trainingData: any[];
    hfOrg: string;
    outputName: string;
    hardware: string;
    epochs: number;
  }): Promise<string> {
    const payload = {
      project_name: params.outputName,
      task: "llm:dpo",
      base_model: params.model,
      hardware: params.hardware,
      params: {
        epochs: params.epochs,
        batch_size: 2,
        lr: 5e-5,
        block_size: 2048,
        peft: true,
        lora_r: 16,
        lora_alpha: 32,
      },
      hub_model: `${params.hfOrg}/${params.outputName}`,
    };

    const resp = await fetch("https://huggingface.co/api/autotrain/create", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`AutoTrain job creation failed: ${resp.status} ${err}`);
    }

    const data = (await resp.json()) as any;
    return data.id || data.job_id;
  }

  // Check AutoTrain job status
  async getAutoTrainJobStatus(jobId: string): Promise<AutoTrainJobStatus> {
    const resp = await fetch(`https://huggingface.co/api/autotrain/status/${jobId}`, {
      headers: this.headers(),
    });
    if (!resp.ok) throw new Error(`Failed to get job status: ${resp.status}`);
    const data = (await resp.json()) as any;
    return {
      job_id: jobId,
      status: data.status,
      error: data.error,
    };
  }

  // Create or check repo existence
  async createRepo(repoId: string, isPrivate: boolean = false): Promise<void> {
    const [namespace, name] = repoId.split("/");
    const resp = await fetch(`${this.apiBase}/repos/create`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        type: "model",
        name,
        organization: namespace,
        private: isPrivate,
      }),
    });
    // 409 = already exists, which is fine
    if (!resp.ok && resp.status !== 409) {
      const err = await resp.text();
      throw new Error(`Repo creation failed: ${resp.status} ${err}`);
    }
  }
}
