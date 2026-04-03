#!/bin/bash
# Digital Twin Truck Configurator V2 - Automated Setup
# Key-Pair JWT Authentication | Network Policy Hardening | Safe RSA Key Reuse
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONNECTION_NAME=""
SNOW_WH=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }

snow_sql() {
  local sql="$1"
  local extra_args="${@:2}"
  if [[ -n "$SNOW_WH" ]]; then
    snow sql -q "$sql" -c "$CONNECTION_NAME" --warehouse "$SNOW_WH" $extra_args
  else
    snow sql -q "$sql" -c "$CONNECTION_NAME" $extra_args
  fi
}

snow_sql_file() {
  local file="$1"
  if [[ -n "$SNOW_WH" ]]; then
    snow sql -f "$file" -c "$CONNECTION_NAME" --warehouse "$SNOW_WH"
  else
    snow sql -f "$file" -c "$CONNECTION_NAME"
  fi
}

snow_sql_silent() {
  snow_sql "$1" 2>/dev/null || true
}

usage() {
  echo "Usage: $0 -c <connection_name> [-h]"
  echo ""
  echo "  -c  Snowflake CLI connection name (required)"
  echo "  -h  Show this help"
  echo ""
  echo "Example: $0 -c cleanbarbarian"
  exit 0
}

while getopts "c:h" opt; do
  case $opt in
    c) CONNECTION_NAME="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [[ -z "$CONNECTION_NAME" ]]; then
  err "Connection name required. Use -c <connection>"
  usage
fi

echo "=================================================="
echo "  Digital Twin Truck Configurator V2 Setup"
echo "  Key-Pair JWT Auth | Network Policy Hardening"
echo "=================================================="
echo ""

check_prereqs() {
  info "Checking prerequisites..."

  if ! command -v snow &> /dev/null; then
    err "'snow' CLI not found. Install: pip install snowflake-cli"
    exit 1
  fi

  if ! command -v docker &> /dev/null; then
    err "'docker' not found. Install Docker Desktop."
    exit 1
  fi

  if ! command -v jq &> /dev/null; then
    err "'jq' not found. Install: brew install jq (macOS) or apt install jq (Linux)"
    exit 1
  fi

  log "Prerequisites satisfied"
}

test_connection() {
  info "Testing connection '$CONNECTION_NAME'..."
  local result
  result=$(snow sql -q "SELECT CURRENT_USER() AS U, CURRENT_ACCOUNT() AS A" -c "$CONNECTION_NAME" --format json 2>&1) || {
    err "Connection '$CONNECTION_NAME' failed. Check: snow connection test -c $CONNECTION_NAME"
    exit 1
  }
  log "Connection OK"
}

