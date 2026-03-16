# Slack Analytics Bot

Slack Analytics Bot is a Node.js application that integrates Slack with Azure Analysis Services (AAS). It translates natural language questions into MDX (and DAX as a fallback) to run queries on AAS, returning formatted data results directly within Slack.

## Features

- **Natural Language Processing:** Converts conversational questions to MDX/DAX using OpenAI.
- **Azure Analysis Services Integration:** Executes complex MDX queries against AAS.
- **DAX Fallback:** Automatically generates and attempts a DAX query if the initial MDX query yields no rows.
- **Intelligent Formatting:** Responses are gracefully formatted for Slack, utilizing native Block Kit tables when supported, or boxed monospace text for compatibility.
- **Interactive Queries:** Supports Slack mentions, Direct Messages, and a dedicated /analytics slash command.
- **Refresh Tracking:** Built-in capability to query the last known AAS refresh or sync time.

## Architecture

The project is structured to enforce separation of concerns:

- `index.js`: Application entry point initializing the Slack Bolt framework and Express HTTP server.
- `handlers/messageHandler.js`: Coordinates the pipeline from receiving a Slack message, checking intent, running translations, and sending the final data.
- `middleware/mdxValidator.js`: Analyzes and validates MDX queries before execution.
- `services/gptService.js`: Integrates with OpenAI to determine user intent and generate MDX/DAX.
- `services/aasService.js`: Manages the XMLA endpoint connection and runs queries against Azure Analysis Services.
- `services/formatterService.js`: Parses tabular data into Slack-compatible UI blocks and handles error formatting.
- `scripts/`: Contains utility scripts, such as periodic AAS model refresh operations.

## Prerequisites

- Node.js (v16 or higher recommended).
- A registered Slack App with the appropriate Bot Token, App Token (if using Socket Mode), and Slash Command configurations.
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
- **Slash Commands:** Use the built-in command `/analytics` followed by your query.

## Model Refreshes

The repository includes a mechanism for triggering AAS model refreshes. Please consult the `REFRESH_AAS.md` document in the root directory for instructions on configuring and scheduling these operations via the `scripts/refresh-aas.js` script.
