import snowflake from "snowflake-sdk";
import crypto from "crypto";
import jwt from "jsonwebtoken";

snowflake.configure({ logLevel: "ERROR" });

let connection: snowflake.Connection | null = null;
let cachedJwt: { token: string; expiry: number } | null = null;

export function getSchema(): string {
  return process.env.SNOWFLAKE_SCHEMA || "TRUCK_CONFIG";
}

export function getDatabase(): string {
  return process.env.SNOWFLAKE_DATABASE || "BOM";
}

export function getFullTableName(table: string): string {
  return `${getDatabase()}.${getSchema()}.${table}`;
}

export function getSemanticView(): string {
  return process.env.SNOWFLAKE_SEMANTIC_VIEW || `${getDatabase()}.${getSchema()}.TRUCK_CONFIG_ANALYST_V2`;
}

export function getCortexAgent(): string {
  return `${getDatabase()}/schemas/${getSchema()}/agents/TRUCK_CONFIG_AGENT_V2`;
}

export function getCortexSearchService(): string {
  return `${getDatabase()}.${getSchema()}.ENGINEERING_DOCS_SEARCH`;
}

function getPrivateKey(): string {
  const raw = process.env.SNOWFLAKE_PRIVATE_KEY;
  if (!raw) throw new Error("SNOWFLAKE_PRIVATE_KEY not set");
  return raw.replace(/\\n/g, "\n");
}

export function generateJwtToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now < cachedJwt.expiry - 60) {
    return cachedJwt.token;
  }

  const privateKeyPem = getPrivateKey();
  const accountLocator = process.env.SNOWFLAKE_ACCOUNT_LOCATOR;
  if (!accountLocator) throw new Error("SNOWFLAKE_ACCOUNT_LOCATOR not set");

  const username = process.env.SNOWFLAKE_USER || "";
  const pubKeyDer = crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "der" });
  const fingerprint = crypto.createHash("sha256").update(pubKeyDer).digest("base64");
  const qualifiedUsername = `${accountLocator.toUpperCase()}.${username.toUpperCase()}`;

  const lifetime = 3600;
  const token = jwt.sign({
    iss: `${qualifiedUsername}.SHA256:${fingerprint}`,
    sub: qualifiedUsername,
    iat: now,
    exp: now + lifetime,
  }, privateKeyPem, { algorithm: "RS256" });

  cachedJwt = { token, expiry: now + lifetime };
  console.log("Generated new JWT token for REST APIs");
  return token;
}

export function getAuthHeaders(): Record<string, string> {
  const token = generateJwtToken();
  return {
    "Authorization": `Bearer ${token}`,
    "X-Snowflake-Authorization-Token-Type": "KEYPAIR_JWT",
    "Content-Type": "application/json",
  };
}

function getConfig(): snowflake.ConnectionOptions {
  const host = process.env.SNOWFLAKE_HOST;
  const account = process.env.SNOWFLAKE_ACCOUNT;

  if (!host || !account) {
    throw new Error("SNOWFLAKE_HOST and SNOWFLAKE_ACCOUNT must be set");
  }

  const baseConfig = {
    account,
    host,
    username: process.env.SNOWFLAKE_USER,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || "DEMO_WH",
    database: getDatabase(),
    schema: getSchema(),
  };

  const privateKey = getPrivateKey();
  console.log("Using Key-Pair JWT authentication");
  return {
    ...baseConfig,
    authenticator: "SNOWFLAKE_JWT",
    privateKey,
  };
}

export async function getConnection(): Promise<snowflake.Connection> {
  if (connection) {
    return connection;
  }

  const config = getConfig();
  const conn = snowflake.createConnection(config);

  await new Promise<void>((resolve, reject) => {
    conn.connect((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  connection = conn;
  return connection;
}

function isRetryableError(err: unknown): boolean {
  const error = err as { message?: string; code?: number };
  return !!(
    error.message?.includes("JWT token expired") ||
    error.message?.includes("terminated connection") ||
    error.code === 407002
  );
}

export async function query<T>(sql: string, retries = 1): Promise<T[]> {
  try {
    const conn = await getConnection();
    return await new Promise<T[]>((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        complete: (err, stmt, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve((rows || []) as T[]);
          }
        },
      });
    });
  } catch (err) {
    console.error("Query error:", (err as Error).message);
    if (retries > 0 && isRetryableError(err)) {
      connection = null;
      cachedJwt = null;
      return query(sql, retries - 1);
    }
    throw err;
  }
}

export async function putFile(localPath: string, stagePath: string): Promise<void> {
  const conn = await getConnection();
  const sql = `PUT 'file://${localPath}' '${stagePath}' AUTO_COMPRESS=FALSE OVERWRITE=TRUE`;
  console.log("PUT command:", sql);

  return new Promise<void>((resolve, reject) => {
    conn.execute({
      sqlText: sql,
      complete: (err) => {
        if (err) {
          console.error("PUT error:", err);
          reject(err);
        } else {
          resolve();
        }
      },
    });
  });
}
