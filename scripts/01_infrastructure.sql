-- Digital Twin Truck Configurator V2 - Infrastructure Setup
-- Run this script first to create the required Snowflake objects
-- NOTE: setup.sh handles this automatically. This file is for manual reference.

-- ============================================
-- STEP 1: Create Database and Schema
-- ============================================
-- Replace __DATABASE__ and __SCHEMA__ with your values
CREATE DATABASE IF NOT EXISTS __DATABASE__;
CREATE SCHEMA IF NOT EXISTS __DATABASE__.__SCHEMA__;
USE SCHEMA __DATABASE__.__SCHEMA__;

-- ============================================
-- STEP 2: Create Warehouse
-- ============================================
CREATE WAREHOUSE IF NOT EXISTS DEMO_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE;

-- ============================================
-- STEP 3: Create Compute Pool for SPCS
-- ============================================
CREATE COMPUTE POOL IF NOT EXISTS TRUCK_CONFIG_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_XS
  AUTO_RESUME = TRUE
  AUTO_SUSPEND_SECS = 3600;

-- ============================================
-- STEP 4: Create Image Repository
-- ============================================
CREATE IMAGE REPOSITORY IF NOT EXISTS __DATABASE__.__SCHEMA__.TRUCK_CONFIG_REPO;

SHOW IMAGE REPOSITORIES IN SCHEMA __DATABASE__.__SCHEMA__;

-- ============================================
-- STEP 5: Create Private Key Secret (Key-Pair JWT Auth)
-- ============================================
-- setup.sh creates this automatically from your CLI connection's private key.
-- For manual setup:
/*
CREATE OR REPLACE SECRET __DATABASE__.__SCHEMA__.SNOWFLAKE_PRIVATE_KEY_SECRET
  TYPE = GENERIC_STRING
  SECRET_STRING = '-----BEGIN PRIVATE KEY-----
<YOUR_PRIVATE_KEY_CONTENT>
-----END PRIVATE KEY-----';
*/

-- ============================================
-- STEP 6: Create External Access Integration
-- ============================================
-- IMPORTANT: ALLOWED_AUTHENTICATION_SECRETS is required for JWT to pass
-- through EAI for Cortex REST API calls (Agent, Analyst)

CREATE OR REPLACE NETWORK RULE __DATABASE__.__SCHEMA__.CORTEX_API_RULE
  TYPE = HOST_PORT
  MODE = EGRESS
  VALUE_LIST = ('*.snowflakecomputing.com:443');

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION TRUCK_CONFIG_EXTERNAL_ACCESS
  ALLOWED_NETWORK_RULES = (__DATABASE__.__SCHEMA__.CORTEX_API_RULE)
  ALLOWED_AUTHENTICATION_SECRETS = (__DATABASE__.__SCHEMA__.SNOWFLAKE_PRIVATE_KEY_SECRET)
  ENABLED = TRUE;

-- ============================================
-- STEP 7: Create Engineering Docs Stage
-- ============================================
CREATE STAGE IF NOT EXISTS __DATABASE__.__SCHEMA__.ENGINEERING_DOCS_STAGE
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');

-- ============================================
-- Verification
-- ============================================
SHOW COMPUTE POOLS LIKE 'TRUCK_CONFIG%';
SHOW IMAGE REPOSITORIES IN SCHEMA __DATABASE__.__SCHEMA__;
SHOW SECRETS IN SCHEMA __DATABASE__.__SCHEMA__;
