-- ============================================
-- DEPRECATED: This stored procedure is NOT used by V2.
-- V2 uses AI_PARSE_DOCUMENT with page_split directly in backend/main.py.
-- This file is kept for historical reference only.
-- setup.sh does NOT load this script.
-- ============================================

-- Digital Twin Truck Configurator - Upload and Parse Document Stored Procedure
-- Receives base64-encoded file content, uploads to stage, and parses with PARSE_DOCUMENT
-- Called by the Python backend upload endpoint

USE SCHEMA BOM.BOM4;

CREATE OR REPLACE PROCEDURE UPLOAD_AND_PARSE_DOCUMENT(FILE_CONTENT_BASE64 VARCHAR, FILE_NAME VARCHAR)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'main'
EXECUTE AS OWNER
AS
$$
import base64
import tempfile
import os
import json

def main(session, file_content_base64: str, file_name: str):
    result = {
        "success": False,
        "file_name": file_name,
        "stage_path": None,
        "parsed_text": None,
        "chunks_inserted": 0,
        "error": None
    }

    try:
        file_bytes = base64.b64decode(file_content_base64)
        suffix = '.' + file_name.split('.')[-1] if '.' in file_name else ''
        temp_dir = tempfile.gettempdir()
        temp_path = os.path.join(temp_dir, file_name)

        with open(temp_path, 'wb') as f:
            f.write(file_bytes)

        db = session.get_current_database().replace('"', '')
        schema = session.get_current_schema().replace('"', '')
        stage_path = f"@{db}.{schema}.ENGINEERING_DOCS_STAGE"

        put_result = session.file.put(
            temp_path,
            stage_path,
            auto_compress=False,
            overwrite=True
        )

        result["stage_path"] = f"{stage_path}/{file_name}"

        if suffix.lower() in ['.pdf', '.docx', '.doc', '.pptx', '.ppt']:
            parse_sql = f"""
                SELECT SNOWFLAKE.CORTEX.PARSE_DOCUMENT(
                    '{stage_path}',
                    '{file_name}',
                    {{'mode': 'LAYOUT'}}
                ):content::VARCHAR as content
            """
            parse_result = session.sql(parse_sql).collect()
            if parse_result and parse_result[0]['CONTENT']:
                content = parse_result[0]['CONTENT']
                result["parsed_text"] = content
                result["chunks_inserted"] = 0
        else:
            result["parsed_text"] = file_bytes.decode('utf-8', errors='ignore')

        result["success"] = True

    except Exception as e:
        result["error"] = str(e)
    finally:
        if 'temp_path' in dir() and os.path.exists(temp_path):
            os.unlink(temp_path)

    return result
$$;
