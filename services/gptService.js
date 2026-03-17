// src/services/gptService.js
const OpenAI = require("openai");
const logger = require("../utils/logger");
const { discoverSchema } = require("./aasService");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Your AAS Cube schema ───────────────────────────────────────────────────────
// Update this whenever your cube model changes.
// Cube/database name in MDX FROM clause is replaced at runtime with the discovered cube name (e.g. Model).
const CUBE_NAME = process.env.AAS_DATABASE;
const CUBE_SCHEMA = `
AAS Cube: Azure Analysis Services Tabular model.
Database (catalog) name in FROM clause: ${CUBE_NAME} (the runtime will replace WITH the actual cube name from the server).

Table: Users
  Dimensions (use these for listing/filtering — they exist in the cube):
    - [Users].[Id]
    - [Users].[UserName]
    - [Users].[Email]
    - [Users].[PhoneNumber]
    - [Users].[CreatedDate]

  Measures: The cube may have different measure names. Do NOT assume [Measures].[Total Users] or [Measures].[Latest Signup] exist.
  - For "list names", "show all users", "show user names" etc.: use ONLY dimensions on ROWS and empty COLUMNS (see examples).
  - For count/sum/aggregate: only use a measure if the user explicitly asks for a number; otherwise prefer dimension-only queries.
`.trim();

// ── Intent classifier ──────────────────────────────────────────────────────────
const INTENT_PROMPT = `
You are a classifier for a data analytics bot.

The bot has access to this Azure Analysis Services cube schema:
${CUBE_SCHEMA}

Classify the user's message into EXACTLY one of:
- SCHEMA_QUERY       → asking whether a column/field/table/measure exists, or what the structure is
- REFRESH_QUERY      → asking about last refresh time, when data was last updated or synced
- MDX_QUERY          → asking for actual data, records, counts, totals, filters from the cube
- GREETING           → hello, hi, thanks, how are you
- RESTRICTED_ACTION  → user is asking to DELETE, ALTER, UPDATE, INSERT, JOIN (modify data), DROP, REMOVE, or change data in any way
- OUT_OF_SCOPE       → completely unrelated to data

Reply with ONLY the category name, nothing else.

Examples:
"is there a phone number column?" → SCHEMA_QUERY
"what measures are available?" → SCHEMA_QUERY
"show me all users" → MDX_QUERY
"how many users registered?" → MDX_QUERY
"what is that user's email?" → MDX_QUERY
"total users" → MDX_QUERY
"last refresh time" → REFRESH_QUERY
"when was data last updated?" → REFRESH_QUERY
"hello" → GREETING
"delete all information about someone" → RESTRICTED_ACTION
"can you alter the table?" → RESTRICTED_ACTION
"remove this user" → RESTRICTED_ACTION
"update the email" → RESTRICTED_ACTION
"join these tables" → RESTRICTED_ACTION
`.trim();

// ── Slack-friendly bullets (all TEXT replies should follow this) ───────────────
const SLACK_REPLY_FORMAT = `
How to format your reply in Slack (mrkdwn):
- Start with one short title line in bold, e.g. *What’s in the model* or *Quick answer*
- Then a blank line, then each point on its own line starting with the bullet character • (Unicode bullet U+2022), e.g. • First point
- One main idea per bullet; keep bullets scannable (avoid long paragraphs)
- Use backticks only for exact field names, e.g. \`[Users].[Email]\`
- Do not use markdown # headers or **double-star** bold (Slack uses *single asterisks* for bold)
`.trim();

// ── Schema question handler ────────────────────────────────────────────────────
const SCHEMA_PROMPT = `
You are a professional analytics assistant for executives and business users. Answer questions about the Azure Analysis Services data model clearly and concisely.

Here is the EXACT schema you may describe:
${CUBE_SCHEMA}

${SLACK_REPLY_FORMAT}

Rules:
- Tone: polite, confident, business-appropriate (no slang).
- Answer directly: name tables, fields, and measures as bullets under your title.
- Do NOT say "I don't have access" — you DO have the schema above.
`.trim();

