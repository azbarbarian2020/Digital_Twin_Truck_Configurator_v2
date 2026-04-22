# Digital Twin Truck Configurator V2 - Handoff Document

**Last Updated:** April 22, 2026
**Current Deployed Image:** `v2-1776884230`
**Service URL:** https://evdvpib-sfsenorthamerica-cleanbarbarian.snowflakecomputing.app
**Status:** All features working (Configuration Assistant, Document Upload/Delete, Validation)

---

## 1. Application Overview

An interactive truck configuration tool deployed on Snowpark Container Services (SPCS). Users select a truck model, then optimize component selections using natural language (powered by Cortex Analyst), upload engineering specification PDFs that are automatically parsed into validation rules (powered by AI_PARSE_DOCUMENT + CORTEX.COMPLETE), and validate configurations against those rules in real-time.

### Core Features

| Feature | Description | Cortex Service |
|---------|-------------|----------------|
| **Configuration Assistant** | Natural language optimization ("maximize safety and comfort while minimizing cost") | Cortex Analyst (REST API + Semantic View) |
| **Document Upload** | Upload PDF specs, OCR text extraction, dynamic rule generation | AI_PARSE_DOCUMENT (OCR) + CORTEX.COMPLETE (mistral-large2) |
| **Document Search** | Chat-based Q&A against uploaded engineering docs | Cortex Search Service |
| **Live Validation** | Real-time component validation against extracted rules | Direct SQL |
| **Configuration Report** | PDF export with BOM, performance scores, validation status | Client-side jsPDF |

---

## 2. Architecture

```
                    SPCS Compute Pool (CPU_X64_XS)
                    ┌──────────────────────────────────────┐
                    │  supervisord                         │
                    │  ┌──────────┐  ┌──────────────────┐  │
  User ──HTTPS──▶   │  │  nginx   │  │  Next.js (3000)  │  │
                    │  │  (8080)  │──│  React Frontend   │  │
                    │  │          │  └──────────────────┘  │
                    │  │  /api/*  │  ┌──────────────────┐  │
                    │  │──────────│──│  FastAPI (8000)   │  │
                    │  └──────────┘  │  Python Backend   │  │
                    │                └────────┬─────────┘  │
                    └─────────────────────────┼────────────┘
                                              │
                    ┌─────────────────────────┼────────────┐
                    │  Snowflake              │            │
                    │  ┌──────────┐  ┌────────▼─────────┐  │
                    │  │ Semantic  │  │ BOM_TBL          │  │
                    │  │ View V2   │  │ TRUCK_OPTIONS    │  │
                    │  └──────────┘  │ MODEL_TBL         │  │
                    │  ┌──────────┐  │ ENGINEERING_DOCS  │  │
                    │  │ Cortex   │  │   _CHUNKED        │  │
                    │  │ Search   │  │ VALIDATION_RULES  │  │
                    │  │ Service  │  │ SAVED_CONFIGS     │  │
                    │  └──────────┘  │ CHAT_HISTORY      │  │
                    │                └──────────────────┘  │
                    └──────────────────────────────────────┘
```

### Process Layout

| Process | Port | Role |
|---------|------|------|
| nginx | 8080 (exposed) | Reverse proxy, SSE support, 50MB upload limit |
| FastAPI/uvicorn | 8000 | Python backend, all `/api/*` routes |
| Next.js standalone | 3000 | React frontend (server-rendered) |
| supervisord | - | Process manager, auto-restart all |

### Authentication

**Key-pair JWT** is used for everything:
- **SQL connections:** `snowflake.connector.connect()` with `private_key=` parameter
- **Cortex Analyst REST API:** Bearer JWT token with account LOCATOR in claims
- **Private key** is stored as a Snowflake Secret and injected via `SNOWFLAKE_PRIVATE_KEY` env var

---

## 3. Snowflake Objects

