// src/services/formatterService.js

const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLS = 8;
/** Slack table block: max 100 rows, 20 cols per row */
const SLACK_TABLE_MAX_ROWS = 100;
const SLACK_TABLE_MAX_COLS = 20;
const MAX_CELL_LEN = 280;

function formatCell(value) {
  if (value === null || value === undefined || value === "") return "—";

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

  return String(value).trim();
}

function cleanColumnName(raw) {
  if (!raw || typeof raw !== "string") return raw;
  let name = raw
    .replace(/_x005[Bb]_/g, "[")
    .replace(/_x005[Dd]_/g, "]")
    .replace(/_x005[Bb]$/g, "[")
    .replace(/_x005[Dd]$/g, "]")
    .replace(/_+$/, "");
  const bracketMatch = name.match(/\[([^\]]+)\]/);
  if (bracketMatch) name = bracketMatch[1];
  return name
    .replace(/\[[^\]]*\]\.\[?/g, "")
    .replace(/\]$/g, "")
    .replace(/_/g, " ")
    .trim() || raw;
}

function slackSafeSnippet(text, maxLen = 220) {
  if (!text || typeof text !== "string") return "—";
  let s = text.replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + "…";
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/\*/g, "·");
}

/**
 * Only show Cube / Your request / Data source when the user explicitly asks.
 */
function metaFlagsFromQuestion(question) {
  const lower = (question || "").toLowerCase();

  const showCube =
    /\bcube\b/.test(lower) ||
    /\bmodel name\b/.test(lower) ||
    /\bname of (the )?(cube|model)\b/.test(lower) ||
    /\bwhich (cube|model|database)\b/.test(lower) ||
    /\bwhat('?s| is) (the )?(cube|model|database|catalog)\b/.test(lower) ||
    /\b(show|tell).{0,40}\b(cube|model|database|catalog)\b/.test(lower) ||
    /\baas (model|database|cube)\b/.test(lower) ||
    /\banalytics model\b/.test(lower);

  const showRequest =
    /\b(repeat|echo|show)\b.{0,20}\b(my )?question\b/.test(lower) ||
    /\bwhat did i ask\b/.test(lower) ||
    /\bmy (original )?question\b/.test(lower);

  const showSource =
    /\bmdx\b/.test(lower) ||
    /\bdax\b/.test(lower) ||
    /\bdata source\b/.test(lower) ||
    /\bquery type\b/.test(lower) ||
    /\bhow (did|was|do).{0,30}\b(query|fetch|run)\b/.test(lower) ||
    /\bxmla\b/.test(lower) ||
    /\bhow.{0,20}\b(get|got).{0,15}\b(this )?data\b/.test(lower);

  return { showCube, showRequest, showSource };
}

function buildOptionalMetaSection(originalQuestion, meta) {
  const cubeName = meta.cubeName || process.env.AAS_DATABASE || "Analytics model";
  const queryType = meta.queryType === "DAX" ? "DAX" : "MDX";
  const q = slackSafeSnippet(originalQuestion || "");
  const flags = metaFlagsFromQuestion(originalQuestion);

  if (!flags.showCube && !flags.showRequest && !flags.showSource) return null;

  const parts = [];
  if (flags.showCube) parts.push(`*Cube / model*\n\`${cubeName}\``);
  if (flags.showRequest) parts.push(`*Your request*\n${q}`);
  if (flags.showSource) {
    parts.push(`*Data source*\nLive query via *${queryType}* on the model`);
  }
  return parts.join("\n\n");
}

/** Safe single-line cell for Slack table raw_text */
function cellTextForTable(value) {
  let s = formatCell(value);
  s = s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > MAX_CELL_LEN) s = s.slice(0, MAX_CELL_LEN - 1) + "…";
  return s || "—";
}

function headerCellRichText(label) {
  const text = cleanColumnName(label).slice(0, MAX_CELL_LEN) || "—";
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [{ type: "text", text, style: { bold: true } }],
      },
    ],
  };
}

function rawTextCell(value) {
  return { type: "raw_text", text: cellTextForTable(value) };
}

/**
 * Slack Block Kit table block — renders as a real table in the client.
 * Only one table per message (Slack rule).
 */
function buildSlackTableBlock(displayCols, displayRows) {
  const cols = displayCols.slice(0, SLACK_TABLE_MAX_COLS);
  const maxDataRows = Math.min(displayRows.length, SLACK_TABLE_MAX_ROWS - 1);
  const rows = displayRows.slice(0, maxDataRows);

  const headerRow = cols.map((col) => headerCellRichText(col));
  const dataRows = rows.map((row) => cols.map((col) => rawTextCell(row[col])));

  const column_settings = cols.map(() => ({
    align: "left",
    is_wrapped: true,
  }));

  return {
    type: "table",
    column_settings,
    rows: [headerRow, ...dataRows],
  };
}

