#!/bin/bash
# Setup script for ArmyKnife Labs Enterprise Control Plane
# Run this once to provision Cloudflare resources

set -euo pipefail

echo "=== ArmyKnife Labs Enterprise Control Plane Setup ==="

# Check prerequisites
command -v npx >/dev/null 2>&1 || { echo "npx required. Install Node.js first."; exit 1; }
command -v wrangler >/dev/null 2>&1 || npm install -g wrangler

# Login to Cloudflare
echo "Logging into Cloudflare..."
wrangler login

# Create D1 database
echo "Creating D1 database..."
wrangler d1 create armyknife-control-plane 2>/dev/null || echo "Database may already exist"

# Create KV namespace
echo "Creating KV namespace..."
wrangler kv namespace create JOB_STATE 2>/dev/null || echo "KV namespace may already exist"

# Create R2 bucket
echo "Creating R2 bucket..."
wrangler r2 bucket create armyknife-models 2>/dev/null || echo "R2 bucket may already exist"

# Run migrations
echo "Running D1 migrations..."
wrangler d1 migrations apply armyknife-control-plane

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Update wrangler.toml with the D1 database_id and KV namespace id from above"
echo "  2. Set secrets:"
echo "     wrangler secret put HF_TOKEN"
echo "     wrangler secret put JWT_SECRET"
echo "     wrangler secret put WEBHOOK_SECRET"
echo "  3. Deploy:"
echo "     npm run deploy"
echo ""
echo "  For local development:"
echo "     npm run db:migrate:local"
echo "     npm run dev"
