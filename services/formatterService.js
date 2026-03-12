// src/services/formatterService.js

const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLS = 8;

// ── Cell formatting — always show raw values ───────────────────────────────────
// Never abbreviate phone numbers, IDs, or dates.

function formatCell(value) {
  if (value === null || value === undefined || value === "") return "-";

  // Date objects → DD-MM-YYYY
  let d = value instanceof Date ? value : null;
  if (!d && typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|\s)/.test(value.trim())) {
    d = new Date(value.trim());
    if (!isNaN(d.getTime())) {
      const dd   = String(d.getDate()).padStart(2, "0");
      const mm   = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = d.getFullYear();
      return `${dd}-${mm}-${yyyy}`;
    }
  }
  if (d && !isNaN(d.getTime())) {
    const dd   = String(d.getDate()).padStart(2, "0");
    const mm   = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  }

  // Everything else → plain string, no number abbreviation
  return String(value).trim();
}

// ── Column name cleaner ────────────────────────────────────────────────────────
// Decode XML/DAX escapes (Users_x005B_UserName_x005D_ → UserName) for clean Slack display
function cleanColumnName(raw) {
  if (!raw || typeof raw !== "string") return raw;
  let name = raw
    .replace(/_x005[Bb]_/g, "[")
    .replace(/_x005[Dd]_/g, "]")
    .replace(/_x005[Bb]$/g, "[")
    .replace(/_x005[Dd]$/g, "]")
    .replace(/_+$/, ""); // trailing underscores (e.g. Users[UserName]_)
  // Show just the field name when it looks like Table[Column] or Table[Column]_
  const bracketMatch = name.match(/\[([^\]]+)\]/);
  if (bracketMatch) name = bracketMatch[1];
  return name
    .replace(/\[[^\]]*\]\.\[?/g, "")
    .replace(/\]$/g, "")
    .replace(/_/g, " ")
    .trim() || raw;
}

// ── Build Slack Block Kit blocks ──────────────────────────────────────────────

/**
 * Formats SQL query results into Slack Block Kit message blocks.
 *
 * @param {{ columns: string[], rows: Object[], lastRefresh?: string }} data
 * @param {string} originalQuestion
 * @param {string} sqlQuery
 * @returns {Object[]} Slack Block Kit blocks
 */
function formatResultsForSlack(data, originalQuestion, sqlQuery) {
  const { columns, rows, lastRefresh } = data;
  const blocks = [];

  // ── Header ─────────────────────────────────────────────────────────────────
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: "Query Results", emoji: false },
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Q:* ${originalQuestion}` },
  });

  blocks.push({ type: "divider" });

  // ── Empty result ────────────────────────────────────────────────────────────
  if (!rows || rows.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":mag: No records found for your query.\n\n_If you expect data, ensure the AAS model has been refreshed (Process/Refresh) from its data source._",
      },
    });
    blocks.push(...buildFooter(sqlQuery, lastRefresh));
    return blocks;
  }

  // ── Stats bar ───────────────────────────────────────────────────────────────
  const displayCols = columns.slice(0, MAX_TABLE_COLS);
  const displayRows = rows.slice(0, MAX_TABLE_ROWS);

  blocks.push({
    type: "context",
    elements: [{
      type: "mrkdwn",
      text: `*${rows.length}* row${rows.length !== 1 ? "s" : ""} · *${columns.length}* column${columns.length !== 1 ? "s" : ""}${rows.length > MAX_TABLE_ROWS ? ` _(showing first ${MAX_TABLE_ROWS})_` : ""}`,
    }],
  });

  // ── Build monospace table ───────────────────────────────────────────────────
  const headers = displayCols.map(cleanColumnName);

  // Calculate column widths based on header and data
  const colWidths = headers.map((h, i) => {
    const col     = displayCols[i];
    const maxData = Math.max(...displayRows.map(r => formatCell(r[col]).length));
    return Math.max(h.length, maxData);
  });

  const headerRow  = headers.map((h, i) => h.padEnd(colWidths[i])).join("  ");
  const separator  = colWidths.map(w => "─".repeat(w)).join("  ");
  const dataRows   = displayRows
    .map(row =>
      displayCols.map((col, i) => formatCell(row[col]).padEnd(colWidths[i])).join("  ")
    )
    .join("\n");

  const tableText = "```\n" + headerRow + "\n" + separator + "\n" + dataRows + "\n```";

  // Slack section text limit is 3000 chars
  if (tableText.length <= 3000) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: tableText } });
  } else {
    // Chunk it
    const lines  = [headerRow, separator, ...dataRows.split("\n")];
    let chunk    = "```\n";
    for (const line of lines) {
      if ((chunk + line + "\n```").length > 2900) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk + "```" } });
        chunk = "```\n";
      }
      chunk += line + "\n";
    }
    if (chunk !== "```\n") {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk + "```" } });
    }
  }

  blocks.push(...buildFooter(sqlQuery, lastRefresh));
  return blocks;
}

// ── Footer ─────────────────────────────────────────────────────────────────────
function buildFooter(sqlQuery, lastRefresh) {
  return [
    { type: "divider" },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "_Powered by Azure Analysis Services_" }],
    },
  ];
}

// ── Error blocks ───────────────────────────────────────────────────────────────
function formatErrorForSlack(errorMessage, type = "general") {
  const icons  = { validation: "🚫", query: "⚠️", gpt: "🤖", general: "❌" };
  const titles = {
    validation: "Query Blocked — Restricted Operation",
    query:      "Query Execution Failed",
    gpt:        "Could Not Process Question",
    general:    "Something Went Wrong",
  };

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${icons[type] || "❌"} *${titles[type] || "Error"}*\n\n${errorMessage}`,
      },
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "_Try rephrasing your question or contact your data team._",
      }],
    },
  ];
}

module.exports = { formatResultsForSlack, formatErrorForSlack };