function buildMonospaceTable(displayCols, displayRows) {
  const headers = displayCols.map(cleanColumnName);
  const colWidths = headers.map((h, i) => {
    const col = displayCols[i];
    const maxData = Math.max(...displayRows.map((r) => cellTextForTable(r[col]).length), 0);
    const cap = Math.min(Math.max(h.length, maxData), 36);
    return cap;
  });
  const borderSeg = colWidths.map((w) => "─".repeat(w + 2));
  const top = "┌" + borderSeg.join("┬") + "┐";
  const mid = "├" + borderSeg.join("┼") + "┤";
  const bot = "└" + borderSeg.join("┴") + "┘";
  const headerLine =
    "│" +
    headers
      .map((h, i) => " " + String(h).slice(0, colWidths[i]).padEnd(colWidths[i]) + " ")
      .join("│") +
    "│";
  const dataLines = displayRows.map(
    (row) =>
      "│" +
      displayCols
        .map((col, i) => " " + cellTextForTable(row[col]).slice(0, colWidths[i]).padEnd(colWidths[i]) + " ")
        .join("│") +
      "│"
  );
  const boxed = [top, headerLine, mid, ...dataLines, bot].join("\n");
  return "```\n" + boxed + "\n```";
}

function pushTableChunks(blocks, tableText, withResultLabel) {
  const prefix = withResultLabel ? "*Result set*\n\n" : "";
  if (tableText.length <= 3000) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: prefix + tableText },
    });
    return;
  }
  const lines = tableText.replace(/^```\n|\n```$/g, "").split("\n");
  let chunk = "```\n";
  for (const line of lines) {
    if ((prefix.length + chunk.length + line.length + 4) > 2900) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: (blocks.length === 0 ? prefix : "") + chunk + "```" },
      });
      chunk = "```\n";
    }
    chunk += line + "\n";
  }
  if (chunk !== "```\n") {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: (blocks.length === 0 ? prefix : "") + chunk + "```" },
    });
  }
}

/**
 * @param {{ columns: string[], rows: Object[] }} data
 * @param {string} originalQuestion
 * @param {string} [_sqlQuery]
 * @param {{ queryType?: 'MDX' | 'DAX', cubeName?: string }} [meta]
 */
function formatResultsForSlack(data, originalQuestion, _sqlQuery, meta = {}) {
  const { columns, rows } = data;
  const blocks = [];
  const cubeName = meta.cubeName || process.env.AAS_DATABASE || "Analytics model";
  const queryType = meta.queryType === "DAX" ? "DAX" : "MDX";
  const flags = metaFlagsFromQuestion(originalQuestion);

  if (!rows || rows.length === 0) {
    const metaText = buildOptionalMetaSection(originalQuestion, { ...meta, queryType, cubeName });
    let emptyMsg =
      "We couldn’t find any matching rows for that request. Try different filters or confirm the model has been refreshed.";
    if (metaText) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: metaText } });
      blocks.push({ type: "divider" });
    }
    blocks.push({ type: "section", text: { type: "mrkdwn", text: emptyMsg } });
    return blocks;
  }

  const displayCols = columns.slice(0, MAX_TABLE_COLS);
  const displayRows = rows.slice(0, MAX_TABLE_ROWS);

  const metaText = buildOptionalMetaSection(originalQuestion, { ...meta, queryType, cubeName });
  if (metaText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: metaText } });
    blocks.push({ type: "divider" });
  }

  const useNativeTable =
    process.env.SLACK_TABLE_BLOCK !== "0" &&
    displayCols.length <= SLACK_TABLE_MAX_COLS &&
    displayRows.length + 1 <= SLACK_TABLE_MAX_ROWS;

  if (useNativeTable) {
    blocks.push(buildSlackTableBlock(displayCols, displayRows));
  } else {
    const tableText = buildMonospaceTable(displayCols, displayRows);
    pushTableChunks(blocks, tableText, !useNativeTable);
  }

  if (rows.length > displayRows.length) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Showing first ${displayRows.length} of ${rows.length} rows._`,
        },
      ],
    });
  }
  return blocks;
}

function formatErrorForSlack(errorMessage, type = "general") {
  const icons  = { validation: "🚫", query: "⚠️", gpt: "🤖", general: "❌" };
  const titles = {
    validation: "Request not run",
    query:      "Data request could not be completed",
    gpt:        "We couldn’t interpret that request",
    general:    "Something went wrong",
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
        text: "_If this persists, please contact your analytics or IT contact._",
      }],
    },
  ];
}

const SLACK_BLOCK_MAX = 2900;

/**
 * Normalize assistant plain text for Slack mrkdwn so bullet lists look consistent.
 * - Lines starting with - or * (list style) become • bullets
 * - Escapes &, <, > so Slack doesn’t break layout
 */
function formatTextReplyForSlack(text) {
  if (!text || typeof text !== "string") return "—";
  let s = text.replace(/\r\n/g, "\n").trim();
  const lines = s.split("\n");
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed)) return "• " + trimmed.replace(/^[-*]\s+/, "");
    if (/^\d+\.\s+/.test(trimmed)) return trimmed; // keep numbered lists
    return line;
  });
  s = out.join("\n");
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (s.length > SLACK_BLOCK_MAX) s = s.slice(0, SLACK_BLOCK_MAX - 1) + "…";
  return s;
}

module.exports = {
  formatResultsForSlack,
  formatErrorForSlack,
  formatTextReplyForSlack,
};