gather_config() {
  info "Detecting account info from connection..."

  SNOWFLAKE_USER=$(snow sql -q "SELECT CURRENT_USER()" -c "$CONNECTION_NAME" --format json 2>/dev/null | jq -r '.[0]."CURRENT_USER()"' 2>/dev/null || echo "")
  SNOWFLAKE_ACCOUNT_LOCATOR=$(snow sql -q "SELECT CURRENT_ACCOUNT()" -c "$CONNECTION_NAME" --format json 2>/dev/null | jq -r '.[0]."CURRENT_ACCOUNT()"' 2>/dev/null || echo "")

  local conn_json
  conn_json=$(snow connection list --format json 2>/dev/null)
  SNOWFLAKE_ACCOUNT=$(echo "$conn_json" | jq -r ".[] | select(.connection_name==\"$CONNECTION_NAME\") | .parameters.account" 2>/dev/null || echo "")
  SNOWFLAKE_HOST="${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com"

  echo ""
  echo "Auto-detected:"
  echo "  User:            $SNOWFLAKE_USER"
  echo "  Account:         $SNOWFLAKE_ACCOUNT"
  echo "  Account Locator: $SNOWFLAKE_ACCOUNT_LOCATOR"
  echo "  Host:            $SNOWFLAKE_HOST"
  echo ""

  read -p "Database name [BOM]: " DATABASE
  DATABASE=${DATABASE:-BOM}

  read -p "Schema name [TRUCK_CONFIG]: " SCHEMA
  SCHEMA=${SCHEMA:-TRUCK_CONFIG}

  read -p "Compute Pool name [TRUCK_CONFIG_POOL]: " COMPUTE_POOL
  COMPUTE_POOL=${COMPUTE_POOL:-TRUCK_CONFIG_POOL}

  read -p "Warehouse name [DEMO_WH]: " SNOWFLAKE_WAREHOUSE
  SNOWFLAKE_WAREHOUSE=${SNOWFLAKE_WAREHOUSE:-DEMO_WH}

  echo ""
  echo "Configuration:"
  echo "  Account:         $SNOWFLAKE_ACCOUNT"
  echo "  Locator:         $SNOWFLAKE_ACCOUNT_LOCATOR"
  echo "  User:            $SNOWFLAKE_USER"
  echo "  Database:        $DATABASE"
  echo "  Schema:          $SCHEMA"
  echo "  Warehouse:       $SNOWFLAKE_WAREHOUSE"
  echo "  Compute Pool:    $COMPUTE_POOL"
  echo ""

  read -p "Continue? (y/n): " CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo "Setup cancelled."
    exit 0
  fi
}

setup_authentication() {
  info "Step 1: Setting up Key-Pair Authentication..."

  local existing_key
  existing_key=$(snow sql -q "DESCRIBE USER $SNOWFLAKE_USER" -c "$CONNECTION_NAME" --format json 2>/dev/null | jq -r '.[] | select(.property=="RSA_PUBLIC_KEY_FP") | .value' 2>/dev/null || echo "")

  if [[ -n "$existing_key" && "$existing_key" != "null" ]]; then
    log "Existing RSA key found: $existing_key"
    info "Reusing existing key (safe -- won't break other SPCS apps)"

    local conn_json
    conn_json=$(snow connection list --format json 2>/dev/null)
    local pk_file
    pk_file=$(echo "$conn_json" | jq -r ".[] | select(.connection_name==\"$CONNECTION_NAME\") | .parameters.private_key_file // .parameters.private_key_path // empty" 2>/dev/null || echo "")

    pk_file="${pk_file/#\~/$HOME}"

    if [[ -z "$pk_file" || ! -f "$pk_file" ]]; then
      err "Could not find private key file for connection '$CONNECTION_NAME'"
      err "Expected in connections.toml: private_key_file = \"path/to/key.p8\""
      exit 1
    fi

    log "Private key file: $pk_file"
    PRIVATE_KEY_PEM=$(cat "$pk_file")

    local local_fp
    local_fp=$(openssl pkey -in "$pk_file" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 -binary | base64)
    info "Local key fingerprint: SHA256:$local_fp"

    local remote_fp
    remote_fp=$(echo "$existing_key" | sed 's/SHA256://')
    if [[ "$local_fp" == "$remote_fp" ]]; then
      log "Fingerprint match confirmed"
    else
      local existing_key2
      existing_key2=$(snow sql -q "DESCRIBE USER $SNOWFLAKE_USER" -c "$CONNECTION_NAME" --format json 2>/dev/null | jq -r '.[] | select(.property=="RSA_PUBLIC_KEY_2_FP") | .value' 2>/dev/null || echo "")
      local remote_fp2
      remote_fp2=$(echo "$existing_key2" | sed 's/SHA256://')
      if [[ "$local_fp" == "$remote_fp2" ]]; then
        log "Fingerprint matches RSA_PUBLIC_KEY_2"
      else
        warn "Fingerprint mismatch -- key in file doesn't match either RSA key slot"
        warn "Local: SHA256:$local_fp"
        warn "Remote slot 1: $existing_key"
        warn "Remote slot 2: $existing_key2"
        read -p "Continue anyway? (y/n): " CONT
        [[ "$CONT" != "y" ]] && exit 1
      fi
    fi
  else
    warn "No RSA key found on user $SNOWFLAKE_USER"
    err "Key-pair auth requires an existing RSA key. Set up with:"
    err "  openssl genrsa -out ~/.snowflake/keys/mykey.p8 2048"
    err "  openssl rsa -in ~/.snowflake/keys/mykey.p8 -pubout -out ~/.snowflake/keys/mykey.pub"
    err "  ALTER USER $SNOWFLAKE_USER SET RSA_PUBLIC_KEY='<public key content>';"
    exit 1
  fi

  log "Authentication setup complete"
}

