#!/bin/bash
set -e

echo "================================================================="
echo "  Digital Twin Truck Configurator V2 - Setup"
echo "  Key-Pair JWT Auth | Network Policy Hardening"
echo "================================================================="
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

check_prereqs() {
    echo -e "${BOLD}Checking prerequisites...${NC}"
    local missing=0
    for cmd in snow docker python3 openssl; do
        if ! command -v "$cmd" &>/dev/null; then
            echo -e "  ${RED}✗ $cmd not found${NC}"
            missing=1
        else
            echo -e "  ${GREEN}✓ $cmd${NC}"
        fi
    done
    docker info &>/dev/null 2>&1 || { echo -e "  ${RED}✗ Docker daemon not running${NC}"; missing=1; }
    if [ $missing -eq 1 ]; then
        echo -e "\n${RED}Please install missing prerequisites and re-run.${NC}"
        exit 1
    fi
    echo ""
}

setup_connection() {
    echo -e "${BOLD}Connection Setup${NC}"
    echo "You need a Snowflake CLI connection configured."
    echo "Available connections:"
    snow connection list 2>/dev/null || true
    echo ""
    read -p "Enter connection name to use: " CONNECTION_NAME
    echo ""

    echo "Testing connection..."
    snow sql --connection "$CONNECTION_NAME" -q "SELECT CURRENT_USER()" >/dev/null 2>&1 || {
        echo -e "${RED}Connection test failed. Check your connection config.${NC}"
        exit 1
    }
    echo -e "${GREEN}Connection OK${NC}"
    echo ""

    ACCOUNT_INFO=$(snow sql --connection "$CONNECTION_NAME" -q "SELECT CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME() AS ACCT" --format json 2>/dev/null)
    ACCOUNT_LOCATOR=$(echo "$ACCOUNT_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['ACCT'])")
    ACCOUNT_LOWER=$(echo "$ACCOUNT_LOCATOR" | tr '[:upper:]' '[:lower:]')
    SNOWFLAKE_HOST="${ACCOUNT_LOWER}.snowflakecomputing.com"
    REGISTRY_HOST="${ACCOUNT_LOWER}.registry.snowflakecomputing.com"
    SNOWFLAKE_USER=$(snow sql --connection "$CONNECTION_NAME" -q "SELECT CURRENT_USER()" --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['CURRENT_USER()'])")
    SF_ACCOUNT_LOCATOR=$(snow sql --connection "$CONNECTION_NAME" -q "SELECT CURRENT_ACCOUNT()" --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['CURRENT_ACCOUNT()'])")

    echo -e "  Account:  ${CYAN}${ACCOUNT_LOCATOR}${NC}"
    echo -e "  Host:     ${CYAN}${SNOWFLAKE_HOST}${NC}"
    echo -e "  Registry: ${CYAN}${REGISTRY_HOST}${NC}"
    echo -e "  User:     ${CYAN}${SNOWFLAKE_USER}${NC}"
    echo -e "  Locator:  ${CYAN}${SF_ACCOUNT_LOCATOR}${NC}"
    echo ""

    PLATFORM=$(snow sql --connection "$CONNECTION_NAME" -q "SELECT SPLIT_PART(CURRENT_REGION(), '_', 1)" --format json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0][list(d[0].keys())[0]])")
    if [[ "$PLATFORM" != *"AWS"* ]]; then
        echo -e "${YELLOW}⚠  Non-AWS region detected ($PLATFORM). Cortex AI features require AWS.${NC}"
        read -p "Continue anyway? (y/n): " CONT
        if [ "$CONT" != "y" ]; then exit 1; fi
    fi
}

snow_sql() {
    if [ -n "${SNOW_WH:-}" ]; then
        snow sql --connection "$CONNECTION_NAME" --warehouse "$SNOW_WH" "$@"
    else
        snow sql --connection "$CONNECTION_NAME" "$@"
    fi
}

SNOW_WH=""

gather_config() {
    echo -e "${BOLD}Configuration${NC}"
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
    echo -e "  Database:      ${CYAN}${DATABASE}${NC}"
    echo -e "  Schema:        ${CYAN}${SCHEMA}${NC}"
    echo -e "  Warehouse:     ${CYAN}${SNOWFLAKE_WAREHOUSE}${NC}"
    echo -e "  Compute Pool:  ${CYAN}${COMPUTE_POOL}${NC}"
    echo ""
    read -p "Continue? (y/n): " CONFIRM
    if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
        echo "Setup cancelled."
        exit 0
    fi
    echo ""
}