| Object | Type | Purpose |
|--------|------|---------|
| `BOM.TRUCK_CONFIG` | Schema | All app objects |
| `MODEL_TBL` | Table | Truck models (5 models) |
| `BOM_TBL` | Table | Bill of Materials options with cost, weight, performance scores |
| `TRUCK_OPTIONS` | Table | Model-to-option mapping |
| `ENGINEERING_DOCS_CHUNKED` | Table | Uploaded doc text, chunked by page |
| `VALIDATION_RULES` | Table | AI-extracted numeric requirements per component group |
| `SAVED_CONFIGS` | Table | User-saved configurations |
| `CHAT_HISTORY` | Table | Chat session history |
| `ENGINEERING_DOCS_STAGE` | Stage | Internal stage for uploaded PDFs |
| `ENGINEERING_DOCS_SEARCH` | Cortex Search Service | Full-text search over doc chunks (1-min target lag) |
| `TRUCK_CONFIG_ANALYST_V2` | Semantic View | Cortex Analyst semantic model for optimization SQL generation |
| `SNOWFLAKE_PRIVATE_KEY_SECRET` | Secret | RSA private key for JWT auth |
| `TRUCK_CONFIG_EXTERNAL_ACCESS` | External Access Integration | Allows SPCS to call Snowflake REST APIs |
| `TRUCK_CONFIGURATOR_SVC` | SPCS Service | The running application |
| `TRUCK_CONFIG_POOL` | Compute Pool | CPU_X64_XS, min/max 1 node |
| `TRUCK_CONFIG_WH` | Warehouse | Large (dedicated for demo performance) |

---

## 4. Document Upload Flow (The Hard Part)

This is the most complex feature and went through several architecture iterations. The current version uses a **POST + background thread + polling** pattern to avoid SPCS ingress proxy SSE connection drops.

### Current Architecture (v2-1776884230)

```
Client                    FastAPI                       Background Thread
  │                            │                              │
  │  POST /upload (PDF+form)   │                              │
  │ ─────────────────────────▶ │                              │
  │  {uploadId} (immediate)    │  spawn daemon thread ───────▶│
  │ ◀───────────────────────── │                              │
  │                            │                              │  create bg_conn
  │  GET /upload-status        │                              │  PUT file to stage
  │ ─────────────────────────▶ │  read _pending_uploads       │
  │  {step:'upload'}           │                              │
  │ ◀───────────────────────── │                              │
  │                            │                              │  AI_PARSE_DOCUMENT (OCR)
  │  GET /upload-status        │                              │  INSERT INTO CHUNKED
  │ ─────────────────────────▶ │                              │
  │  {step:'extract'}          │                              │
  │ ◀───────────────────────── │                              │
  │                            │                              │  Dynamic CTE SQL:
  │  GET /upload-status        │                              │   spec_catalog from BOM_TBL
  │ ─────────────────────────▶ │                              │   CORTEX.COMPLETE
  │  {step:'rules'}            │                              │   INSERT INTO VALIDATION_RULES
  │ ◀───────────────────────── │                              │
  │                            │                              │  Search REFRESH
  │  GET /upload-status        │                              │  close bg_conn
  │ ─────────────────────────▶ │                              │
  │  {status:'done'}           │                              │
  │ ◀───────────────────────── │                              │
```

### Key Design Decisions

1. **POST returns immediately** with `{uploadId}`. All SQL runs in a daemon background thread with its own connection (`bg_conn`). This avoids SPCS ingress proxy killing long-lived SSE connections (~30s timeout).

2. **`_pending_uploads` dict**: In-memory state tracking per upload (step, chunkCount, rulesCreated, error, message). Frontend polls `GET /upload-status?uploadId=X` every 2 seconds.

3. **AI_PARSE_DOCUMENT in OCR mode**: Returns full document text in ~3 seconds (vs 3+ minutes in LAYOUT mode). Warehouse size does not affect performance.

4. **Dynamic rule extraction via single SQL INSERT with CTEs**: No hardcoded component groups. The SQL queries `BOM_TBL.SPECS` via `LATERAL FLATTEN(TRY_PARSE_JSON(TO_VARCHAR(SPECS)))` to build a runtime catalog of all component groups and their numeric spec names (74 specs across 41 groups). This catalog is injected into the CORTEX.COMPLETE prompt so the LLM knows what to extract from any properly structured document.

5. **LINKED_OPTION_ID**: Set from frontend's `linkedParts[0].optionId`. Required for validation queries which filter `WHERE vr.LINKED_OPTION_ID IN ({option_list})`.

6. **Search refresh is fire-and-forget**: After updating `_pending_uploads` to `done`, runs `ALTER CORTEX SEARCH SERVICE ... REFRESH`.

### Upload UI Steps (3 steps)

