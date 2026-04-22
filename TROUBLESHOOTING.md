# Troubleshooting Guide

## SPCS Stops Working Every ~12 Hours

**Symptom**: Service endpoint returns connection errors or timeouts after working fine.

**Cause**: SE demo accounts run `ACCOUNT_LEVEL_NETWORK_POLICY_TASK` every 720 minutes (12 hours). This task resets the account-level network policy, removing SPCS CIDRs.

**Fix**:
```bash
./fix_network_policy.sh
```

This applies a three-part fix:
1. Re-adds `153.45.59.0/24` to the account-level policy
2. Updates the enforcement procedure to include SPCS CIDR
3. Creates/updates a user-level policy (immune to account resets)

## JWT Token is Invalid (401 Error)

**Symptom**: REST API calls return 401 Unauthorized with "JWT token is invalid".

**Cause**: JWT claims must use the account **LOCATOR** (e.g., `LNB24417`), NOT the org-account format (e.g., `SFSENORTHAMERICA-CLEANBARBARIAN`).

**Check**:
```sql
SELECT CURRENT_ACCOUNT();  -- Should return the locator
```

**Fix**: Ensure `SNOWFLAKE_ACCOUNT_LOCATOR` env var is set to the locator value in the service spec.

## Empty Cortex Agent Response

**Symptom**: Cortex Agent returns empty or no response, but no error.

**Cause**: External Access Integration (EAI) is missing `ALLOWED_AUTHENTICATION_SECRETS`. Without this, the JWT token cannot pass through the EAI for Cortex REST API calls.

**Fix**:
```sql
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION TRUCK_CONFIG_EXTERNAL_ACCESS
  ALLOWED_NETWORK_RULES = (DB.SCHEMA.CORTEX_API_RULE)
  ALLOWED_AUTHENTICATION_SECRETS = (DB.SCHEMA.SNOWFLAKE_PRIVATE_KEY_SECRET)
  ENABLED = TRUE;
```

Then restart the service:
```sql
ALTER SERVICE DB.SCHEMA.TRUCK_CONFIGURATOR_SVC SUSPEND;
ALTER SERVICE DB.SCHEMA.TRUCK_CONFIGURATOR_SVC RESUME;
```

## Service Shows Old Code After Docker Push

**Symptom**: After rebuilding and pushing Docker image, the service still runs old code.

**Cause**: SPCS caches Docker images. Using the same tag (e.g., `v1`) won't trigger a pull.

**Fix**: Always use a unique tag (setup.sh does this with timestamps):
```bash
TAG="v2-$(date +%s)"
docker buildx build --platform linux/amd64 --no-cache -t truck-config:$TAG .
docker tag truck-config:$TAG $REPO_URL/truck-config:$TAG
docker push $REPO_URL/truck-config:$TAG
```

Then update the service spec with the new tag.

## Network Policy Blocks SPCS

**Symptom**: Service starts but endpoint is unreachable from browser.

**Cause**: Account-level network policy doesn't include SPCS egress CIDRs.

**Check**:
```sql
SHOW PARAMETERS LIKE 'NETWORK_POLICY' IN ACCOUNT;
-- Then describe the policy:
DESCRIBE NETWORK POLICY <policy_name>;
-- Look for 153.45.59.0/24 in ALLOWED_IP_LIST
```

**Fix**: Add SPCS CIDR to the policy:
```sql
ALTER NETWORK POLICY <policy_name> SET ALLOWED_IP_LIST = (
  -- existing IPs...,
  '153.45.59.0/24'
);
```

Or run `./fix_network_policy.sh`.

## Cannot Connect to Snowflake from Container

**Symptom**: Backend logs show "connection refused" or "authentication failed".

**Check service logs**:
```sql
CALL SYSTEM$GET_SERVICE_LOGS('DB.SCHEMA.TRUCK_CONFIGURATOR_SVC', 0, 'truck-configurator', 100);
```

**Common causes**:
1. `SNOWFLAKE_PRIVATE_KEY` not mounted -- check service spec `secrets:` section
2. Wrong secret key reference -- must be `secretKeyRef: secret_string` (not `token`)
3. Private key format wrong -- must be PEM format with `-----BEGIN PRIVATE KEY-----`