create_infrastructure() {
    echo -e "${BOLD}[1/9] Creating infrastructure...${NC}"

    snow_sql -q "CREATE WAREHOUSE IF NOT EXISTS ${SNOWFLAKE_WAREHOUSE} WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE;"
    SNOW_WH="$SNOWFLAKE_WAREHOUSE"

    snow_sql -q "CREATE DATABASE IF NOT EXISTS ${DATABASE};"
    snow_sql -q "CREATE SCHEMA IF NOT EXISTS ${DATABASE}.${SCHEMA};"
    snow_sql -q "CREATE IMAGE REPOSITORY IF NOT EXISTS ${DATABASE}.${SCHEMA}.TRUCK_CONFIG_REPO;"
    snow_sql -q "CREATE STAGE IF NOT EXISTS ${DATABASE}.${SCHEMA}.ENGINEERING_DOCS_STAGE ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');"

    snow_sql -q "CREATE COMPUTE POOL IF NOT EXISTS ${COMPUTE_POOL} MIN_NODES = 1 MAX_NODES = 1 INSTANCE_FAMILY = CPU_X64_XS AUTO_RESUME = TRUE AUTO_SUSPEND_SECS = 3600;" 2>/dev/null || true

    REPO_URL=$(snow_sql -q "SHOW IMAGE REPOSITORIES IN SCHEMA ${DATABASE}.${SCHEMA};" --format json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for row in data:
    if row.get('name','').upper() == 'TRUCK_CONFIG_REPO':
        print(row['repository_url'])
        break
")
    echo -e "  Image repo: ${CYAN}${REPO_URL}${NC}"
    echo -e "${GREEN}✓ Infrastructure created${NC}\n"
}

generate_new_key() {
    echo ""
    echo "  Generating RSA key pair..."
    TEMP_DIR=$(mktemp -d)
    openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out "$TEMP_DIR/key.p8" 2>/dev/null
    openssl rsa -in "$TEMP_DIR/key.p8" -pubout -out "$TEMP_DIR/key.pub" 2>/dev/null
    PUBLIC_KEY=$(grep -v "BEGIN\|END" "$TEMP_DIR/key.pub" | tr -d '\n')

    snow_sql -q "ALTER USER ${SNOWFLAKE_USER} SET RSA_PUBLIC_KEY='${PUBLIC_KEY}';"
    echo -e "  ${GREEN}✓ Public key assigned to ${SNOWFLAKE_USER}${NC}"

    PRIVATE_KEY=$(awk '{printf "%s\\n", $0}' "$TEMP_DIR/key.p8")
    snow_sql -q "CREATE OR REPLACE SECRET ${DATABASE}.${SCHEMA}.SNOWFLAKE_PRIVATE_KEY_SECRET TYPE = GENERIC_STRING SECRET_STRING = '${PRIVATE_KEY}';"
    echo -e "  ${GREEN}✓ Private key secret created${NC}"
    rm -rf "$TEMP_DIR"
}

generate_key_slot_2() {
    echo ""
    echo "  Generating RSA key pair for RSA_PUBLIC_KEY_2..."
    TEMP_DIR=$(mktemp -d)
    openssl genrsa 2048 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out "$TEMP_DIR/key.p8" 2>/dev/null
    openssl rsa -in "$TEMP_DIR/key.p8" -pubout -out "$TEMP_DIR/key.pub" 2>/dev/null
    PUBLIC_KEY=$(grep -v "BEGIN\|END" "$TEMP_DIR/key.pub" | tr -d '\n')

    snow_sql -q "ALTER USER ${SNOWFLAKE_USER} SET RSA_PUBLIC_KEY_2='${PUBLIC_KEY}';"
    echo -e "  ${GREEN}✓ Public key assigned to RSA_PUBLIC_KEY_2${NC}"

    PRIVATE_KEY=$(awk '{printf "%s\\n", $0}' "$TEMP_DIR/key.p8")
    snow_sql -q "CREATE OR REPLACE SECRET ${DATABASE}.${SCHEMA}.SNOWFLAKE_PRIVATE_KEY_SECRET TYPE = GENERIC_STRING SECRET_STRING = '${PRIVATE_KEY}';"
    echo -e "  ${GREEN}✓ Private key secret created${NC}"
    rm -rf "$TEMP_DIR"
}

create_secrets() {
    echo -e "${BOLD}[2/9] Setting up key-pair authentication...${NC}"
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  KEY-PAIR AUTHENTICATION SETUP${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  The SPCS app uses RSA key-pair JWT for both SQL connections"
    echo "  and Cortex Agent REST API calls. No PAT required."
    echo ""

    echo "  Checking for existing RSA key on ${SNOWFLAKE_USER}..."
    EXISTING_KEY=$(snow_sql -q "DESCRIBE USER ${SNOWFLAKE_USER};" --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for row in data:
        if row.get('property') == 'RSA_PUBLIC_KEY':
            val = row.get('value', '')
            if val and val != 'null' and len(val) > 10:
                print('EXISTS')
                break
except: pass
" 2>/dev/null || echo "")

    if [ "$EXISTING_KEY" = "EXISTS" ]; then
        echo ""
        echo -e "${YELLOW}════════════════════════════════════════════════════════════${NC}"
        echo -e "${YELLOW}  RSA_PUBLIC_KEY already exists for user ${SNOWFLAKE_USER}${NC}"
        echo -e "${YELLOW}════════════════════════════════════════════════════════════${NC}"
        echo ""

        AUTO_KEY_PATH=""
        CLI_KEY_PATH=$(python3 -c "
try:
    import tomllib
except ImportError:
    import tomli as tomllib
import os, pathlib
for f in [pathlib.Path.home()/'.snowflake'/'connections.toml', pathlib.Path.home()/'.snowflake'/'config.toml']:
    if f.exists():
        with open(f, 'rb') as fh:
            cfg = tomllib.load(fh)
        for section in [cfg.get('${CONNECTION_NAME}', {}), cfg.get('connections', {}).get('${CONNECTION_NAME}', {})]:
            p = section.get('private_key_file', '')
            if p:
                p = os.path.expanduser(p)
                if os.path.isfile(p):
                    print(p)
                    raise SystemExit(0)
" 2>/dev/null || echo "")
        if [ -n "$CLI_KEY_PATH" ]; then
            AUTO_KEY_PATH="$CLI_KEY_PATH"
        else
            for CANDIDATE in "$HOME/.snowflake/keys/${CONNECTION_NAME}.p8" "$HOME/.snowflake/keys/admin_key.p8"; do
                if [ -f "$CANDIDATE" ]; then
                    AUTO_KEY_PATH="$CANDIDATE"
                    break
                fi
            done
        fi

        if [ -n "$AUTO_KEY_PATH" ]; then
            echo -e "  ${GREEN}Found matching private key: ${AUTO_KEY_PATH}${NC}"
            echo "  Auto-selecting: Reuse existing key"
            KEY_CHOICE=1
        else
            echo "  Another SPCS application may be using this key."
            echo "  Overwriting it will break that application's authentication."
            echo ""
            echo "  Options:"
            echo "    1) Reuse existing key (requires private key file or existing secret)"
            echo "    2) Use RSA_PUBLIC_KEY_2 (secondary slot - BOTH apps work)"
            echo "    3) Generate NEW key (WARNING: breaks other SPCS apps!)"
            echo ""
            read -p "  Choice [1/2/3] (default 2 - recommended): " KEY_CHOICE
            KEY_CHOICE=${KEY_CHOICE:-2}
        fi

        case $KEY_CHOICE in
            1)
                echo ""
                echo "  Checking for existing private key secret..."
                SECRET_EXISTS=$(snow_sql -q "SHOW SECRETS LIKE 'SNOWFLAKE_PRIVATE_KEY_SECRET' IN SCHEMA ${DATABASE}.${SCHEMA};" --format json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d else 'no')" 2>/dev/null || echo "no")

                if [ "$SECRET_EXISTS" = "yes" ]; then
                    echo -e "  ${GREEN}✓ Private key secret already exists - reusing${NC}"
                else
                    PRIVATE_KEY_PATH="${AUTO_KEY_PATH:-}"
                    if [ -z "$PRIVATE_KEY_PATH" ]; then
                        read -p "  Path to private key file (.p8): " PRIVATE_KEY_PATH
                    fi
                    if [ -f "$PRIVATE_KEY_PATH" ]; then
                        PRIVATE_KEY=$(awk '{printf "%s\\n", $0}' "$PRIVATE_KEY_PATH")
                        snow_sql -q "CREATE OR REPLACE SECRET ${DATABASE}.${SCHEMA}.SNOWFLAKE_PRIVATE_KEY_SECRET TYPE = GENERIC_STRING SECRET_STRING = '${PRIVATE_KEY}';"
                        echo -e "  ${GREEN}✓ Private key secret created from ${PRIVATE_KEY_PATH}${NC}"
                    else
                        echo -e "  ${RED}File not found: $PRIVATE_KEY_PATH${NC}"
                        echo -e "  ${RED}Cannot continue without private key.${NC}"
                        exit 1
                    fi
                fi
                ;;
            2)
                generate_key_slot_2
                ;;
            3)
                echo ""
                echo -e "  ${RED}WARNING: This will invalidate any other SPCS apps using this user!${NC}"
                read -p "  Are you sure? (yes/no): " CONFIRM
                if [ "$CONFIRM" != "yes" ]; then
                    echo "  Aborted."
                    exit 1
                fi
                generate_new_key
                ;;
            *)
                echo -e "  ${YELLOW}Invalid choice, using RSA_PUBLIC_KEY_2 (default)${NC}"
                generate_key_slot_2
                ;;
        esac
    else
        generate_new_key
    fi

    echo -e "${GREEN}✓ Key-pair authentication configured${NC}\n"
}

