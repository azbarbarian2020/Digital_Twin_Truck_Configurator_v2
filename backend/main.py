import os
import json
import time
import hashlib
import base64
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import snowflake.connector
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
import jwt

app = FastAPI(title="Truck Configurator API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SNOWFLAKE_ACCOUNT = os.getenv("SNOWFLAKE_ACCOUNT", "")
SNOWFLAKE_ACCOUNT_LOCATOR = os.getenv("SNOWFLAKE_ACCOUNT_LOCATOR", "")
SNOWFLAKE_HOST = os.getenv("SNOWFLAKE_HOST", "")
SNOWFLAKE_WAREHOUSE = os.getenv("SNOWFLAKE_WAREHOUSE", "TRUCK_CONFIG_WH")
SNOWFLAKE_DATABASE = os.getenv("SNOWFLAKE_DATABASE", "BOM")
SNOWFLAKE_SCHEMA = os.getenv("SNOWFLAKE_SCHEMA", "TRUCK_CONFIG")
SNOWFLAKE_USER = os.getenv("SNOWFLAKE_USER", "")

if SNOWFLAKE_ACCOUNT and (not SNOWFLAKE_HOST or SNOWFLAKE_ACCOUNT_LOCATOR.lower() in SNOWFLAKE_HOST.lower()):
    SNOWFLAKE_HOST = f"{SNOWFLAKE_ACCOUNT.lower()}.snowflakecomputing.com"
    print(f"Using org-account host: {SNOWFLAKE_HOST}")

_connection = None
_jwt_token = None
_jwt_expiry = 0


def generate_jwt_token() -> str:
    """Generate JWT token using private key for REST API authentication"""
    global _jwt_token, _jwt_expiry
    
    current_time = int(time.time())
    if _jwt_token and current_time < _jwt_expiry - 60:
        return _jwt_token
    
    private_key_pem = os.getenv("SNOWFLAKE_PRIVATE_KEY", "")
    if not private_key_pem:
        raise ValueError("SNOWFLAKE_PRIVATE_KEY not set")
    
    if "-----BEGIN" not in private_key_pem:
        private_key_pem = f"-----BEGIN PRIVATE KEY-----\n{private_key_pem}\n-----END PRIVATE KEY-----"
    
    private_key = serialization.load_pem_private_key(
        private_key_pem.encode(),
        password=None,
        backend=default_backend()
    )
    
    public_key = private_key.public_key()
    public_key_bytes = public_key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo
    )
    sha256hash = hashlib.sha256()
    sha256hash.update(public_key_bytes)
    public_key_fp = "SHA256:" + base64.b64encode(sha256hash.digest()).decode('utf-8')
    
    account_for_jwt = SNOWFLAKE_ACCOUNT_LOCATOR.upper()
    if not account_for_jwt:
        raise ValueError("SNOWFLAKE_ACCOUNT_LOCATOR not set - required for JWT")
    
    qualified_username = f"{account_for_jwt}.{SNOWFLAKE_USER.upper()}"
    
    print(f"JWT qualified_username: {qualified_username}")
    print(f"JWT public_key_fp: {public_key_fp}")
    
    now = int(time.time())
    lifetime = 59 * 60
    
    payload = {
        "iss": f"{qualified_username}.{public_key_fp}",
        "sub": qualified_username,
        "iat": now,
        "exp": now + lifetime
    }
    
    _jwt_token = jwt.encode(payload, private_key, algorithm="RS256")
    _jwt_expiry = now + lifetime
    
    print(f"Generated new JWT token, expires in {lifetime}s")
    return _jwt_token

def get_auth_header() -> Dict[str, str]:
    """Get authentication header for Snowflake REST APIs using Key-Pair JWT."""
    jwt_token = generate_jwt_token()
    return {
        "Authorization": f"Bearer {jwt_token}",
        "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
        "Content-Type": "application/json",
    }

def _create_connection():
    private_key_pem = os.getenv("SNOWFLAKE_PRIVATE_KEY", "")
    if private_key_pem:
        if "-----BEGIN" not in private_key_pem:
            private_key_pem = f"-----BEGIN PRIVATE KEY-----\n{private_key_pem}\n-----END PRIVATE KEY-----"
        return snowflake.connector.connect(
            account=SNOWFLAKE_ACCOUNT,
            user=SNOWFLAKE_USER,
            private_key=serialization.load_pem_private_key(
                private_key_pem.encode(),
                password=None,
                backend=default_backend()
            ),
            warehouse=SNOWFLAKE_WAREHOUSE,
            database=SNOWFLAKE_DATABASE,
            schema=SNOWFLAKE_SCHEMA,
        )
    else:
        conn_name = os.getenv("SNOWFLAKE_CONNECTION_NAME", "")
        return snowflake.connector.connect(
            connection_name=conn_name,
            warehouse=SNOWFLAKE_WAREHOUSE,
            database=SNOWFLAKE_DATABASE,
            schema=SNOWFLAKE_SCHEMA,
        )

def get_connection():
    global _connection
    if _connection is not None:
        try:
            _connection.cursor().execute("SELECT 1")
            return _connection
        except:
            _connection = None
    
    print("Connecting with Key-Pair authentication" if os.getenv("SNOWFLAKE_PRIVATE_KEY", "") else "Connecting with connection name (local dev)")
    _connection = _create_connection()
    return _connection

def query(sql: str) -> List[Dict]:
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(sql)
        if cursor.description:
            columns = [col[0] for col in cursor.description]
            rows = cursor.fetchall()
            return [dict(zip(columns, row)) for row in rows]
        return []
    finally:
        cursor.close()

def query_single(sql: str) -> Any:
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(sql)
        row = cursor.fetchone()
        return row[0] if row else None
    finally:
        cursor.close()

def get_semantic_view() -> str:
    return os.getenv("SNOWFLAKE_SEMANTIC_VIEW", f"{SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_CONFIG_ANALYST_V2")

def get_cortex_agent_path() -> str:
    return f"{SNOWFLAKE_DATABASE}/schemas/{SNOWFLAKE_SCHEMA}/agents/TRUCK_CONFIG_AGENT_V2"

# ============ CORTEX AI FUNCTIONS ============

def optimize_via_sql(model_id: str, categories_to_maximize: List[str], minimize_cost: bool) -> Dict[str, Any]:
    """Use direct SQL for optimization - bypasses REST API auth issues"""
    try:
        print(f"SQL-based optimization: model={model_id}, maximize={categories_to_maximize}, minimize_cost={minimize_cost}")
        
        if categories_to_maximize and minimize_cost:
            cat_list = ", ".join([f"'{c}'" for c in categories_to_maximize])
            sql = f"""
                WITH component_priority AS (
                    SELECT 
                        b.COMPONENT_GROUP,
                        MAX(CASE WHEN b.PERFORMANCE_CATEGORY IN ({cat_list}) THEN 1 ELSE 0 END) as should_maximize
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    WHERE t.MODEL_ID = '{model_id}'
                    GROUP BY b.COMPONENT_GROUP
                ),
                ranked_maximize AS (
                    SELECT 
                        b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.COST_USD, b.WEIGHT_LBS,
                        b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE, b.SYSTEM_NM, b.SUBSYSTEM_NM,
                        ROW_NUMBER() OVER (PARTITION BY b.COMPONENT_GROUP ORDER BY b.PERFORMANCE_SCORE DESC, b.COST_USD ASC) as rn
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    JOIN component_priority cp ON b.COMPONENT_GROUP = cp.COMPONENT_GROUP
                    WHERE t.MODEL_ID = '{model_id}'
                      AND cp.should_maximize = 1
                      AND b.PERFORMANCE_CATEGORY IN ({cat_list})
                ),
                ranked_minimize AS (
                    SELECT 
                        b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.COST_USD, b.WEIGHT_LBS,
                        b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE, b.SYSTEM_NM, b.SUBSYSTEM_NM,
                        ROW_NUMBER() OVER (PARTITION BY b.COMPONENT_GROUP ORDER BY b.COST_USD ASC, b.PERFORMANCE_SCORE DESC) as rn
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    JOIN component_priority cp ON b.COMPONENT_GROUP = cp.COMPONENT_GROUP
                    WHERE t.MODEL_ID = '{model_id}'
                      AND cp.should_maximize = 0
                )
                SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, 
                       PERFORMANCE_CATEGORY, PERFORMANCE_SCORE, SYSTEM_NM, SUBSYSTEM_NM
                FROM ranked_maximize WHERE rn = 1
                UNION ALL
                SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, 
                       PERFORMANCE_CATEGORY, PERFORMANCE_SCORE, SYSTEM_NM, SUBSYSTEM_NM
                FROM ranked_minimize WHERE rn = 1
                ORDER BY SYSTEM_NM, SUBSYSTEM_NM, COMPONENT_GROUP
            """
        elif categories_to_maximize:
            cat_list = ", ".join([f"'{c}'" for c in categories_to_maximize])
            sql = f"""
                WITH relevant_component_groups AS (
                    -- Only find component groups that have options matching the requested categories
                    SELECT DISTINCT b.COMPONENT_GROUP
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    WHERE t.MODEL_ID = '{model_id}'
                      AND b.PERFORMANCE_CATEGORY IN ({cat_list})
                ),
                ranked_options AS (
                    SELECT 
                        b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.COST_USD, b.WEIGHT_LBS,
                        b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE, b.SYSTEM_NM, b.SUBSYSTEM_NM,
                        ROW_NUMBER() OVER (PARTITION BY b.COMPONENT_GROUP ORDER BY b.PERFORMANCE_SCORE DESC, b.COST_USD ASC) as rn
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    JOIN relevant_component_groups rcg ON b.COMPONENT_GROUP = rcg.COMPONENT_GROUP
                    WHERE t.MODEL_ID = '{model_id}'
                      AND b.PERFORMANCE_CATEGORY IN ({cat_list})
                )
                SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS,
                       PERFORMANCE_CATEGORY, PERFORMANCE_SCORE, SYSTEM_NM, SUBSYSTEM_NM
                FROM ranked_options
                WHERE rn = 1
                ORDER BY SYSTEM_NM, SUBSYSTEM_NM, COMPONENT_GROUP
            """
        else:
            sql = f"""
                WITH ranked_options AS (
                    SELECT 
                        b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.COST_USD, b.WEIGHT_LBS,
                        b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE, b.SYSTEM_NM, b.SUBSYSTEM_NM,
                        ROW_NUMBER() OVER (PARTITION BY b.COMPONENT_GROUP ORDER BY b.COST_USD ASC) as rn
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    WHERE t.MODEL_ID = '{model_id}'
                )
                SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS,
                       PERFORMANCE_CATEGORY, PERFORMANCE_SCORE, SYSTEM_NM, SUBSYSTEM_NM
                FROM ranked_options
                WHERE rn = 1
                ORDER BY SYSTEM_NM, SUBSYSTEM_NM, COMPONENT_GROUP
            """
        
        results = query(sql)
        print(f"SQL optimization returned {len(results)} rows")
        return {"results": results, "sql": sql, "error": None}
    except Exception as e:
        print(f"SQL optimization failed: {e}")
        return {"results": [], "sql": None, "error": str(e)}

