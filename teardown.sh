#!/bin/bash
set -e

echo "================================================================="
echo "  Digital Twin Truck Configurator V2 - Teardown"
echo "  Safely removes the demo without breaking other SPCS apps"
echo "================================================================="
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}Connection Setup${NC}"
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

snow_sql() {
    snow sql --connection "$CONNECTION_NAME" "$@" 2>/dev/null || true
}

read -p "Database name [BOM]: " DATABASE
DATABASE=${DATABASE:-BOM}
read -p "Schema name [TRUCK_CONFIG]: " SCHEMA
SCHEMA=${SCHEMA:-TRUCK_CONFIG}
read -p "Compute Pool name [TRUCK_CONFIG_POOL]: " COMPUTE_POOL
COMPUTE_POOL=${COMPUTE_POOL:-TRUCK_CONFIG_POOL}
echo ""

echo -e "${YELLOW}This will remove:${NC}"
echo "  - Service: ${DATABASE}.${SCHEMA}.TRUCK_CONFIGURATOR_SVC"
echo "  - External Access Integration: TRUCK_CONFIG_EXTERNAL_ACCESS"
echo "  - Compute Pool: ${COMPUTE_POOL}"
echo "  - Schema: ${DATABASE}.${SCHEMA} (all tables, views, secrets within)"
echo ""
echo -e "${GREEN}This will NOT remove:${NC}"
echo "  - RSA public keys on user"
echo "  - User-level network policies"
echo "  - Account-level network policy entries"
echo "  - Database: ${DATABASE} (only the schema is dropped)"
echo ""

read -p "Continue with teardown? (yes/no): " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
    echo "Teardown cancelled."
    exit 0
fi

echo ""
echo -e "${BOLD}Dropping service...${NC}"
snow_sql -q "ALTER SERVICE IF EXISTS ${DATABASE}.${SCHEMA}.TRUCK_CONFIGURATOR_SVC SUSPEND;"
sleep 5
snow_sql -q "DROP SERVICE IF EXISTS ${DATABASE}.${SCHEMA}.TRUCK_CONFIGURATOR_SVC;"
echo -e "${GREEN}✓ Service dropped${NC}"

echo -e "${BOLD}Dropping external access integration...${NC}"
snow_sql -q "DROP EXTERNAL ACCESS INTEGRATION IF EXISTS TRUCK_CONFIG_EXTERNAL_ACCESS;"
echo -e "${GREEN}✓ EAI dropped${NC}"

echo -e "${BOLD}Dropping compute pool...${NC}"
snow_sql -q "ALTER COMPUTE POOL IF EXISTS ${COMPUTE_POOL} STOP ALL;"
sleep 5
snow_sql -q "DROP COMPUTE POOL IF EXISTS ${COMPUTE_POOL};"
echo -e "${GREEN}✓ Compute pool dropped${NC}"

echo -e "${BOLD}Dropping schema ${DATABASE}.${SCHEMA}...${NC}"
snow_sql -q "DROP SCHEMA IF EXISTS ${DATABASE}.${SCHEMA} CASCADE;"
echo -e "${GREEN}✓ Schema dropped${NC}"

echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}  Teardown Complete${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  Preserved:"
echo "    - RSA keys on user (safe for other SPCS apps)"
echo "    - User-level network policies"
echo "    - Database ${DATABASE} (drop manually if desired)"
