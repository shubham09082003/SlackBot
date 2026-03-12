// src/index.js
require("dotenv").config();

const { App, LogLevel } = require("@slack/bolt");
const { handleMessage } = require("./handlers/messageHandler");
const logger = require("./utils/logger");

// ── Validate required environment variables ────────────────────────────────────
const REQUIRED_ENV = [
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "OPENAI_API_KEY",
    "AAS_XMLA_ENDPOINT",
    "AAS_DATABASE",
    "AAS_TENANT_ID",
    "AAS_USERNAME",
    "AAS_PASSWORD",
];

const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(", ")}`);
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

// ── Slash command: /analytics ─────────────────────────────────────────────────
app.command("/analytics", async ({ command, ack, say, client }) => {
    await ack();
    if (!command.text || command.text.trim().length === 0) {
        await say("Please provide a question. Example: `/analytics show me all users`");
        return;
    }
    await handleMessage({ text: command.text.trim(), userId: command.user_id, channel: command.channel_id, say, client });
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

    logger.info("🤖 Bot ready — AAS (MDX) mode active");
    logger.info("Mention @bot or send a DM to query your Azure Analysis Services cube.");
})();