## Setup Script Fails at "Testing Connection"

**Fix**: Verify your CLI connection works:
```bash
snow connection test -c <your-connection>
snow sql -q "SELECT CURRENT_USER()" -c <your-connection>
```

If using key-pair auth, ensure `connections.toml` has:
```toml
[connections.myconn]
account = "ORG-ACCOUNT"
user = "USERNAME"
authenticator = "SNOWFLAKE_JWT"
private_key_file = "~/.snowflake/keys/mykey.p8"
```

## RSA Key Fingerprint Mismatch

**Symptom**: Setup warns about fingerprint mismatch.

**Cause**: The private key in your `connections.toml` doesn't match the RSA_PUBLIC_KEY set on your Snowflake user.

**Check**:
```bash
# Local fingerprint
openssl pkey -in ~/.snowflake/keys/mykey.p8 -pubout -outform DER | openssl dgst -sha256 -binary | base64

# Remote fingerprint
snow sql -q "DESCRIBE USER <username>" -c <connection> --format json | python3 -c "import sys,json; [print(r) for r in json.load(sys.stdin) if r.get('property')=='RSA_PUBLIC_KEY_FP']"
```

If they don't match, you may need to update the RSA_PUBLIC_KEY on the user or use the correct private key file.

## SPECS Data Shows NULL / Validation Fails

**Symptom**: Validation endpoint returns no issues, or all SPECS values are NULL.

**Cause**: The `02b_bom_data.sql` script may have been loaded without the SPECS column (13th column with `PARSE_JSON()`).

**Check**:
```bash
snow sql -q "SELECT COUNT(*), COUNT(SPECS) FROM BOM.TRUCK_CONFIG.BOM_TBL;" -c <connection>
```
Both counts should be 253. If `COUNT(SPECS)` is 0, SPECS data is missing.

**Important**: Do NOT use the `snowflake_sql_execute` IDE tool to verify VARIANT columns — it can report non-null values when the actual data is NULL. Always use `snow sql` CLI.

**Fix**: Re-run the BOM data load:
```bash
snow sql -f scripts/02b_bom_data.sql -c <connection>
```

## Document Upload Times Out or Fails

**Symptom**: Upload modal spins indefinitely or shows an error after uploading a PDF.

**Background**: The upload pipeline runs AI_PARSE_DOCUMENT (OCR) + CORTEX.COMPLETE in a background thread. The frontend polls `GET /upload-status` every 2 seconds for up to 4 minutes (120 polls).

**Check service logs**:
```sql
SELECT SYSTEM$GET_SERVICE_LOGS('BOM.TRUCK_CONFIG.TRUCK_CONFIGURATOR_SVC', 0, 'truck-configurator', 500);
```

Look for lines starting with `DEBUG:` in the upload pipeline.

**Common causes**:
1. **AI_PARSE_DOCUMENT timeout** — If using LAYOUT mode instead of OCR, parsing can take 3+ minutes. The current code uses OCR mode (~3 seconds). Check that `'mode': 'OCR'` is in the SQL.
2. **CORTEX.COMPLETE JSON parse failure** — The LLM may return markdown-wrapped JSON. The SQL uses `REGEXP_SUBSTR(REPLACE(REPLACE(response, '```json', ''), '```', ''), '\\[\\s\\S]*\\]')` to strip it.
3. **No matching component groups** — If the document mentions components not in BOM_TBL, zero rules will be created. This is normal (rules_created=0 is not an error).
4. **LINKED_OPTION_ID not set** — If no linked part is selected in the UI, rules are inserted with NULL LINKED_OPTION_ID and won't appear in validation. Upload with a linked option selected.

**AI_PARSE_DOCUMENT modes**:
- **OCR** (~3 seconds): Returns full text as single block. Current default.
- **LAYOUT** (3+ minutes): Returns page-by-page structured content. Warehouse size does NOT affect performance.

## Warehouse Not Found After Teardown

**Symptom**: `snow connection test` or `snow sql` fails with "No active warehouse" after running teardown.

**Cause**: The user's `DEFAULT_WAREHOUSE` still points to the dropped warehouse.

**Fix**:
```sql
ALTER USER <username> UNSET DEFAULT_WAREHOUSE;
```
