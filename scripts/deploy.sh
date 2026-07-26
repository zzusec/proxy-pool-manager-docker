#!/bin/bash
# Deploy Proxy Pool Manager on us2
# Run this script on the server

set -e

cd /opt/proxy-pool-manager

# Build and start
echo "Building Docker image..."
docker compose build --no-cache

echo "Starting container..."
docker compose up -d

echo "Checking status..."
docker compose ps

echo "Testing API..."
sleep 5
curl -s http://localhost:3000/api/stats || echo "API not ready yet"

echo ""
echo "=== Deployment Complete ==="
echo "Access at: http://localhost:3000"
echo "Check .env for credentials"