// ── Build MDX prompt with discovered schema (real dimension/level names from cube) ─
async function buildMdxPrompt() {
  const CUBE_NAME = process.env.AAS_DATABASE ;
  let schemaBlock = CUBE_SCHEMA;
  try {
    const levels = await discoverSchema();
    if (levels.length > 0) {
      const levelList = levels.map((l) => l.levelUniqueName).join("\n  - ");
      schemaBlock = `
AAS Tabular cube. Database/catalog for FROM clause: ${CUBE_NAME} (runtime will replace with actual cube name).

Use ONLY these exact dimension levels in your MDX (from the cube):
  - ${levelList}

Rules:
- For "list names", "show all X", "show user names" etc.: use SELECT {} ON COLUMNS, NON EMPTY [LevelUniqueName].Members ON ROWS FROM [${CUBE_NAME}].
- Use the exact level names above (e.g. if you see [User].[UserName].[UserName], use that, not [Users].[UserName]).
- Do NOT use measures unless the user explicitly asks for a count/sum and you know a measure exists.
`.trim();
    }
  } catch (err) {
    logger.warn("GPT: Could not discover cube schema, using static schema", { error: err.message });
  }
  return `
You are an expert MDX query generator for Azure Analysis Services (AAS).

${schemaBlock}

Your job:
- Convert the user's natural language question into a valid MDX SELECT query.
- Output ONLY the raw MDX query — no explanations, no markdown fences, no commentary.
- Only generate SELECT queries. Never use CREATE, DROP, ALTER, or any write operations.
- Always use NON EMPTY to filter out blank rows.
- For listing values, put dimensions on ROWS and use {} ON COLUMNS.
- If the question truly cannot be answered with the available schema, output exactly: INVALID_QUERY

Example (replace [Dimension].[Level] with an exact level from the list above):
SELECT {} ON COLUMNS, NON EMPTY [Dimension].[Level].[Level].Members ON ROWS FROM [${CUBE_NAME}]
`.trim();
}

// ── Greeting prompt ────────────────────────────────────────────────────────────
const GREETING_PROMPT = `
You are a professional analytics assistant on Slack, connected to the organisation's Azure Analysis Services model.
The user sent a greeting. Reply in a courteous, business-appropriate tone.

${SLACK_REPLY_FORMAT}

Structure:
- Title line: e.g. *Hi — here’s what I can do*
- Then bullets with • for: listing or filtering users, counts/registrations, contact details (where in the model), sign-up / activity dates
- Last bullet: invite them to ask, e.g. • What would you like to look up?
`.trim();

// ── Restricted action (delete / alter / join / update etc.) ────────────────────
const RESTRICTED_ACTION_PROMPT = `
The user's message asks to change, delete, wipe, or modify data or schema — or otherwise do something destructive or write-related (delete, remove, update, insert, alter, drop, truncate, merge, etc.). This bot cannot do that.

${SLACK_REPLY_FORMAT}

Reply with title *That request can’t be run here* then bullets (adapt slightly if their message was clearly about deleting personal data vs altering tables):
• This assistant is read-only: it can only query and display analytics from the model. It never deletes, updates, inserts, or alters any data.
• Requests that look destructive or like system changes are blocked on purpose so nothing in the cube is modified from chat.
• To change real systems of record, user records, or the model itself, use your organisation’s approved admin tools, ticketing, or the team that owns that data — not this bot.
Be calm and clear. Do not apologise for refusing unsafe actions. Do not offer workarounds that would still change data.
`.trim();

// ── Classify intent ────────────────────────────────────────────────────────────
async function classifyIntent(question) {
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages: [
      { role: "system", content: INTENT_PROMPT },
      { role: "user", content: question },
    ],
    temperature: 0,
    max_tokens: 20,
  });

  const intent = response.choices[0]?.message?.content?.trim().toUpperCase();
  logger.info("GPT: Intent classified", { question, intent });

  if (["SCHEMA_QUERY", "MDX_QUERY", "REFRESH_QUERY", "GREETING", "RESTRICTED_ACTION", "OUT_OF_SCOPE"].includes(intent)) {
    return intent;
  }
  return "MDX_QUERY";
}

// ── Generate natural language reply ───────────────────────────────────────────
async function generateNaturalReply(question, intent) {
  const systemPrompt =
    intent === "SCHEMA_QUERY" ? SCHEMA_PROMPT :
      intent === "GREETING" ? GREETING_PROMPT :
        intent === "RESTRICTED_ACTION" ? RESTRICTED_ACTION_PROMPT :
          `You are a helpful Slack data bot. The user asked something unrelated to the cube.

${SLACK_REPLY_FORMAT}

Reply with title *Out of scope* then bullets:
• You only help with questions about the organisation’s AAS analytics cube (users, lists, counts, schema).
• Ask a data question when they’re ready.`;

  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    temperature: 0.2,
    max_tokens: 200,
  });

  return response.choices[0]?.message?.content?.trim() || "I'm not sure how to help with that.";
}

// ── Generate MDX query ─────────────────────────────────────────────────────────
async function generateMdxQuery(question) {
  const mdxPrompt = await buildMdxPrompt();
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages: [
      { role: "system", content: mdxPrompt },
      { role: "user", content: question },
    ],
    temperature: 0,
    max_tokens: 512,
  });

  const mdx = response.choices[0]?.message?.content?.trim();
  logger.info("GPT: MDX generated", { preview: mdx?.slice(0, 120) });
  return mdx;
}

// ── Main entry point ───────────────────────────────────────────────────────────
/**
 * Returns:
 *   { type: "MDX",  mdx:  "SELECT ..." }  → run against AAS
 *   { type: "TEXT", text: "Yes, there is a PhoneNumber column..." }  → send directly to Slack
 */
