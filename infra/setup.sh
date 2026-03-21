#!/bin/bash
# =============================================================================
# AWS Infrastructure Setup — mcp-nevent
#
# Idempotent where possible. Run once to provision all resources for the
# mcp-nevent ECS Fargate service on the existing "production" cluster.
#
# Prerequisites:
#   - AWS CLI v2 configured with an IAM identity that has:
#       ecr:*, ecs:*, logs:*, elasticloadbalancing:*, route53:*, secretsmanager:CreateSecret
#   - jq installed (brew install jq / apt install jq)
#   - The following values resolved and set as environment variables or
#     substituted in the CONFIGURATION section below.
#
# Usage:
#   chmod +x infra/setup.sh
#   export AWS_PROFILE=nevent-prod    # or use --profile flag
#   ./infra/setup.sh
# =============================================================================

set -euo pipefail

# =============================================================================
# CONFIGURATION — Update these values before running
# =============================================================================

AWS_REGION="eu-west-1"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"      # Set via env or replace inline

ECR_REPOSITORY="mcp-nevent"
ECS_CLUSTER="production"
ECS_SERVICE="mcp-nevent"
TASK_FAMILY="mcp-nevent"
CONTAINER_NAME="mcp-nevent"
CONTAINER_PORT=3000

DOMAIN="mcp.nevent.ai"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"     # Route53 hosted zone for nevent.ai

# The ARN of the existing ALB (shared with api-2 / other services)
ALB_ARN="${ALB_ARN:-}"
# The ARN of the HTTPS listener on the existing ALB (port 443)
ALB_LISTENER_ARN="${ALB_LISTENER_ARN:-}"
# VPC and subnets — same as the existing production services
VPC_ID="${VPC_ID:-}"
SUBNET_IDS="${SUBNET_IDS:-}"             # Comma-separated, e.g. subnet-abc,subnet-def
SECURITY_GROUP_IDS="${SECURITY_GROUP_IDS:-}"  # Comma-separated

# IAM roles (same as other ECS services in the cluster)
ECS_EXECUTION_ROLE_ARN="${ECS_EXECUTION_ROLE_ARN:-arn:aws:iam::${AWS_ACCOUNT_ID}:role/ecsTaskExecutionRole}"
ECS_TASK_ROLE_ARN="${ECS_TASK_ROLE_ARN:-arn:aws:iam::${AWS_ACCOUNT_ID}:role/ecsTaskRole}"

# ALB listener rule priority — pick one not already in use
# Run: aws elbv2 describe-rules --listener-arn $ALB_LISTENER_ARN | jq '[.Rules[].Priority] | sort'
ALB_RULE_PRIORITY="${ALB_RULE_PRIORITY:-110}"

# =============================================================================
# GUARDS
# =============================================================================

if [ -z "$AWS_ACCOUNT_ID" ]; then
  echo "ERROR: AWS_ACCOUNT_ID is not set."
  echo "  Export it: export AWS_ACCOUNT_ID=\$(aws sts get-caller-identity --query Account --output text)"
  exit 1
fi

echo ""
echo "=== mcp-nevent AWS Infrastructure Setup ==="
echo "Account: $AWS_ACCOUNT_ID"
echo "Region:  $AWS_REGION"
echo "Cluster: $ECS_CLUSTER"
echo "Domain:  $DOMAIN"
echo ""

# =============================================================================
# STEP 1 — ECR Repository
# =============================================================================

echo "--- [1/7] Creating ECR repository: $ECR_REPOSITORY"

if aws ecr describe-repositories \
     --repository-names "$ECR_REPOSITORY" \
     --region "$AWS_REGION" \
     --output text > /dev/null 2>&1; then
  echo "  ECR repository already exists — skipping."
else
  aws ecr create-repository \
    --repository-name "$ECR_REPOSITORY" \
    --region "$AWS_REGION" \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256
  echo "  ECR repository created."
