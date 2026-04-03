# Digital Twin Truck Configurator V2

An AI-powered truck configuration tool running on Snowpark Container Services (SPCS) with Cortex AI integration.

**V2 uses Key-Pair JWT authentication** (replaces PATs from V1), safely reuses existing RSA keys, and includes network policy hardening for Snowflake SE demo accounts.

## Architecture

```
SPCS Container
+------------------------------------------+
|  Next.js Frontend (port 3000)            |
|    -> Cortex Agent REST API (JWT)        |
|    -> Cortex Analyst REST API (JWT)      |
|                                          |
|  Python Backend (port 8000)              |
|    -> Snowflake SDK (Key-Pair Auth)      |
|    -> Cortex Complete (SQL function)     |
|    -> Cortex Search (SQL function)       |
|                                          |
|  Nginx (port 8080) -> reverse proxy     |
+------------------------------------------+
         |
         v
  SNOWFLAKE_PRIVATE_KEY_SECRET (mounted as env var)
         |
         v
  JWT Token Generation (account LOCATOR based)
         |
         v
  Cortex Agent / Analyst / SDK
```

## Prerequisites

1. **Snowflake CLI** with key-pair authentication configured
   ```bash
   snow connection test -c <your-connection>
   ```

2. **Docker Desktop** (for building the container image)

3. **jq** (for JSON parsing in setup scripts)
   ```bash
   brew install jq  # macOS
   ```

4. **RSA key-pair** already assigned to your Snowflake user
   - The setup script reuses your existing key from `~/.snowflake/connections.toml`
   - It will NOT overwrite existing RSA_PUBLIC_KEY slots

## Quick Start

```bash
git clone https://github.com/azbarbarian2020/Digital_Twin_Truck_Configurator_v2.git
cd Digital_Twin_Truck_Configurator_v2
./setup.sh -c <your-connection-name>
```

The setup script will:
1. Detect your account info and RSA key from the CLI connection
2. Create database, schema, warehouse, compute pool, image repository
3. Create a private key secret (reusing your existing key)
4. Create external access integration with `ALLOWED_AUTHENTICATION_SECRETS`
5. Load BOM data and create semantic view
6. Harden network policies (three-part fix for SE demo accounts)
7. Build and push Docker image
8. Deploy the SPCS service

## What's Different from V1

| Feature | V1 | V2 |
|---------|----|----|
| Auth method | PAT (manual token entry) | Key-Pair JWT (auto-detected from CLI) |
| Key management | None (could break other apps) | Safe: detect, reuse, verify fingerprint |
| REST API auth | `Snowflake Token=` (broken for Agent) | `Bearer` + `KEYPAIR_JWT` header |
| JWT account ID | Org-account with underscore hack | Account LOCATOR (correct) |
| Network policy | None | Three-part hardening |
| EAI | Missing auth secrets | Includes `ALLOWED_AUTHENTICATION_SECRETS` |
| Service secrets | `snowflakeName:` (wrong key) | `snowflakeSecret: objectName:` (correct) |
| SQL parameterization | `sed -i.bak` (mutates files) | Template substitution to temp files |
| Teardown | None | `teardown.sh` (preserves keys) |
| Hardcoded values | `SFSENORTHAMERICA-AWSBARBARIAN` | All parameterized |

## Scripts

| Script | Purpose |
|--------|---------|
| `setup.sh -c <conn>` | Full automated deployment |
| `teardown.sh -c <conn> -d <db>` | Safe cleanup (preserves RSA keys) |
| `fix_network_policy.sh -c <conn>` | Fix after 12-hour enforcement task |

## Network Policy (SE Demo Accounts)

Snowflake SE demo accounts run `ACCOUNT_LEVEL_NETWORK_POLICY_TASK` every 12 hours, which resets the account-level network policy and can wipe SPCS CIDRs. The setup script applies a three-part fix:

1. **Account-level**: Adds SPCS CIDR `153.45.59.0/24` to the current policy
2. **Enforcement procedure**: Updates the stored procedure to include SPCS CIDR
3. **User-level**: Creates a user-specific policy that is immune to account resets

If SPCS stops working after ~12 hours, run:
```bash
./fix_network_policy.sh -c <your-connection>
```

## Environment Variables (SPCS Container)

| Variable | Source | Description |
|----------|--------|-------------|
| `SNOWFLAKE_PRIVATE_KEY` | Secret mount | RSA private key PEM |
| `SNOWFLAKE_ACCOUNT_LOCATOR` | Service spec | Account locator (e.g., `LNB24417`) |
| `SNOWFLAKE_ACCOUNT` | Service spec | Org-account format |
| `SNOWFLAKE_HOST` | Service spec | Full hostname |
| `SNOWFLAKE_USER` | Service spec | Snowflake username |
| `SNOWFLAKE_WAREHOUSE` | Service spec | Warehouse name |
| `SNOWFLAKE_DATABASE` | Service spec | Database name |
| `SNOWFLAKE_SCHEMA` | Service spec | Schema name |
| `SNOWFLAKE_SEMANTIC_VIEW` | Service spec | Fully qualified semantic view |

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues and fixes.
