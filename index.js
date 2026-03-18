// src/index.js
require("dotenv").config();

const { App, LogLevel } = require("@slack/bolt");
const { handleMessage } = require("./handlers/messageHandler");
const logger = require("./utils/logger");

// ── Validate required environment variables (Genie pipeline only) ───────────────
const REQUIRED_ENV = [
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "DATABRICKS_URL",
    "GENIE_SPACE_ID",
];
// Databricks token: any of these env vars (same as genieService)
const DATABRICKS_TOKEN_KEYS = ["DATABRICKS_TOKEN", "TOKEN", "ACCESS_TOKEN", "DATABRICKS_ACCESS_TOKEN", "DATABRICKS_PAT"];
const hasDatabricksToken = DATABRICKS_TOKEN_KEYS.some((key) => process.env[key]);

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
}
if (!hasDatabricksToken) {
    logger.error(`Missing Databricks token. Set one of: ${DATABRICKS_TOKEN_KEYS.join(", ")}`);
    process.exit(1);
}

// ── Initialise Slack Bolt App ─────────────────────────────────────────────────
const useSocketMode = !!process.env.SLACK_APP_TOKEN;

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    ...(useSocketMode
        ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
        : {}),
    logLevel: process.env.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.WARN,
});

// ── Event: App mention (@bot "...") ──────────────────────────────────────────
app.event("app_mention", async ({ event, say, client }) => {
    const text = event.text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
    await handleMessage({ text, userId: event.user, channel: event.channel, say, client });
});

// ── Event: Direct message ─────────────────────────────────────────────────────
app.message(async ({ message, say, client }) => {
    if (message.subtype || message.bot_id) return;
    if (message.channel_type !== "im") return;
    await handleMessage({ text: message.text, userId: message.user, channel: message.channel, say, client });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.error(async (error) => {
    logger.error("Slack Bolt unhandled error", { error: error.message, stack: error.stack });
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
    const port = parseInt(process.env.SLACK_PORT || "3000", 10);

    if (useSocketMode) {
        await app.start();
        logger.info("⚡ Slack Analytics Bot started in Socket Mode");
    } else {
        await app.start(port);
        logger.info(`⚡ Slack Analytics Bot started on HTTP port ${port}`);
    }

    logger.info("🤖 Bot ready — answers come from your Databricks data (via Genie)");
    logger.info("Mention @bot or send a DM to query your data in Databricks");
})();