fi

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
echo "  ECR URI: $ECR_URI"

# =============================================================================
# STEP 2 — CloudWatch Log Group
# =============================================================================

echo ""
echo "--- [2/7] Creating CloudWatch log group: /ecs/$TASK_FAMILY"

if aws logs describe-log-groups \
     --log-group-name-prefix "/ecs/$TASK_FAMILY" \
     --region "$AWS_REGION" \
     --query "logGroups[?logGroupName=='/ecs/$TASK_FAMILY'] | length(@)" \
     --output text | grep -q "^1$"; then
  echo "  Log group already exists — skipping."
else
  aws logs create-log-group \
    --log-group-name "/ecs/$TASK_FAMILY" \
    --region "$AWS_REGION"
  # Retain logs for 90 days in production
  aws logs put-retention-policy \
    --log-group-name "/ecs/$TASK_FAMILY" \
    --retention-in-days 90 \
    --region "$AWS_REGION"
  echo "  Log group created with 90-day retention."
fi

# =============================================================================
# STEP 3 — Secrets Manager (manual fill required)
# =============================================================================

echo ""
echo "--- [3/7] Secrets Manager placeholders"
echo "  IMPORTANT: Create these secrets manually and replace REPLACE_ME with real values."
echo ""

SECRET_NAMES=(
  "mcp-nevent/jwt-token:NEVENT_JWT_TOKEN"
  "mcp-nevent/mcp-jwt-secret:MCP_JWT_SECRET"
  "mcp-nevent/mongodb-uri:MONGODB_URI"
)

for entry in "${SECRET_NAMES[@]}"; do
  SECRET_NAME="${entry%%:*}"
  ENV_VAR="${entry##*:}"
  SECRET_ARN="arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:${SECRET_NAME}"

  if aws secretsmanager describe-secret \
       --secret-id "$SECRET_NAME" \
       --region "$AWS_REGION" > /dev/null 2>&1; then
    echo "  Secret '$SECRET_NAME' already exists — skipping creation."
  else
    echo "  Creating placeholder secret: $SECRET_NAME"
    aws secretsmanager create-secret \
      --name "$SECRET_NAME" \
      --description "mcp-nevent: $ENV_VAR" \
      --secret-string "REPLACE_ME" \
      --region "$AWS_REGION"
    echo "  Created. ARN: $SECRET_ARN"
  fi
done

echo ""
echo "  ACTION REQUIRED: Fill in the real secret values via the AWS Console or:"
echo "    aws secretsmanager put-secret-value --secret-id mcp-nevent/jwt-token     --secret-string '<value>'"
echo "    aws secretsmanager put-secret-value --secret-id mcp-nevent/mcp-jwt-secret --secret-string '<value>'"
echo "    aws secretsmanager put-secret-value --secret-id mcp-nevent/mongodb-uri   --secret-string '<value>'"
echo ""

# =============================================================================
# STEP 4 — ALB Target Group
# =============================================================================

echo "--- [4/7] Creating ALB target group for $DOMAIN (port $CONTAINER_PORT)"

if [ -z "$VPC_ID" ]; then
  echo "  WARNING: VPC_ID is not set. Skipping target group creation."
  echo "  Set VPC_ID and re-run, or create manually:"
  echo "    aws elbv2 create-target-group \\"
  echo "      --name mcp-nevent-tg \\"
  echo "      --protocol HTTP \\"
  echo "      --port $CONTAINER_PORT \\"
  echo "      --vpc-id <VPC_ID> \\"
  echo "      --target-type ip \\"
  echo "      --health-check-protocol HTTP \\"
  echo "      --health-check-path /health \\"
  echo "      --health-check-interval-seconds 30 \\"
  echo "      --health-check-timeout-seconds 5 \\"
  echo "      --healthy-threshold-count 2 \\"
  echo "      --unhealthy-threshold-count 3 \\"
  echo "      --region $AWS_REGION"
  TARGET_GROUP_ARN="PENDING_MANUAL_CREATION"
