#!/bin/bash
set -e

echo "================================================================="
echo "  SPCS Network Policy Fix"
echo "  Run this when SPCS services become unreachable after"
echo "  the 12-hour enforcement task resets the account policy"
echo "================================================================="
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SPCS_CIDR="153.45.59.0/24"

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
    snow sql --connection "$CONNECTION_NAME" "$@"
}

USERNAME=$(snow_sql -q "SELECT CURRENT_USER()" --format json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['CURRENT_USER()'])")

echo -e "  User:      ${CYAN}${USERNAME}${NC}"
echo -e "  SPCS CIDR: ${CYAN}${SPCS_CIDR}${NC}"
echo ""

echo -e "${BOLD}Part 1: Account-level network policy${NC}"

ACCT_POLICY=$(snow_sql -q "SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN ACCOUNT;" --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if data:
        print(data[0].get('value', ''))
except:
    pass
" 2>/dev/null || echo "")

if [ -n "$ACCT_POLICY" ]; then
    echo "  Account policy: $ACCT_POLICY"

    IP_LIST=$(snow_sql -q "DESC NETWORK POLICY ${ACCT_POLICY};" --format json 2>/dev/null | python3 -c "
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

    if echo "$IP_LIST" | grep -q "$SPCS_CIDR"; then
        echo -e "  ${GREEN}✓ SPCS CIDR already in account policy${NC}"
    else
        echo "  Adding SPCS CIDR to account policy..."
        COMBINED_IPS=$(python3 -c "
ip_list = '''$IP_LIST'''
spcs = '$SPCS_CIDR'
ips = [ip.strip().strip(\"'\") for ip in ip_list.split(',') if ip.strip()]
if spcs not in ips:
    ips.append(spcs)
print(','.join([f\"'{ip}'\" for ip in ips]))
")
        snow_sql -q "ALTER NETWORK POLICY ${ACCT_POLICY} SET ALLOWED_IP_LIST = ($COMBINED_IPS);" 2>/dev/null || echo -e "  ${YELLOW}Could not update account policy${NC}"
        echo -e "  ${GREEN}✓ Added ${SPCS_CIDR} to ${ACCT_POLICY}${NC}"
    fi
else
    echo -e "  ${GREEN}✓ No account-level network policy${NC}"
fi

echo ""
echo -e "${BOLD}Part 2: Enforcement procedure${NC}"

SECURITY_TASK_DETECTED=$(snow_sql -q "SHOW TASKS LIKE 'ACCOUNT_LEVEL_NETWORK_POLICY_TASK' IN ACCOUNT;" --format json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for row in data:
        if 'NETWORK_POLICY' in row.get('name', '').upper():
            print('yes')
            break
except:
    pass
" 2>/dev/null || echo "")

if [ "$SECURITY_TASK_DETECTED" = "yes" ] && [ -n "$ACCT_POLICY" ]; then
    echo "  Security enforcement task found. Updating procedure..."

    DESIRED_IP_CSV=$(python3 -c "
ip_list = '''${IP_LIST:-}'''
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
    snow_sql -f "$PROC_SQL_FILE" 2>/dev/null && echo -e "  ${GREEN}✓ Enforcement procedure updated${NC}" || echo -e "  ${YELLOW}Could not update procedure -- may need manual edit${NC}"
    rm -f "$PROC_SQL_FILE"
else
    echo -e "  ${CYAN}No enforcement task found (not an SE demo account?)${NC}"
fi

echo ""
echo -e "${BOLD}Part 3: User-level network policy${NC}"

if [ -n "$ACCT_POLICY" ]; then
    COMBINED_IPS=$(python3 -c "
ip_list = '''${IP_LIST:-}'''
spcs = '$SPCS_CIDR'
ips = [ip.strip().strip(\"'\") for ip in ip_list.split(',') if ip.strip()]
if spcs not in ips:
    ips.append(spcs)
print(','.join([f\"'{ip}'\" for ip in ips]))
")

    snow_sql -q "CREATE OR REPLACE NETWORK POLICY TRUCK_CONFIG_USER_POLICY ALLOWED_IP_LIST = ($COMBINED_IPS) COMMENT = 'User-level NP: VPN IPs + SPCS CIDR. Immune to account-level security task.';" 2>/dev/null || true
    snow_sql -q "ALTER USER ${USERNAME} SET NETWORK_POLICY = TRUCK_CONFIG_USER_POLICY;" 2>/dev/null || true
    echo -e "  ${GREEN}✓ User-level policy: TRUCK_CONFIG_USER_POLICY${NC}"
else
    snow_sql -q "CREATE OR REPLACE NETWORK POLICY TRUCK_CONFIG_USER_POLICY ALLOWED_IP_LIST = ('0.0.0.0/0') COMMENT = 'User-level NP: allow all (no account policy detected).';" 2>/dev/null || true
    snow_sql -q "ALTER USER ${USERNAME} SET NETWORK_POLICY = TRUCK_CONFIG_USER_POLICY;" 2>/dev/null || true
    echo -e "  ${GREEN}✓ User-level policy: TRUCK_CONFIG_USER_POLICY (allow all)${NC}"
fi

echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}  Network Policy Fix Complete${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  If services are still unreachable, check:"
echo "  snow sql --connection $CONNECTION_NAME -q \"SHOW ENDPOINTS IN SERVICE <db>.<schema>.TRUCK_CONFIGURATOR_SVC;\""
