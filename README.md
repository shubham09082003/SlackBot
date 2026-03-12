# Slack Analytics Bot

Slack Analytics Bot is a Node.js application that integrates Slack with your database services. It translates natural language user questions into SQL or MDX queries, executes them against your Azure SQL Database or Azure Analysis Services (AAS), and returns the formatted results directly in Slack.

## Features

- Natural language to SQL translation using OpenAI.
- Executes queries against an Azure SQL Database.
- Supports querying Azure Analysis Services (AAS) using MDX.
- MDX validation middleware to ensure query correctness before execution.
- Result formatting for easy reading in Slack.
- Dedicated script and documentation for refreshing AAS models.

## Architecture & Services

The application codebase is structured into directories to separate concerns:

- `index.js`: Main application entry point that initializes the Slack Bolt app and Express server.
- `handlers/`: Contains input handlers like `messageHandler.js` to process incoming Slack messages.
- `middleware/`: Contains middleware such as `mdxValidator.js`.
- `services/`: Core logic and service integrations.
  - `aasService.js`: Handles connections and queries to Azure Analysis Services.
  - `sqlService.js`: Handles connections to Azure SQL Database.
  - `gptService.js`: Interfaces with OpenAI to generate queries based on natural language.
  - `formatterService.js`: Formats the data results for Slack presentation.
- `scripts/`: Operational scripts like `refresh-aas.js` for model refresh tasks.
- `utils/` Shared utilities like `logger.js` (Winston-based logging).

## Prerequisites

- Node.js installed (v16 or higher recommended).
- An active Slack Bot application with necessary OAuth scopes.
- OpenAI API Key.
- Azure SQL Database credentials.
- Azure Analysis Services connection details and credentials.

## Setup

1. Clone this repository.

2. Install dependencies:
```bash
npm install
```

3. Configure your environment variables. Create a `.env` file in the root directory (refer to `.env.example` if available) and add the appropriate secrets:
   - Slack Bot Token and Signing Secret
   - OpenAI App Key
   - SQL Server Connection String
   - AAS XMLA Endpoint and Credentials

4. Start the application:
```bash
npm start
```

For development with automatic restarts upon save, use:
```bash
npm run dev
```

## Usage

Once running and connected to your Slack workspace, simply mention the bot or send a direct message asking a data-related question. The bot will determine if it should query the SQL database or correct AAS models, generate the appropriate query, execute it, and return the formatted data.

## Note on AAS Refreshes

Please see the `REFRESH_AAS.md` file in the project root for details on how to manually trigger or schedule an Azure Analysis Services model refresh using the `scripts/refresh-aas.js` script.
