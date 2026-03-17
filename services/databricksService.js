// services/databricksService.js
//
// Executes SQL against Databricks SQL Warehouse via the Statement Execution API.
// Uses DATABRICKS_URL, WAREHOUSE_ID, and DATABRICKS_TOKEN (fallback: TOKEN) from env.
//
const axios = require("axios");
const logger = require("../utils/logger");

const BASE_URL = (process.env.DATABRICKS_URL || "").replace(/\/$/, "");
const WAREHOUSE_ID = process.env.WAREHOUSE_ID;
const TOKEN = process.env.DATABRICKS_TOKEN || process.env.TOKEN;

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 60; // ~90s max wait

/** Only allow read-only SELECT statements. */
function assertReadOnlySql(statement) {
  const normalized = statement.trim().toUpperCase();
  if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH")) {
    throw new Error("Only SELECT (and read-only WITH) statements are allowed.");
  }
  const forbidden = [
    "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER",
    "TRUNCATE", "MERGE", "REPLACE", "GRANT", "REVOKE",
  ];
  for (const kw of forbidden) {
    if (new RegExp(`\\b${kw}\\b`, "i").test(statement)) {
      throw new Error(`Statement not allowed: ${kw} is forbidden.`);
    }
  }
}

/**
 * Execute a SQL statement and return results in { columns, rows } format
 * compatible with formatterService.formatResultsForSlack.
 *
 * @param {string} statement - SQL SELECT statement
 * @returns {Promise<{ columns: string[], rows: Object[] }>}
 */
async function executeSqlQuery(statement) {
  if (!BASE_URL || !WAREHOUSE_ID || !TOKEN) {
    throw new Error(
      "DATABRICKS_URL, WAREHOUSE_ID, and DATABRICKS_TOKEN (or TOKEN) must be set in .env"
    );
  }

  assertReadOnlySql(statement);

  const url = `${BASE_URL}/api/2.0/sql/statements`;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
  const body = {
    statement,
    warehouse_id: WAREHOUSE_ID,
    wait_timeout: "30s",
    disposition: "INLINE",
    format: "JSON_ARRAY",
  };

  logger.info("[Databricks SQL] 1. Submitting statement", { statementPreview: statement.slice(0, 80) });
  let response = await axios.post(url, body, { headers, timeout: 35_000 });

  let statementId = response.data.statement_id;
  let state = response.data.status?.state || response.data.status?.status;

  // Poll until terminal state if needed
  let attempts = 0;
  while (
    statementId &&
    (state === "PENDING" || state === "RUNNING") &&
    attempts < POLL_MAX_ATTEMPTS
  ) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const getUrl = `${BASE_URL}/api/2.0/sql/statements/${statementId}`;
    response = await axios.get(getUrl, { headers, timeout: 10_000 });
    state = response.data.status?.state || response.data.status?.status;
    attempts++;
    if (attempts <= 3 || attempts % 10 === 0) {
      logger.info("[Databricks SQL] 2. Poll status", { state, attempt: attempts });
    }
  }

  if (state === "FAILED" || state === "CANCELED") {
    const errMsg =
      response.data.status?.error?.message ||
      response.data.status?.error ||
      String(state);
    throw new Error(`Databricks statement failed: ${errMsg}`);
  }

  if (state !== "SUCCEEDED") {
    throw new Error(`Databricks statement did not complete: state=${state}`);
  }

  const manifest = response.data.manifest;
  const result = response.data.result;

  if (!manifest || !manifest.schema) {
    return { columns: [], rows: [] };
  }

  const columns =
    (manifest.schema.columns?.map((c) => c.name || c.column_name || "") || []).filter(Boolean);

  let dataArray = [];
  if (result?.data_array && Array.isArray(result.data_array)) {
    dataArray = result.data_array;
  }

  const rows = dataArray.map((rowArr) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = rowArr[i] !== undefined ? rowArr[i] : null;
    });
    return obj;
  });

  logger.info("[Databricks SQL] 3. Query completed", {
    columnCount: columns.length,
    rowCount: rows.length,
  });
  return { columns, rows };
}

module.exports = { executeSqlQuery };