| Step Key | Label | Backend Action |
|----------|-------|----------------|
| `upload` | Uploading to stage | PUT file to ENGINEERING_DOCS_STAGE |
| `extract` | Extracting document text | AI_PARSE_DOCUMENT (OCR) + INSERT INTO ENGINEERING_DOCS_CHUNKED |
| `rules` | Extracting validation rules (AI) | Dynamic CTE SQL: BOM_TBL spec catalog + CORTEX.COMPLETE + INSERT INTO VALIDATION_RULES |

---

## 5. Critical Gotchas and Lessons Learned

### SPCS SNOWFLAKE_HOST Override

SPCS auto-populates `SNOWFLAKE_HOST` with a **locator-based URL** (e.g., `lnb24417.prod3.us-west-2.aws.snowflakecomputing.com`). REST API calls to this URL get **401 "IP not allowed"** even when the SPCS CIDR is in the network policy. The code auto-overrides to the org-account URL:

```python
# backend/main.py lines 35-37
if SNOWFLAKE_ACCOUNT and (not SNOWFLAKE_HOST or SNOWFLAKE_ACCOUNT_LOCATOR.lower() in SNOWFLAKE_HOST.lower()):
    SNOWFLAKE_HOST = f"{SNOWFLAKE_ACCOUNT.lower()}.snowflakecomputing.com"
```

**Do NOT set `SNOWFLAKE_HOST` in the service spec.** Let the code derive it.

### Snowflake Python Connector Thread Safety

The Snowflake Python connector connection objects are **NOT thread-safe**. Using a connection from multiple threads (even sequentially from different threads) corrupts internal state. Symptoms: second operation on the connection hangs forever.

**Pattern that works:** Single `upload_conn` used ONLY from background threads via `_run_sql()`. Main thread only yields keepalives.

**Pattern that fails:** Separate connections for main thread (`gen_conn`) and background thread (`thread_conn`) — still corrupts on second upload cycle.

### SPCS Ingress Proxy and SSE

The SPCS ingress proxy drops SSE connections after ~30 seconds of inactivity, even with keepalive comments. This is why the upload flow was rewritten from SSE to POST + polling. The proxy has no issue with short-lived request/response cycles.

### Service Spec Secrets Syntax

```yaml
secrets:
- snowflakeSecret: BOM.TRUCK_CONFIG.SNOWFLAKE_PRIVATE_KEY_SECRET
  secretKeyRef: secret_string    # NOT "private_key_value"
  envVarName: SNOWFLAKE_PRIVATE_KEY
```

Note: `snowflakeSecret` is NOT an object with `objectName` — it's a direct reference. The `secretKeyRef` value must be `secret_string` (generic secret type), not the secret name.

### ALTER SERVICE Cannot Include EXTERNAL_ACCESS_INTEGRATIONS

Once `EXTERNAL_ACCESS_INTEGRATIONS` is set on the service (during CREATE), ALTER SERVICE with a new spec does NOT need to re-specify it. Including it after the `$$` delimiter causes a syntax error.

### JWT Claims Require Account LOCATOR

The `SNOWFLAKE_ACCOUNT_LOCATOR` env var (`LNB24417`) is required for JWT token generation. The JWT `iss` claim must use the locator format, not the org-account format.

---

## 6. Deployment Procedures

### Build and Deploy a New Image

```bash
# 1. Login to SPCS image registry
snow spcs image-registry login --connection cleanbarbarian

# 2. Build (linux/amd64 required for SPCS)
IMAGE_TAG="v2-$(date +%s)"
docker build --platform linux/amd64 \
  -t sfsenorthamerica-cleanbarbarian.registry.snowflakecomputing.com/bom/truck_config/truck_config_repo/truck-configurator:$IMAGE_TAG .

# 3. Push
docker push sfsenorthamerica-cleanbarbarian.registry.snowflakecomputing.com/bom/truck_config/truck_config_repo/truck-configurator:$IMAGE_TAG

# 4. Deploy (ALTER SERVICE — do NOT DROP/CREATE)
```

```sql
ALTER SERVICE BOM.TRUCK_CONFIG.TRUCK_CONFIGURATOR_SVC
FROM SPECIFICATION $$
spec:
  containers:
  - name: truck-configurator
    image: /bom/truck_config/truck_config_repo/truck-configurator:<IMAGE_TAG>
    env:
      SNOWFLAKE_ACCOUNT: SFSENORTHAMERICA-CLEANBARBARIAN
      SNOWFLAKE_ACCOUNT_LOCATOR: LNB24417
      SNOWFLAKE_USER: ADMIN
      SNOWFLAKE_WAREHOUSE: TRUCK_CONFIG_WH
      SNOWFLAKE_DATABASE: BOM
      SNOWFLAKE_SCHEMA: TRUCK_CONFIG
    secrets:
    - snowflakeSecret: BOM.TRUCK_CONFIG.SNOWFLAKE_PRIVATE_KEY_SECRET
      secretKeyRef: secret_string
      envVarName: SNOWFLAKE_PRIVATE_KEY
  endpoints:
  - name: app
    port: 8080
    public: true
$$;
```

