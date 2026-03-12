// Blocks any non-SELECT / destructive MDX operations.
const logger = require("../utils/logger");

const BLOCKED_PATTERNS = [
  /\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i,
  /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i,
  /\bCREATE\b/i, /\bEXEC\b/i, /\bEXECUTE\b/i,
  /\bGRANT\b/i, /\bREVOKE\b/i, /\bMERGE\b/i,
  /\bWRITE\b/i, /\bXP_\w+/i,
  /--/, /\/\*/,
];

function validateMdx(query) {
  if (!query || typeof query !== "string" || query.trim().length < 5) {
    return { valid: false, reason: "Empty or invalid query." };
  }

  const trimmed = query.trim();

  // Allow standard MDX/DAX read patterns
  if (!/^\s*(SELECT|WITH|EVALUATE)\b/i.test(trimmed)) {
    return { valid: false, reason: "Only SELECT, WITH, or EVALUATE queries are permitted." };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      const match = trimmed.match(pattern)?.[0] || "unknown";
      logger.warn("MDX Validator: Blocked operation", { keyword: match });
      return { valid: false, reason: `Restricted operation detected: \`${match.toUpperCase()}\`` };
    }
  }

  logger.info("MDX Validator: Query passed", { preview: trimmed.slice(0, 80) });
  return { valid: true };
}

// Keep old export names for compatibility
module.exports = { validateMdx, validateSql: validateMdx };