else
  # Check if target group already exists
  EXISTING_TG=$(aws elbv2 describe-target-groups \
    --names "mcp-nevent-tg" \
    --region "$AWS_REGION" \
    --query "TargetGroups[0].TargetGroupArn" \
    --output text 2>/dev/null || echo "NONE")

  if [ "$EXISTING_TG" != "NONE" ] && [ -n "$EXISTING_TG" ]; then
    echo "  Target group already exists: $EXISTING_TG"
    TARGET_GROUP_ARN="$EXISTING_TG"
  else
    TARGET_GROUP_ARN=$(aws elbv2 create-target-group \
      --name "mcp-nevent-tg" \
      --protocol HTTP \
      --port "$CONTAINER_PORT" \
      --vpc-id "$VPC_ID" \
      --target-type ip \
      --health-check-protocol HTTP \
      --health-check-path /health \
      --health-check-interval-seconds 30 \
      --health-check-timeout-seconds 5 \
      --healthy-threshold-count 2 \
      --unhealthy-threshold-count 3 \
      --region "$AWS_REGION" \
      --query "TargetGroups[0].TargetGroupArn" \
      --output text)
    echo "  Target group created: $TARGET_GROUP_ARN"
  fi
fi

# =============================================================================
# STEP 5 — ALB Listener Rule
# =============================================================================

echo ""
echo "--- [5/7] Adding ALB listener rule for host: $DOMAIN"

if [ -z "$ALB_LISTENER_ARN" ] || [ "$TARGET_GROUP_ARN" = "PENDING_MANUAL_CREATION" ]; then
  echo "  WARNING: ALB_LISTENER_ARN or TARGET_GROUP_ARN is not set. Skipping."
  echo "  Once both are available, run:"
  echo "    aws elbv2 create-rule \\"
  echo "      --listener-arn <ALB_LISTENER_ARN> \\"
  echo "      --priority $ALB_RULE_PRIORITY \\"
  echo "      --conditions '[{\"Field\":\"host-header\",\"Values\":[\"$DOMAIN\"]}]' \\"
  echo "      --actions '[{\"Type\":\"forward\",\"TargetGroupArn\":\"<TARGET_GROUP_ARN>\"}]' \\"
  echo "      --region $AWS_REGION"
else
  # Check if a rule for this host already exists
  EXISTING_RULE=$(aws elbv2 describe-rules \
    --listener-arn "$ALB_LISTENER_ARN" \
    --region "$AWS_REGION" \
    --query "Rules[?Conditions[?Field=='host-header' && Values[?contains(@, '$DOMAIN')]]] | [0].RuleArn" \
    --output text 2>/dev/null || echo "NONE")

  if [ "$EXISTING_RULE" != "NONE" ] && [ -n "$EXISTING_RULE" ]; then
    echo "  Listener rule for $DOMAIN already exists: $EXISTING_RULE — skipping."
  else
    RULE_ARN=$(aws elbv2 create-rule \
      --listener-arn "$ALB_LISTENER_ARN" \
      --priority "$ALB_RULE_PRIORITY" \
      --conditions "[{\"Field\":\"host-header\",\"Values\":[\"$DOMAIN\"]}]" \
      --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"$TARGET_GROUP_ARN\"}]" \
      --region "$AWS_REGION" \
      --query "Rules[0].RuleArn" \
      --output text)
    echo "  Listener rule created: $RULE_ARN"
  fi
fi

# =============================================================================
# STEP 6 — ECS Task Definition
# =============================================================================

echo ""
echo "--- [6/7] Registering ECS task definition: $TASK_FAMILY"

# Substitute ACCOUNT_ID placeholder in the template
sed "s/ACCOUNT_ID/${AWS_ACCOUNT_ID}/g" "$(dirname "$0")/task-definition.json" > /tmp/mcp-nevent-task-def.json

