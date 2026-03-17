# App workflow

**Single pipeline in use:** DM / @mention / /analytics / /databricks → **Genie API → Databricks SQL** → Slack.

---

## Entry points (all use the same pipeline)

| Trigger | Handler | Pipeline |
|--------|---------|----------|
| **DM** (direct message to the bot) | `handleMessage` | Genie → Databricks SQL |
| **@mention** (e.g. `@Bot tell me all users`) | `handleMessage` | Genie → Databricks SQL |
| **/analytics** (e.g. `/analytics show me all users`) | `handleMessage` | Genie → Databricks SQL |
| **/databricks** (e.g. `/databricks how many users?`) | `handleMessage` | Genie → Databricks SQL |

---

## Active pipeline: Genie → Databricks SQL

**Flow:** Slack → Node → **Genie API** → (Genie runs SQL on **Databricks SQL**) → Slack

1. User sends a message (DM, @mention, `/analytics <question>`, or `/databricks <question>`).
2. **Node** receives it and calls `handleMessage`.
3. Optional: if the message looks like “refresh” / “last query”, reply with last query time and stop.
4. **Genie API** (`askGenie` in `genieService`):
   - Calls Databricks Genie “start-conversation” with the question.
   - Genie turns natural language into SQL and runs it on **Databricks SQL**.
   - Node polls the Genie message until COMPLETED or FAILED, then fetches the query result.
5. Result (text + table if any) is formatted and sent back to Slack.

**Required env:** `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `DATABRICKS_URL`, `GENIE_SPACE_ID`, and `DATABRICKS_TOKEN` (or `TOKEN`).

---

## Commented out: AAS pipeline (GPT → AAS cube)

The previous pipeline **Slack → GPT → AAS (MDX/DAX) → Slack** is commented out in `handlers/messageHandler.js` (see `handleMessageAAS` and the commented imports). To use AAS again, you would need to:

- Restore the GPT and AAS env vars and uncomment the AAS pipeline code.
- Switch `handleMessage` back to the AAS flow (or choose by env/config).

Right now only the Genie pipeline runs.
