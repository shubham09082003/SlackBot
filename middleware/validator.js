// Blocks destructive SQL/MDX; allows only read-only (SELECT, WITH, SHOW, DESCRIBE, etc.).
const logger = require("../utils/logger");

const BLOCKED_PATTERNS = [
  /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i,
  /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i,
  /\bCREATE\b/i, /\bEXEC\b/i, /\bEXECUTE\b/i,
  /\bGRANT\b/i, /\bREVOKE\b/i, /\bMERGE\b/i,
  /\bWRITE\b/i, /\bXP_\w+/i,
  /--/, /\/\*/,
];

const READ_ONLY_PREFIX = /^\s*(SELECT|WITH|EVALUATE|SHOW|DESCRIBE|EXPLAIN)\b/i;

function validateSql(query) {
  if (!query || typeof query !== "string" || query.trim().length < 5) {
    return { valid: false, reason: "Empty or invalid query." };
  }
  const trimmed = query.trim();
  if (!READ_ONLY_PREFIX.test(trimmed)) {
    return { valid: false, reason: "Only read-only queries (SELECT, WITH, SHOW, DESCRIBE, etc.) are permitted." };
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      const match = trimmed.match(pattern)?.[0] || "unknown";
      logger.warn("SQL Validator: Blocked operation", { keyword: match });
      return { valid: false, reason: `Restricted operation detected: \`${String(match).toUpperCase()}\`` };
    }
  }
  logger.info("SQL Validator: Query passed", { preview: trimmed.slice(0, 80) });
  return { valid: true };
}

module.exports = { validateSql };
