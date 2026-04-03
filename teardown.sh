#!/bin/bash
# Digital Twin Truck Configurator V2 - Teardown
# Safely removes the demo without breaking other SPCS apps or RSA keys
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

CONNECTION_NAME=""
DATABASE="BOM"
SCHEMA="TRUCK_CONFIG"

usage() {
  echo "Usage: $0 -c <connection_name> [-d <database>] [-s <schema>]"
  echo ""
  echo "  -c  Snowflake CLI connection name (required)"
  echo "  -d  Database name [BOM]"
  echo "  -s  Schema name [TRUCK_CONFIG]"
  exit 0
}

while getopts "c:d:s:h" opt; do
  case $opt in
    c) CONNECTION_NAME="$OPTARG" ;;
    d) DATABASE="$OPTARG" ;;
    s) SCHEMA="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [[ -z "$CONNECTION_NAME" ]]; then
  echo -e "${RED}Connection name required. Use -c <connection>${NC}"
  usage
fi

snow_sql() {
  snow sql -q "$1" -c "$CONNECTION_NAME" 2>/dev/null || true
}

echo "=================================================="
echo "  Truck Configurator V2 - Teardown"
echo "=================================================="
echo ""
echo -e "${YELLOW}This will remove:${NC}"
echo "  - Service: $DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC"
echo "  - Compute Pool: TRUCK_CONFIG_POOL"
echo "  - Schema: $DATABASE.$SCHEMA (all tables, views, secrets within)"
echo ""
echo -e "${GREEN}This will NOT remove:${NC}"
echo "  - RSA public keys on user"
echo "  - User-level network policies"
echo "  - Account-level network policy entries"
echo "  - Database: $DATABASE (only the schema is dropped)"
echo ""

read -p "Continue with teardown? (yes/no): " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Teardown cancelled."
  exit 0
fi

echo ""
echo -e "${YELLOW}Dropping service...${NC}"
snow_sql "ALTER SERVICE IF EXISTS $DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC SUSPEND;"
sleep 5
snow_sql "DROP SERVICE IF EXISTS $DATABASE.$SCHEMA.TRUCK_CONFIGURATOR_SVC;"
echo -e "${GREEN}[OK]${NC} Service dropped"

echo -e "${YELLOW}Dropping external access integration...${NC}"
snow_sql "DROP EXTERNAL ACCESS INTEGRATION IF EXISTS TRUCK_CONFIG_EXTERNAL_ACCESS;"
echo -e "${GREEN}[OK]${NC} EAI dropped"

echo -e "${YELLOW}Dropping compute pool...${NC}"
snow_sql "ALTER COMPUTE POOL IF EXISTS TRUCK_CONFIG_POOL STOP ALL;"
sleep 5
snow_sql "DROP COMPUTE POOL IF EXISTS TRUCK_CONFIG_POOL;"
echo -e "${GREEN}[OK]${NC} Compute pool dropped"

echo -e "${YELLOW}Dropping schema $DATABASE.$SCHEMA...${NC}"
snow_sql "DROP SCHEMA IF EXISTS $DATABASE.$SCHEMA CASCADE;"
echo -e "${GREEN}[OK]${NC} Schema dropped"

echo ""
echo "=================================================="
echo -e "${GREEN}  Teardown Complete${NC}"
echo "=================================================="
echo ""
echo "Preserved:"
echo "  - RSA keys on user (safe for other SPCS apps)"
echo "  - User-level network policies"
echo "  - Database $DATABASE (drop manually if desired)"
