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

- Snowflake account on **AWS** (Cortex AI features require AWS)
- ACCOUNTADMIN role (or equivalent privileges)
- Docker Desktop (for building the container image)
- Snowflake CLI (`pip install snowflake-cli`)
- Python 3.11+ (for JSON parsing in setup script)
- openssl (for RSA key generation)

> **Note**: No `jq` dependency — all JSON parsing uses `python3`.

## CLI Connection Setup

The setup script uses the Snowflake CLI (`snow`) to connect. You must configure **key-pair JWT authentication** in your CLI connection — browser-based auth will not work because the setup script runs non-interactively.

### 1. Generate an RSA Key Pair (if you don't have one)

```bash
mkdir -p ~/.snowflake/keys
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt > ~/.snowflake/keys/<connection_name>.p8
chmod 600 ~/.snowflake/keys/<connection_name>.p8
```

Assign the public key to your Snowflake user:
```bash
openssl rsa -in ~/.snowflake/keys/<connection_name>.p8 -pubout -out /tmp/key.pub
PUBLIC_KEY=$(grep -v 'BEGIN\|END' /tmp/key.pub | tr -d '\n')
```
```sql
ALTER USER <username> SET RSA_PUBLIC_KEY='<PUBLIC_KEY>';
```

### 2. Configure `~/.snowflake/connections.toml`

```toml
[<connection_name>]
account = "<ORG>-<ACCOUNT>"
user = "<USERNAME>"
authenticator = "SNOWFLAKE_JWT"
private_key_file = "~/.snowflake/keys/<connection_name>.p8"
role = "ACCOUNTADMIN"
```

**Key points:**
- `authenticator` must be `SNOWFLAKE_JWT` (not `externalbrowser`)
- `private_key_file` points to the `.p8` key from step 1
- Do NOT set `warehouse` — the setup script creates one

### 3. Configure `~/.snowflake/config.toml`

```toml
default_connection_name = "<connection_name>"
```

### 4. Verify

```bash
snow sql --connection <connection_name> -q "SELECT CURRENT_USER()"
```

## Quick Start

```bash
git clone https://github.com/azbarbarian2020/Digital_Twin_Truck_Configurator_v2.git
cd Digital_Twin_Truck_Configurator_v2
./setup.sh
```

**Estimated time**: 10-20 minutes (mostly Docker build + SPCS startup)

The setup script will:

1. Prompt for your Snowflake CLI connection name
2. Auto-detect your account, host, and registry
3. Prompt for database, schema, warehouse, and compute pool names
4. Create all infrastructure (database, schema, warehouse, compute pool, image repo)
5. Set up RSA key-pair authentication (with safe key management)
6. Create network rules and external access integration
7. Load BOM data, truck options, and app tables
8. Create semantic view
9. Harden network policies (three-part fix for SE demo accounts)
10. Build and push the Docker image
11. Deploy the SPCS service
12. Print the application URL

### Safe Key Management

If you already have an RSA key configured for another SPCS app (like midstream-pdm_v2), the setup script will detect this and offer options:

1. **Reuse existing key** — Auto-detected from `connections.toml` (recommended if key file found)
2. **Use RSA_PUBLIC_KEY_2** — Both apps work simultaneously (recommended if no key file found)
3. **Generate new key** — Warning: breaks other SPCS apps

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
| `./setup.sh` | Full automated deployment (interactive prompts) |
| `./teardown.sh` | Safe cleanup (preserves RSA keys) |
| `./fix_network_policy.sh` | Fix after 12-hour enforcement task |

## Network Policy (SE Demo Accounts)

Snowflake SE demo accounts run `ACCOUNT_LEVEL_NETWORK_POLICY_TASK` every 12 hours, which resets the account-level network policy and can wipe SPCS CIDRs. The setup script applies a three-part fix:

1. **Account-level**: Adds SPCS CIDR `153.45.59.0/24` to the current policy
2. **Enforcement procedure**: Updates the stored procedure to include SPCS CIDR
3. **User-level**: Creates a user-specific policy that is immune to account resets

If SPCS stops working after ~12 hours, run:
```bash
./fix_network_policy.sh
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
