# Databricks Integration — Slack Bot

This document describes the **Databricks + Genie** integration added to the Slack Analytics Bot: a single pipeline where natural language questions are sent to the **Databricks Genie API**, which converts them to SQL, runs them on **Databricks SQL**, and returns results back to Slack.

---

## What Was Done

- **Single pipeline:** All user entry points (DM, @mention, `/analytics`, `/databricks`) now use **Genie API → Databricks SQL**. No GPT or Azure Analysis Services in the active path.
- **New slash command:** `/databricks` — same flow as `/analytics` (Genie → Databricks SQL).
- **Genie service:** `services/genieService.js` — starts a Genie conversation, polls until completion, and returns text + tabular results from Databricks SQL.
- **Message handler:** `handlers/messageHandler.js` — routes every query through `askGenie()` and formats the response for Slack.
- **Env validation:** `index.js` checks for Slack + Databricks/Genie env vars at startup; no OpenAI or AAS required for the main flow.
- **“Last query” / “refresh”:** Replies with the last Genie/Databricks query time without calling the API.

---

## Flow

```
Slack (DM / @mention / /analytics / /databricks)
    → Node.js (handleMessage)
    → Genie API (start-conversation)
    → Genie runs SQL on Databricks SQL
    → Node polls until COMPLETED/FAILED
    → Format result → Slack
```

1. User sends a message (any of the four triggers above).
2. Bot optionally shows “Retrieving from Databricks…”.
3. If the message is “refresh” or “last query”, bot replies with last query time and stops.
4. Otherwise: `genieService.askGenie(question)`:
   - POST to `start-conversation` with the question.
   - Wait for Genie cold start (configurable, default 15s).
   - Poll the message until status is `SUCCEEDED`/`COMPLETED` or `FAILED`.
   - Fetch message content (text + optional result table).
5. `formatterService` builds Slack blocks; bot updates or sends the reply.

---

## Entry Points (All Use the Same Pipeline)

| Trigger      | Example                          | Pipeline              |
|-------------|-----------------------------------|------------------------|
| **DM**      | Message to the bot                | Genie → Databricks SQL |
| **@mention**| `@Bot show me top 10 users`       | Genie → Databricks SQL |
| **/analytics** | `/analytics show me all users`  | Genie → Databricks SQL |
| **/databricks** | `/databricks how many users?` | Genie → Databricks SQL |

---

## Environment Variables (Databricks / Genie)

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Slack Bot OAuth token |
| `SLACK_SIGNING_SECRET` | Yes | Slack signing secret |
| `SLACK_APP_TOKEN` | No | For Socket Mode; otherwise HTTP on `SLACK_PORT` |
| `DATABRICKS_URL` | Yes | Databricks workspace URL (e.g. `https://adb-xxxx.azuredatabricks.net/`) |
| `GENIE_SPACE_ID` | Yes | Genie Space ID |
| `DATABRICKS_TOKEN` | Yes* | Databricks PAT or API token |
| `TOKEN` | Yes* | Alternative to `DATABRICKS_TOKEN` |
| `GENIE_COLD_START_DELAY_MS` | No | Seconds to wait before first poll (default 15). Genie cold start is often 10–30s. |

\* One of `DATABRICKS_TOKEN`, `TOKEN`, `ACCESS_TOKEN`, `DATABRICKS_ACCESS_TOKEN`, or `DATABRICKS_PAT` must be set.

---

## Key Files

| File | Role |
|------|------|
| `index.js` | Validates Slack + Databricks env; registers events and `/analytics`, `/databricks`. |
| `handlers/messageHandler.js` | Single handler: refresh/last-query or Genie → format → Slack. |
| `services/genieService.js` | Genie API: start-conversation, poll, parse text + table. |
| `services/formatterService.js` | Builds Slack blocks from Genie results and errors. |
| `services/databricksService.js` | Databricks helpers (if used). |

---

## Slack App Setup

1. Create or use an existing Slack app.
2. Add **Bot Token** and **Signing Secret** (and optionally **App Token** for Socket Mode).
3. Create slash commands:
   - **/analytics** — e.g. “Show me all users”
   - **/databricks** — e.g. “How many users do we have?”
4. Install the app to your workspace and invite the bot to channels where you want @mentions.

---

## Running the Bot

```bash
npm install
cp .env.example .env   # then fill Slack + Databricks/Genie vars
npm start
```

For development with live reload:

```bash
npm run dev
```

On startup you should see something like:

- `Bot ready — Genie → Databricks SQL (single pipeline)`
- `DM / @mention / /analytics / /databricks → Genie API → Databricks SQL → response`

---

## Legacy AAS Pipeline

The previous **Slack → GPT → AAS (MDX/DAX) → Slack** pipeline is commented out in `messageHandler.js`. Only the Genie → Databricks SQL pipeline runs by default. See `WORKFLOW.md` for how to re-enable the AAS flow.
