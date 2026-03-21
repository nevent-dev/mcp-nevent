# =============================================================================
# Nevent MCP Server — Multi-stage Dockerfile
#
# Build targets:
#   1. builder  — Installs all dependencies and compiles TypeScript.
#   2. runner   — Minimal production image (Node.js + compiled JS only).
#
# Usage (local):
#   docker build -t nevent-mcp .
#   docker run -p 3000:3000 \
#     -e NEVENT_JWT_TOKEN=<token> \
#     -e MCP_TRANSPORT=http \
#     -e MCP_JWT_SECRET=<secret> \
#     -e MONGODB_URI=<mongodb+srv://...> \
#     nevent-mcp
#
# Production (AWS ECS Fargate):
#   - Push to ECR, deploy as a Fargate task.
#   - Inject secrets via ECS task definition `secrets` (from Secrets Manager).
#   - Expose port 3000; place behind an Application Load Balancer with HTTPS.
#   - The ALB terminates TLS; set MCP_SERVER_URL to the HTTPS ALB DNS name.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: builder
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

LABEL stage="builder"

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --include=dev

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies so the production install is lean
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 2: runner
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner

# Security hardening: run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcp -u 1001 -G nodejs

WORKDIR /app

# Copy compiled output and production node_modules only
COPY --from=builder --chown=mcp:nodejs /app/dist     ./dist
COPY --from=builder --chown=mcp:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=mcp:nodejs /app/package.json ./package.json

USER mcp

# Default to HTTP transport. Override via environment or ECS task definition.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_PORT=3000 \
    NEVENT_DATA_API_URL=https://data.nevent.es \
    NEVENT_API_URL=https://api.nevent.es \
    NEVENT_OPERATION_MODE=READ_ONLY

EXPOSE 3000

# Health check — polls /health every 30 seconds. ECS uses this to determine
# task health before routing traffic via the ALB target group.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Run the compiled entry point
CMD ["node", "dist/index.js", "--transport=http"]
