#!/bin/bash
# Fix Network Policy for SPCS after 12-hour enforcement task resets it
# Run this when SPCS services become unreachable
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

CONNECTION_NAME=""
USERNAME=""
SPCS_CIDR="153.45.59.0/24"

usage() {
  echo "Usage: $0 -c <connection_name> [-u <username>]"
  echo ""
  echo "  -c  Snowflake CLI connection name (required)"
  echo "  -u  Username to create user-level policy for (default: current user)"
  echo ""
  echo "This script applies a three-part fix:"
  echo "  1. Adds SPCS CIDR ($SPCS_CIDR) to account-level network policy"
  echo "  2. Updates enforcement procedure to include SPCS CIDR"
  echo "  3. Creates user-level policy (immune to account-level resets)"
  exit 0
}

while getopts "c:u:h" opt; do
  case $opt in
    c) CONNECTION_NAME="$OPTARG" ;;
    u) USERNAME="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [[ -z "$CONNECTION_NAME" ]]; then
  echo -e "${RED}Connection name required. Use -c <connection>${NC}"
  usage
fi

snow_sql() {
  snow sql -q "$1" -c "$CONNECTION_NAME" "${@:2}" 2>/dev/null || true
}

snow_sql_strict() {
  snow sql -q "$1" -c "$CONNECTION_NAME" "${@:2}"
}

echo "=================================================="
echo "  SPCS Network Policy Fix"
echo "=================================================="
echo ""

if [[ -z "$USERNAME" ]]; then
  USERNAME=$(snow_sql_strict "SELECT CURRENT_USER()" --format json 2>/dev/null | jq -r '.[0]."CURRENT_USER()"' || echo "")
  if [[ -z "$USERNAME" ]]; then
    echo -e "${RED}Could not detect username. Use -u <username>${NC}"
    exit 1
  fi
fi

echo -e "${CYAN}User: $USERNAME${NC}"
echo -e "${CYAN}SPCS CIDR: $SPCS_CIDR${NC}"
echo ""

echo -e "${YELLOW}Part 1: Account-level network policy${NC}"

ACCT_POLICY=$(snow_sql_strict "SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN ACCOUNT;" --format json 2>/dev/null | jq -r '.[0].value // empty' 2>/dev/null || echo "")

if [[ -n "$ACCT_POLICY" ]]; then
  echo "  Account policy: $ACCT_POLICY"

  CURRENT_IPS=$(snow_sql_strict "SELECT LISTAGG(VALUE::STRING, ',') AS IPS FROM TABLE(FLATTEN(INPUT => PARSE_JSON((SELECT ALLOWED_IP_LIST FROM SNOWFLAKE.INFORMATION_SCHEMA.NETWORK_POLICIES WHERE NAME = '$ACCT_POLICY'))));" --format json 2>/dev/null | jq -r '.[0].IPS // empty' || echo "")

  if echo "$CURRENT_IPS" | grep -q "153.45.59"; then
    echo -e "  ${GREEN}[OK]${NC} SPCS CIDR already present"
  else
    echo "  Adding SPCS CIDR..."
    snow_sql "ALTER NETWORK POLICY $ACCT_POLICY SET ALLOWED_IP_LIST = ($CURRENT_IPS, '$SPCS_CIDR');"
    echo -e "  ${GREEN}[OK]${NC} Added $SPCS_CIDR"
  fi
else
  echo -e "  ${GREEN}[OK]${NC} No account-level policy"
fi

echo ""
echo -e "${YELLOW}Part 2: Enforcement procedure${NC}"

PROC_BODY=$(snow_sql_strict "SELECT GET_DDL('PROCEDURE', 'SECURITY_NETWORK_DB.POLICIES.SET_ACCOUNT_LEVEL_NETWORK_POLICY()');" --format json 2>/dev/null | jq -r '.[0] | to_entries[0].value // empty' 2>/dev/null || echo "")

if [[ -n "$PROC_BODY" ]]; then
  if echo "$PROC_BODY" | grep -q "153.45.59"; then
    echo -e "  ${GREEN}[OK]${NC} Procedure already has SPCS CIDR"
  else
    echo "  Updating procedure..."
    NEW_PROC=$(echo "$PROC_BODY" | sed "s/desiredIpList = \[/desiredIpList = ['$SPCS_CIDR', /")
    snow_sql "$NEW_PROC" 2>/dev/null && echo -e "  ${GREEN}[OK]${NC} Procedure updated" || echo -e "  ${YELLOW}[WARN]${NC} Could not update -- may need manual edit"
  fi
else
  echo -e "  ${CYAN}[INFO]${NC} No enforcement procedure found (not an SE demo account?)"
fi

echo ""
echo -e "${YELLOW}Part 3: User-level network policy${NC}"

USER_POLICY_NAME="SPCS_USER_POLICY_${USERNAME^^}"

if [[ -n "$ACCT_POLICY" ]]; then
  VPN_IPS=$(snow_sql_strict "SELECT LISTAGG(VALUE::STRING, ',') AS IPS FROM TABLE(FLATTEN(INPUT => PARSE_JSON((SELECT ALLOWED_IP_LIST FROM SNOWFLAKE.INFORMATION_SCHEMA.NETWORK_POLICIES WHERE NAME = '$ACCT_POLICY'))));" --format json 2>/dev/null | jq -r '.[0].IPS // empty' || echo "")

  if [[ -n "$VPN_IPS" ]]; then
    HAS_SPCS=$(echo "$VPN_IPS" | grep -c "153.45.59" || echo "0")
    if [[ "$HAS_SPCS" == "0" ]]; then
      VPN_IPS="$VPN_IPS,'$SPCS_CIDR'"
    fi

    snow_sql "CREATE OR REPLACE NETWORK POLICY $USER_POLICY_NAME ALLOWED_IP_LIST = ($VPN_IPS);"
    snow_sql "ALTER USER $USERNAME SET NETWORK_POLICY = $USER_POLICY_NAME;"
    echo -e "  ${GREEN}[OK]${NC} User policy: $USER_POLICY_NAME"
  else
    echo -e "  ${YELLOW}[WARN]${NC} Could not read VPN IPs"
  fi
else
  snow_sql "CREATE OR REPLACE NETWORK POLICY $USER_POLICY_NAME ALLOWED_IP_LIST = ('0.0.0.0/0');"
  snow_sql "ALTER USER $USERNAME SET NETWORK_POLICY = $USER_POLICY_NAME;"
  echo -e "  ${GREEN}[OK]${NC} User policy: $USER_POLICY_NAME (allow all)"
fi

echo ""
echo "=================================================="
echo -e "${GREEN}  Network Policy Fix Complete${NC}"
echo "=================================================="
echo ""
echo "If services are still unreachable, check:"
echo "  snow sql -q \"SHOW ENDPOINTS IN SERVICE <db>.<schema>.TRUCK_CONFIGURATOR_SVC;\" -c $CONNECTION_NAME"
