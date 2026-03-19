# Slack Analytics Bot

Slack Analytics Bot is a Node.js application that integrates Slack with Azure Analysis Services (AAS). It translates natural language questions into MDX (and DAX as a fallback) to run queries on AAS, returning formatted data results directly within Slack.

On branch **feat/databricks-genie**, the same Slack app instead routes questions through **Databricks Genie** (natural language → SQL on Databricks SQL). See **Branches** below and `DATABRICK_README.md` for that path (includes app workflow).

## Branches: what each branch does

| Branch | Primary data path | What it can do |
|--------|-------------------|----------------|
| **`main`** | **OpenAI (GPT)** → **MDX / DAX** → **Azure Analysis Services** | Answer analytics questions against your AAS tabular/cube model; DAX fallback if MDX returns no rows; optional AAS refresh tracking via scripts (`REFRESH_AAS.md`). |
| **`feat/databricks-genie`** | **Databricks Genie API** → **SQL** → **Databricks SQL** | Answer questions against data Genie is configured for in your Databricks workspace; Genie generates and runs SQL; “refresh” / “last query” style messages use in-app session state; formatted tables in Slack. |

**Summary**

- **`main`** — Best when your source of truth is **Azure Analysis Services**. You need OpenAI, AAS/XMLA credentials, and the stack described in **Features** through **Model Refreshes** below.
- **`feat/databricks-genie`** — Best when your source of truth is **Databricks** and you use **Genie spaces**. You need Databricks workspace URL, Genie space ID, and a Databricks token; full setup, workflow, and env are in **`DATABRICK_README.md`**. On this branch only the Genie pipeline is used; AAS/GPT services and scripts have been removed.

---

**Documentation map**

- Everything from **Features** through **Model Refreshes** below applies to the **`main`** branch (AAS + GPT).
- For **`feat/databricks-genie`**, use **`DATABRICK_README.md`** (Genie + Databricks env, app workflow, and detailed flow).

## Features

- **Natural Language Processing:** Converts conversational questions to MDX/DAX using OpenAI.
- **Azure Analysis Services Integration:** Executes complex MDX queries against AAS.
- **DAX Fallback:** Automatically generates and attempts a DAX query if the initial MDX query yields no rows.
- **Intelligent Formatting:** Responses are gracefully formatted for Slack, utilizing native Block Kit tables when supported, or boxed monospace text for compatibility.
- **Interactive Queries:** Supports Slack mentions and Direct Messages only.
- **Refresh Tracking:** Built-in capability to query the last known AAS refresh or sync time.

## Architecture

The project is structured to enforce separation of concerns:

- `index.js`: Application entry point initializing the Slack Bolt framework and Express HTTP server.
- `handlers/messageHandler.js`: Coordinates the pipeline from receiving a Slack message, checking intent, running translations, and sending the final data.
- `middleware/validator.js`: Analyzes and validates SQL/MDX queries before execution.
- `services/formatterService.js`: Parses tabular data into Slack-compatible UI blocks and handles error formatting.

On **`main`** branch only: `gptService.js` (OpenAI/MDX/DAX), `aasService.js` (AAS/XMLA), and `scripts/` (e.g. AAS refresh). On **`feat/databricks-genie`** the app uses `genieService.js` and `databricksRefreshService.js` instead; those AAS/GPT services are not present.

## Prerequisites

- Node.js (v16 or higher recommended).
- A registered Slack App with the appropriate Bot Token and App Token (if using Socket Mode).
- OpenAI API Key.
- Azure Analysis Services connection details (XMLA endpoint, database model name, cube name, tenant ID, and credentials).

## Setup and Installation

1. Clone the repository to your local machine.

2. Install the necessary Node.js dependencies:
   ```bash
   npm install
   ```

3. Configure your environment variables. Copy the `.env.example` file to `.env` and populate it with your specific secrets:
   - Slack Tokens (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`)
   - OpenAI Keys (`OPENAI_API_KEY`, `OPENAI_MODEL`)
   - AAS Configurations (`AAS_XMLA_ENDPOINT`, `AAS_DATABASE`, `AAS_CUBE_NAME`, `AAS_TENANT_ID`, `AAS_USERNAME`, `AAS_PASSWORD`, `AAS_SERVER`)

4. Start the application:
   ```bash
   npm start
   ```
   For development with live reloading:
   ```bash
   npm run dev
   ```

## Usage

Once the bot is running and installed in your Slack workspace, you can interact with it in several ways:

- **Direct Messages:** Send a DM directly to the bot with your data question.
- **Mentions:** Mention the bot in any channel it has been invited to.

## Model Refreshes

The repository includes a mechanism for triggering AAS model refreshes. Please consult the `REFRESH_AAS.md` document in the root directory for instructions on configuring and scheduling these operations via the `scripts/refresh-aas.js` script.
