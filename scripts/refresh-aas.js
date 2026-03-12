#!/usr/bin/env node
/**
 * Refresh (Process) the Azure Analysis Services model so it loads data from the data source.
 * Use this when "Synchronize model" in Azure Portal asks for Standard tier.
 *
 * Requires: .env with AAS_XMLA_ENDPOINT, AAS_DATABASE, AAS_TENANT_ID, AAS_USERNAME, AAS_PASSWORD.
 * The service principal must have Process permission on the database (not just Reader).
 *
 * Usage: node scripts/refresh-aas.js [full|dataOnly|automatic]
 */
require("dotenv").config();

const { processModel } = require("../services/aasService");

const type = process.argv[2] || "full";
if (!["full", "dataOnly", "automatic"].includes(type)) {
  console.error("Usage: node scripts/refresh-aas.js [full|dataOnly|automatic]");
  process.exit(1);
}

processModel(process.env.AAS_DATABASE, type)
  .then(() => {
    console.log("Refresh completed. Try your Slack bot again.");
  })
  .catch((err) => {
    console.error("Refresh failed:", err.message);
    if (err.message.includes("fault") || err.message.includes("403") || err.message.includes("401")) {
      console.error("\nTip: Your service principal may need 'Process' permission on the database.");
      console.error("In Azure Portal → gnindiacube → Access control (IAM), add the SP as 'Contributor' or use an admin account.");
    }
    process.exit(1);
  });
