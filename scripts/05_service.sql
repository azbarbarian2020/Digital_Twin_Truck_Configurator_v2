-- Digital Twin Truck Configurator V2 - Service Deployment
-- Run after loading data, creating semantic view, and pushing Docker image
-- NOTE: setup.sh handles this automatically. This file is for manual reference.

-- Replace these placeholders:
-- __DATABASE__       - Your database name
-- __SCHEMA__         - Your schema name
-- __ACCOUNT__        - Org-account (e.g., SFSENORTHAMERICA-CLEANBARBARIAN)
-- __ACCOUNT_LOCATOR__- Account locator (e.g., LNB24417) -- REQUIRED for JWT
-- __HOST__           - Full host (e.g., sfsenorthamerica-cleanbarbarian.snowflakecomputing.com)
-- __USER__           - Snowflake username
-- __WAREHOUSE__      - Warehouse name
-- __REGISTRY_URL__   - From: SHOW IMAGE REPOSITORIES IN SCHEMA __DATABASE__.__SCHEMA__;
-- __IMAGE_TAG__      - Docker image tag (e.g., v2-1712345678)

USE SCHEMA __DATABASE__.__SCHEMA__;

-- ============================================
-- Create Service (Key-Pair JWT Auth)
-- ============================================

CREATE SERVICE IF NOT EXISTS __DATABASE__.__SCHEMA__.TRUCK_CONFIGURATOR_SVC
  IN COMPUTE POOL TRUCK_CONFIG_POOL
  FROM SPECIFICATION $$
spec:
  containers:
    - name: truck-configurator
      image: __REGISTRY_URL__/truck-config:__IMAGE_TAG__
      env:
        SNOWFLAKE_ACCOUNT: __ACCOUNT__
        SNOWFLAKE_ACCOUNT_LOCATOR: __ACCOUNT_LOCATOR__
        SNOWFLAKE_HOST: __HOST__
        SNOWFLAKE_USER: __USER__
        SNOWFLAKE_WAREHOUSE: __WAREHOUSE__
        SNOWFLAKE_DATABASE: __DATABASE__
        SNOWFLAKE_SCHEMA: __SCHEMA__
        SNOWFLAKE_SEMANTIC_VIEW: __DATABASE__.__SCHEMA__.TRUCK_CONFIG_ANALYST_V2
      secrets:
        - snowflakeSecret:
            objectName: __DATABASE__.__SCHEMA__.SNOWFLAKE_PRIVATE_KEY_SECRET
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
$$
EXTERNAL_ACCESS_INTEGRATIONS = (TRUCK_CONFIG_EXTERNAL_ACCESS)
MIN_INSTANCES = 1
MAX_INSTANCES = 1;

-- ============================================
-- Check Status
-- ============================================
SELECT SYSTEM$GET_SERVICE_STATUS('__DATABASE__.__SCHEMA__.TRUCK_CONFIGURATOR_SVC');

-- ============================================
-- Get Service URL
-- ============================================
SHOW ENDPOINTS IN SERVICE __DATABASE__.__SCHEMA__.TRUCK_CONFIGURATOR_SVC;

-- ============================================
-- Useful Commands
-- ============================================

-- View service logs:
-- CALL SYSTEM$GET_SERVICE_LOGS('__DATABASE__.__SCHEMA__.TRUCK_CONFIGURATOR_SVC', 0, 'truck-configurator', 100);

-- Suspend service:
-- ALTER SERVICE __DATABASE__.__SCHEMA__.TRUCK_CONFIGURATOR_SVC SUSPEND;

-- Resume service:
-- ALTER SERVICE __DATABASE__.__SCHEMA__.TRUCK_CONFIGURATOR_SVC RESUME;

-- Update service image (use ALTER, never DROP):
-- ALTER SERVICE __DATABASE__.__SCHEMA__.TRUCK_CONFIGURATOR_SVC
--   FROM SPECIFICATION $$ ... $$;