# Verify secrets exist before registering (warn, don't fail)
for SECRET in "mcp-nevent/jwt-token" "mcp-nevent/mcp-jwt-secret" "mcp-nevent/mongodb-uri"; do
  VAL=$(aws secretsmanager get-secret-value \
    --secret-id "$SECRET" \
    --region "$AWS_REGION" \
    --query SecretString \
    --output text 2>/dev/null || echo "REPLACE_ME")
  if [ "$VAL" = "REPLACE_ME" ]; then
    echo "  WARNING: Secret '$SECRET' still has placeholder value. Update it before the first deploy."
  fi
done

TASK_DEF_ARN=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/mcp-nevent-task-def.json \
  --query "taskDefinition.taskDefinitionArn" \
  --output text \
  --region "$AWS_REGION")

echo "  Task definition registered: $TASK_DEF_ARN"

# =============================================================================
# STEP 7 — ECS Service
# =============================================================================

echo ""
echo "--- [7/7] Creating ECS service: $ECS_SERVICE"

if [ -z "$SUBNET_IDS" ] || [ -z "$SECURITY_GROUP_IDS" ] || [ "$TARGET_GROUP_ARN" = "PENDING_MANUAL_CREATION" ]; then
  echo "  WARNING: SUBNET_IDS, SECURITY_GROUP_IDS, or TARGET_GROUP_ARN not set. Skipping ECS service creation."
  echo "  Once all values are available, run:"
  echo ""
  echo "    aws ecs create-service \\"
  echo "      --cluster $ECS_CLUSTER \\"
  echo "      --service-name $ECS_SERVICE \\"
  echo "      --task-definition $TASK_FAMILY \\"
  echo "      --desired-count 1 \\"
  echo "      --launch-type FARGATE \\"
  echo "      --network-configuration 'awsvpcConfiguration={subnets=[<SUBNET_IDS>],securityGroups=[<SG_IDS>],assignPublicIp=DISABLED}' \\"
  echo "      --load-balancers '[{\"targetGroupArn\":\"<TARGET_GROUP_ARN>\",\"containerName\":\"$CONTAINER_NAME\",\"containerPort\":$CONTAINER_PORT}]' \\"
  echo "      --health-check-grace-period-seconds 30 \\"
  echo "      --region $AWS_REGION"
