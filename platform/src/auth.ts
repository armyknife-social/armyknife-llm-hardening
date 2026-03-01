import { Context, Next } from "hono";
import { AppEnv, Env, Tenant } from "./types";

// Authenticate via API key (Bearer token) or Cloudflare Access JWT
export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  if (authHeader.startsWith("Bearer ak_")) {
    // API key auth
    const apiKey = authHeader.slice(7); // "Bearer " prefix
    const tenant = await validateApiKey(c.env.DB, apiKey);
    if (!tenant) {
      return c.json({ error: "Invalid API key" }, 401);
    }
    c.set("tenant", tenant);
    c.set("actor", `key:${apiKey.slice(0, 8)}...`);
  } else if (authHeader.startsWith("Bearer cf_")) {
    // Cloudflare Access JWT (enterprise SSO)
    const token = authHeader.slice(7);
    const tenant = await validateAccessToken(c.env, token);
    if (!tenant) {
      return c.json({ error: "Invalid access token" }, 401);
    }
    c.set("tenant", tenant);
    c.set("actor", `sso:${tenant.slug}`);
  } else {
    return c.json({ error: "Unsupported auth method. Use API key (ak_...) or Cloudflare Access token." }, 401);
  }

  await next();
}

async function validateApiKey(db: D1Database, apiKey: string): Promise<Tenant | null> {
  // Hash the key for lookup
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const keyHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  const result = await db
    .prepare(
      `SELECT t.* FROM tenants t
       JOIN api_keys ak ON ak.tenant_id = t.id
       WHERE ak.key_hash = ? AND (ak.expires_at IS NULL OR ak.expires_at > datetime('now'))`
    )
    .bind(keyHash)
    .first<Tenant>();

  if (result) {
    // Update last_used_at
    await db
      .prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE key_hash = ?")
      .bind(keyHash)
      .run();
  }

  return result;
}

async function validateAccessToken(env: Env, token: string): Promise<Tenant | null> {
  // Cloudflare Access JWT validation
  // In production, verify against the Cloudflare Access certs endpoint
  try {
    const { importSPKI, jwtVerify } = await import("jose");
    // For now, validate with our own JWT_SECRET (replace with CF Access keys in prod)
    const secret = new TextEncoder().encode(env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    const tenantSlug = payload.sub as string;

    return await env.DB
      .prepare("SELECT * FROM tenants WHERE slug = ?")
      .bind(tenantSlug)
      .first<Tenant>();
  } catch {
    return null;
  }
}

// Generate a new API key for a tenant
export async function generateApiKey(db: D1Database, tenantId: string, name: string, scopes: string[] = ["read", "write"]): Promise<string> {
  const id = crypto.randomUUID();
  const apiKey = `ak_${generateRandomString(40)}`;

  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const keyHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  await db
    .prepare("INSERT INTO api_keys (id, tenant_id, key_hash, name, scopes) VALUES (?, ?, ?, ?, ?)")
    .bind(id, tenantId, keyHash, name, JSON.stringify(scopes))
    .run();

  return apiKey;
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values)
    .map((v) => chars[v % chars.length])
    .join("");
}