create_infrastructure() {
  info "Step 2: Creating infrastructure..."

  snow_sql "CREATE WAREHOUSE IF NOT EXISTS $SNOWFLAKE_WAREHOUSE WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE;"
  SNOW_WH="$SNOWFLAKE_WAREHOUSE"

  snow_sql "CREATE DATABASE IF NOT EXISTS $DATABASE;"
  snow_sql "CREATE SCHEMA IF NOT EXISTS $DATABASE.$SCHEMA;"

  snow_sql "CREATE COMPUTE POOL IF NOT EXISTS $COMPUTE_POOL
    MIN_NODES = 1 MAX_NODES = 1
    INSTANCE_FAMILY = CPU_X64_XS
    AUTO_RESUME = TRUE AUTO_SUSPEND_SECS = 3600;" 2>/dev/null || warn "Compute pool may already exist"

  snow_sql "CREATE IMAGE REPOSITORY IF NOT EXISTS $DATABASE.$SCHEMA.TRUCK_CONFIG_REPO;"

  REPO_URL=$(snow_sql "SHOW IMAGE REPOSITORIES IN SCHEMA $DATABASE.$SCHEMA;" --format json 2>/dev/null | jq -r '.[0].repository_url' 2>/dev/null || echo "")
  if [[ -z "$REPO_URL" ]]; then
    err "Could not get image repository URL"
    exit 1
  fi
  log "Image repo: $REPO_URL"

  snow_sql "CREATE STAGE IF NOT EXISTS $DATABASE.$SCHEMA.ENGINEERING_DOCS_STAGE;"

  log "Infrastructure created"
}

create_private_key_secret() {
  info "Step 3: Creating private key secret..."

  local escaped_key
  escaped_key=$(echo "$PRIVATE_KEY_PEM" | sed "s/'/''/g")

  snow_sql "CREATE OR REPLACE SECRET $DATABASE.$SCHEMA.SNOWFLAKE_PRIVATE_KEY_SECRET
    TYPE = GENERIC_STRING
    SECRET_STRING = '$escaped_key';"

  log "Private key secret created"
}

create_external_access() {
  info "Step 4: Creating external access integration..."

  snow_sql "CREATE OR REPLACE NETWORK RULE $DATABASE.$SCHEMA.CORTEX_API_RULE
    TYPE = HOST_PORT MODE = EGRESS
    VALUE_LIST = ('*.snowflakecomputing.com:443');"

  snow_sql "CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION TRUCK_CONFIG_EXTERNAL_ACCESS
    ALLOWED_NETWORK_RULES = ($DATABASE.$SCHEMA.CORTEX_API_RULE)
    ALLOWED_AUTHENTICATION_SECRETS = ($DATABASE.$SCHEMA.SNOWFLAKE_PRIVATE_KEY_SECRET)
    ENABLED = TRUE;"

  log "External access integration created (with ALLOWED_AUTHENTICATION_SECRETS)"
}

load_data() {
  info "Step 5: Loading data..."

  local tmpdir
  tmpdir=$(mktemp -d)

  for f in 02_data.sql 02b_bom_data.sql 02c_truck_options.sql; do
    sed "s/BOM\.BOM4/$DATABASE.$SCHEMA/g" "$SCRIPT_DIR/scripts/$f" > "$tmpdir/$f"
    snow_sql_file "$tmpdir/$f"
  done

  rm -rf "$tmpdir"
  log "Data loaded"
}

