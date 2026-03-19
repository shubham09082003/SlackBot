# Slack Analytics Bot

Node.js Slack app that answers natural language questions using Databricks Genie. Questions are sent to the Genie API, which generates and runs SQL on Databricks SQL; results are formatted and returned in Slack.

**Pipeline:** Slack (DM or @mention) to Genie API to Databricks SQL, then formatted reply in Slack. Data freshness queries (e.g. last refresh) use the Databricks Jobs API for the configured refresh job; no Genie call.

## Prerequisites

- Node.js (v16 or higher)
- Slack app with Bot Token and Signing Secret (and App Token if using Socket Mode)
- Databricks workspace URL, Genie space ID, and a Databricks token (PAT or API token) with access to Genie and SQL

## Setup

1. Clone the repository and install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set the required variables (see below).

## Required environment variables

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `SLACK_APP_TOKEN`
- `DATABRICKS_URL`
- `GENIE_SPACE_ID`
- `DATABRICKS_TOKEN` or `DATABRICKS_PAT`
- `DATABRICKS_REFRESH_JOB_ID`


## Optional (where used)

| Variable | Used in | Purpose |
|----------|---------|---------|
| `SLACK_APP_TOKEN` | `index.js` | Socket Mode; omit for HTTP. |
| `SLACK_PORT` | `index.js` | HTTP port when not Socket Mode. Default: `3000`. |
| `NODE_ENV` | `index.js` | `development` for debug log level. |
| `LOG_LEVEL` | `utils/logger.js` | Log level. Default: `info`. |
| `DATABRICKS_REFRESH_JOB_ID` | `services/databricksRefreshService.js` | Job ID for "last refresh" answers. |
| `AAS_DATABASE` | `services/formatterService.js` | Fallback cube name in formatted replies. |
| `SLACK_TABLE_BLOCK` | `services/formatterService.js` | Set to `0` to disable Block Kit tables. |

## Run

```bash
npm start
```

With live reload:

```bash
npm run dev
```

## Usage

- **Direct message:** Send a DM to the bot with your question.
- **Mention:** Mention the bot in a channel it is in (e.g. `@Bot show me all users`).

## What each file does

| File | Role |
|------|------|
| `index.js` | Loads env, validates required variables, starts Slack Bolt (Socket or HTTP), wires app_mention and DM to `handleMessage`. |
| `handlers/messageHandler.js` | Receives messages, decides freshness vs Genie, calls Genie or refresh service, formats and sends reply. |
| `services/genieService.js` | Calls Genie start-conversation, polls until done, fetches query result; uses `DATABRICKS_URL`, token, `GENIE_SPACE_ID`. Uses `middleware/validator` to validate SQL. |
| `middleware/validator.js` | Validates SQL/MDX: allows only read-only (SELECT, WITH, SHOW, DESCRIBE, etc.); blocks INSERT, UPDATE, DELETE, DROP, and other destructive operations. Used by `genieService.js`. |
| `services/databricksRefreshService.js` | Detects "last refresh" / "next refresh" intent, calls Jobs API for `DATABRICKS_REFRESH_JOB_ID`, returns last run info. |
| `services/formatterService.js` | Builds Slack blocks (text + optional table); uses `AAS_DATABASE` as fallback name, `SLACK_TABLE_BLOCK` to disable tables. |
| `utils/logger.js` | Pino logger; level from `LOG_LEVEL`. |

For HTTP mode, set the Slack app Request URL to your server. For Socket Mode, set `SLACK_APP_TOKEN` and enable Socket Mode in the Slack app settings.