### Check Service Status and Logs

```sql
-- Status
SELECT SYSTEM$GET_SERVICE_STATUS('BOM.TRUCK_CONFIG.TRUCK_CONFIGURATOR_SVC');

-- Logs (last 500 lines)
SELECT SYSTEM$GET_SERVICE_LOGS('BOM.TRUCK_CONFIG.TRUCK_CONFIGURATOR_SVC', 0, 'truck-configurator', 500);

-- Tail of logs (last 3000 chars)
SELECT RIGHT(SYSTEM$GET_SERVICE_LOGS('BOM.TRUCK_CONFIG.TRUCK_CONFIGURATOR_SVC', 0, 'truck-configurator', 500), 3000);
```

### Fresh Setup

```bash
./setup.sh
```

This interactive script handles all 9 steps: infrastructure, key-pair auth, external access, data loading, semantic view, network policy, Docker build/push, service creation, and endpoint display.

### Teardown

```bash
./teardown.sh
```

Drops service, EAI, compute pool, schema, and warehouse. Preserves RSA keys, user-level network policy, and the parent database.

---

## 7. File Inventory

### Backend

| File | Purpose |
|------|---------|
| `backend/main.py` | **Primary backend** — all API endpoints, upload flow, Cortex integration |
| `backend/requirements.txt` | Python deps: fastapi, snowflake-connector-python, PyJWT, etc. |

### Frontend

| File | Purpose |
|------|---------|
| `components/Configurator.tsx` | Main configurator UI — option selection, upload/delete modals, validation display |
| `components/ChatPanel.tsx` | Configuration Assistant chat interface |
| `components/Compare.tsx` | Side-by-side configuration comparison |
| `components/ConfigurationReport.tsx` | PDF report generation |
| `components/ModelSelection.tsx` | Truck model picker |
| `components/Header.tsx` | App header |
| `components/Skeleton.tsx` | Loading skeletons |
| `app/page.tsx` | Main page layout |
| `app/api/*/route.ts` | Next.js API routes (proxy to Python backend) |
| `lib/api-config.ts` | API base URL configuration |

### Infrastructure

| File | Purpose |
|------|---------|
| `setup.sh` | Full automated setup (9 steps) |
| `teardown.sh` | Safe teardown |
| `fix_network_policy.sh` | Re-add SPCS CIDR after security task reset |
| `Dockerfile` | Multi-stage: node:20-alpine → python:3.11-slim |
| `nginx.conf` | Reverse proxy with SSE support |
| `scripts/01_infrastructure.sql` | Database, schema, compute pool, stage, secret, EAI |
| `scripts/02_data.sql` | Model data |
| `scripts/02b_bom_data.sql` | BOM options data |
| `scripts/02c_truck_options.sql` | Model-option mappings |
| `scripts/02d_app_tables.sql` | App tables + Cortex Search Service |
| `scripts/02e_upload_procedure.sql` | Deprecated — V2 uses AI_PARSE_DOCUMENT in main.py directly |
| `scripts/03_semantic_view.sql` | Semantic View for Cortex Analyst |
| `scripts/05_service.sql` | Service creation template |

### Sample Documents

| File | Purpose |
|------|---------|
| `public/docs/605_HP_Engine_Requirements.pdf` | Primary test doc — 3 pages, turbo/radiator/transmission/brake requirements |
| `public/docs/*.pdf` | Additional test specification documents |

---

## 8. API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models` | List truck models |
| GET | `/api/options?modelId=X` | Get options for a model |
| POST | `/api/chat` | Configuration Assistant (Cortex Analyst + Search) |
| PATCH | `/api/chat-history` | Save/update chat history |
| GET | `/api/chat-history?sessionId=X` | Retrieve chat history |
| POST | `/api/validate` | Validate configuration against rules |
| POST | `/api/engineering-docs/upload` | Upload PDF (returns uploadId, runs pipeline in background) |
| GET | `/api/engineering-docs/upload-status` | Poll upload progress by uploadId |
| DELETE | `/api/engineering-docs` | Delete a document and its rules |
| GET | `/api/engineering-docs` | List uploaded documents |
| GET | `/api/engineering-docs/view` | Get document text |
| POST | `/api/configs` | Save a configuration |
| GET | `/api/configs` | List saved configurations |
| GET | `/api/report` | Generate configuration report data |
| POST | `/api/describe` | AI-generated configuration description |