create_semantic_view() {
  info "Step 6: Creating semantic view..."

  local tmpdir
  tmpdir=$(mktemp -d)
  sed "s/BOM\.BOM4/$DATABASE.$SCHEMA/g" "$SCRIPT_DIR/scripts/03_semantic_view.sql" > "$tmpdir/03_semantic_view.sql"
  snow_sql_file "$tmpdir/03_semantic_view.sql"
  rm -rf "$tmpdir"

  log "Semantic view created"
}

ensure_network_policy() {
  info "Step 7: Network policy hardening..."

  local SPCS_CIDR="153.45.59.0/24"

  local has_enforcement_task
  has_enforcement_task=$(snow_sql "SHOW TASKS LIKE 'ACCOUNT_LEVEL_NETWORK_POLICY_TASK' IN SCHEMA SECURITY_NETWORK_DB.POLICIES;" --format json 2>/dev/null | jq -r '.[0].name // empty' 2>/dev/null || echo "")

  if [[ -n "$has_enforcement_task" ]]; then
    info "Security enforcement task detected -- applying three-part network policy fix"

    local acct_policy
    acct_policy=$(snow_sql "SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN ACCOUNT;" --format json 2>/dev/null | jq -r '.[0].value // empty' 2>/dev/null || echo "")

    if [[ -n "$acct_policy" ]]; then
      info "Account-level policy: $acct_policy"

      local has_spcs
      has_spcs=$(snow_sql "SELECT COUNT(*) AS C FROM TABLE(FLATTEN(INPUT => PARSE_JSON((SELECT ALLOWED_IP_LIST FROM SNOWFLAKE.INFORMATION_SCHEMA.NETWORK_POLICIES WHERE NAME = '$acct_policy')))) WHERE VALUE::STRING LIKE '153.45.59%';" --format json 2>/dev/null | jq -r '.[0].C // "0"' 2>/dev/null || echo "0")

      if [[ "$has_spcs" == "0" ]]; then
        info "Adding SPCS CIDR to account policy $acct_policy..."
        local current_ips
        current_ips=$(snow_sql "SELECT LISTAGG(VALUE::STRING, ',') AS IPS FROM TABLE(FLATTEN(INPUT => PARSE_JSON((SELECT ALLOWED_IP_LIST FROM SNOWFLAKE.INFORMATION_SCHEMA.NETWORK_POLICIES WHERE NAME = '$acct_policy'))));" --format json 2>/dev/null | jq -r '.[0].IPS // empty' 2>/dev/null || echo "")

        if [[ -n "$current_ips" ]]; then
          snow_sql "ALTER NETWORK POLICY $acct_policy SET ALLOWED_IP_LIST = ($current_ips, '$SPCS_CIDR');" 2>/dev/null || warn "Could not update account policy"
          log "Added $SPCS_CIDR to $acct_policy"
        fi
      else
        log "SPCS CIDR already in account policy"
      fi
    fi

    info "Checking enforcement procedure for SPCS CIDR..."
    local proc_body
    proc_body=$(snow_sql "SELECT GET_DDL('PROCEDURE', 'SECURITY_NETWORK_DB.POLICIES.SET_ACCOUNT_LEVEL_NETWORK_POLICY()');" --format json 2>/dev/null | jq -r '.[0] | to_entries[0].value // empty' 2>/dev/null || echo "")

    if [[ -n "$proc_body" && ! "$proc_body" == *"153.45.59"* ]]; then
      info "Updating enforcement procedure to include SPCS CIDR..."
      local new_proc
      new_proc=$(echo "$proc_body" | sed "s/desiredIpList = \[/desiredIpList = ['$SPCS_CIDR', /")
      snow_sql "$new_proc" 2>/dev/null || warn "Could not update enforcement procedure -- you may need to do this manually"
    else
      log "Enforcement procedure already has SPCS CIDR (or could not read)"
    fi

    info "Creating user-level network policy (immune to account resets)..."

    local vpn_ips
    vpn_ips=""
    if [[ -n "$acct_policy" ]]; then
      vpn_ips=$(snow_sql "SELECT LISTAGG(VALUE::STRING, ',') AS IPS FROM TABLE(FLATTEN(INPUT => PARSE_JSON((SELECT ALLOWED_IP_LIST FROM SNOWFLAKE.INFORMATION_SCHEMA.NETWORK_POLICIES WHERE NAME = '$acct_policy'))));" --format json 2>/dev/null | jq -r '.[0].IPS // empty' 2>/dev/null || echo "")
    fi

    if [[ -n "$vpn_ips" ]]; then
      local user_policy_name="SPCS_USER_POLICY_${SNOWFLAKE_USER^^}"

      local has_user_spcs
      has_user_spcs=$(echo "$vpn_ips" | grep -c "153.45.59" || echo "0")
      if [[ "$has_user_spcs" == "0" ]]; then
        vpn_ips="$vpn_ips,'$SPCS_CIDR'"
      fi

      snow_sql "CREATE OR REPLACE NETWORK POLICY $user_policy_name ALLOWED_IP_LIST = ($vpn_ips);" 2>/dev/null || warn "Could not create user policy"
      snow_sql "ALTER USER $SNOWFLAKE_USER SET NETWORK_POLICY = $user_policy_name;" 2>/dev/null || warn "Could not assign user policy"
      log "User-level policy created: $user_policy_name"
    else
      warn "Could not read VPN IPs -- skipping user-level policy"
      warn "Run fix_network_policy.sh later if SPCS stops working"
    fi
  else
    info "No enforcement task found -- checking account policy for SPCS CIDR"
    local acct_policy
    acct_policy=$(snow_sql "SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN ACCOUNT;" --format json 2>/dev/null | jq -r '.[0].value // empty' 2>/dev/null || echo "")

    if [[ -n "$acct_policy" ]]; then
      local has_spcs
      has_spcs=$(snow_sql "DESCRIBE NETWORK POLICY $acct_policy;" --format json 2>/dev/null | jq -r '.[] | select(.name=="ALLOWED_IP_LIST") | .value' 2>/dev/null | grep -c "153.45.59" || echo "0")

      if [[ "$has_spcs" == "0" ]]; then
        warn "Account policy '$acct_policy' may not include SPCS CIDR"
        warn "If service is unreachable, add $SPCS_CIDR to the allowed IP list"
      else
        log "SPCS CIDR found in account policy"
      fi
    else
      log "No account-level network policy -- SPCS should work"
    fi
  fi

  log "Network policy check complete"
}

