// src/handlers/messageHandler.js
// ACTIVE: Single pipeline — DM / @mention → Genie API → Databricks SQL → Slack
const { askGenie } = require("../services/genieService");
const {
    formatResultsForSlack,
    formatErrorForSlack,
} = require("../services/formatterService");
const {
    isDataRefreshMetadataQuery,
    isNextRefreshQuery,
    getLastRefreshForDisplay,
    NEXT_REFRESH_MRKDWN,
} = require("../services/databricksRefreshService");
const logger = require("../utils/logger");

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

    // Next refresh — no last-run stats, no Genie
    if (isNextRefreshQuery(text)) {
        await reply(
            [{ type: "section", text: { type: "mrkdwn", text: NEXT_REFRESH_MRKDWN } }],
            "Next data refresh: hourly schedule in Databricks."
        );
        return;
    }

    // Databricks job "Refresh_Users_Data" — last run (Jobs API), no Genie
    if (isDataRefreshMetadataQuery(text)) {
        const info = await getLastRefreshForDisplay();
        if (!info) {
            await reply(
                [{
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "⚠️ Unable to fetch last refresh time. Please try again later.",
                    },
                }],
                "Unable to fetch last refresh time."
            );
            return;
        }
        await reply(
            [{ type: "section", text: { type: "mrkdwn", text: info.mrkdwn } }],
            "Last data refresh from Databricks."
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