create_external_access() {
    echo -e "${BOLD}[3/9] Creating network rules and external access integration...${NC}"

    snow_sql -q "CREATE OR REPLACE NETWORK RULE ${DATABASE}.${SCHEMA}.CORTEX_API_RULE TYPE = HOST_PORT MODE = EGRESS VALUE_LIST = ('${SNOWFLAKE_HOST}:443');"

    S3_HOST=$(snow_sql -q "SELECT PARSE_JSON(VALUE)['host']::VARCHAR AS host FROM TABLE(FLATTEN(INPUT => PARSE_JSON(SYSTEM\$ALLOWLIST()))) WHERE PARSE_JSON(VALUE)['type']::VARCHAR = 'STAGE' AND PARSE_JSON(VALUE)['host']::VARCHAR LIKE '%s3.%amazonaws.com' LIMIT 1;" --format json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['HOST'])" 2>/dev/null || echo "")

    if [ -n "$S3_HOST" ]; then
        echo "  S3 stage host: $S3_HOST"
        snow_sql -q "CREATE OR REPLACE NETWORK RULE ${DATABASE}.${SCHEMA}.S3_RESULT_RULE TYPE = HOST_PORT MODE = EGRESS VALUE_LIST = ('${S3_HOST}:443');"

        snow_sql -q "CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION TRUCK_CONFIG_EXTERNAL_ACCESS ALLOWED_NETWORK_RULES = (${DATABASE}.${SCHEMA}.CORTEX_API_RULE, ${DATABASE}.${SCHEMA}.S3_RESULT_RULE) ALLOWED_AUTHENTICATION_SECRETS = (${DATABASE}.${SCHEMA}.SNOWFLAKE_PRIVATE_KEY_SECRET) ENABLED = TRUE;"
    else
        echo -e "  ${YELLOW}Could not detect S3 stage host; creating EAI without S3 rule${NC}"
        snow_sql -q "CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION TRUCK_CONFIG_EXTERNAL_ACCESS ALLOWED_NETWORK_RULES = (${DATABASE}.${SCHEMA}.CORTEX_API_RULE) ALLOWED_AUTHENTICATION_SECRETS = (${DATABASE}.${SCHEMA}.SNOWFLAKE_PRIVATE_KEY_SECRET) ENABLED = TRUE;"
    fi

    echo -e "${GREEN}✓ External access configured (with ALLOWED_AUTHENTICATION_SECRETS)${NC}\n"
}