else
  EXISTING_SERVICE=$(aws ecs describe-services \
    --cluster "$ECS_CLUSTER" \
    --services "$ECS_SERVICE" \
    --region "$AWS_REGION" \
    --query "services[?status=='ACTIVE'] | [0].serviceArn" \
    --output text 2>/dev/null || echo "NONE")

  if [ "$EXISTING_SERVICE" != "NONE" ] && [ -n "$EXISTING_SERVICE" ]; then
    echo "  ECS service already exists: $EXISTING_SERVICE — skipping."
  else
    # Convert comma-separated subnet/sg strings to JSON arrays
    SUBNET_JSON=$(echo "$SUBNET_IDS" | tr ',' '\n' | jq -R . | jq -s .)
    SG_JSON=$(echo "$SECURITY_GROUP_IDS" | tr ',' '\n' | jq -R . | jq -s .)

    aws ecs create-service \
      --cluster "$ECS_CLUSTER" \
      --service-name "$ECS_SERVICE" \
      --task-definition "$TASK_FAMILY" \
      --desired-count 1 \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=$(echo $SUBNET_JSON),securityGroups=$(echo $SG_JSON),assignPublicIp=DISABLED}" \
      --load-balancers "[{\"targetGroupArn\":\"$TARGET_GROUP_ARN\",\"containerName\":\"$CONTAINER_NAME\",\"containerPort\":$CONTAINER_PORT}]" \
      --health-check-grace-period-seconds 30 \
      --region "$AWS_REGION"

    echo "  ECS service created."
  fi
fi

# =============================================================================
# STEP 8 — Route53 DNS record (mcp.nevent.ai → ALB)
# =============================================================================

echo ""
echo "--- [8/8] Route53 DNS record for $DOMAIN"

if [ -z "$HOSTED_ZONE_ID" ] || [ -z "$ALB_ARN" ]; then
  echo "  WARNING: HOSTED_ZONE_ID or ALB_ARN not set. Skipping Route53 record."
  echo ""
  echo "  To get your ALB DNS name:"
  echo "    aws elbv2 describe-load-balancers --load-balancer-arns <ALB_ARN> \\"
  echo "      --query 'LoadBalancers[0].DNSName' --output text"
  echo ""
  echo "  Then create the Route53 ALIAS record manually or via:"
  echo ""
  echo "    ALB_DNS_NAME=\$(aws elbv2 describe-load-balancers --load-balancer-arns <ALB_ARN> --query 'LoadBalancers[0].DNSName' --output text)"
  echo "    ALB_HOSTED_ZONE=\$(aws elbv2 describe-load-balancers --load-balancer-arns <ALB_ARN> --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)"
  echo ""
  echo "    aws route53 change-resource-record-sets \\"
  echo "      --hosted-zone-id <HOSTED_ZONE_ID_FOR_nevent.ai> \\"
  echo "      --change-batch '{"
  echo "        \"Changes\": [{"
  echo "          \"Action\": \"UPSERT\","
  echo "          \"ResourceRecordSet\": {"
  echo "            \"Name\": \"$DOMAIN\","
  echo "            \"Type\": \"A\","
  echo "            \"AliasTarget\": {"
  echo "              \"HostedZoneId\": \"'\$ALB_HOSTED_ZONE'\","
  echo "              \"DNSName\": \"'\$ALB_DNS_NAME'\","
  echo "              \"EvaluateTargetHealth\": true"
  echo "            }"
  echo "          }"
  echo "        }]"
  echo "      }'"
else
  ALB_DNS_NAME=$(aws elbv2 describe-load-balancers \
    --load-balancer-arns "$ALB_ARN" \
    --query "LoadBalancers[0].DNSName" \
    --output text \
    --region "$AWS_REGION")

  ALB_CANONICAL_ZONE=$(aws elbv2 describe-load-balancers \
    --load-balancer-arns "$ALB_ARN" \
    --query "LoadBalancers[0].CanonicalHostedZoneId" \
    --output text \
    --region "$AWS_REGION")

  aws route53 change-resource-record-sets \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "{
      \"Changes\": [{
        \"Action\": \"UPSERT\",
        \"ResourceRecordSet\": {
          \"Name\": \"$DOMAIN\",
          \"Type\": \"A\",
          \"AliasTarget\": {
            \"HostedZoneId\": \"$ALB_CANONICAL_ZONE\",
            \"DNSName\": \"$ALB_DNS_NAME\",
            \"EvaluateTargetHealth\": true
          }
        }
      }]
    }"

  echo "  Route53 ALIAS record upserted: $DOMAIN -> $ALB_DNS_NAME"
fi

# =============================================================================
# SUMMARY
# =============================================================================

echo ""
echo "======================================================"
echo "Setup complete. Summary:"
echo "  ECR:            $ECR_URI"
echo "  Task family:    $TASK_FAMILY (revision: $TASK_DEF_ARN)"
echo "  ECS cluster:    $ECS_CLUSTER"
echo "  ECS service:    $ECS_SERVICE"
echo "  Target group:   ${TARGET_GROUP_ARN:-PENDING}"
echo "  Domain:         $DOMAIN"
echo ""
echo "Next steps:"
echo "  1. Fill in the Secrets Manager secrets with real values."
echo "  2. Verify ECS service is running:"
echo "       aws ecs describe-services --cluster $ECS_CLUSTER --services $ECS_SERVICE --region $AWS_REGION"
echo "  3. Push to main to trigger the GitHub Actions deploy workflow."
echo "  4. Verify health: curl https://$DOMAIN/health"
echo "======================================================"
