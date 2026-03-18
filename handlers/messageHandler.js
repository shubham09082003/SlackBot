// src/handlers/messageHandler.js
// ACTIVE: Single pipeline — DM / @mention / /analytics → Genie API → Databricks SQL → Slack
const { askGenie } = require("../services/genieService");
const {
    formatResultsForSlack,
    formatErrorForSlack,
} = require("../services/formatterService");
const logger = require("../utils/logger");

// ── COMMENTED OUT: AAS pipeline (GPT → AAS cube). Only Genie pipeline is used now. ──
// const { processQuestion, generateDaxQuery } = require("../services/gptService");
// const { executeMdxQuery } = require("../services/aasService");
// const { formatTextReplyForSlack } = require("../services/formatterService");

let _lastQueryTime = null;

async function handleMessage({ text, userId, channel, say, client }) {
    if (!text || text.trim().length === 0) return;

    logger.info("[Pipeline] 1. Message received", { userId, channel, textPreview: text.slice(0, 80) });

    let thinkingTs;
    try {
        const msg = await say({
            text: "Retrieving data from Databricks…",
            blocks: [{
                type: "context",
                elements: [{ type: "mrkdwn", text: "⏳ Retrieving data from Databricks…" }],
            }],
        });
        thinkingTs = msg.ts;
    } catch (_) {}

    const reply = async (blocks, fallbackText) => {
        try {
            if (thinkingTs) {
                await client.chat.update({ channel, ts: thinkingTs, text: fallbackText, blocks });
            } else {
                await say({ text: fallbackText, blocks });
            }
        } catch {
            await say({ text: fallbackText, blocks }).catch(() => {});
        }
    };

    // Optional: answer "refresh" / "last query" without calling Genie
    if (isRefreshQuery(text)) {
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
                    text: `*Last query time*\n\n• *When:* ${refreshTime}\n• *Source:* Genie → Databricks SQL`,
                },
            }],
            `Last query: ${refreshTime}`
        );
        return;
    }

    // ── Single pipeline: Genie API → Databricks SQL ─────────────────────────────
    logger.info("[Pipeline] 2. Calling Genie API (Genie → Databricks SQL)", {});
    let result;
    try {
        result = await askGenie(text);
        logger.info("[Pipeline] 3. Genie returned", { hasError: !!result.error, hasText: !!result.text, hasData: !!(result.data?.rows?.length) });
        if (result.text) {
            logger.info("[Pipeline] 3. hasText: true — content preview", { textLength: result.text.length, textPreview: String(result.text).slice(0, 500) });
        }
    } catch (err) {
        logger.error("[Pipeline] 3. Genie request failed", { error: err.message });
        await reply(formatErrorForSlack(`Genie API error: ${err.message}`, "query"), "Genie request failed.");
        return;
    }

    if (result.error) {
        await reply(formatErrorForSlack(result.error, "query"), "Genie returned an error.");
        return;
    }

    _lastQueryTime = Date.now();

    const blocks = [];
    if (result.text) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: result.text } });
    }
    if (result.data && result.data.rows && result.data.rows.length > 0) {
        if (result.text) blocks.push({ type: "divider" });
        blocks.push(
            ...formatResultsForSlack(result.data, text, null, {
                queryType: "SQL",
                cubeName: "Databricks SQL (via Genie)",
            })
        );
    } else if (result.data && result.data.rows && result.data.rows.length === 0 && !result.text) {
        // Only show "No rows" when there is no text response; when hasText is true, the text is the response.
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: "_No rows returned from the query._\nThe query ran successfully but the result set was empty. Check that the Genie space has access to the right catalog/schema and that the table has data.",
            },
        });
    }

    const fallback = result.text || "Here is the result from Genie.";
    await reply(
        blocks.length > 0 ? blocks : [{ type: "section", text: { type: "mrkdwn", text: fallback } }],
        fallback
    );
    logger.info("[Pipeline] 4. Response delivered", { userId, channel });
}

module.exports = { handleMessage };

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

// ── COMMENTED OUT: AAS pipeline (GPT → AAS cube). Uncomment to restore. ─────────
/*
async function handleMessageAAS({ text, userId, channel, say, client }) {
    if (!text || text.trim().length === 0) return;
    let thinkingTs;
    try {
        const msg = await say({
            text: "Retrieving your data…",
            blocks: [{
                type: "context",
                elements: [{ type: "mrkdwn", text: "⏳ Slack → GPT → AAS (cube) → response" }],
            }],
        });
        thinkingTs = msg.ts;
    } catch (_) {}
    const reply = async (blocks, fallbackText) => {
        try {
            if (thinkingTs) await client.chat.update({ channel, ts: thinkingTs, text: fallbackText, blocks });
            else await say({ text: fallbackText, blocks });
        } catch {
            await say({ text: fallbackText, blocks }).catch(() => {});
        }
    };
    let result;
    try {
        result = await processQuestion(text);
    } catch (err) {
        await reply(formatErrorForSlack(`GPT error: ${err.message}`, "gpt"), "GPT error.");
        return;
    }
    if (result.type === "TEXT" && isRefreshQuery(text)) {
        const refreshTime = _lastQueryTime ? new Date(_lastQueryTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) + " IST" : "No queries run yet";
        await reply([{ type: "section", text: { type: "mrkdwn", text: `*Last AAS query time*\n\n• *When:* ${refreshTime}` } }], `Last query: ${refreshTime}`);
        return;
    }
    if (result.type === "TEXT") {
        await reply([{ type: "section", text: { type: "mrkdwn", text: formatTextReplyForSlack(result.text) } }], result.text);
        return;
    }
    let queryResult;
    try {
        queryResult = await executeMdxQuery(result.mdx);
        _lastQueryTime = Date.now();
    } catch (err) {
        await reply(formatErrorForSlack(`AAS query error: ${err.message}\n\n\`\`\`${result.mdx?.slice(0, 300)}\`\`\``, "query"), "MDX query failed.");
        return;
    }
    if (queryResult.rows.length === 0) {
        try {
            const dax = await generateDaxQuery(text);
            if (dax) {
                const daxResult = await executeMdxQuery(dax);
                if (daxResult.rows.length > 0) {
                    await reply(formatResultsForSlack(daxResult, text, dax, { queryType: "DAX" }), "Here is the information you asked for.");
                    return;
                }
            }
        } catch (_) {}
    }
    await reply(formatResultsForSlack(queryResult, text, result.mdx, { queryType: "MDX" }), "Here is the information you asked for.");
}
*/