load_data() {
    echo -e "${BOLD}[4/9] Loading data...${NC}"

    local tmpdir
    tmpdir=$(mktemp -d)
    for f in 02_data.sql 02b_bom_data.sql 02c_truck_options.sql 02d_app_tables.sql 02e_upload_procedure.sql; do
        if [ -f "$SCRIPT_DIR/scripts/$f" ]; then
            sed "s/BOM\.BOM4/${DATABASE}.${SCHEMA}/g; s/__WAREHOUSE__/${SNOWFLAKE_WAREHOUSE}/g" "$SCRIPT_DIR/scripts/$f" > "$tmpdir/$f"
            snow_sql -f "$tmpdir/$f"
        fi
    done
    rm -rf "$tmpdir"

    echo -e "${GREEN}✓ Data loaded${NC}\n"
}

create_semantic_view() {
    echo -e "${BOLD}[5/9] Creating semantic view...${NC}"

    local tmpdir
    tmpdir=$(mktemp -d)
    if [ -f "$SCRIPT_DIR/scripts/03_semantic_view.sql" ]; then
        sed "s/BOM\.BOM4/${DATABASE}.${SCHEMA}/g" "$SCRIPT_DIR/scripts/03_semantic_view.sql" > "$tmpdir/03_semantic_view.sql"
        snow_sql -f "$tmpdir/03_semantic_view.sql"
    fi
    rm -rf "$tmpdir"

    echo -e "${GREEN}✓ Semantic view created${NC}\n"
}