build_and_push() {
  info "Step 8: Building and pushing Docker image..."

  snow spcs image-registry login -c "$CONNECTION_NAME"

  local tag="v2-$(date +%s)"
  info "Building image with tag: $tag (no-cache for fresh build)..."

  docker buildx build --platform linux/amd64 --no-cache -t "truck-config:$tag" "$SCRIPT_DIR"

  docker tag "truck-config:$tag" "$REPO_URL/truck-config:$tag"
  docker tag "truck-config:$tag" "$REPO_URL/truck-config:latest"

  info "Pushing to Snowflake registry..."
  docker push "$REPO_URL/truck-config:$tag"
  docker push "$REPO_URL/truck-config:latest"

  IMAGE_TAG="$tag"
  log "Image pushed: $REPO_URL/truck-config:$tag"
}

deploy_service() {
  info "Step 9: Deploying SPCS service..."

  local image="$REPO_URL/truck-config:$IMAGE_TAG"

  snow_sql "CREATE SERVICE IF NOT EXISTS $DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC
    IN COMPUTE POOL $COMPUTE_POOL
    FROM SPECIFICATION \$\$
spec:
  containers:
    - name: truck-configurator
      image: $image
      env:
        SNOWFLAKE_ACCOUNT: $SNOWFLAKE_ACCOUNT
        SNOWFLAKE_ACCOUNT_LOCATOR: $SNOWFLAKE_ACCOUNT_LOCATOR
        SNOWFLAKE_HOST: $SNOWFLAKE_HOST
        SNOWFLAKE_USER: $SNOWFLAKE_USER
        SNOWFLAKE_WAREHOUSE: $SNOWFLAKE_WAREHOUSE
        SNOWFLAKE_DATABASE: $DATABASE
        SNOWFLAKE_SCHEMA: $SCHEMA
        SNOWFLAKE_SEMANTIC_VIEW: $DATABASE.$SCHEMA.TRUCK_CONFIG_ANALYST_V2
      secrets:
        - snowflakeSecret:
            objectName: $DATABASE.$SCHEMA.SNOWFLAKE_PRIVATE_KEY_SECRET
          secretKeyRef: secret_string
          envVarName: SNOWFLAKE_PRIVATE_KEY
      resources:
        requests:
          cpu: 0.5
          memory: 1Gi
        limits:
          cpu: 2
          memory: 4Gi
  endpoints:
    - name: web
      port: 8080
      public: true
  networkPolicyConfig:
    allowInternetEgress: true
\$\$
EXTERNAL_ACCESS_INTEGRATIONS = (TRUCK_CONFIG_EXTERNAL_ACCESS)
MIN_INSTANCES = 1
MAX_INSTANCES = 1;"

  log "Service created -- waiting for startup..."
  sleep 30

  local status
  status=$(snow_sql "SELECT SYSTEM\$GET_SERVICE_STATUS('$DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC');" --format json 2>/dev/null | jq -r '.[0] | to_entries[0].value // "UNKNOWN"' 2>/dev/null || echo "UNKNOWN")

  if [[ "$status" == *"RUNNING"* ]]; then
    log "Service is RUNNING"
  else
    info "Service status: $status (may still be starting)"
    info "Check: snow sql -q \"SELECT SYSTEM\\\$GET_SERVICE_STATUS('$DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC');\" -c $CONNECTION_NAME"
  fi
}