def optimize_via_sql_weight(model_id: str, categories_to_maximize: List[str], minimize_weight: bool) -> Dict[str, Any]:
    """Optimize configuration prioritizing weight minimization"""
    try:
        print(f"Weight optimization: model={model_id}, maximize={categories_to_maximize}, minimize_weight={minimize_weight}")
        
        if categories_to_maximize and minimize_weight:
            # Maximize specified categories, minimize weight for others
            cat_list = ", ".join([f"'{c}'" for c in categories_to_maximize])
            sql = f"""
                WITH component_priority AS (
                    SELECT 
                        b.COMPONENT_GROUP,
                        MAX(CASE WHEN b.PERFORMANCE_CATEGORY IN ({cat_list}) THEN 1 ELSE 0 END) as should_maximize
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    WHERE t.MODEL_ID = '{model_id}'
                    GROUP BY b.COMPONENT_GROUP
                ),
                ranked_maximize AS (
                    SELECT 
                        b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.COST_USD, b.WEIGHT_LBS,
                        b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE, b.SYSTEM_NM, b.SUBSYSTEM_NM,
                        ROW_NUMBER() OVER (PARTITION BY b.COMPONENT_GROUP ORDER BY b.PERFORMANCE_SCORE DESC, b.WEIGHT_LBS ASC) as rn
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    JOIN component_priority cp ON b.COMPONENT_GROUP = cp.COMPONENT_GROUP
                    WHERE t.MODEL_ID = '{model_id}'
                      AND cp.should_maximize = 1
                      AND b.PERFORMANCE_CATEGORY IN ({cat_list})
                ),
                ranked_minimize AS (
                    SELECT 
                        b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.COST_USD, b.WEIGHT_LBS,
                        b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE, b.SYSTEM_NM, b.SUBSYSTEM_NM,
                        ROW_NUMBER() OVER (PARTITION BY b.COMPONENT_GROUP ORDER BY b.WEIGHT_LBS ASC, b.PERFORMANCE_SCORE DESC) as rn
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    JOIN component_priority cp ON b.COMPONENT_GROUP = cp.COMPONENT_GROUP
                    WHERE t.MODEL_ID = '{model_id}'
                      AND cp.should_maximize = 0
                )
                SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, 
                       PERFORMANCE_CATEGORY, PERFORMANCE_SCORE, SYSTEM_NM, SUBSYSTEM_NM
                FROM ranked_maximize WHERE rn = 1
                UNION ALL
                SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, 
                       PERFORMANCE_CATEGORY, PERFORMANCE_SCORE, SYSTEM_NM, SUBSYSTEM_NM
                FROM ranked_minimize WHERE rn = 1
                ORDER BY SYSTEM_NM, SUBSYSTEM_NM, COMPONENT_GROUP
            """
        else:
            # Just minimize weight across all components
            sql = f"""
                WITH ranked_options AS (
                    SELECT 
                        b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.COST_USD, b.WEIGHT_LBS,
                        b.PERFORMANCE_CATEGORY, b.PERFORMANCE_SCORE, b.SYSTEM_NM, b.SUBSYSTEM_NM,
                        ROW_NUMBER() OVER (PARTITION BY b.COMPONENT_GROUP ORDER BY b.WEIGHT_LBS ASC) as rn
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    WHERE t.MODEL_ID = '{model_id}'
                )
                SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS,
                       PERFORMANCE_CATEGORY, PERFORMANCE_SCORE, SYSTEM_NM, SUBSYSTEM_NM
                FROM ranked_options
                WHERE rn = 1
                ORDER BY SYSTEM_NM, SUBSYSTEM_NM, COMPONENT_GROUP
            """
        
        results = query(sql)
        print(f"Weight optimization returned {len(results)} rows")
        return {"results": results, "sql": sql, "error": None}
    except Exception as e:
        print(f"Weight optimization failed: {e}")
        return {"results": [], "sql": None, "error": str(e)}

def call_cortex_analyst_via_complete(question: str, model_id: str) -> Dict[str, Any]:
    """Use Cortex COMPLETE to generate SQL for optimization - works via SQL connector"""
    try:
        schema_info = f"""
Tables in {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}:
- BOM_TBL: OPTION_ID, OPTION_NM, SYSTEM_NM, SUBSYSTEM_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, PERFORMANCE_CATEGORY (Safety|Comfort|Power|Economy|Durability|Hauling), PERFORMANCE_SCORE (1-10)
- TRUCK_OPTIONS: MODEL_ID, OPTION_ID, IS_DEFAULT (join table linking models to available options)
- MODEL_TBL: MODEL_ID, MODEL_NM, BASE_MSRP, BASE_WEIGHT_LBS

Current MODEL_ID: {model_id}
"""
        
        prompt = f"""You are a SQL expert. Generate a Snowflake SQL query for this request.

{schema_info}

User request: {question}

Requirements:
1. Join BOM_TBL with TRUCK_OPTIONS to get options for the specific MODEL_ID
2. Return: OPTION_ID, OPTION_NM, COMPONENT_GROUP, COST_USD, WEIGHT_LBS, PERFORMANCE_CATEGORY, PERFORMANCE_SCORE
3. Select ONE best option per COMPONENT_GROUP based on the user's optimization criteria
4. Use window functions with ROW_NUMBER() partitioned by COMPONENT_GROUP

Return ONLY the SQL query, no explanation."""

        escaped_prompt = prompt.replace("'", "''").replace("\\", "\\\\")
        sql = f"SELECT SNOWFLAKE.CORTEX.COMPLETE('mistral-large2', '{escaped_prompt}') as response"
        result = query_single(sql)
        
        if result:
            generated_sql = result.strip()
            if generated_sql.startswith("```"):
                generated_sql = generated_sql.split("```")[1]
                if generated_sql.startswith("sql"):
                    generated_sql = generated_sql[3:]
            generated_sql = generated_sql.strip()
            
            if generated_sql.upper().startswith("SELECT"):
                print(f"COMPLETE generated SQL: {generated_sql[:200]}...")
                return {"response": None, "sql": generated_sql, "error": None}
        
        return {"response": None, "sql": None, "error": "Failed to generate SQL"}
    except Exception as e:
        print(f"Cortex COMPLETE SQL generation failed: {e}")
        return {"response": None, "sql": None, "error": str(e)}

def call_cortex_agent(message: str) -> Dict[str, Any]:
    """Call Cortex Agent REST API with proper authentication"""
    agent_path = get_cortex_agent_path()
    url = f"https://{SNOWFLAKE_HOST}/api/v2/databases/{agent_path}:run"
    
    request_body = {
        "messages": [{"role": "user", "content": [{"type": "text", "text": message}]}]
    }
    
    headers = get_auth_header()
    headers["Accept"] = "text/event-stream"
    
    print(f"Calling Cortex Agent: {message[:100]}...")
    
    try:
        response = requests.post(url, json=request_body, headers=headers, timeout=120, stream=True)
        
        if not response.ok:
            print(f"Agent error: {response.status_code}")
            return {"response": None, "error": response.text}
        
        full_text = ""
        for line in response.iter_lines():
            if line:
                line_str = line.decode('utf-8')
                if line_str.startswith("data: "):
                    try:
                        data = json.loads(line_str[6:])
                        if data.get("role") == "assistant" and data.get("content"):
                            for item in data["content"]:
                                if item.get("type") == "text":
                                    full_text = item.get("text", "")
                        if data.get("text") and not data.get("content_index"):
                            full_text += data.get("text", "")
                    except json.JSONDecodeError:
                        pass
        
        print(f"Agent returned {len(full_text)} chars")
        return {"response": full_text, "error": None}
    except Exception as e:
        print(f"Agent call failed: {e}")
        return {"response": None, "error": str(e)}

def call_cortex_complete(prompt: str, model: str = "claude-3-5-sonnet") -> str:
    """Call Cortex Complete via SQL (always works with SPCS)"""
    try:
        escaped_prompt = prompt.replace("'", "''").replace("\\", "\\\\")
        sql = f"SELECT SNOWFLAKE.CORTEX.COMPLETE('{model}', '{escaped_prompt}') as response"
        result = query_single(sql)
        return result if result else ""
    except Exception as e:
        print(f"Cortex COMPLETE error: {e}")
        return ""

