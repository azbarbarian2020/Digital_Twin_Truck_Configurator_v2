# Digital Twin Truck Configurator V2 - Technical Documentation

**Version:** V2 (Key-Pair JWT)
**Repository:** https://github.com/azbarbarian2020/Digital_Twin_Truck_Configurator_v2

---

## 1. V2 Pillars

V2 migrates the Digital Twin Truck Configurator from PAT-based authentication to key-pair JWT. The three pillars:

1. **Key-Pair JWT replacing PATs** — The SPCS container authenticates to Snowflake using RSA key-pair JWT for both SQL connections (via snowflake-connector-python) and REST API calls (Cortex Agent, Cortex Analyst). No PATs needed.

2. **Safe RSA key reuse** — The setup script detects existing RSA keys on the user and offers to reuse them or use the secondary `RSA_PUBLIC_KEY_2` slot, avoiding accidental invalidation of other SPCS apps on the same account.

3. **Network policy hardening** — Three-part fix for SE demo accounts where a security enforcement task (`ACCOUNT_LEVEL_NETWORK_POLICY_TASK`) resets the account-level network policy every 12 hours, wiping SPCS CIDRs.

---

## 2. Authentication Architecture

### Authentication Matrix

| Operation | SPCS OAuth | PAT | Key-Pair JWT |
|-----------|------------|-----|--------------|
| SQL queries (snowflake-connector-python) | Yes | Yes | Yes |
| REST APIs (Cortex Agent/Analyst) | No (401) | Yes | Yes |
| PUT commands (file uploads) | No | No | Yes |

Key-pair JWT is the most capable method and the only one that works for all operations.

### JWT Token Generation (Python)

The backend (`backend/main.py`) generates JWT tokens using the account LOCATOR (not org-account format):

```python
qualified_username = f"{ACCOUNT_LOCATOR}.{SNOWFLAKE_USER}"
payload = {
    "iss": f"{qualified_username}.SHA256:{fingerprint}",
    "sub": qualified_username,
    "iat": now,
    "exp": now + 3600,
}
jwt_token = jwt.encode(payload, private_key, algorithm="RS256")
```

**CRITICAL**: The `iss` and `sub` claims MUST use the account LOCATOR (e.g., `LNB24417`), NOT the org-account format (e.g., `SFSENORTHAMERICA-CLEANBARBARIAN`).

### REST API Headers

```python
headers = {
    "Authorization": f"Bearer {jwt_token}",
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    "Content-Type": "application/json",
}
```

### SQL Connection

```python
snowflake.connector.connect(
    account=SNOWFLAKE_ACCOUNT,
    user=SNOWFLAKE_USER,
    private_key=<deserialized RSA key>,
    warehouse=SNOWFLAKE_WAREHOUSE,
    database=SNOWFLAKE_DATABASE,
    schema=SNOWFLAKE_SCHEMA,
)
```

The connection also falls back to SPCS OAuth token (`/snowflake/session/token`) if no private key is available (for local dev or if secret mount fails).

---

## 3. Service Specification

### YAML (from setup.sh)

```yaml
spec:
  containers:
    - name: truck-configurator
      image: <registry>/<db>/<schema>/truck_config_repo/truck-config:<tag>
      env:
        SNOWFLAKE_ACCOUNT: <ORG-ACCOUNT>
        SNOWFLAKE_ACCOUNT_LOCATOR: <LOCATOR>
        SNOWFLAKE_HOST: <org-account>.snowflakecomputing.com
        SNOWFLAKE_USER: <USERNAME>
        SNOWFLAKE_WAREHOUSE: <WAREHOUSE>
        SNOWFLAKE_DATABASE: <DATABASE>
        SNOWFLAKE_SCHEMA: <SCHEMA>
        SNOWFLAKE_SEMANTIC_VIEW: <DATABASE>.<SCHEMA>.TRUCK_CONFIG_ANALYST_V2
      secrets:
        - snowflakeSecret:
            objectName: <DATABASE>.<SCHEMA>.SNOWFLAKE_PRIVATE_KEY_SECRET
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
```

### Key Design Decisions

- **Secrets use `envVarName` injection**, NOT `volumeMounts`. SPCS reserves the `/snowflake/` path prefix, and `volumeMounts` with `readOnly` are not supported. The private key is injected as the `SNOWFLAKE_PRIVATE_KEY` environment variable.

- **Container name is `truck-configurator`**, endpoint name is `web`.