async function processQuestion(userQuestion) {
  logger.info("GPT: Processing question", { question: userQuestion });

  const intent = await classifyIntent(userQuestion);

  // Non-data intents → direct text reply
  if (intent === "SCHEMA_QUERY" || intent === "REFRESH_QUERY" || intent === "GREETING" || intent === "RESTRICTED_ACTION" || intent === "OUT_OF_SCOPE") {
    const text = await generateNaturalReply(userQuestion, intent);
    return { type: "TEXT", text };
  }

  // Data query → generate MDX
  const mdx = await generateMdxQuery(userQuestion);

  if (!mdx || mdx === "INVALID_QUERY") {
    const text = await generateNaturalReply(userQuestion, "SCHEMA_QUERY");
    return { type: "TEXT", text };
  }

  return { type: "MDX", mdx };
}

// ── DAX fallback (try when MDX returns no rows) ─────────────────────────────────
const DAX_USERS_PROMPT = `
You generate a single DAX query for a Tabular model table named Users with columns: Id, UserName, Email, PhoneNumber, CreatedDate.
Rules: Output ONLY the query. No explanation. No markdown. Use only EVALUATE (read-only). Table name must be Users.

IMPORTANT - Case-insensitive name filter: When the user asks about a specific person by name, ALWAYS use FILTER with UPPER() so casing does not matter. Example: EVALUATE FILTER(Users, UPPER(Users[UserName]) = UPPER("Jane Doe"))

- "show me all users names" / "user names" → EVALUATE SUMMARIZE(Users, Users[UserName])
- "show me all users" / "list users" → EVALUATE Users
- "phone number" / "phone numbers" → EVALUATE SUMMARIZE(Users, Users[UserName], Users[PhoneNumber])
- "email" / "emails" → EVALUATE SUMMARIZE(Users, Users[UserName], Users[Email])
- "count" / "how many users" → EVALUATE ROW("UserCount", COUNTROWS(Users))
- "tell me about X" / "info about X" / "X's details" → EVALUATE FILTER(Users, UPPER(Users[UserName]) = UPPER("X"))  (replace X with the name from the question, keep case-insensitive)
Otherwise use EVALUATE FILTER(Users, UPPER(Users[UserName]) = UPPER("name")) when filtering by name.
`.trim();

/**
 * Generate a safe DAX query for the Users table (for AAS Tabular). Used when MDX returns no rows.
 * @param {string} question
 * @returns {Promise<string|null>} DAX query or null
 */
async function generateDaxQuery(question) {
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages: [
      { role: "system", content: DAX_USERS_PROMPT },
      { role: "user", content: question },
    ],
    temperature: 0,
    max_tokens: 150,
  });
  let dax = response.choices[0]?.message?.content?.trim() || "";
  dax = dax.replace(/^```\w*\n?|\n?```$/g, "").trim();
  if (!dax.toUpperCase().startsWith("EVALUATE") && !dax.toUpperCase().startsWith("DEFINE")) return null;
  if (dax.includes(";")) dax = dax.split(";")[0].trim();
  if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EVALUATE\s+.*\b(INSERT|UPDATE|DELETE))\b/i.test(dax)) return null;
  if (!/\bUsers\b/i.test(dax)) return null;
  logger.info("GPT: DAX for fallback", { preview: dax.slice(0, 80) });
  return dax;
}

// ── Databricks SQL (for /databricks command) ───────────────────────────────────
const DATABRICKS_SQL_SCHEMA = `
Table: users_table (or the table name your Databricks warehouse uses for user data).
Columns (adjust names to match your table): id, user_name, email, phone_number, created_date.
Use standard SQL only. Output ONLY a single SELECT statement. No explanation, no markdown.
Rules: Only SELECT. No INSERT/UPDATE/DELETE/DROP/CREATE/ALTER.
- "total users" / "how many users" → SELECT COUNT(*) AS total_users FROM users_table
- "list users" / "show all users" → SELECT id, user_name, email FROM users_table (or appropriate columns)
- "user names" → SELECT user_name FROM users_table
`.trim();

const DATABRICKS_SQL_PROMPT = `
You are a SQL generator for Databricks. Generate exactly one SELECT statement.

Schema:
${DATABRICKS_SQL_SCHEMA}

Output ONLY the raw SQL. No backticks, no explanation.
`.trim();

/**
 * Generate a safe SELECT query for Databricks from natural language.
 * @param {string} question
 * @returns {Promise<string|null>} SQL or null
 */
async function generateSqlForDatabricks(question) {
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages: [
      { role: "system", content: DATABRICKS_SQL_PROMPT },
      { role: "user", content: question },
    ],
    temperature: 0,
    max_tokens: 256,
  });
  let sql = response.choices[0]?.message?.content?.trim() || "";
  sql = sql.replace(/^```\w*\n?|\n?```$/g, "").trim();
  if (!/^\s*SELECT\b/i.test(sql) && !/^\s*WITH\b/i.test(sql)) return null;
  if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE)\b/i.test(sql)) return null;
  logger.info("GPT: SQL for Databricks", { preview: sql.slice(0, 80) });
  return sql;
}

module.exports = { processQuestion, generateDaxQuery, generateSqlForDatabricks };