def call_cortex_search(search_query: str, limit: int = 5) -> List[Dict]:
    """Call Cortex Search via SQL using SEARCH_PREVIEW"""
    try:
        escaped_query = search_query.replace("'", "''").replace('"', '\\"')
        sql = f"""
            SELECT PARSE_JSON(SNOWFLAKE.CORTEX.SEARCH_PREVIEW(
                '{SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_SEARCH',
                '{{"query": "{escaped_query}", "columns": ["CHUNK_TEXT", "DOC_TITLE", "DOC_ID"], "limit": {limit}}}'
            )):results as results
        """
        result = query_single(sql)
        if result:
            import json
            parsed = json.loads(result) if isinstance(result, str) else result
            return parsed if isinstance(parsed, list) else []
        return []
    except Exception as e:
        print(f"Cortex Search error: {e}")
        return []

# ============ API ENDPOINTS ============

@app.get("/api/health")
def health():
    try:
        query("SELECT 1")
        return {"status": "ok", "database": "connected"}
    except Exception as e:
        return {"status": "error", "error": str(e)}

@app.get("/api/models")
def get_models():
    try:
        sql = f"SELECT * FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.MODEL_TBL ORDER BY BASE_MSRP"
        return query(sql)
    except Exception as e:
        print(f"Error fetching models: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/options")
def get_options(modelId: Optional[str] = None):
    try:
        base_sql = f"""
            SELECT b.OPTION_ID, b.OPTION_NM, t.MODEL_ID, b.SYSTEM_NM, b.SUBSYSTEM_NM, 
                   b.COMPONENT_GROUP, b.COST_USD, b.WEIGHT_LBS, b.PERFORMANCE_CATEGORY, 
                   b.PERFORMANCE_SCORE, t.IS_DEFAULT, b.DESCRIPTION, b.SPECS
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t
            JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b ON t.OPTION_ID = b.OPTION_ID
        """
        if modelId:
            sql = f"{base_sql} WHERE t.MODEL_ID = '{modelId}' ORDER BY b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP, b.COST_USD"
        else:
            sql = f"{base_sql} ORDER BY b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP, b.COST_USD"
        
        options = query(sql)
        
        # Parse SPECS JSON for each option
        for opt in options:
            if opt.get("SPECS") and isinstance(opt["SPECS"], str):
                try:
                    opt["SPECS"] = json.loads(opt["SPECS"])
                except:
                    pass
        
        hierarchy = {}
        for opt in options:
            system = opt.get("SYSTEM_NM", "Other")
            subsystem = opt.get("SUBSYSTEM_NM", "Other")
            component_group = opt.get("COMPONENT_GROUP", "Other")
            
            if system not in hierarchy:
                hierarchy[system] = {"subsystems": {}}
            if subsystem not in hierarchy[system]["subsystems"]:
                hierarchy[system]["subsystems"][subsystem] = {"componentGroups": {}}
            if component_group not in hierarchy[system]["subsystems"][subsystem]["componentGroups"]:
                hierarchy[system]["subsystems"][subsystem]["componentGroups"][component_group] = []
            hierarchy[system]["subsystems"][subsystem]["componentGroups"][component_group].append(opt)
        
        model_options = [{"OPTION_ID": str(opt["OPTION_ID"]), "IS_DEFAULT": opt.get("IS_DEFAULT", False)} for opt in options]
        
        return {"hierarchy": hierarchy, "options": options, "modelOptions": model_options}
    except Exception as e:
        print(f"Error fetching options: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/configs")