show_results() {
  echo ""
  echo "=================================================="
  echo -e "  ${GREEN}Setup Complete!${NC}"
  echo "=================================================="
  echo ""

  snow_sql "SHOW ENDPOINTS IN SERVICE $DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC;" 2>/dev/null || true

  echo ""
  echo "Useful commands:"
  echo "  # Check status"
  echo "  snow sql -q \"SELECT SYSTEM\\\$GET_SERVICE_STATUS('$DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC');\" -c $CONNECTION_NAME"
  echo ""
  echo "  # View logs"
  echo "  snow sql -q \"CALL SYSTEM\\\$GET_SERVICE_LOGS('$DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC', 0, 'truck-configurator', 100);\" -c $CONNECTION_NAME"
  echo ""
  echo "  # Get URL"
  echo "  snow sql -q \"SHOW ENDPOINTS IN SERVICE $DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC;\" -c $CONNECTION_NAME"
  echo ""
  echo "  # Fix network policy (if 12h task resets it)"
  echo "  ./fix_network_policy.sh -c $CONNECTION_NAME"
  echo ""
  echo "  # Teardown"
  echo "  ./teardown.sh -c $CONNECTION_NAME -d $DATABASE"
  echo ""
}

main() {
  check_prereqs
  test_connection
  gather_config
  setup_authentication
  create_infrastructure
  create_private_key_secret
  create_external_access
  load_data
  create_semantic_view
  ensure_network_policy

  echo ""
  read -p "Build and push Docker image? (y/n): " BUILD_DOCKER
  if [[ "$BUILD_DOCKER" == "y" || "$BUILD_DOCKER" == "Y" ]]; then
    build_and_push
    deploy_service
    show_results
  else
    echo ""
    echo "To complete setup manually:"
    echo "1. docker buildx build --platform linux/amd64 --no-cache -t truck-config:v2 ."
    echo "2. docker tag truck-config:v2 $REPO_URL/truck-config:v2"
    echo "3. docker push $REPO_URL/truck-config:v2"
    echo "4. Update and run scripts/05_service.sql"
  fi
}

main