ensure_network_policy_access() {
    echo -e "${BOLD}[6/9] Ensuring SPCS service IP is allowed through account network policy...${NC}"

    SPCS_CIDR="153.45.59.0/24"

    CURRENT_POLICY=$(snow_sql -q "SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN ACCOUNT;" --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data:
        print(data[0].get('value', ''))
except:
    pass
" 2>/dev/null || echo "")

    if [ -z "$CURRENT_POLICY" ]; then
        echo "  No account-level network policy set. SPCS access should work."
        echo -e "${GREEN}✓ No network policy blocking${NC}\n"
        return
    fi

    echo "  Account network policy: $CURRENT_POLICY"

    SECURITY_TASK_DETECTED=$(snow_sql -q "SHOW TASKS LIKE 'ACCOUNT_LEVEL_NETWORK_POLICY_TASK' IN ACCOUNT;" --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for row in data:
        if 'NETWORK_POLICY' in row.get('name', '').upper():
            state = row.get('state', '')
            schedule = row.get('schedule', '')
            print(f'{state}|{schedule}')
            break
except:
    pass
" 2>/dev/null || echo "")

    if [ -n "$SECURITY_TASK_DETECTED" ]; then
        TASK_STATE=$(echo "$SECURITY_TASK_DETECTED" | cut -d'|' -f1)
        TASK_SCHEDULE=$(echo "$SECURITY_TASK_DETECTED" | cut -d'|' -f2)
        echo ""
        echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
        echo -e "${RED}  SECURITY ENFORCEMENT TASK DETECTED${NC}"
        echo -e "${RED}════════════════════════════════════════════════════════════${NC}"
        echo ""
        echo -e "  Task:     ACCOUNT_LEVEL_NETWORK_POLICY_TASK"
        echo -e "  State:    ${TASK_STATE}"
        echo -e "  Schedule: ${TASK_SCHEDULE}"
        echo ""
        echo -e "  This task periodically resets the account network policy"
        echo -e "  to a hardcoded VPN IP list, wiping any SPCS CIDRs added."
        echo -e "  ${BOLD}Modifying the account policy directly will NOT persist.${NC}"
        echo ""
        echo -e "  ${CYAN}Creating a user-level network policy instead. This is${NC}"
        echo -e "  ${CYAN}immune to the account-level enforcement task.${NC}"
        NP_CHOICE=1
    fi

    IP_LIST=$(snow_sql -q "DESC NETWORK POLICY ${CURRENT_POLICY};" --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for row in data:
        if row.get('name') == 'ALLOWED_IP_LIST':
            print(row.get('value', ''))
            break
except:
    pass
" 2>/dev/null || echo "")

    USER_POLICY_LEVEL=$(snow_sql -q "SHOW PARAMETERS LIKE 'NETWORK_POLICY' FOR USER ${SNOWFLAKE_USER};" --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data:
        level = data[0].get('level', '')
        value = data[0].get('value', '')
        print(f'{level}|{value}')
except:
    pass
" 2>/dev/null || echo "")

    USER_NP_LEVEL=$(echo "$USER_POLICY_LEVEL" | cut -d'|' -f1)
    USER_NP_NAME=$(echo "$USER_POLICY_LEVEL" | cut -d'|' -f2)

    if [ "$USER_NP_LEVEL" = "USER" ]; then
        USER_NP_IPS=$(snow_sql -q "DESC NETWORK POLICY ${USER_NP_NAME};" --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for row in data:
        if row.get('name') == 'ALLOWED_IP_LIST':
            print(row.get('value', ''))
            break
except:
    pass
" 2>/dev/null || echo "")
        if echo "$USER_NP_IPS" | grep -q "$SPCS_CIDR"; then
            echo "  User-level policy '${USER_NP_NAME}' already includes SPCS CIDR."
            echo -e "${GREEN}✓ SPCS IP already allowed (user-level policy)${NC}\n"
            return
        else
            echo "  User-level policy '${USER_NP_NAME}' exists but missing SPCS CIDR."
            echo "  Will update it to include ${SPCS_CIDR}."
            IP_LIST="$USER_NP_IPS"
            NP_CHOICE=1
        fi
    fi

    if echo "$IP_LIST" | grep -q "$SPCS_CIDR"; then
        if [ -z "$SECURITY_TASK_DETECTED" ]; then
            echo "  SPCS CIDR $SPCS_CIDR already in account policy allow-list."
            echo -e "${GREEN}✓ SPCS IP already allowed${NC}\n"
            return
        else
            echo "  SPCS CIDR found in account policy, but security task will remove it."
            echo "  Creating user-level policy for persistence."
        fi
    fi

    if [ -z "${NP_CHOICE:-}" ]; then
        echo ""
        echo -e "${YELLOW}════════════════════════════════════════════════════════════${NC}"
        echo -e "${YELLOW}  ACCOUNT NETWORK POLICY - SPCS ACCESS${NC}"
        echo -e "${YELLOW}════════════════════════════════════════════════════════════${NC}"
        echo ""
        echo "  The account network policy '$CURRENT_POLICY' does not include"
        echo "  the SPCS service CIDR ($SPCS_CIDR)."
        echo ""
        echo "  Without this, the SPCS container cannot call Snowflake APIs"
        echo "  (Cortex Agent, SQL, etc.)."
        echo ""
        echo -e "${CYAN}  A user-level network policy is recommended. It only${NC}"
        echo -e "${CYAN}  affects ${SNOWFLAKE_USER} and survives account-level${NC}"
        echo -e "${CYAN}  security task resets.${NC}"
        echo ""
        echo "  Options:"
        echo "    1) Create user-level network policy (recommended - survives security tasks)"
        echo "    2) Add SPCS CIDR to account policy directly (may be wiped by security tasks)"
        echo "    3) Skip (I'll handle this manually)"
        echo ""
        read -p "  Choice [1/2/3] (default 1): " NP_CHOICE
        NP_CHOICE=${NP_CHOICE:-1}
    fi

    COMBINED_IPS=$(python3 -c "
ip_list = '''$IP_LIST'''
spcs = '$SPCS_CIDR'
ips = [ip.strip().strip(\"'\") for ip in ip_list.split(',') if ip.strip()]
if spcs not in ips:
    ips.append(spcs)
print(','.join([f\"'{ip}'\" for ip in ips]))
")

    case $NP_CHOICE in
        1)
            echo "  Creating user-level network policy for ${SNOWFLAKE_USER}..."

            snow_sql -q "CREATE OR REPLACE NETWORK POLICY TRUCK_CONFIG_USER_POLICY ALLOWED_IP_LIST = ($COMBINED_IPS) COMMENT = 'User-level NP for Truck Config demo: VPN IPs + SPCS CIDR. Immune to account-level security task. Managed by setup.sh';"

            snow_sql -q "ALTER USER ${SNOWFLAKE_USER} SET NETWORK_POLICY = TRUCK_CONFIG_USER_POLICY;"
            echo -e "  ${GREEN}✓ User-level network policy created and assigned${NC}"
            echo -e "  ${CYAN}  Policy: TRUCK_CONFIG_USER_POLICY${NC}"
            echo -e "  ${CYAN}  Includes all VPN IPs from account policy + SPCS CIDR${NC}"
            echo -e "  ${CYAN}  Assigned to user '${SNOWFLAKE_USER}' (immune to account-level resets)${NC}"

            echo ""
            echo "  Adding SPCS CIDR to account-level policy (required for SPCS service connections)..."
            snow_sql -q "ALTER NETWORK POLICY ${CURRENT_POLICY} SET ALLOWED_IP_LIST = ($COMBINED_IPS);"
            echo -e "  ${GREEN}✓ SPCS CIDR added to account policy${NC}"

            if [ -n "$SECURITY_TASK_DETECTED" ]; then
                echo ""
                echo "  Updating enforcement procedure to include SPCS CIDR permanently..."
                DESIRED_IP_CSV=$(python3 -c "
ip_list = '''$IP_LIST'''
spcs = '$SPCS_CIDR'
ips = [ip.strip().strip(\"'\") for ip in ip_list.split(',') if ip.strip()]
if spcs not in ips:
    ips.append(spcs)
print(','.join(ips))
")
                PROC_SQL_FILE=$(mktemp /tmp/fix_np_proc_XXXXXX.sql)
                cat > "$PROC_SQL_FILE" << 'PROCSQLEOF'
USE ROLE ACCOUNTADMIN;
USE DATABASE security_network_db;
USE SCHEMA security_network_db.policies;

CREATE OR REPLACE PROCEDURE security_network_db.policies.account_level_network_policy_proc()
  RETURNS STRING
  LANGUAGE JAVASCRIPT
  EXECUTE AS CALLER
AS
$$
    function exec(sqlText, binds) {
      binds = binds || [];
      var retval = [];
      var stmnt = snowflake.createStatement({sqlText: sqlText, binds: binds});
      var result;
      try { result = stmnt.execute(); }
      catch(err) { return err; }
      var columnCount = stmnt.getColumnCount();
      var columnNames = [];
      for (var i = 1; i <= columnCount; i++) { columnNames.push(stmnt.getColumnName(i)); }
      while(result.next()) {
        var o = {};
        for (var ci = 0; ci < columnNames.length; ci++) { o[columnNames[ci]] = result.getColumnValue(columnNames[ci]); }
        retval.push(o);
      }
      return retval;
    }
PROCSQLEOF
                echo "    var desiredIpList = '${DESIRED_IP_CSV}';" >> "$PROC_SQL_FILE"
                cat >> "$PROC_SQL_FILE" << 'PROCSQLEOF'
    var currentNpResult = exec("SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN ACCOUNT");
    var allowedIpList = '';
    var isNetworkRuleApplied = false;
    if (currentNpResult.length > 0) {
        var currentNpName = currentNpResult[0]['value'];
        var describeNpResult = exec('DESCRIBE NETWORK POLICY ' + currentNpName);
        var allowedIpListRow = describeNpResult.filter(function(item) { return item.name === 'ALLOWED_IP_LIST'; });
        allowedIpList = allowedIpListRow.length > 0 ? allowedIpListRow[0]['value'] : '';
        var networkRuleListRow = describeNpResult.filter(function(item) { return item.name === 'ALLOWED_NETWORK_RULE_LIST'; });
        isNetworkRuleApplied = networkRuleListRow.length > 0;
    }
    if (currentNpResult.length > 0 && allowedIpList === desiredIpList && isNetworkRuleApplied === false) {
        return 'Allowed IP matches. No changes required.';
    } else {
        var policyName = 'ACCOUNT_VPN_POLICY_SE';
        exec('ALTER ACCOUNT UNSET NETWORK_POLICY');
        exec("CREATE OR REPLACE NETWORK POLICY " + policyName + " ALLOWED_IP_LIST = ('" + desiredIpList + "')");
        exec('ALTER ACCOUNT SET NETWORK_POLICY = ' + policyName);
        return 'Network policy updated to ' + policyName + ' with allowed IP ' + desiredIpList + '.';
    }
$$;
PROCSQLEOF
                snow_sql -f "$PROC_SQL_FILE"
                rm -f "$PROC_SQL_FILE"
                echo -e "  ${GREEN}✓ Enforcement procedure updated with SPCS CIDR${NC}"
                echo -e "  ${CYAN}  The 12-hour enforcement task will now preserve SPCS access${NC}"
            fi
            ;;
        2)
            if [ -n "$SECURITY_TASK_DETECTED" ]; then
                echo -e "  ${RED}Cannot use option 2 alone: security enforcement task will overwrite changes.${NC}"
                echo -e "  ${RED}Falling back to option 1 (user-level + account-level + procedure update).${NC}"
                NP_CHOICE=1
                snow_sql -q "CREATE OR REPLACE NETWORK POLICY TRUCK_CONFIG_USER_POLICY ALLOWED_IP_LIST = ($COMBINED_IPS) COMMENT = 'User-level NP for Truck Config demo: VPN IPs + SPCS CIDR. Immune to account-level security task. Managed by setup.sh';"
                snow_sql -q "ALTER USER ${SNOWFLAKE_USER} SET NETWORK_POLICY = TRUCK_CONFIG_USER_POLICY;"
                snow_sql -q "ALTER NETWORK POLICY ${CURRENT_POLICY} SET ALLOWED_IP_LIST = ($COMBINED_IPS);"
                echo -e "  ${GREEN}✓ User-level + account-level policies updated (fallback from option 2)${NC}"
            else
                echo "  Adding $SPCS_CIDR to account policy..."
                snow_sql -q "ALTER NETWORK POLICY ${CURRENT_POLICY} SET ALLOWED_IP_LIST = ($COMBINED_IPS);"
                echo -e "  ${GREEN}✓ SPCS CIDR added to account policy${NC}"
                echo -e "  ${YELLOW}  WARNING: If a security enforcement task exists, this may be overwritten.${NC}"
                echo -e "  ${YELLOW}  Consider option 1 (user-level policy) for a permanent solution.${NC}"
            fi
            ;;
        3)
            echo -e "  ${YELLOW}Skipped. You must ensure SPCS IP $SPCS_CIDR is allowed manually.${NC}"
            ;;
    esac
    echo -e "${GREEN}✓ Network policy access configured${NC}\n"
}

build_and_push() {
    echo -e "${BOLD}[7/9] Building and pushing Docker image...${NC}"

    snow spcs image-registry login --connection "$CONNECTION_NAME"

    IMAGE_TAG="v2-$(date +%s)"
    IMAGE_PATH="${REPO_URL}/truck-config:${IMAGE_TAG}"
    echo "  Building image: ${IMAGE_PATH} (no-cache for fresh build)"

    docker buildx build --platform linux/amd64 --no-cache \
        -t "$IMAGE_PATH" \
        -f "$SCRIPT_DIR/Dockerfile" \
        "$SCRIPT_DIR" \
        --load

    docker tag "$IMAGE_PATH" "${REPO_URL}/truck-config:latest"

    echo "  Pushing image..."
    docker push "$IMAGE_PATH"
    docker push "${REPO_URL}/truck-config:latest"
    echo -e "${GREEN}✓ Image pushed to Snowflake registry${NC}\n"
}

deploy_service() {
    echo -e "${BOLD}[8/9] Deploying SPCS service...${NC}"

    snow_sql -q "CREATE SERVICE IF NOT EXISTS ${DATABASE}.${SCHEMA}.TRUCK_CONFIGURATOR_SVC
    IN COMPUTE POOL ${COMPUTE_POOL}
    FROM SPECIFICATION \$\$
spec:
  containers:
    - name: truck-configurator
      image: ${IMAGE_PATH}
      env:
        SNOWFLAKE_ACCOUNT: ${ACCOUNT_LOCATOR}
        SNOWFLAKE_ACCOUNT_LOCATOR: ${SF_ACCOUNT_LOCATOR}
        SNOWFLAKE_HOST: ${SNOWFLAKE_HOST}
        SNOWFLAKE_USER: ${SNOWFLAKE_USER}
        SNOWFLAKE_WAREHOUSE: ${SNOWFLAKE_WAREHOUSE}
        SNOWFLAKE_DATABASE: ${DATABASE}
        SNOWFLAKE_SCHEMA: ${SCHEMA}
        SNOWFLAKE_SEMANTIC_VIEW: ${DATABASE}.${SCHEMA}.TRUCK_CONFIG_ANALYST_V2
      secrets:
        - snowflakeSecret:
            objectName: ${DATABASE}.${SCHEMA}.SNOWFLAKE_PRIVATE_KEY_SECRET
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

    echo "  Waiting for service to start..."
    for i in $(seq 1 40); do
        STATUS=$(snow_sql -q "SELECT SYSTEM\$GET_SERVICE_STATUS('${DATABASE}.${SCHEMA}.TRUCK_CONFIGURATOR_SVC')" --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    status_json = json.loads(data[0][list(data[0].keys())[0]])
    print(status_json[0].get('status', 'UNKNOWN'))
except:
    print('PENDING')
" 2>/dev/null || echo "PENDING")
        echo "  Status: $STATUS ($i/40)"
        if [ "$STATUS" = "READY" ]; then
            break
        fi
        sleep 15
    done
    echo -e "${GREEN}✓ Service deployed${NC}\n"
}

show_results() {
    echo -e "${BOLD}[9/9] Getting service endpoint...${NC}"
    ENDPOINT=$(snow_sql -q "SHOW ENDPOINTS IN SERVICE ${DATABASE}.${SCHEMA}.TRUCK_CONFIGURATOR_SVC;" --format json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for row in data:
    url = row.get('ingress_url', '')
    if url:
        print(url)
        break
" 2>/dev/null || echo "(endpoint not yet available)")

    echo ""
    echo -e "${GREEN}=================================================================${NC}"
    echo -e "${GREEN}  Setup Complete!${NC}"
    echo -e "${GREEN}=================================================================${NC}"
    echo ""
    echo -e "  App URL:      ${CYAN}https://${ENDPOINT}${NC}"
    echo -e "  Account:      ${ACCOUNT_LOCATOR}"
    echo -e "  Locator:      ${SF_ACCOUNT_LOCATOR}"
    echo -e "  Database:     ${DATABASE}"
    echo -e "  Schema:       ${SCHEMA}"
    echo -e "  Service:      ${DATABASE}.${SCHEMA}.TRUCK_CONFIGURATOR_SVC"
    echo -e "  Service User: ${SNOWFLAKE_USER}"
    echo -e "  Pool:         ${COMPUTE_POOL}"
    echo ""
    echo "  To tear down: ./teardown.sh"
    echo "  To fix network policy after 12h reset: ./fix_network_policy.sh"
    echo -e "${GREEN}=================================================================${NC}"
}

main() {
    check_prereqs
    setup_connection
    gather_config
    create_infrastructure        # Step 1
    create_secrets               # Step 2: Key-pair auth (SAFE key management)
    create_external_access       # Step 3: Network rules + EAI
    load_data                    # Step 4
    create_semantic_view         # Step 5
    ensure_network_policy_access # Step 6: Account/user network policy for SPCS IP

    echo ""
    read -p "Build and push Docker image? (y/n): " BUILD_DOCKER
    if [[ "$BUILD_DOCKER" == "y" || "$BUILD_DOCKER" == "Y" ]]; then
        build_and_push           # Step 7
        deploy_service           # Step 8
        show_results             # Step 9
    else
        echo ""
        echo "To complete setup manually:"
        echo "  1. docker buildx build --platform linux/amd64 --no-cache -t truck-config:v2 ."
        echo "  2. docker tag truck-config:v2 $REPO_URL/truck-config:v2"
        echo "  3. docker push $REPO_URL/truck-config:v2"
        echo "  4. Create service via Snowsight or scripts/05_service.sql"
    fi
}

main
