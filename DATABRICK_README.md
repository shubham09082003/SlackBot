# Slack, Genie, and Databricks

This document covers how the bot answers in Slack using **Databricks Genie**. User questions go to the Genie API; Genie generates SQL, runs it on Databricks SQL, and the bot returns Genie’s text and optional result table to Slack.

## App workflow

**Single pipeline in use:** DM / @mention → **Genie API → Databricks SQL** → Slack.

### Entry points (all use the same pipeline)

| Trigger | Handler | Pipeline |
|--------|---------|----------|
| **DM** (direct message to the bot) | `handleMessage` | Genie → Databricks SQL |
| **@mention** (e.g. `@Bot tell me all users`) | `handleMessage` | Genie → Databricks SQL |

### Active pipeline: Genie → Databricks SQL

**Flow:** Slack → Node → **Genie API** → (Genie runs SQL on **Databricks SQL**) → Slack

1. User sends a message (DM or @mention).
2. **Node** receives it and calls `handleMessage`.
3. Optional: if the message asks about **data freshness** (last refresh, when data synced, etc.), the bot calls the **Databricks Jobs API** for the scheduled job `Refresh_Users_Data` (`DATABRICKS_REFRESH_JOB_ID`) and replies with IST timestamps — **no Genie call**.
4. **Genie API** (`askGenie` in `genieService`):
   - Calls Databricks Genie “start-conversation” with the question.
   - Genie turns natural language into SQL and runs it on **Databricks SQL**.
   - Node polls the Genie message until COMPLETED or FAILED, then fetches the query result.
5. Result (text + table if any) is formatted and sent back to Slack.

**Required env:** `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `DATABRICKS_URL`, `GENIE_SPACE_ID`, and `DATABRICKS_TOKEN` (or `TOKEN`). See [Environment variables](#environment-variables-this-path-only) below for the full list.

### Commented out on this branch: AAS pipeline (GPT → AAS cube)

The previous pipeline **Slack → GPT → AAS (MDX/DAX) → Slack** is commented out in `handlers/messageHandler.js` (see `handleMessageAAS` and the commented imports). To use AAS again, you would need to:

- Restore the GPT and AAS env vars and uncomment the AAS pipeline code.
- Switch `handleMessage` back to the AAS flow (or choose by env/config).

On **`feat/databricks-genie`**, only the Genie pipeline runs.

---

## Workflow: Slack and Databricks (diagram & detail)

### Overview

```
Slack (DM / @mention)
        |
        v
  Slack Bolt app (Node.js)
        |
        +-- freshness / last refresh --> Jobs API (last job run), then Slack
        |
        v
  Genie API (Databricks workspace)
    start-conversation --> Genie plans SQL --> Databricks SQL warehouse
        |
        v
  Poll message until SUCCEEDED / COMPLETED or FAILED
        |
        v
  Fetch text + optional query-result attachment
        |
        v
  Format blocks --> update or send message in Slack
```

### Step-by-step (question → answer)

1. **Slack to app** — User submits text. Bolt delivers the event to `handleMessage` in `handlers/messageHandler.js` (after stripping the bot mention for app_mention events).
2. **Placeholder in channel** — The bot may post a short “retrieving” context message, then **update** that same message when the answer is ready (so the thread stays clean).
3. **Branch: data freshness** — If the text matches (e.g. last refresh, when data synced), the bot calls **Jobs API** `runs/list` for `DATABRICKS_REFRESH_JOB_ID` and **stops** (no Genie).
4. **Genie: start conversation** — `askGenie` in `services/genieService.js` sends `POST .../genie/spaces/{GENIE_SPACE_ID}/start-conversation` with the user question (authorized with your Databricks token).
5. **Genie and Databricks SQL** — Genie interprets the question, generates SQL, and runs it against Databricks SQL in your workspace. The conversation message moves through states such as submitted, in progress, running, then succeeded or failed.
6. **Poll until done** — The app polls `GET .../conversations/{id}/messages/{id}` until the message is no longer in a pending state (with an optional cold-start delay before polling).
7. **Result payload** — On success, the app reads narrative text from message attachments and, when present, calls the query-result endpoint for tabular data. That data is normalized to columns and rows for Slack tables.
8. **Slack reply** — `formatterService` builds Block Kit sections (text plus table when applicable). The bot **updates** the earlier message or sends a new one. Refresh time is **not** shown on data answers—only when the user asks (see step 3).

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
| `DATABRICKS_REFRESH_JOB_ID` | For freshness UX | Numeric job ID for the hourly refresh job (e.g. `Refresh_Users_Data`). Used when users ask about last refresh / data freshness. Token must allow `jobs/runs/list` on that job. |

If `DATABRICKS_TOKEN` is not set, the app accepts **one** of these instead (same meaning as above): `TOKEN`, `ACCESS_TOKEN`, `DATABRICKS_ACCESS_TOKEN`, `DATABRICKS_PAT`.

## Slack app configuration

- **Bot token** and **signing secret** must match the values in `.env`.
- For HTTP mode, configure Request URLs to your server. For Socket Mode, set `SLACK_APP_TOKEN` and enable Socket Mode in the Slack app.

## Code reference

| Area | Location |
|------|----------|
| Genie API calls and parsing | `services/genieService.js` |
| Last job run (refresh Q&A only) | `services/databricksRefreshService.js` |
| Slack handling and reply formatting | `handlers/messageHandler.js`, `services/formatterService.js` |
| Startup checks for the variables above | `index.js` |

`WAREHOUSE_ID` and direct SQL execution are not used for Genie-based Slack replies (the former `databricksService.js` has been removed).
