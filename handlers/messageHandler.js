// src/handlers/messageHandler.js
const { processQuestion, generateSqlForUsers, generateDaxQuery } = require("../services/gptService");
const { executeMdxQuery } = require("../services/aasService");
const { executeSqlQuery } = require("../services/sqlService");
const { formatResultsForSlack,
    formatErrorForSlack } = require("../services/formatterService");
const logger = require("../utils/logger");

// Track last AAS query time for refresh reporting
let _lastQueryTime = null;

async function handleMessage({ text, userId, channel, say, client }) {
    if (!text || text.trim().length === 0) return;

    logger.info("Pipeline: Received message", { userId, channel, text });

    // ── Thinking indicator ──────────────────────────────────────────────────────
    let thinkingTs;
    try {
        const msg = await say({
            text: "⏳ Thinking...",
            blocks: [{
                type: "context",
                elements: [{ type: "mrkdwn", text: "⏳ *Thinking...* Analysing your question." }],
            }],
        });
        thinkingTs = msg.ts;
    } catch (_) { }

    const reply = async (blocks, fallbackText) => {
        try {
            if (thinkingTs) {
                await client.chat.update({ channel, ts: thinkingTs, text: fallbackText, blocks });
            } else {
                await say({ text: fallbackText, blocks });
            }
        } catch {
            await say({ text: fallbackText, blocks }).catch(() => { });
        }
    };

    // ── Step 1: GPT — classify + generate MDX or text reply ────────────────────
    let result;
    try {
        result = await processQuestion(text);
    } catch (err) {
        logger.error("Pipeline: GPT failed", { error: err.message });
        await reply(formatErrorForSlack(`GPT error: ${err.message}`, "gpt"), "GPT error.");
        return;
    }

    // ── Step 2: Refresh time query — answer directly ───────────────────────────
    if (result.type === "TEXT" && isRefreshQuery(text)) {
        const refreshTime = _lastQueryTime
            ? new Date(_lastQueryTime).toLocaleString("en-IN", {
                timeZone: "Asia/Kolkata",
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true,
            }) + " IST"
            : "No queries run yet this session";

        await reply(
            [{
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Last AAS Query Time*\n\n*${refreshTime}*\n\n_Data is served live from Azure Analysis Services (AAS), which syncs from Azure SQL Database._`,
                },
            }],
            `Last query: ${refreshTime}`
        );
        return;
    }

    // ── Step 3: Direct text reply (schema questions, greetings, etc.) ───────────
    if (result.type === "TEXT") {
        logger.info("Pipeline: Sending text reply");
        await reply(
            [{ type: "section", text: { type: "mrkdwn", text: result.text } }],
            result.text
        );
        return;
    }

    // ── Step 4: Execute MDX against AAS ────────────────────────────────────────
    let queryResult;
    try {
        logger.info("Pipeline: Executing MDX", { mdxPreview: result.mdx?.slice(0, 100) });
        queryResult = await executeMdxQuery(result.mdx);
        _lastQueryTime = Date.now();
        logger.info("Pipeline: MDX query succeeded", { rows: queryResult.rows.length });
    } catch (err) {
        logger.error("Pipeline: AAS MDX failed", { error: err.message });
        await reply(
            formatErrorForSlack(
                `AAS query error: ${err.message}\n\n_MDX attempted:_\n\`\`\`${result.mdx?.slice(0, 300)}\`\`\``,
                "query"
            ),
            "MDX query failed."
        );
        return;
    }

    // ── Step 5: If MDX returned no rows, try DAX then SQL fallback ─────────────
    if (queryResult.rows.length === 0) {
        // Try DAX (same cube, different query language)
        try {
            const dax = await generateDaxQuery(text);
            if (dax) {
                const daxResult = await executeMdxQuery(dax);
                if (daxResult.rows.length > 0) {
                    logger.info("Pipeline: MDX empty, sent DAX results", { rows: daxResult.rows.length });
                    const blocks = formatResultsForSlack(daxResult, text, dax);
                    const withNote = [
                        ...blocks,
                        { type: "context", elements: [{ type: "mrkdwn", text: "_Data from cube (DAX)._" }] },
                    ];
                    await reply(withNote, "Here are your results.");
                    return;
                }
            }
        } catch (err) {
            logger.warn("Pipeline: DAX fallback failed", { error: err.message });
        }

        // Try Azure SQL
        if (process.env.AZURE_DB_SERVER && process.env.AZURE_DB_NAME) {
            try {
                const sql = await generateSqlForUsers(text);
                if (sql) {
                    const sqlResult = await executeSqlQuery(sql);
                    if (sqlResult.rows.length > 0) {
                        logger.info("Pipeline: AAS empty, sent SQL fallback results", { rows: sqlResult.rows.length });
                        const blocks = formatResultsForSlack(sqlResult, text, sql);
                        const withNote = [
                            ...blocks,
                            { type: "context", elements: [{ type: "mrkdwn", text: "_Data from Azure SQL (cube not refreshed)._" }] },
                        ];
                        await reply(withNote, "Here are your results.");
                        return;
                    }
                }
            } catch (err) {
                logger.warn("Pipeline: SQL fallback failed", { error: err.message });
            }
        }
    }

    const blocks = formatResultsForSlack(queryResult, text, result.mdx);
    await reply(blocks, "Here are your results.");
    logger.info("Pipeline: Response delivered", { userId, channel });
}

module.exports = { handleMessage };

// ── Helper ─────────────────────────────────────────────────────────────────────
function isRefreshQuery(text) {
    const lower = text.toLowerCase();
    return (
        lower.includes("refresh") ||
        lower.includes("last update") ||
        lower.includes("last sync") ||
        lower.includes("data updated") ||
        lower.includes("when was") ||
        lower.includes("last query")
    );
}