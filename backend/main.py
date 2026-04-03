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
SNOWFLAKE_WAREHOUSE = os.getenv("SNOWFLAKE_WAREHOUSE", "DEMO_WH")
SNOWFLAKE_DATABASE = os.getenv("SNOWFLAKE_DATABASE", "BOM")
SNOWFLAKE_SCHEMA = os.getenv("SNOWFLAKE_SCHEMA", "TRUCK_CONFIG")
SNOWFLAKE_USER = os.getenv("SNOWFLAKE_USER", "")

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

def get_connection():
    global _connection
    if _connection is not None:
        try:
            _connection.cursor().execute("SELECT 1")
            return _connection
        except:
            _connection = None
    
    private_key_pem = os.getenv("SNOWFLAKE_PRIVATE_KEY", "")
    
    if private_key_pem:
        print("Connecting with Key-Pair authentication")
        if "-----BEGIN" not in private_key_pem:
            private_key_pem = f"-----BEGIN PRIVATE KEY-----\n{private_key_pem}\n-----END PRIVATE KEY-----"
        _connection = snowflake.connector.connect(
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
        print("Connecting with connection name (local dev)")
        conn_name = os.getenv("SNOWFLAKE_CONNECTION_NAME", "")
        _connection = snowflake.connector.connect(
            connection_name=conn_name,
            warehouse=SNOWFLAKE_WAREHOUSE,
            database=SNOWFLAKE_DATABASE,
            schema=SNOWFLAKE_SCHEMA,
        )
    
    return _connection

def query(sql: str) -> List[Dict]:
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(sql)
        if cursor.description:
            columns = [col[0] for col in cursor.description]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]
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
        is_doc_query = any(kw in lower_msg for kw in ['specification', 'document', 'attached', 'linked', 'spec doc', 'engineering doc', 'which options have', 'what has'])
        
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
        
        # For non-optimization queries, use Cortex Complete for conversation
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
        # Query engineering docs with their linked parts - LINKED_PARTS contains objects with optionId key
        docs_with_parts = query(f"""
            SELECT DISTINCT 
                d.DOC_ID, d.DOC_TITLE,
                lp.value:optionId::VARCHAR as LINKED_OPTION_ID,
                lp.value:optionName::VARCHAR as LINKED_OPTION_NAME,
                b.OPTION_ID, b.OPTION_NM, b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED d,
                 LATERAL FLATTEN(input => d.LINKED_PARTS) lp
            JOIN {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b 
                ON b.OPTION_ID = lp.value:optionId::VARCHAR
            WHERE d.LINKED_PARTS IS NOT NULL AND ARRAY_SIZE(d.LINKED_PARTS) > 0
            ORDER BY b.SYSTEM_NM, b.SUBSYSTEM_NM, b.COMPONENT_GROUP
        """)
        
        if not docs_with_parts:
            return {"response": "No engineering specification documents are currently linked to any BOM options. You can upload documents and link them to specific parts in the Engineering Docs panel."}
        
        # Build response
        response_lines = ["**Options with Specification Documents:**\n"]
        for doc in docs_with_parts:
            opt_name = doc.get("OPTION_NM", "") or doc.get("LINKED_OPTION_NAME", "")
            doc_title = doc.get("DOC_TITLE", "")
            system = doc.get("SYSTEM_NM", "")
            subsystem = doc.get("SUBSYSTEM_NM", "")
            cg = doc.get("COMPONENT_GROUP", "")
            
            path = f"{system} → {subsystem} → {cg}"
            response_lines.append(f"• **{opt_name}** has document: *{doc_title}*")
            response_lines.append(f"  BOM Path: {path}\n")
        
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
        
        response = requests.post(url, json=payload, headers=headers, timeout=30)
        
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
    """Validate configuration using Cortex Search against engineering docs"""
    try:
        if not req.selectedOptions:
            return {"isValid": True, "issues": [], "fixPlan": None}
        
        options_to_check = req.incrementalOnly if req.incrementalOnly else req.selectedOptions
        option_list = ",".join([f"'{o}'" for o in options_to_check])
        
        # Get option details
        options_sql = f"""
            SELECT b.OPTION_ID, b.OPTION_NM, b.COMPONENT_GROUP, b.PERFORMANCE_CATEGORY
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.BOM_TBL b
            WHERE b.OPTION_ID IN ({option_list})
        """
        selected_option_details = query(options_sql)
        
        issues = []
        to_remove = []
        to_add = []
        
        # Search engineering docs for each option using Cortex Search
        for opt in selected_option_details:
            opt_id = opt["OPTION_ID"]
            opt_name = opt["OPTION_NM"]
            component_group = opt["COMPONENT_GROUP"]
            
            # Use Cortex Search to find relevant engineering requirements
            search_results = call_cortex_search(f"{opt_name} {component_group} requirements compatibility")
            
            for doc in search_results:
                chunk_text = doc.get("CHUNK_TEXT", "")
                doc_title = doc.get("DOC_TITLE", "")
                
                # Use Cortex Complete to analyze if there are compatibility issues
                analysis_prompt = f"""Analyze if this BOM option is compatible based on the engineering document.

BOM Option: {opt_name} (ID: {opt_id}, Component: {component_group})
Currently Selected Options: {', '.join(req.selectedOptions[:20])}

Engineering Document: {doc_title}
Relevant Text: {chunk_text[:1500]}

If there are compatibility issues, required options, or incompatible options mentioned, respond with JSON:
{{"hasIssue": true, "issueType": "missing_required" or "incompatible", "message": "brief description", "relatedOptionId": "ID if mentioned"}}

If compatible or no issues found, respond with:
{{"hasIssue": false}}

Respond with ONLY the JSON object."""

                analysis = call_cortex_complete(analysis_prompt, "mistral-large2")
                
                try:
                    json_match = analysis.strip()
                    if json_match.startswith("{"):
                        result = json.loads(json_match.split("}")[0] + "}")
                        if result.get("hasIssue"):
                            issues.append({
                                "type": result.get("issueType", "warning"),
                                "message": result.get("message", f"Potential issue with {opt_name}"),
                                "severity": "error" if result.get("issueType") == "incompatible" else "warning",
                                "optionId": opt_id,
                                "docTitle": doc_title
                            })
                            if result.get("relatedOptionId"):
                                if result.get("issueType") == "missing_required":
                                    to_add.append(result["relatedOptionId"])
                                elif result.get("issueType") == "incompatible":
                                    to_remove.append(result["relatedOptionId"])
                except (json.JSONDecodeError, IndexError):
                    pass
        
        is_valid = len([i for i in issues if i["severity"] == "error"]) == 0
        fix_plan = None
        
        if not is_valid and (to_remove or to_add):
            fix_plan = {
                "remove": list(set(to_remove)),
                "add": list(set(to_add)),
                "summary": f"Remove {len(set(to_remove))} incompatible, add {len(set(to_add))} required"
            }
        
        return {"isValid": is_valid, "issues": issues, "fixPlan": fix_plan}
    except Exception as e:
        print(f"Validation error: {e}")
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
                COUNT(*) as CHUNK_COUNT,
                MIN(CREATED_AT) as CREATED_AT,
                MAX(LINKED_PARTS)::VARCHAR as LINKED_PARTS
            FROM {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
            GROUP BY DOC_ID, DOC_TITLE, DOC_PATH
            ORDER BY 5 DESC
        """)
        
        results = []
        for doc in docs:
            linked_parts = []
            if doc.get("LINKED_PARTS"):
                try:
                    linked_parts = json.loads(doc["LINKED_PARTS"])
                except:
                    pass
            
            results.append({
                "docId": doc["DOC_ID"],
                "docTitle": doc["DOC_TITLE"],
                "docPath": doc["DOC_PATH"],
                "chunkCount": doc["CHUNK_COUNT"],
                "linkedParts": linked_parts,
                "createdAt": str(doc["CREATED_AT"])
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
        try:
            # Parse linked parts
            try:
                parts_list = json.loads(linkedParts)
            except:
                parts_list = []
            
            # Generate doc ID
            doc_id = f"DOC-{uuid.uuid4().hex[:8]}"
            doc_title = filename
            staged_filename = doc_title.replace("'", "").replace(" ", "_")
            
            # Step 1: Upload to stage
            yield f"data: {json.dumps({'step': 'upload', 'status': 'active', 'message': 'Uploading to stage...'})}\n\n"
            
            is_text = filename and (filename.endswith('.txt') or filename.endswith('.md'))
            
            if is_text:
                try:
                    full_text = content.decode('utf-8')
                except:
                    full_text = content.decode('latin-1')
                yield f"data: {json.dumps({'step': 'upload', 'status': 'done'})}\n\n"
            else:
                content_base64 = base64.b64encode(content).decode('utf-8')
                print(f"Uploading {staged_filename} via stored procedure ({len(content)} bytes)")
                
                try:
                    upload_result = query(f"""
                        CALL {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.UPLOAD_AND_PARSE_DOCUMENT(
                            '{content_base64}',
                            '{staged_filename}'
                        )
                    """)
                    
                    if upload_result and len(upload_result) > 0:
                        result_data = upload_result[0].get("UPLOAD_AND_PARSE_DOCUMENT", {})
                        if isinstance(result_data, str):
                            result_data = json.loads(result_data)
                        
                        if result_data.get("error"):
                            yield f"data: {json.dumps({'step': 'upload', 'status': 'error', 'message': result_data['error']})}\n\n"
                            yield f"data: {json.dumps({'type': 'result', 'success': False, 'error': result_data['error']})}\n\n"
                            return
                        
                        full_text = result_data.get("parsed_text", "")
                        if not full_text:
                            yield f"data: {json.dumps({'step': 'upload', 'status': 'error', 'message': 'No text extracted'})}\n\n"
                            yield f"data: {json.dumps({'type': 'result', 'success': False, 'error': 'Failed to extract text'})}\n\n"
                            return
                    else:
                        yield f"data: {json.dumps({'step': 'upload', 'status': 'error', 'message': 'No result'})}\n\n"
                        yield f"data: {json.dumps({'type': 'result', 'success': False, 'error': 'Upload returned no result'})}\n\n"
                        return
                        
                except Exception as e:
                    print(f"Stored procedure upload failed: {e}")
                    yield f"data: {json.dumps({'step': 'upload', 'status': 'error', 'message': str(e)})}\n\n"
                    yield f"data: {json.dumps({'type': 'result', 'success': False, 'error': str(e)})}\n\n"
                    return
            
            yield f"data: {json.dumps({'step': 'upload', 'status': 'done'})}\n\n"
            
            # Step 2: Extract text (already done via stored procedure, but show progress)
            yield f"data: {json.dumps({'step': 'extract', 'status': 'active', 'message': 'Processing document...'})}\n\n"
            yield f"data: {json.dumps({'step': 'extract', 'status': 'done', 'message': f'{len(full_text)} chars'})}\n\n"
            
            # Step 3: Chunk the text
            yield f"data: {json.dumps({'step': 'chunk', 'status': 'active', 'message': 'Creating chunks...'})}\n\n"
            
            chunks = []
            chunk_size = 1500
            overlap = 200
            
            if len(full_text) <= chunk_size:
                chunks = [full_text]
            else:
                start = 0
                while start < len(full_text):
                    end = min(start + chunk_size, len(full_text))
                    chunk = full_text[start:end]
                    chunks.append(chunk)
                    start = end - overlap
                    if start + overlap >= len(full_text):
                        break
            
            # Insert chunks into table
            linked_parts_json = json.dumps(parts_list).replace("'", "''")
            stage_path = f"@{SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_STAGE/{staged_filename}"
            
            for i, chunk in enumerate(chunks):
                chunk_escaped = chunk.replace("'", "''").replace("\\", "\\\\")
                query(f"""
                    INSERT INTO {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_CHUNKED
                    (DOC_ID, DOC_TITLE, DOC_PATH, CHUNK_INDEX, CHUNK_TEXT, LINKED_PARTS)
                    SELECT '{doc_id}', '{doc_title.replace("'", "''")}', '{stage_path}', 
                           {i}, '{chunk_escaped}', PARSE_JSON('{linked_parts_json}')
                """)
            
            yield f"data: {json.dumps({'step': 'chunk', 'status': 'done', 'message': f'{len(chunks)} chunks'})}\n\n"
            
            # Step 4: Refresh search service
            yield f"data: {json.dumps({'step': 'search', 'status': 'active', 'message': 'Indexing...'})}\n\n"
            try:
                query(f"ALTER CORTEX SEARCH SERVICE {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_SEARCH REFRESH")
                yield f"data: {json.dumps({'step': 'search', 'status': 'done'})}\n\n"
            except Exception as refresh_err:
                print(f"Search refresh warning: {refresh_err}")
                yield f"data: {json.dumps({'step': 'search', 'status': 'done', 'message': 'Auto-refresh scheduled'})}\n\n"
            
            # Step 5: Analyze (optional)
            yield f"data: {json.dumps({'step': 'analyze', 'status': 'active', 'message': 'Analyzing...'})}\n\n"
            yield f"data: {json.dumps({'step': 'analyze', 'status': 'done'})}\n\n"
            
            # Final result
            yield f"data: {json.dumps({'type': 'result', 'success': True, 'docId': doc_id, 'docTitle': doc_title, 'chunkCount': len(chunks), 'linkedParts': parts_list})}\n\n"
            
        except Exception as e:
            print(f"Upload error: {e}")
            yield f"data: {json.dumps({'type': 'result', 'success': False, 'error': str(e)})}\n\n"
    
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
        
        # Remove from stage
        try:
            filename = doc_path.split("/")[-1]
            if filename:
                query(f"REMOVE @{SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_STAGE/{filename}")
        except:
            pass
        
        # Refresh search service
        try:
            query(f"ALTER CORTEX SEARCH SERVICE {SNOWFLAKE_DATABASE}.{SNOWFLAKE_SCHEMA}.ENGINEERING_DOCS_SEARCH REFRESH")
        except:
            pass
        
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
