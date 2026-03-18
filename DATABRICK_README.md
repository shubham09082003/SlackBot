# Slack, Genie, and Databricks

This document covers how the bot answers in Slack using **Databricks Genie**. User questions go to the Genie API; Genie generates SQL, runs it on Databricks SQL, and the bot returns Genie’s text and optional result table to Slack.

## Response path

1. User sends a question (direct message, app mention, `/analytics`, or `/databricks`).
2. The app calls the Genie API (`start-conversation` on the configured Genie space).
3. Genie executes against Databricks SQL and completes the message when ready.
4. The app reads the message (text and, when present, query result attachments) and posts the formatted reply to Slack.

Messages that match “refresh” or “last query” are answered from in-memory session state only; they do not call Genie.

## Environment variables (this path only)

| Variable | Required | Purpose |
|----------|----------|---------|
| `SLACK_BOT_TOKEN` | Yes | Slack bot OAuth token. |
| `SLACK_SIGNING_SECRET` | Yes | Verifies requests from Slack. |
| `SLACK_APP_TOKEN` | Conditional | Required for Socket Mode. Omit if you use HTTP mode. |
| `SLACK_PORT` | No | HTTP listener port when not using Socket Mode. Default: `3000`. |
| `DATABRICKS_URL` | Yes | Workspace URL, no trailing slash issues handled in code (e.g. `https://adb-xxxx.azuredatabricks.net`). |
| `GENIE_SPACE_ID` | Yes | Genie space ID for `start-conversation` and follow-up API calls. |
| `DATABRICKS_TOKEN` | One required | Personal access token or API token with access to Genie and SQL in that workspace. |

If `DATABRICKS_TOKEN` is not set, the app accepts **one** of these instead (same meaning as above): `TOKEN`, `ACCESS_TOKEN`, `DATABRICKS_ACCESS_TOKEN`, `DATABRICKS_PAT`.

## Slack app configuration

- **Bot token** and **signing secret** must match the values in `.env`.
- Register slash commands `/analytics` and `/databricks` if you use them; both use the same Genie pipeline as DMs and mentions.
- For HTTP mode, configure Request URLs to your server. For Socket Mode, set `SLACK_APP_TOKEN` and enable Socket Mode in the Slack app.

## Code reference

| Area | Location |
|------|----------|
| Genie API calls and parsing | `services/genieService.js` |
| Slack handling and reply formatting | `handlers/messageHandler.js`, `services/formatterService.js` |
| Startup checks for the variables above | `index.js` |

`WAREHOUSE_ID` and direct SQL execution via `services/databricksService.js` are **not** used for the Genie-based Slack replies described here.
