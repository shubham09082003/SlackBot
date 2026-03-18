// services/genieService.js
//
// Sends natural language questions to Databricks Genie API. Genie converts to SQL,
// runs it on Databricks SQL, and returns text + query results.
// Flow: Node.js Backend → Genie API → Databricks SQL → Response
//
const axios = require("axios");
const logger = require("../utils/logger");

const BASE_URL = (process.env.DATABRICKS_URL || "").replace(/\/$/, "");
const TOKEN =
    process.env.DATABRICKS_TOKEN ||
    process.env.TOKEN ||
    process.env.ACCESS_TOKEN ||
    process.env.DATABRICKS_ACCESS_TOKEN ||
    process.env.DATABRICKS_PAT;
const SPACE_ID = process.env.GENIE_SPACE_ID;

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 90; // ~3 min of polling

/**
 * Ask Genie a natural language question. Genie runs it against Databricks SQL and returns
 * text answer and optional tabular result.
 *
 * @param {string} question - Natural language question
 * @returns {Promise<{ text: string, data?: { columns: string[], rows: Object[] }, error?: string }>}
 */
async function askGenie(question) {
  if (!BASE_URL || !TOKEN || !SPACE_ID) {
    throw new Error(
      "DATABRICKS_URL, GENIE_SPACE_ID, and DATABRICKS_TOKEN (or TOKEN) must be set for Genie."
    );
  }

  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };

  // 1. Start conversation (Genie API runs query on Databricks SQL)
  const startUrl = `${BASE_URL}/api/2.0/genie/spaces/${SPACE_ID}/start-conversation`;
  logger.info("[Genie] 1. Start conversation (Genie → Databricks SQL)", { questionPreview: question.slice(0, 60) });

  let response;
  try {
    response = await axios.post(startUrl, { content: question }, { headers, timeout: 30_000 });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message;
    logger.error("[Genie] 1. Start conversation failed", { error: msg });
    throw new Error(`Genie start-conversation failed: ${msg}`);
  }

  const conversationId = response.data.conversation?.id || response.data.conversation_id;
  const messageId = response.data.message?.id || response.data.message_id;
  if (!conversationId || !messageId) {
    logger.error("[Genie] 1. Missing conversation_id or message_id", { data: response.data });
    throw new Error("Genie did not return conversation_id or message_id.");
  }
  const initialStatus = response.data.message?.status || response.data.status || "IN_PROGRESS";
  const maxWaitSec = Math.round((POLL_INTERVAL_MS * POLL_MAX_ATTEMPTS) / 1000);
  logger.info("[Genie] 2. Conversation started, polling for result", {
    conversationId,
    messageId,
    initialStatus,
    pollIntervalMs: POLL_INTERVAL_MS,
    maxAttempts: POLL_MAX_ATTEMPTS,
    maxWaitSec,
  });

  // 3. Poll until message is SUCCEEDED (or COMPLETED) or FAILED
  // Flow: SUBMITTED → ASKING_AI → PENDING_WAREHOUSE → RUNNING → SUCCEEDED
  const getMessageUrl = `${BASE_URL}/api/2.0/genie/spaces/${SPACE_ID}/conversations/${conversationId}/messages/${messageId}`;
  let status = initialStatus;
  let attempts = 0;
  const pollStartMs = Date.now();
  const pendingStatuses = [
    "SUBMITTED",
    "ASKING_AI",
    "FILTERING_CONTEXT",
    "PENDING",
    "PENDING_WAREHOUSE",
    "IN_PROGRESS",
    "RUNNING",
  ];
  const successStatuses = ["SUCCEEDED", "COMPLETED"];

  while (pendingStatuses.includes(status) && attempts < POLL_MAX_ATTEMPTS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const elapsedMs = Date.now() - pollStartMs;
    try {
      response = await axios.get(getMessageUrl, { headers, timeout: 15_000 });
    } catch (err) {
      logger.warn("[Genie] 2. Poll get message failed", {
        attempt: attempts + 1,
        elapsedMs,
        error: err.message,
      });
      attempts++;
      continue;
    }
    const prevStatus = status;
    status = response.data.status || response.data.message?.status || "IN_PROGRESS";
    attempts++;
    const logPayload = { status, attempt: attempts, elapsedMs };
    if (prevStatus !== status) logPayload.prevStatus = prevStatus;
    if (attempts <= 5 || attempts % 10 === 0 || successStatuses.includes(status) || status === "FAILED") {
      logger.info("[Genie] 2. Poll message", logPayload);
    }
  }

  const totalElapsedMs = Date.now() - pollStartMs;

  if (status === "FAILED" || response.data.error) {
    const errMsg = response.data.error?.message || response.data.error || String(response.data.error);
    logger.error("[Genie] 2. Message FAILED", { error: errMsg, attempts, totalElapsedMs });
    return { text: "", error: errMsg || "Genie returned FAILED." };
  }

  if (!successStatuses.includes(status)) {
    logger.warn("[Genie] 2. Timeout or incomplete", {
      status,
      attempts,
      totalElapsedMs,
      maxWaitSec,
    });
    return { text: "", error: `Genie did not complete in time (status: ${status}).` };
  }

  logger.info("[Genie] 3. Message SUCCEEDED, fetching attachments/query-result", {
    attempts,
    totalElapsedMs,
  });
  const message = response.data;
  const attachments = message.attachments || [];
  let text = "";
  let data = null;

  for (const att of attachments) {
    if (att.text && att.text.content) {
      text = att.text.content;
    }
    const attachmentId = att.attachment_id || att.id;
    if (attachmentId && (att.query || att.type === "query_result")) {
      try {
        const resultUrl = `${BASE_URL}/api/2.0/genie/spaces/${SPACE_ID}/conversations/${conversationId}/messages/${messageId}/attachments/${attachmentId}/query-result`;
        const resultRes = await axios.get(resultUrl, { headers, timeout: 15_000 });
        const raw = resultRes.data;
        // Log raw shape so we can see why we might get 0 rows/columns (parsing vs empty from Genie)
        const stmt = raw?.statement_response;
        const rawSummary = {
          topLevelKeys: raw ? Object.keys(raw) : [],
          hasStatementResponse: !!stmt,
          hasManifest: !!(stmt?.manifest ?? raw?.manifest),
          hasResult: !!(stmt?.result ?? raw?.result),
          manifestSchemaColumns: (stmt?.manifest ?? raw?.manifest)?.schema?.columns?.length ?? (stmt?.manifest ?? raw?.manifest)?.columns?.length ?? null,
          resultDataArrayLength: Array.isArray((stmt?.result ?? raw?.result)?.data_array) ? (stmt?.result ?? raw?.result).data_array.length : (Array.isArray((stmt?.result ?? raw?.result)?.data) ? (stmt?.result ?? raw?.result).data.length : null),
          resultDataLength: Array.isArray(raw?.data_array) ? raw.data_array.length : (Array.isArray(raw?.data) ? raw.data.length : null),
        };
        logger.info("[Genie] 3. Query result raw shape", rawSummary);
        if (att.query?.query_text) {
          logger.info("[Genie] 3. SQL executed by Genie", { sqlPreview: String(att.query.query_text).slice(0, 500) });
        }
        const parsed = parseGenieQueryResult(raw);
        if (parsed && parsed.rows && parsed.rows.length >= 0) {
          data = parsed;
          logger.info("[Genie] 3. Query result fetched", { rows: parsed.rows?.length, columns: parsed.columns?.length, columnNames: parsed.columns?.slice(0, 10) });
          break;
        }
      } catch (err) {
        logger.warn("[Genie] 3. Fetch query-result failed", { attachmentId, error: err.message });
      }
    }
  }

  if (!text && !data && !message.content) {
    text = message.content || "No text or table in response.";
  }
  // if (!text && data) {
  //   text = "Here are the results from Databricks SQL.";
  // }

  logger.info("[Genie] 4. Done", { hasText: !!text, hasData: !!data });
  return { text, data };
}

/**
 * Parse Genie query-result response into { columns, rows } for formatterService.
 * Genie API returns data inside statement_response; unwrap that first, then read
 * manifest.schema.columns and result.data_array.
 */
function parseGenieQueryResult(body) {
  if (!body) return null;
  // Unwrap statement_response (Genie query-result API shape)
  const inner = body.statement_response || body;
  const manifest = inner.manifest || inner.schema || body.manifest || body.schema;
  const result = inner.result || body.result || body;
  const columns = [];
  if (manifest?.schema?.columns) {
    for (const c of manifest.schema.columns) {
      columns.push(c.name || c.column_name || "");
    }
  } else if (manifest?.columns) {
    for (const c of manifest.columns) {
      columns.push(c.name || c.column_name || "");
    }
  }
  const dataArray = result.data_array || result.data || body.data_array || [];
  if (!Array.isArray(dataArray) && columns.length === 0) return null;
  const rows = Array.isArray(dataArray)
    ? dataArray.map((rowArr) => {
        const obj = {};
        columns.forEach((col, i) => {
          obj[col] = rowArr[i] !== undefined ? rowArr[i] : null;
        });
        return obj;
      })
    : [];
  return { columns: columns.filter(Boolean), rows };
}

module.exports = { askGenie };