---

## 9. Validation System

When a document is uploaded with a linked option (e.g., "605 HP / 2050 lb-ft Maximum", OPTION_ID=134):

1. `AI_PARSE_DOCUMENT` (OCR mode) extracts full document text into `ENGINEERING_DOCS_CHUNKED`
2. A single SQL INSERT with CTEs dynamically reads `BOM_TBL.SPECS` to build a catalog of all component groups and their numeric spec names
3. `CORTEX.COMPLETE` (mistral-large2) receives this catalog + document text and extracts matching requirements as JSON
4. Rules are parsed and inserted into `VALIDATION_RULES` with `LINKED_OPTION_ID`, `COMPONENT_GROUP`, `SPEC_NAME`, `MIN_VALUE`, `MAX_VALUE`

Component groups are NOT hardcoded -- the system dynamically discovers all groups with numeric specs from BOM_TBL at runtime (currently 41 groups, 74 numeric spec names).

When `/api/validate` is called, the backend:
1. Fetches all validation rules where `LINKED_OPTION_ID` matches the selected options
2. Compares each rule's `MIN_VALUE`/`MAX_VALUE` against the selected option's spec values (stored in `BOM_TBL.SPECS` VARIANT column)
3. Returns pass/fail per rule with explanations

The frontend auto-calls `validateConfig()` after upload success and delete success to refresh validation icons.

---

## 10. Version History

| Image Tag | Date | Changes |
|-----------|------|---------|
| `v2-1776884230` | Apr 22 | **Current.** OCR mode (3s vs 3min LAYOUT), dynamic BOM_TBL rule extraction (single SQL), POST+polling (no SSE). |
| `v2-1776878601` | Apr 22 | Background thread + polling (still LAYOUT mode, timed out on parse). |
| `v2-1776875425` | Apr 22 | Partial SSE fix (rules only in background). Still failed. |
| `v2-1776795444` | Apr 21 | AI_PARSE_DOCUMENT with page_split, single-connection upload, batch rule INSERT. Fixes second-upload hang. |
| `v2-1776794043` | Apr 21 | SNOWFLAKE_HOST override to org-account URL. Dual-connection (still had second-upload hang). |
| `v2-1776791977` | Apr 21 | Added SNOWFLAKE_ACCOUNT_LOCATOR env var. validateConfig() auto-refresh. |
| `v2-1776790297` | Apr 21 | Per-query connections (too slow). Missing ACCOUNT_LOCATOR. |
| `v2-1776789128` | Apr 21 | First upload works, second fails (connection corruption). |
| `v2-1776788203` | Apr 21 | Partial fix for SSE keepalive. |
| `v2-1775763530` | Apr 8 | Original deploy. |

---

## 11. Known Issues / Future Improvements

- **Warehouse sizing**: setup.sh now creates `TRUCK_CONFIG_WH` as Large by default for demo performance. Adjust size in setup.sh if cost is a concern.
- **Orphaned stage files**: Previous test uploads may have left files like `605_HP_Engine_Requirements_(9).pdf` on the stage. Run `LS @BOM.TRUCK_CONFIG.ENGINEERING_DOCS_STAGE;` and `REMOVE` unwanted files.
- **Network policy enforcement task**: A `ACCOUNT_LEVEL_NETWORK_POLICY_TASK` runs every 12 hours and may remove the SPCS CIDR from the account network policy. `setup.sh` handles this by creating a user-level policy and updating the enforcement procedure, but `fix_network_policy.sh` can be run manually if needed.
- **Text file uploads**: The text file path (`is_text`) doesn't use AI_PARSE_DOCUMENT — it inserts the raw text as a single chunk. This is fine for small text files but could be improved.
- **AI_PARSE_DOCUMENT mode**: OCR mode runs in ~3 seconds. LAYOUT mode takes 3+ minutes even on small PDFs. Snowflake docs confirm warehouse size does not affect AI_PARSE_DOCUMENT performance. No reason to use LAYOUT unless page structure is needed.