def get_configs():
    try:
        sql = f"""
            SELECT CONFIG_ID, CONFIG_NAME, MODEL_ID, CONFIG_OPTIONS, 
                   TOTAL_COST_USD, TOTAL_WEIGHT_LBS, PERFORMANCE_SUMMARY, NOTES,
                   IS_VALIDATED, CREATED_AT
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.SAVED_CONFIGS
            ORDER BY CREATED_AT DESC
        """
        results = query(sql)
        for r in results:
            if r.get("CONFIG_OPTIONS") and isinstance(r["CONFIG_OPTIONS"], str):
                try:
                    r["CONFIG_OPTIONS"] = json.loads(r["CONFIG_OPTIONS"])
                except:
                    pass
            if r.get("PERFORMANCE_SUMMARY") and isinstance(r["PERFORMANCE_SUMMARY"], str):
                try:
                    r["PERFORMANCE_SUMMARY"] = json.loads(r["PERFORMANCE_SUMMARY"])
                except:
                    pass
        return results
    except Exception as e:
        print(f"Error fetching configs: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class SaveConfigRequest(BaseModel):
    configName: str
    modelId: str
    selectedOptions: List[str]
    totalCost: float
    totalWeight: float
    performanceSummary: Dict[str, Any]
    notes: Optional[str] = ""
    isValidated: Optional[bool] = False

@app.post("/api/configs")
def save_config(req: SaveConfigRequest):
    try:
        config_id = f"CFG-{int(time.time() * 1000)}"
        options_json = json.dumps(req.selectedOptions).replace("'", "''")
        perf_json = json.dumps(req.performanceSummary).replace("'", "''")
        notes_escaped = (req.notes or "").replace("'", "''")
        
        sql = f"""
            INSERT INTO {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.SAVED_CONFIGS 
            (CONFIG_ID, CONFIG_NAME, MODEL_ID, CONFIG_OPTIONS, TOTAL_COST_USD, TOTAL_WEIGHT_LBS, 
             PERFORMANCE_SUMMARY, NOTES, IS_VALIDATED)
            SELECT '{config_id}', '{req.configName.replace("'", "''")}', '{req.modelId}', 
                   PARSE_JSON('{options_json}'), {req.totalCost}, {req.totalWeight},
                   PARSE_JSON('{perf_json}'), '{notes_escaped}', {str(req.isValidated).upper()}
        """
        query(sql)
        
        return {"success": True, "configId": config_id}
    except Exception as e:
        print(f"Error saving config: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/configs/{config_id}")
def delete_config(config_id: str):
    try:
        sql = f"""
            DELETE FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.SAVED_CONFIGS 
            WHERE CONFIG_ID = '{config_id.replace("'", "''")}'
        """
        query(sql)
        return {"success": True}
    except Exception as e:
        print(f"Error deleting config: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class UpdateConfigRequest(BaseModel):
    configId: str
    configName: str
    notes: Optional[str] = ""

@app.put("/api/configs")
def update_config(req: UpdateConfigRequest):
    try:
        sql = f"""
            UPDATE {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.SAVED_CONFIGS 
            SET CONFIG_NAME = '{req.configName.replace("'", "''")}',
                NOTES = '{(req.notes or "").replace("'", "''")}',
                UPDATED_AT = CURRENT_TIMESTAMP()
            WHERE CONFIG_ID = '{req.configId.replace("'", "''")}'
        """
        query(sql)
        return {"success": True}
    except Exception as e:
        print(f"Error updating config: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============ CHAT / OPTIMIZATION ============

class ChatRequest(BaseModel):
    message: str
    modelId: Optional[str] = None
    selectedOptions: Optional[List[Any]] = None
    modelInfo: Optional[Dict[str, Any]] = None
    
    class Config:
        extra = "allow"

@app.post("/api/chat")
def chat(req: ChatRequest):
    """Handle chat requests using Cortex AI to generate intelligent SQL"""
    try:
        message = req.message
        model_id = req.modelId
        
        if not model_id and req.modelInfo:
            model_id = req.modelInfo.get("modelId")
        
        if not model_id:
            return {"response": "Please select a truck model first to get optimization recommendations."}
        
        selected_option_ids = []
        if req.selectedOptions:
            if isinstance(req.selectedOptions, list):
                for opt in req.selectedOptions:
                    if isinstance(opt, dict):
                        selected_option_ids.append(str(opt.get("optionId", "")))
                    else:
                        selected_option_ids.append(str(opt))
        
        print(f"=== CHAT REQUEST ===")
        print(f"Message: {message}")
        print(f"Model: {model_id}")
        print(f"Selected Options Count: {len(selected_option_ids)}")
        
        lower_msg = message.lower()
        
        # Check if asking about engineering docs / specifications
        is_doc_query = any(kw in lower_msg for kw in [
            'specification', 'document', 'attached', 'linked', 'spec doc',
            'engineering doc', 'which options have', 'what has', 'upload',
            'file', 'pdf', 'object', 'part has', 'requirement', 'what docs',
            'which parts', 'what objects'
        ])
        
        if is_doc_query:
            return handle_doc_query(message, model_id)
        
        # Check if this is an optimization request
        is_optimization = any(kw in lower_msg for kw in ['maximize', 'minimize', 'optimize', 'best', 'cheapest', 'lightest', 'lightweight', 'recommend', 'performance', 'all categories'])
        
        if is_optimization:
            # Use AI to understand and generate SQL
            print("Using Cortex AI to generate optimization SQL...")
            
            ai_result = generate_optimization_sql_with_ai(message, model_id)
            
            if ai_result.get("sql"):
                try:
                    sql_results = query(ai_result["sql"])
                    print(f"AI-generated SQL returned {len(sql_results)} rows")
                    
                    if sql_results:
                        recommendations = []
                        recommended_ids = []
                        for r in sql_results:
                            cg = r.get("COMPONENT_GROUP", r.get("component_group", ""))
                            opt_id = str(r.get("OPTION_ID", r.get("option_id", "")))
                            score = float(r.get("PERFORMANCE_SCORE", r.get("performance_score", 0)) or 0)
                            cost = float(r.get("COST_USD", r.get("cost_usd", 0)) or 0)
                            weight = float(r.get("WEIGHT_LBS", r.get("weight_lbs", 0)) or 0)
                            perf_cat = r.get("PERFORMANCE_CATEGORY", r.get("performance_category", ""))
                            
                            recommended_ids.append(opt_id)
                            
                            reason = ai_result.get("reasoning", {}).get(cg, f"Best match for '{message}'")
                            if not reason or reason == f"Best match for '{message}'":
                                if score >= 8:
                                    reason = f"Top performer ({perf_cat}, score: {score})"
                                elif cost <= 500:
                                    reason = f"Budget-friendly (${cost:,.0f})"
                                else:
                                    reason = f"Optimized for your request"
                            
                            recommendations.append({
                                "optionId": opt_id,
                                "optionName": r.get("OPTION_NM", r.get("option_nm", "")),
                                "componentGroup": cg,
                                "cost": cost,
                                "weight": weight,
                                "reason": reason,
                                "action": "optimize",
                                "performanceCategory": perf_cat
                            })
                        
                        if recommendations:
                            total_cost = sum(r["cost"] for r in recommendations)
                            total_weight = sum(r["weight"] for r in recommendations)
                            
                            summary = ai_result.get("summary", f"Found {len(recommendations)} optimizations based on your request.")
                            
                            return {
                                "response": f"**AI-Optimized Configuration** (Powered by Cortex AI)\n\n{summary}\n\n**Total: ${total_cost:,.0f}** | Weight: {total_weight:,.0f} lbs\n\nClick Apply to update your configuration.",
                                "recommendations": recommendations,
                                "canApply": True,
                                "applyAction": {
                                    "type": "optimize",
                                    "optionIds": recommended_ids,
                                    "summary": f"Apply {len(recommendations)} AI optimizations"
                                }
                            }
                except Exception as e:
                    print(f"AI-generated SQL execution failed: {e}")
            
            # If AI fails, provide helpful message
            return {"response": f"I understood your request: '{message}'. However, I couldn't generate a valid optimization. Try being more specific, like 'maximize power and safety' or 'minimize all costs'."}
        
        # For non-optimization queries, check engineering docs for context via Cortex Search
        search_results = call_cortex_search(message, limit=3)
        if search_results:
            context_chunks = []
            for r in search_results:
                chunk = r.get("CHUNK_TEXT", "") if isinstance(r, dict) else ""
                if chunk:
                    context_chunks.append(chunk)
            if context_chunks:
                context = "\n\n".join(context_chunks)[:4000]
                search_prompt = f"""You are a truck configuration assistant. Use the following engineering document context to answer the user's question.

ENGINEERING DOCUMENT CONTEXT:
{context}

USER QUESTION: {message}

Provide a helpful, concise answer based on the context. If the context doesn't help answer the question, say so and provide general truck configuration guidance."""
                ai_response = call_cortex_complete(search_prompt, "mistral-large2")
                if ai_response:
                    return {"response": ai_response}

        ai_response = call_cortex_complete(f"User asked about truck configuration: {message}. Provide a helpful, concise response about truck configuration options.", "mistral-large2")
        if ai_response:
            return {"response": ai_response}
        
        return {"response": "I can help you optimize your truck configuration. Try asking me to 'maximize comfort and safety while minimizing other costs'."}
    
    except Exception as e:
        print(f"Chat error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def handle_doc_query(message: str, model_id: str) -> Dict[str, Any]:
    """Handle questions about engineering documents and linked parts"""
    try:
        docs_with_parts = query(f"""
            SELECT DISTINCT
                vr.DOC_TITLE, vr.LINKED_OPTION_ID,
                b.OPTION_NM, b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.VALIDATION_RULES vr
            JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                ON b.OPTION_ID = vr.LINKED_OPTION_ID
            WHERE vr.LINKED_OPTION_ID IS NOT NULL
            ORDER BY b.OPTION_NM
        """)

        rule_groups = query(f"""
            SELECT DOC_TITLE, LISTAGG(DISTINCT COMPONENT_GROUP, ', ') 
                WITHIN GROUP (ORDER BY COMPONENT_GROUP) as RULE_GROUPS
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.VALIDATION_RULES
            GROUP BY DOC_TITLE
        """)
        rule_groups_map = {r['DOC_TITLE']: r['RULE_GROUPS'] for r in rule_groups} if rule_groups else {}
        
        if not docs_with_parts:
            return {"response": "No engineering specification documents are currently linked to any BOM options. You can upload documents and link them to specific parts in the Engineering Docs panel."}
        
        seen = set()
        response_lines = ["**Options with Specification Documents:**\n"]
        for doc in docs_with_parts:
            opt_name = doc.get("OPTION_NM", "")
            doc_title = doc.get("DOC_TITLE", "")
            key = f"{opt_name}:{doc_title}"
            if key in seen:
                continue
            seen.add(key)
            system = doc.get("SYSTEM_NM", "")
            subsystem = doc.get("SUBSYSTEM_NM", "")
            cg = doc.get("COMPONENT_GROUP", "")
            groups = rule_groups_map.get(doc_title, cg)
            
            path = f"{system} → {subsystem} → {cg}"
            response_lines.append(f"• **{opt_name}** has document: *{doc_title}*")
            response_lines.append(f"  BOM Path: {path}")
            response_lines.append(f"  Validation rules cover: {groups}\n")
        
        return {"response": "\n".join(response_lines)}
    except Exception as e:
        print(f"Doc query error: {e}")
        return {"response": f"I couldn't retrieve information about specification documents. Error: {str(e)}"}

def generate_optimization_sql_with_ai(user_request: str, model_id: str) -> Dict[str, Any]:
    """Use Cortex Analyst REST API with Semantic View to generate optimization SQL"""
    try:
        question = f"For {model_id}: {user_request}"
        print(f"Cortex Analyst question: {question}")
        
        url = f"https://{SNOWFLAKE_HOST}/api/v2/cortex/analyst/message"
        
        payload = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": question
                        }
                    ]
                }
            ],
            "semantic_view": get_semantic_view()
        }
        
        headers = get_auth_header()
        print(f"Calling Cortex Analyst API: {url}")
        print(f"Auth header type: {headers.get('X-Snowflake-Authorization-Token-Type', 'JWT')}")
        
        response = requests.post(url, json=payload, headers=headers, timeout=120)
        
        if response.status_code == 200:
            result = response.json()
            print(f"Cortex Analyst response: {json.dumps(result)[:500]}...")
            
            message_content = result.get("message", {}).get("content", [])
            
            generated_sql = None
            text_explanation = ""
            
            for content_block in message_content:
                if content_block.get("type") == "sql":
                    generated_sql = content_block.get("statement", "")
                elif content_block.get("type") == "text":
                    text_explanation = content_block.get("text", "")
            
            if generated_sql:
                generated_sql = generated_sql.strip().rstrip(';')
                sql_upper = generated_sql.upper().strip()
                if sql_upper.startswith("SELECT") or sql_upper.startswith("WITH"):
                    print(f"Cortex Analyst generated SQL: {generated_sql[:200]}...")
                    summary = text_explanation or f"Optimized configuration for: {user_request}"
                    return {"sql": generated_sql, "summary": summary, "error": None}
            
            if text_explanation:
                print(f"Analyst returned text but no SQL: {text_explanation[:200]}")
                return {"sql": None, "summary": None, "error": f"Analyst response: {text_explanation}"}
        else:
            print(f"Cortex Analyst API error: {response.status_code} - {response.text[:500]}")
            return {"sql": None, "summary": None, "error": f"API error: {response.status_code}"}
        
        return {"sql": None, "summary": None, "error": "Failed to get SQL from Cortex Analyst"}
    except Exception as e:
        print(f"Cortex Analyst SQL generation failed: {e}")
        return {"sql": None, "summary": None, "error": str(e)}

# ============ VALIDATION ============

class ValidateRequest(BaseModel):
    selectedOptions: List[str]
    modelId: str
    incrementalOnly: Optional[List[str]] = None