- **`networkPolicyConfig.allowInternetEgress: true`** is required for the container to reach Snowflake REST APIs through the External Access Integration.

---

## 4. External Access Integration

```sql
CREATE NETWORK RULE <db>.<schema>.CORTEX_API_RULE
  TYPE = HOST_PORT MODE = EGRESS
  VALUE_LIST = ('<host>:443');

CREATE EXTERNAL ACCESS INTEGRATION TRUCK_CONFIG_EXTERNAL_ACCESS
  ALLOWED_NETWORK_RULES = (<db>.<schema>.CORTEX_API_RULE)
  ALLOWED_AUTHENTICATION_SECRETS = (<db>.<schema>.SNOWFLAKE_PRIVATE_KEY_SECRET)
  ENABLED = TRUE;
```

**CRITICAL**: `ALLOWED_AUTHENTICATION_SECRETS` MUST include the private key secret. Without it, JWT auth cannot pass through the EAI for Cortex REST API calls.

The setup script also detects and adds an S3 stage host rule when available (for presigned URL access).

---

## 5. Network Policy Hardening

### The Problem

SE demo accounts have `ACCOUNT_LEVEL_NETWORK_POLICY_TASK` running every 720 minutes (12 hours). It replaces the account-level network policy with a hardcoded VPN IP list, wiping any SPCS CIDRs.

### The Three-Part Fix

1. **Account-level policy** — Add SPCS CIDR (`153.45.59.0/24`) to the existing account policy (immediate fix, but temporary if enforcement task runs)

2. **Enforcement procedure** — Update `security_network_db.policies.account_level_network_policy_proc()` to include SPCS CIDR in its `desiredIpList` variable (permanent fix)

3. **User-level policy** — Create `TRUCK_CONFIG_USER_POLICY` with all VPN IPs + SPCS CIDR, assigned to the user. This is immune to account-level resets.

### Safety Rules for User-Level Policies

- Include all VPN IPs from the account policy
- Add SPCS CIDR (`153.45.59.0/24` for AWS US West 2)
- Do NOT include `0.0.0.0/0` — the user disablement task flags this
- User MUST have RSA key set (`has_rsa_public_key=true`)

---

## 6. Database Schema

### BOM_TBL (253 rows)

The Bill of Materials table stores all configurable options. The **SPECS** column (VARIANT) is critical — it contains JSON technical specifications that the validation engine compares against extracted engineering rules.

```sql
CREATE TABLE BOM_TBL (
    OPTION_ID VARCHAR(50) NOT NULL PRIMARY KEY,
    SYSTEM_NM VARCHAR(100) NOT NULL,
    SUBSYSTEM_NM VARCHAR(100) NOT NULL,
    COMPONENT_GROUP VARCHAR(100) NOT NULL,
    OPTION_NM VARCHAR(150) NOT NULL,
    COST_USD NUMBER(12,2) NOT NULL,
    WEIGHT_LBS NUMBER(10,2) NOT NULL,
    SOURCE_COUNTRY VARCHAR(50) NOT NULL,
    PERFORMANCE_CATEGORY VARCHAR(50) NOT NULL,
    PERFORMANCE_SCORE NUMBER(3,1) NOT NULL,
    DESCRIPTION VARCHAR(500),
    OPTION_TIER VARCHAR(20),
    SPECS VARIANT
);
```

Example SPECS values:
```json
{"boost_psi": 48, "max_hp_supported": 650, "turbo_type": "twin-vgt"}
{"gear_count": 12, "torque_rating_lb_ft": 2050, "trans_class": "AMT-premium"}
{"cooling_capacity_btu": 500000, "fan_type": "viscous-clutch", "radiator_type": "crossflow"}
```

### VALIDATION_RULES (dynamic)

AI-extracted rules from uploaded engineering specification documents:

```sql
CREATE TABLE VALIDATION_RULES (
    RULE_ID VARCHAR(100) NOT NULL,
    DOC_ID VARCHAR(100) NOT NULL,
    DOC_TITLE VARCHAR(500),
    LINKED_OPTION_ID VARCHAR(50),
    COMPONENT_GROUP VARCHAR(100),
    SPEC_NAME VARCHAR(100),
    MIN_VALUE NUMBER(20,4),
    MAX_VALUE NUMBER(20,4),
    UNIT VARCHAR(50),
    RAW_REQUIREMENT VARCHAR(1000),
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

### Validation Flow

1. User uploads engineering spec PDF
2. Backend calls `CORTEX_PARSE_DOCUMENT` to extract text
3. Text is chunked into `ENGINEERING_DOCS_CHUNKED` (for Cortex Search)
4. `Cortex Complete` extracts validation rules (spec_name, min/max values)
5. Rules are stored in `VALIDATION_RULES` with `LINKED_OPTION_ID` and `DOC_ID`
6. When user clicks "Verify Configuration":
   - Backend queries `VALIDATION_RULES` for rules linked to selected options
   - For each rule, compares `BOM_TBL.SPECS[spec_name]` against `MIN_VALUE`/`MAX_VALUE`
   - If any spec fails, finds the cheapest alternative in the same `COMPONENT_GROUP` that meets ALL rules
   - Returns `fixPlan: {remove: [optionIds], add: [optionIds], explanation: string}`
7. When user deletes a document, `VALIDATION_RULES` rows for that `DOC_ID` are also deleted

---

## 7. Data Loading

Data is loaded by `setup.sh` via SQL scripts in `scripts/`:

| Script | Content |
|--------|---------|
| `02_data.sql` | MODEL_TBL (5 truck models) |
| `02b_bom_data.sql` | BOM_TBL (253 options with SPECS via `PARSE_JSON()`) |
| `02c_truck_options.sql` | TRUCK_OPTIONS (868 model-option mappings) |
| `02d_app_tables.sql` | VALIDATION_RULES, ENGINEERING_DOCS_CHUNKED, SAVED_CONFIGS, CHAT_HISTORY, Cortex Search Service |
| `02e_upload_procedure.sql` | UPLOAD_AND_PARSE_DOCUMENT stored procedure |

Scripts use `BOM.BOM4` as a placeholder which `setup.sh` substitutes to the actual `${DATABASE}.${SCHEMA}` via `sed`.

---

## 8. Docker Build

```bash
docker buildx build --platform linux/amd64 --no-cache \
  -t truck-config:v2-latest \
  -f Dockerfile .
```

**MUST use `--platform linux/amd64`** — SPCS only supports amd64 architecture.

The multi-stage Dockerfile:
1. `frontend-deps` — installs npm dependencies
2. `frontend-builder` — builds Next.js standalone output
3. `final` — Python 3.11-slim with nginx, supervisor, backend, and frontend

### Docker Push (VPN proxy bypass)

```bash
snow spcs image-registry login --connection <conn>
HTTPS_PROXY="" HTTP_PROXY="" NO_PROXY="<registry_host>" docker push <image>
```

The `HTTPS_PROXY=""` prefix is required to bypass Docker Desktop's VpnKit transparent proxy on corporate/VPN networks.

---

## 9. Teardown

```bash
./teardown.sh
```

This safely removes:
- SPCS service
- External Access Integration
- Compute pool
- Schema (including all tables, views, secrets)
- Warehouse (if created by setup)

This preserves:
- RSA public keys on user (safe for other SPCS apps)
- User-level network policies (can be removed manually)
- Database (only schema is dropped)

---

## 10. Lessons Learned

### SPCS Authentication
| Issue | Solution |
|-------|----------|
| SPCS OAuth returns 401 for REST APIs | Use key-pair JWT instead |
| JWT `iss` claim uses wrong account format | Must use account LOCATOR from `SELECT CURRENT_ACCOUNT()` |
| EAI blocks JWT auth | Add private key secret to `ALLOWED_AUTHENTICATION_SECRETS` |

### Service Spec
| Issue | Solution |
|-------|----------|
| `readOnly` in volumeMounts | Not supported in SPCS — use `secrets` with `envVarName` instead |
| `/snowflake/` mount path | Reserved by SPCS — use `envVarName` injection |
| `snowflakeName:` in secrets | Wrong key — use `snowflakeSecret: objectName:` |

### Data
| Issue | Solution |
|-------|----------|
| SPECS column is NULL | Ensure `02b_bom_data.sql` includes `PARSE_JSON()` for SPECS |
| Validation finds issues but no fix plan | SPECS must be populated for comparison against rules |

### Docker
| Issue | Solution |
|-------|----------|
| `unauthorized` on registry push | Re-run `snow spcs image-registry login` |
| SPCS image architecture error | Build with `--platform linux/amd64` |
| Same tag doesn't trigger re-pull | Use unique tags (setup.sh appends timestamp) |
| Push fails through VPN | Use `HTTPS_PROXY="" HTTP_PROXY="" NO_PROXY="<host>"` |