@app.post("/api/validate")
def validate_config(req: ValidateRequest):
    """Validate configuration using pre-stored VALIDATION_RULES (fast path)"""
    try:
        if not req.selectedOptions:
            return {"isValid": True, "issues": [], "fixPlan": None}
        
        model_id = req.modelId
        
        print(f"\n=== VALIDATION API CALLED ===")
        print(f"Validating {len(req.selectedOptions)} options for model {model_id}")
        
        option_list = ",".join([f"'{o}'" for o in req.selectedOptions])
        
        options_sql = f"""
            SELECT OPTION_ID, OPTION_NM, COMPONENT_GROUP, SYSTEM_NM, 
                   PERFORMANCE_CATEGORY, SPECS
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL
            WHERE OPTION_ID IN ({option_list})
        """
        selected_options = query(options_sql)
        
        options_by_group = {}
        selected_specs = {}
        for opt in selected_options:
            cg = opt['COMPONENT_GROUP']
            options_by_group[cg] = opt
            raw_specs = opt.get('SPECS')
            if raw_specs:
                try:
                    specs = json.loads(raw_specs) if isinstance(raw_specs, str) else raw_specs if isinstance(raw_specs, dict) else {}
                except:
                    specs = {}
                selected_specs[cg] = specs
        
        validation_rules = query(f"""
            SELECT vr.RULE_ID, vr.DOC_ID, vr.DOC_TITLE, vr.LINKED_OPTION_ID,
                   vr.COMPONENT_GROUP, vr.SPEC_NAME, vr.MIN_VALUE, vr.MAX_VALUE,
                   vr.UNIT, vr.RAW_REQUIREMENT
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.VALIDATION_RULES vr
            WHERE vr.LINKED_OPTION_ID IN ({option_list})
        """)
        
        print(f"Found {len(validation_rules)} validation rules for selected options")
        
        rules_by_component = {}
        for rule in validation_rules:
            cg = rule['COMPONENT_GROUP']
            if cg not in rules_by_component:
                rules_by_component[cg] = []
            rules_by_component[cg].append(rule)
        
        issues = []
        component_fixes = {}
        
        for component_group, rules in rules_by_component.items():
            selected_opt = options_by_group.get(component_group, {})
            selected_spec = selected_specs.get(component_group, {})
            
            if not selected_opt:
                continue
            
            opt_name = selected_opt.get('OPTION_NM', 'Unknown')
            opt_id = selected_opt.get('OPTION_ID', '')
            doc_title = rules[0]['DOC_TITLE'] if rules else ''
            
            print(f"Checking {opt_name} against {len(rules)} rules for {component_group}")
            
            failed_specs = []
            all_passed = True
            
            for rule in rules:
                spec_name = rule['SPEC_NAME']
                min_val = rule['MIN_VALUE']
                max_val = rule['MAX_VALUE']
                unit = rule['UNIT'] or ''
                
                actual_value = selected_spec.get(spec_name, 0) if selected_spec else 0
                
                if min_val is not None and actual_value < float(min_val):
                    print(f"  X {spec_name}={actual_value} < {min_val} X")
                    all_passed = False
                    failed_specs.append({
                        "specName": spec_name,
                        "currentValue": float(actual_value) if actual_value else 0,
                        "requiredValue": float(min_val),
                        "unit": unit,
                        "reason": f"{spec_name}={actual_value} {unit} < required {min_val} {unit}"
                    })
                elif min_val is not None:
                    try:
                        print(f"  OK {spec_name}={float(actual_value):,.0f} >= {float(min_val):,.0f} OK")
                    except:
                        print(f"  OK {spec_name}={actual_value} >= {min_val} OK")
                
                if max_val is not None and actual_value > float(max_val):
                    all_passed = False
                    failed_specs.append({
                        "specName": spec_name,
                        "currentValue": actual_value,
                        "requiredValue": float(max_val),
                        "unit": unit,
                        "reason": f"{spec_name}={actual_value} {unit} > max {max_val} {unit}"
                    })
            
            if not all_passed:
                issue = {
                    "type": "requirement",
                    "title": f"{opt_name} Incompatible",
                    "message": f"{opt_name} does not meet {len(failed_specs)} specification(s)",
                    "relatedOptions": [opt_id],
                    "sourceDoc": doc_title,
                    "specMismatches": failed_specs
                }
                
                print(f"  Finding cheapest {component_group} meeting ALL {len(rules)} requirements...")
                escaped_component = component_group.replace("'", "''")
                candidates = query(f"""
                    SELECT b.OPTION_ID, b.OPTION_NM, b.COST_USD, b.SPECS
                    FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
                    JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t ON b.OPTION_ID = t.OPTION_ID
                    WHERE t.MODEL_ID = '{model_id}'
                      AND b.COMPONENT_GROUP = '{escaped_component}'
                    ORDER BY b.COST_USD ASC
                """)
                print(f"  Evaluating {len(candidates)} candidates...")
                
                for candidate in candidates:
                    cand_specs_raw = candidate.get('SPECS')
                    if isinstance(cand_specs_raw, str):
                        try:
                            cand_specs = json.loads(cand_specs_raw)
                        except:
                            cand_specs = {}
                    elif isinstance(cand_specs_raw, dict):
                        cand_specs = cand_specs_raw
                    else:
                        cand_specs = {}
                    
                    meets_all = True
                    for rule in rules:
                        spec_name = rule['SPEC_NAME']
                        min_val = rule['MIN_VALUE']
                        max_val = rule['MAX_VALUE']
                        cand_value = cand_specs.get(spec_name, 0)
                        
                        if min_val is not None and cand_value < float(min_val):
                            meets_all = False
                            break
                        if max_val is not None and cand_value > float(max_val):
                            meets_all = False
                            break
                    
                    if meets_all:
                        print(f"  CHEAPEST meeting ALL: {candidate['OPTION_NM']} (${candidate['COST_USD']:,.0f})")
                        issue['fixOptionId'] = candidate['OPTION_ID']
                        issue['fixOptionName'] = candidate['OPTION_NM']
                        component_fixes[component_group] = {
                            "removeId": opt_id,
                            "removeName": opt_name,
                            "addId": candidate['OPTION_ID'],
                            "addName": candidate['OPTION_NM']
                        }
                        break
                
                issues.append(issue)
        
        is_valid = len(issues) == 0
        print(f"Validation complete: isValid={is_valid}, issues={len(issues)}")
        print(f"=== VALIDATION END ===\n")
        
        fix_plan = None
        if component_fixes:
            remove_ids = []
            add_ids = []
            
            for cg, fix in component_fixes.items():
                remove_ids.append(fix["removeId"])
                add_ids.append(fix["addId"])
            
            fix_plan = {
                "explanation": f"Replace {len(remove_ids)} component(s) to meet engineering specifications",
                "remove": remove_ids,
                "add": add_ids
            }
        
        return {"isValid": is_valid, "issues": issues, "fixPlan": fix_plan}
        
    except Exception as e:
        print(f"Validation error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

# ============ AI DESCRIPTION ============

class DescribeRequest(BaseModel):
    modelName: str
    modelId: Optional[str] = None
    selectedOptions: List[str]
    totalCost: float
    totalWeight: float
    performanceSummary: Dict[str, Any]
    optimizationHistory: Optional[List[str]] = None
    manualChanges: Optional[List[str]] = None
    costDelta: Optional[float] = None
    weightDelta: Optional[float] = None

@app.post("/api/describe")
def describe_config(req: DescribeRequest):
    """Generate AI description using Cortex Complete - context-aware of optimizations and manual changes"""
    try:
        print(f"=== DESCRIBE REQUEST ===")
        print(f"Model: {req.modelName}")
        print(f"Optimization History: {req.optimizationHistory}")
        print(f"Manual Changes: {req.manualChanges}")
        print(f"Cost Delta: {req.costDelta}, Weight Delta: {req.weightDelta}")
        
        model_desc = ""
        try:
            model_lookup = query(f"""
                SELECT MODEL_ID, TRUCK_DESCRIPTION 
                FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.MODEL_TBL 
                WHERE MODEL_NM ILIKE '%{req.modelName.replace("'", "''")}%' 
                LIMIT 1
            """)
            if model_lookup:
                model_desc = model_lookup[0].get("TRUCK_DESCRIPTION", "")
        except:
            pass
        
        opt_history = req.optimizationHistory or []
        manual_changes = req.manualChanges or []
        base_desc = model_desc[:150] if model_desc else ""
        
        last_opt = opt_history[-1] if opt_history else None
        
        cost_delta = req.costDelta or 0
        weight_delta = req.weightDelta or 0
        
        cost_summary = ""
        if cost_delta > 500:
            cost_summary = f"Added ${cost_delta:,.0f} in upgrades"
        elif cost_delta < -500:
            cost_summary = f"Saved ${abs(cost_delta):,.0f} from default"
        else:
            cost_summary = "Near-default cost"
            
        weight_summary = ""
        if weight_delta > 100:
            weight_summary = f"Added {weight_delta:,.0f} lbs"
        elif weight_delta < -100:
            weight_summary = f"Saved {abs(weight_delta):,.0f} lbs"
        
        prompt = f"""Write a 2-sentence marketing description for this custom truck configuration.

BASE MODEL: {req.modelName}
{f"Base description: {base_desc}" if base_desc else ""}

CONFIGURATION STRATEGY:
{f'- AI Optimizations applied: {", ".join(opt_history)}' if opt_history else '- No AI optimizations applied'}
{f'- Manual additions: {", ".join(manual_changes[-5:])}' if manual_changes else '- No manual changes'}

KEY METRICS:
- {cost_summary}
- {weight_summary if weight_summary else "Standard weight"}
- Total: ${req.totalCost:,.0f} | {req.totalWeight:,.0f} lbs

WRITING RULES:
1. First sentence: Brief model intro (1 phrase) + primary configuration strategy
2. Second sentence: Key benefit or value proposition
3. Use natural language - no bullet points or lists
4. If "maximize X while minimizing costs" was applied: emphasize budget-friendly approach
5. If "maximize X" alone: emphasize upgraded/enhanced X capability  
6. If "minimize weight" was applied: mention weight savings
7. If manual additions exist: briefly mention notable upgrades
8. Keep it concise and marketing-focused

Examples of good output:
- "This budget-optimized F-150 maximizes safety and economy while keeping other costs minimal. Perfect for practical buyers who prioritize protection without breaking the bank."
- "This performance-enhanced Silverado features upgraded power components with a manual V8 addition. Built for those who demand maximum capability on and off the road."
- "This lightweight Ram 1500 saves 450 lbs through strategic component selection. Ideal for improved fuel efficiency and responsive handling."

Write exactly 2 sentences."""

        print(f"Sending prompt to Cortex...")
        description = call_cortex_complete(prompt, "mistral-large2")
        print(f"Cortex response: {description[:200] if description else 'None'}...")
        
        if not description:
            if opt_history:
                description = f"This {req.modelName} has been optimized for {opt_history[-1]}. {cost_summary}."
            else:
                description = f"Custom {req.modelName} configuration. Total investment: ${req.totalCost:,.0f}."
        
        return {"description": description}
    except Exception as e:
        print(f"Describe error: {e}")
        return {"description": f"Custom {req.modelName} configuration."}

# ============ ENGINEERING DOCS ============

@app.get("/api/engineering-docs")
def get_engineering_docs():
    """Get list of indexed engineering documents"""
    try:
        docs = query(f"""
            SELECT 
                DOC_ID, DOC_TITLE, DOC_PATH,
                COUNT(*) as CHUNK_COUNT
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
            GROUP BY DOC_ID, DOC_TITLE, DOC_PATH
            ORDER BY DOC_TITLE
        """)
        
        linked_parts_data = query(f"""
            SELECT DISTINCT vr.DOC_ID, vr.LINKED_OPTION_ID, 
                   b.OPTION_NM, b.COMPONENT_GROUP
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.VALIDATION_RULES vr
            JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b 
                ON b.OPTION_ID = vr.LINKED_OPTION_ID
            WHERE vr.LINKED_OPTION_ID IS NOT NULL
        """)
        
        doc_linked_parts = {}
        for row in linked_parts_data:
            doc_id = row['DOC_ID']
            if doc_id not in doc_linked_parts:
                doc_linked_parts[doc_id] = []
            doc_linked_parts[doc_id].append({
                'optionId': row['LINKED_OPTION_ID'],
                'optionName': row['OPTION_NM'],
                'componentGroup': row['COMPONENT_GROUP']
            })
        
        results = []
        for doc in docs:
            linked_parts = doc_linked_parts.get(doc["DOC_ID"], [])
            
            results.append({
                "docId": doc["DOC_ID"],
                "docTitle": doc["DOC_TITLE"],
                "docPath": doc["DOC_PATH"],
                "chunkCount": doc["CHUNK_COUNT"],
                "linkedParts": linked_parts
            })
        
        return {"docs": results}
    except Exception as e:
        print(f"Error fetching docs: {e}")
        return {"docs": [], "error": str(e)}

class DeleteDocRequest(BaseModel):
    docId: str

@app.get("/api/engineering-docs/view")
def view_engineering_doc(docId: str):
    """Get presigned URL for viewing a document"""
    try:
        doc_info = query(f"""
            SELECT DISTINCT DOC_PATH
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
            WHERE DOC_ID = '{docId.replace("'", "''")}'
            LIMIT 1
        """)
        
        if not doc_info:
            raise HTTPException(status_code=404, detail="Document not found")
        
        doc_path = doc_info[0]["DOC_PATH"]
        filename = doc_path.split("/")[-1] if doc_path else ""
        
        if not filename:
            raise HTTPException(status_code=404, detail="Document path invalid")
        
        # Generate presigned URL for the file
        presigned_result = query(f"""
            SELECT GET_PRESIGNED_URL(
                @{SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_STAGE,
                '{filename.replace("'", "''")}',
                3600
            ) as url
        """)
        
        if presigned_result and presigned_result[0].get("URL"):
            return {"url": presigned_result[0]["URL"]}
        
        raise HTTPException(status_code=500, detail="Could not generate presigned URL")
    except HTTPException:
        raise
    except Exception as e:
        print(f"View doc error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/engineering-docs/upload")
async def upload_engineering_doc(
    file: UploadFile = File(...),
    linkedParts: str = Form(default="[]")
):
    """Upload, extract, chunk and index an engineering document with SSE progress"""
    import uuid
    import base64
    
    # CRITICAL: Read file content BEFORE creating the generator
    # The file handle will be closed after the request handler returns
    content = await file.read()
    filename = file.filename or "Untitled"
    
    def generate_progress():
        import threading

        upload_conn = _create_connection()

        def _run_sql(sql):
            """Run SQL on upload_conn in a background thread, yielding keepalives."""
            result_box = {}
            def _run():
                try:
                    cursor = upload_conn.cursor()
                    try:
                        cursor.execute(sql)
                        if cursor.description:
                            columns = [col[0] for col in cursor.description]
                            rows = cursor.fetchall()
                            result_box['data'] = [dict(zip(columns, row)) for row in rows]
                        else:
                            result_box['data'] = []
                    finally:
                        cursor.close()
                except Exception as ex:
                    result_box['error'] = ex
            t = threading.Thread(target=_run)
            t.start()
            while t.is_alive():
                yield ": keepalive\n\n"
                t.join(timeout=2)
            if 'error' in result_box:
                raise result_box['error']
            return result_box.get('data', [])

        try:
            try:
                parts_list = json.loads(linkedParts)
            except:
                parts_list = []
            
            doc_id = f"DOC-{uuid.uuid4().hex[:8]}"
            doc_title = filename
            staged_filename = doc_title.replace("'", "").replace(" ", "_")

            try:
                check_result = {}
                def _check():
                    try:
                        cursor = upload_conn.cursor()
                        try:
                            cursor.execute(f"""
                                SELECT DISTINCT DOC_ID FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
                                WHERE DOC_TITLE = '{doc_title.replace("'", "''")}' LIMIT 1
                            """)
                            if cursor.description:
                                cols = [c[0] for c in cursor.description]
                                rows = cursor.fetchall()
                                check_result['data'] = [dict(zip(cols, r)) for r in rows]
                        finally:
                            cursor.close()
                    except:
                        pass
                t = threading.Thread(target=_check)
                t.start()
                t.join(timeout=10)
                existing = check_result.get('data', [])
                if existing:
                    old_doc_id = existing[0]['DOC_ID']
                    print(f"Cleaning up existing doc {old_doc_id} for {doc_title}")
                    def _cleanup():
                        try:
                            c = upload_conn.cursor()
                            c.execute(f"DELETE FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED WHERE DOC_ID = '{old_doc_id}'")
                            c.close()
                            c = upload_conn.cursor()
                            c.execute(f"DELETE FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.VALIDATION_RULES WHERE DOC_ID = '{old_doc_id}'")
                            c.close()
                        except Exception as e:
                            print(f"Cleanup error: {e}")
                    ct = threading.Thread(target=_cleanup)
                    ct.start()
                    ct.join(timeout=10)
            except Exception as cleanup_err:
                print(f"Warning: dedup cleanup failed: {cleanup_err}")
            
            is_text = filename and (filename.endswith('.txt') or filename.endswith('.md'))
            stage_path = f"@{SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_STAGE/{staged_filename}"
            
            # Step 1: Upload to stage
            yield f"data: {json.dumps({'step': 'upload', 'status': 'active', 'message': 'Uploading to stage...'})}\n\n"
            
            if is_text:
                try:
                    full_text = content.decode('utf-8')
                except:
                    full_text = content.decode('latin-1')
                yield f"data: {json.dumps({'step': 'upload', 'status': 'done'})}\n\n"
            else:
                import tempfile as _tempfile
                print(f"Uploading {staged_filename} directly ({len(content)} bytes)")
                
                try:
                    tmp_dir = _tempfile.gettempdir()
                    tmp_path = os.path.join(tmp_dir, staged_filename)
                    with open(tmp_path, 'wb') as f:
                        f.write(content)
                    
                    stage_ref = f"@{SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_STAGE"
                    put_sql = f"PUT 'file://{tmp_path}' '{stage_ref}' AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
                    yield from _run_sql(put_sql)
                    
                    try:
                        os.unlink(tmp_path)
                    except:
                        pass
                    
                    yield f"data: {json.dumps({'step': 'upload', 'status': 'done', 'message': 'File staged'})}\n\n"
                    
                except Exception as e:
                    print(f"Stage upload failed: {e}")
                    yield f"data: {json.dumps({'step': 'upload', 'status': 'error', 'message': str(e)})}\n\n"
                    yield f"data: {json.dumps({'type': 'result', 'success': False, 'error': str(e)})}\n\n"
                    return
            
            # Step 2: Extract text + chunk + insert in one SQL operation
            yield f"data: {json.dumps({'step': 'extract', 'status': 'active', 'message': 'Extracting & chunking document...'})}\n\n"
            
            chunk_count = 0
            
            if is_text:
                chunk_escaped = full_text.replace("'", "''").replace("\\", "\\\\")
                yield from _run_sql(f"""
                    INSERT INTO {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
                    (DOC_ID, DOC_TITLE, DOC_PATH, CHUNK_INDEX, CHUNK_TEXT)
                    SELECT '{doc_id}', '{doc_title.replace("'", "''")}', '{stage_path}', 0, '{chunk_escaped}'
                """)
                chunk_count = 1
            else:
                try:
                    insert_sql = f"""
                        INSERT INTO {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
                        (DOC_ID, DOC_TITLE, DOC_PATH, CHUNK_INDEX, CHUNK_TEXT)
                        WITH parsed AS (
                            SELECT AI_PARSE_DOCUMENT(
                                TO_FILE('{stage_path}'),
                                {{'mode': 'LAYOUT', 'page_split': true}}
                            ) AS PARSED
                        ),
                        pages AS (
                            SELECT
                                p.value:index::INT AS PAGE_INDEX,
                                p.value:content::VARCHAR AS PAGE_CONTENT
                            FROM parsed,
                                LATERAL FLATTEN(input => parsed.PARSED:pages) p
                            WHERE LENGTH(TRIM(p.value:content::VARCHAR)) > 0
                        )
                        SELECT
                            '{doc_id}',
                            '{doc_title.replace("'", "''")}',
                            '{stage_path}',
                            PAGE_INDEX,
                            PAGE_CONTENT
                        FROM pages
                        ORDER BY PAGE_INDEX
                    """
                    insert_box = {}
                    def _run_insert():
                        try:
                            cursor = upload_conn.cursor()
                            try:
                                cursor.execute(insert_sql)
                                insert_box['rowcount'] = cursor.rowcount
                            finally:
                                cursor.close()
                        except Exception as ex:
                            insert_box['error'] = ex
                    t = threading.Thread(target=_run_insert)
                    t.start()
                    while t.is_alive():
                        yield ": keepalive\n\n"
                        t.join(timeout=2)
                    if 'error' in insert_box:
                        raise insert_box['error']
                    chunk_count = insert_box.get('rowcount', 0)
                    
                except Exception as e:
                    print(f"Extract+chunk failed: {e}")
                    yield f"data: {json.dumps({'step': 'extract', 'status': 'error', 'message': str(e)})}\n\n"
                    yield f"data: {json.dumps({'type': 'result', 'success': False, 'error': str(e)})}\n\n"
                    return
            
            if chunk_count == 0:
                yield f"data: {json.dumps({'step': 'extract', 'status': 'error', 'message': 'No content extracted'})}\n\n"
                yield f"data: {json.dumps({'type': 'result', 'success': False, 'error': 'Failed to extract content'})}\n\n"
                return
            
            print(f"Extracted and inserted {chunk_count} chunks for {doc_title}")
            yield f"data: {json.dumps({'step': 'extract', 'status': 'done', 'message': f'{chunk_count} pages extracted'})}\n\n"
            
            # Fetch the text back for rule extraction
            text_box = {}
            def _fetch_text():
                try:
                    cursor = upload_conn.cursor()
                    try:
                        cursor.execute(f"""
                            SELECT CHUNK_TEXT FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
                            WHERE DOC_ID = '{doc_id}' ORDER BY CHUNK_INDEX LIMIT 5
                        """)
                        cols = [c[0] for c in cursor.description]
                        rows = cursor.fetchall()
                        text_box['data'] = [dict(zip(cols, r)) for r in rows]
                    finally:
                        cursor.close()
                except Exception as ex:
                    text_box['error'] = ex
            ft = threading.Thread(target=_fetch_text)
            ft.start()
            while ft.is_alive():
                yield ": keepalive\n\n"
                ft.join(timeout=2)
            
            chunks_text = [r['CHUNK_TEXT'] for r in text_box.get('data', [])]
            combined_text = '\n\n'.join(chunks_text)[:6000]
            
            # Step 3: Extract validation rules using Cortex Complete
            print(f"DEBUG: Starting rule extraction for {doc_title}, chunks: {chunk_count}")
            yield f"data: {json.dumps({'step': 'rules', 'status': 'active', 'message': 'Extracting validation rules...'})}\n\n"
            
            linked_option_id = parts_list[0].get('optionId') if parts_list else None
            rules_created = 0
            rule_error_msg = None

            combined_text_escaped = combined_text.replace("\\", "\\\\").replace("'", "''")
            doc_title_escaped = doc_title.replace("'", "''")

            import re
            max_retries = 2
            for attempt in range(max_retries + 1):
                try:
                    prompt = f"""Extract component requirements from this engineering specification.

DOCUMENT: {doc_title_escaped}

CONTENT:
{combined_text_escaped}

Extract numeric requirements for supporting components. Valid component groups and their spec names:
- Turbocharger: boost_psi, max_hp_supported
- Radiator: cooling_capacity_btu, core_rows
- Transmission Type: torque_rating_lb_ft
- Engine Brake Type: braking_hp, brake_stages
- Frame Rails: yield_strength_psi, rbm_rating_in_lb
- Axle Rating: gawr_lb, beam_thickness_in
- Front Suspension Type: spring_rating_lb
- Rear Suspension Type: spring_rating_lb

For each requirement, return JSON with the EXACT componentGroup name from above.

Return JSON array:
[
  {{"componentGroup": "Turbocharger", "specName": "boost_psi", "minValue": 45, "unit": "PSI", "rawRequirement": "minimum 45 PSI boost"}},
  {{"componentGroup": "Frame Rails", "specName": "yield_strength_psi", "minValue": 80000, "unit": "PSI", "rawRequirement": "80,000 PSI yield strength"}}
]

Return [] if no numeric requirements found. Return ONLY the JSON array."""

                    prompt_escaped = prompt.replace("\\", "\\\\").replace("'", "''")

                    ai_box = {}
                    def _run_ai():
                        try:
                            cursor = upload_conn.cursor()
                            try:
                                cursor.execute(f"""
                                    SELECT SNOWFLAKE.CORTEX.COMPLETE('mistral-large2', '{prompt_escaped}') AS RESPONSE
                                """)
                                if cursor.description:
                                    cols = [c[0] for c in cursor.description]
                                    rows = cursor.fetchall()
                                    ai_box['data'] = [dict(zip(cols, r)) for r in rows]
                            finally:
                                cursor.close()
                        except Exception as ex:
                            ai_box['error'] = ex
                    at = threading.Thread(target=_run_ai)
                    at.start()
                    while at.is_alive():
                        yield ": keepalive\n\n"
                        at.join(timeout=2)
                    if 'error' in ai_box:
                        raise ai_box['error']
                    ai_result = ai_box.get('data', [])

                    if not ai_result or len(ai_result) == 0:
                        rule_error_msg = f"CORTEX.COMPLETE returned no result (attempt {attempt + 1})"
                        print(f"DEBUG: {rule_error_msg}")
                        continue

                    response = ai_result[0].get("RESPONSE", "").strip()
                    print(f"DEBUG: AI response (attempt {attempt + 1}): {response[:300]}...")
                    response = response.replace("```json", "").replace("```", "").strip()

                    json_match = re.search(r'\[[\s\S]*?\]', response)
                    if not json_match:
                        rule_error_msg = f"No JSON array found in LLM response (attempt {attempt + 1})"
                        print(f"DEBUG: {rule_error_msg}. Raw response: {response[:500]}")
                        continue

                    rules = json.loads(json_match.group(0))
                    if not isinstance(rules, list):
                        rule_error_msg = f"LLM returned non-list JSON (attempt {attempt + 1})"
                        print(f"DEBUG: {rule_error_msg}")
                        continue

                    valid_groups = {'Turbocharger', 'Radiator', 'Transmission Type', 'Engine Brake Type',
                                    'Frame Rails', 'Axle Rating', 'Front Suspension Type', 'Rear Suspension Type'}
                    
                    rule_values = []
                    for rule in rules:
                        if not isinstance(rule, dict):
                            continue
                        component_group = rule.get('componentGroup', '').replace("'", "''")
                        spec_name = rule.get('specName', '').replace("'", "''")
                        min_value = rule.get('minValue')
                        max_value = rule.get('maxValue')
                        unit = rule.get('unit', '').replace("'", "''")
                        raw_req = rule.get('rawRequirement', '').replace("'", "''")

                        if min_value is None and max_value is None:
                            continue
                        if component_group.replace("''", "'") not in valid_groups:
                            print(f"DEBUG: Skipping rule with invalid componentGroup: {component_group}")
                            continue

                        rule_id = str(uuid.uuid4())[:36]
                        min_val_sql = min_value if min_value is not None else "NULL"
                        max_val_sql = max_value if max_value is not None else "NULL"
                        option_id_sql = f"'{linked_option_id}'" if linked_option_id else "NULL"
                        
                        rule_values.append(f"('{rule_id}', '{doc_id}', '{doc_title_escaped}', {option_id_sql}, '{component_group}', '{spec_name}', {min_val_sql}, {max_val_sql}, '{unit}', '{raw_req}')")
                    
                    if rule_values:
                        insert_rules_sql = f"""
                            INSERT INTO {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.VALIDATION_RULES
                            (RULE_ID, DOC_ID, DOC_TITLE, LINKED_OPTION_ID, COMPONENT_GROUP,
                             SPEC_NAME, MIN_VALUE, MAX_VALUE, UNIT, RAW_REQUIREMENT)
                            VALUES {', '.join(rule_values)}
                        """
                        rule_insert_box = {}
                        def _run_rule_insert():
                            try:
                                cursor = upload_conn.cursor()
                                try:
                                    cursor.execute(insert_rules_sql)
                                    rule_insert_box['count'] = cursor.rowcount
                                finally:
                                    cursor.close()
                            except Exception as ex:
                                rule_insert_box['error'] = ex
                        rt = threading.Thread(target=_run_rule_insert)
                        rt.start()
                        while rt.is_alive():
                            yield ": keepalive\n\n"
                            rt.join(timeout=2)
                        if 'error' in rule_insert_box:
                            raise rule_insert_box['error']
                        rules_created = rule_insert_box.get('count', len(rule_values))
                    
                    if rules_created > 0:
                        print(f"Created {rules_created} validation rules for {doc_title}")
                        rule_error_msg = None
                        break
                    else:
                        rule_error_msg = f"LLM returned 0 valid rules (attempt {attempt + 1})"
                        print(f"DEBUG: {rule_error_msg}")

                except json.JSONDecodeError as je:
                    rule_error_msg = f"JSON parse error: {je} (attempt {attempt + 1})"
                    print(f"DEBUG: {rule_error_msg}")
                except Exception as rule_err:
                    import traceback
                    rule_error_msg = f"Rule extraction error: {rule_err} (attempt {attempt + 1})"
                    print(f"DEBUG: {rule_error_msg}")
                    print(f"DEBUG traceback: {traceback.format_exc()}")

            if rule_error_msg and rules_created == 0:
                yield f"data: {json.dumps({'step': 'rules', 'status': 'error', 'message': rule_error_msg})}\n\n"
            else:
                yield f"data: {json.dumps({'step': 'rules', 'status': 'done', 'message': f'{rules_created} rules created'})}\n\n"
            
            # Final result
            yield f"data: {json.dumps({'type': 'result', 'success': True, 'docId': doc_id, 'docTitle': doc_title, 'chunkCount': chunk_count, 'linkedParts': parts_list, 'rulesCreated': rules_created})}\n\n"
            
            def _bg_search_refresh():
                try:
                    conn = _create_connection()
                    try:
                        cursor = conn.cursor()
                        cursor.execute(f"ALTER CORTEX SEARCH SERVICE {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_SEARCH REFRESH")
                        cursor.close()
                        print("Background search refresh completed")
                    finally:
                        conn.close()
                except Exception as e:
                    print(f"Background search refresh failed: {e}")
            threading.Thread(target=_bg_search_refresh, daemon=True).start()
            
        except Exception as e:
            print(f"Upload error: {e}")
            yield f"data: {json.dumps({'type': 'result', 'success': False, 'error': str(e)})}\n\n"
        finally:
            try:
                upload_conn.close()
            except:
                pass
    
    return StreamingResponse(
        generate_progress(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )

# ============ CHAT HISTORY ============

_chat_history: Dict[str, Dict] = {}

@app.get("/api/chat-history")
def get_chat_history(sessionId: str):
    """Get chat history for a session"""
    if sessionId in _chat_history:
        return _chat_history[sessionId]
    return {"messages": [], "optimizationRequests": [], "configId": None}

class ChatHistoryPatchRequest(BaseModel):
    sessionId: str
    configId: Optional[str] = None
    message: Optional[Dict] = None
    optimizationRequest: Optional[str] = None

@app.patch("/api/chat-history")
def patch_chat_history(req: ChatHistoryPatchRequest):
    """Update chat history for a session"""
    if req.sessionId not in _chat_history:
        _chat_history[req.sessionId] = {"messages": [], "optimizationRequests": [], "configId": None}
    
    if req.configId:
        _chat_history[req.sessionId]["configId"] = req.configId
    if req.message:
        _chat_history[req.sessionId]["messages"].append(req.message)
    if req.optimizationRequest:
        _chat_history[req.sessionId]["optimizationRequests"].append(req.optimizationRequest)
    
    return {"success": True}

@app.delete("/api/engineering-docs")
async def delete_engineering_doc(req: DeleteDocRequest):
    """Delete an engineering document and refresh search index"""
    try:
        doc_id = req.docId.replace("'", "''")
        
        # Get doc info
        doc_info = query(f"""
            SELECT DISTINCT DOC_PATH, DOC_TITLE
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
            WHERE DOC_ID = '{doc_id}'
            LIMIT 1
        """)
        
        if not doc_info:
            raise HTTPException(status_code=404, detail="Document not found")
        
        doc_title = doc_info[0]["DOC_TITLE"]
        doc_path = doc_info[0]["DOC_PATH"]
        
        # Delete chunks
        query(f"""
            DELETE FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
            WHERE DOC_ID = '{doc_id}'
        """)
        
        # Delete validation rules linked to this document
        query(f"""
            DELETE FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.VALIDATION_RULES
            WHERE DOC_ID = '{doc_id}'
        """)
        
        # Remove from stage (quote path to handle parentheses/special chars in filenames)
        try:
            filename = doc_path.split("/")[-1]
            if filename:
                query(f"REMOVE '@{SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_STAGE/{filename}'")
        except Exception as stage_err:
            print(f"Warning: Could not remove stage file {filename}: {stage_err}")
        
        # Refresh search index in background
        import threading
        def _bg_refresh():
            try:
                conn = _create_connection()
                try:
                    cursor = conn.cursor()
                    cursor.execute(f"ALTER CORTEX SEARCH SERVICE {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_SEARCH REFRESH")
                    cursor.close()
                    print("Background search refresh (delete) completed")
                finally:
                    conn.close()
            except Exception as e:
                print(f"Background search refresh (delete) failed: {e}")
        threading.Thread(target=_bg_refresh, daemon=True).start()
        
        return {"success": True, "deletedDocId": req.docId, "docTitle": doc_title}
    except HTTPException:
        raise
    except Exception as e:
        print(f"Delete error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ============ REPORT ============

@app.get("/api/report")
def get_report(modelId: str, options: Optional[str] = None, configId: Optional[str] = None):
    """Generate detailed BOM report"""
    try:
        # Get model info
        model_result = query(f"""
            SELECT MODEL_ID, MODEL_NM, TRUCK_DESCRIPTION, BASE_MSRP, BASE_WEIGHT_LBS
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.MODEL_TBL
            WHERE MODEL_ID = '{modelId}'
        """)
        
        if not model_result:
            raise HTTPException(status_code=404, detail="Model not found")
        
        model = model_result[0]
        
        # Get all options for this model
        all_options = query(f"""
            SELECT b.OPTION_ID, b.OPTION_NM, b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP,
                   b.DESCRIPTION, b.COST_USD, b.WEIGHT_LBS, b.PERFORMANCE_CATEGORY, 
                   b.PERFORMANCE_SCORE, t.IS_DEFAULT
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.TRUCK_OPTIONS t
            JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b ON t.OPTION_ID = b.OPTION_ID
            WHERE t.MODEL_ID = '{modelId}'
            ORDER BY b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP, b.COST_USD
        """)
        
        # Parse selected options
        selected_option_ids = []
        if options:
            try:
                selected_option_ids = json.loads(options)
            except:
                selected_option_ids = options.split(",")
        
        default_option_ids = [o["OPTION_ID"] for o in all_options if o.get("IS_DEFAULT")]
        
        # Build BOM hierarchy
        bom_hierarchy = build_bom_hierarchy(all_options, selected_option_ids, default_option_ids)
        
        return {
            "model": model,
            "bomHierarchy": bom_hierarchy,
            "selectedOptionIds": selected_option_ids,
            "defaultOptionIds": default_option_ids,
            "allOptions": all_options
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"Report error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

def build_bom_hierarchy(all_options: List[Dict], selected_ids: List[str], default_ids: List[str]) -> List[Dict]:
    """Build hierarchical BOM structure"""
    systems = {}
    
    # Determine which option is active per component group
    cg_selections = {}
    cg_defaults = {}
    
    for opt in all_options:
        cg_key = f"{opt['SYSTEM_NM']}|{opt['SUBSYSTEM_NM']}|{opt['COMPONENT_GROUP']}"
        
        if opt.get("IS_DEFAULT"):
            cg_defaults[cg_key] = opt
        
        if opt["OPTION_ID"] in selected_ids:
            cg_selections[cg_key] = opt["OPTION_ID"]
        elif cg_key not in cg_selections and opt.get("IS_DEFAULT"):
            cg_selections[cg_key] = opt["OPTION_ID"]
    
    for opt in all_options:
        cg_key = f"{opt['SYSTEM_NM']}|{opt['SUBSYSTEM_NM']}|{opt['COMPONENT_GROUP']}"
        active_id = cg_selections.get(cg_key)
        is_active = opt["OPTION_ID"] == active_id
        is_default = opt["OPTION_ID"] in default_ids
        is_selected = opt["OPTION_ID"] in selected_ids
        
        if is_active:
            if is_default:
                status = "default"
            elif is_selected:
                default_opt = cg_defaults.get(cg_key)
                if default_opt and opt["COST_USD"] > default_opt["COST_USD"]:
                    status = "upgraded"
                else:
                    status = "downgraded"
            else:
                status = "default"
        else:
            status = "base"
        
        bom_item = {
            "optionId": opt["OPTION_ID"],
            "optionName": opt["OPTION_NM"],
            "description": opt.get("DESCRIPTION", ""),
            "cost": opt["COST_USD"],
            "weight": opt["WEIGHT_LBS"],
            "performanceCategory": opt["PERFORMANCE_CATEGORY"],
            "performanceScore": opt["PERFORMANCE_SCORE"],
            "status": status,
            "isSelected": is_active
        }
        
        sys_name = opt["SYSTEM_NM"]
        sub_name = opt["SUBSYSTEM_NM"]
        cg_name = opt["COMPONENT_GROUP"]
        
        if sys_name not in systems:
            systems[sys_name] = {"name": sys_name, "subsystems": [], "totalCost": 0, "totalWeight": 0}
        
        sys_obj = systems[sys_name]
        sub_obj = next((s for s in sys_obj["subsystems"] if s["name"] == sub_name), None)
        if not sub_obj:
            sub_obj = {"name": sub_name, "componentGroups": [], "totalCost": 0, "totalWeight": 0}
            sys_obj["subsystems"].append(sub_obj)
        
        cg_obj = next((c for c in sub_obj["componentGroups"] if c["name"] == cg_name), None)
        if not cg_obj:
            cg_obj = {"name": cg_name, "items": [], "selectedItem": None, "totalCost": 0, "totalWeight": 0}
            sub_obj["componentGroups"].append(cg_obj)
        
        cg_obj["items"].append(bom_item)
        if is_active:
            cg_obj["selectedItem"] = bom_item
            cg_obj["totalCost"] = bom_item["cost"]
            cg_obj["totalWeight"] = bom_item["weight"]
    
    # Calculate totals
    for sys_obj in systems.values():
        for sub_obj in sys_obj["subsystems"]:
            sub_obj["totalCost"] = sum(cg["totalCost"] for cg in sub_obj["componentGroups"])
            sub_obj["totalWeight"] = sum(cg["totalWeight"] for cg in sub_obj["componentGroups"])
        sys_obj["totalCost"] = sum(s["totalCost"] for s in sys_obj["subsystems"])
        sys_obj["totalWeight"] = sum(s["totalWeight"] for s in sys_obj["subsystems"])
    
    return sorted(systems.values(), key=lambda x: x["name"])

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
