// src/services/aasService.js
//
// Communicates with Azure Analysis Services via the XMLA (XML for Analysis)
// HTTP endpoint using MDX queries.
//
// Auth: Azure AD client-credentials flow (service principal).
//
const axios = require("axios");
const logger = require("../utils/logger");

// ── Azure AD token cache ───────────────────────────────────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

/**
 * Obtains an Azure AD access token for the Analysis Services resource
 * using client credentials (service principal).
 */
async function getAzureAdToken() {
  const now = Date.now();

  if (_tokenCache.token && now < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const tenantId = process.env.AAS_TENANT_ID;
  const clientId = process.env.AAS_USERNAME;
  const clientSecret = process.env.AAS_PASSWORD;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("AAS_TENANT_ID, AAS_USERNAME, AAS_PASSWORD must be set in .env");
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/token`;

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    resource: "https://*.asazure.windows.net",
  });

  logger.info("[AAS] 0. Requesting Azure AD token");

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15_000,
  });

  if (!response.data?.access_token) {
    throw new Error("Azure AD token request failed: no access_token in response");
  }

  const { access_token, expires_in } = response.data;
  _tokenCache = {
    token: access_token,
    expiresAt: now + parseInt(expires_in, 10) * 1000,
  };

  logger.info("[AAS] 0. Azure AD token obtained", { expiresIn: `${expires_in}s` });
  return access_token;
}

// ── Build XMLA Execute SOAP envelope ──────────────────────────────────────────
function buildXmlaEnvelope(mdx, database) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>${escapeXml(mdx)}</Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>${escapeXml(database)}</Catalog>
          <Format>Tabular</Format>
          <Content>Data</Content>
        </PropertyList>
      </Properties>
    </Execute>
  </Body>
</Envelope>`;
}

/** Build XMLA Execute envelope for a TMSL command (e.g. Process/Refresh). */
function buildTmslEnvelope(tmslJson, database) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
      <Command>
        <Statement>${escapeXml(tmslJson)}</Statement>
      </Command>
      <Properties>
        <PropertyList>
          <Catalog>${escapeXml(database)}</Catalog>
          <Format>Tabular</Format>
        </PropertyList>
      </Properties>
    </Execute>
  </Body>
</Envelope>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Cube name cache (Discover once per database) ──────────────────────────────
let _cubeNameCache = {};

/**
 * Build XMLA Discover SOAP envelope for MDSCHEMA_CUBES to get cube name(s) in a database.
 */
function buildDiscoverEnvelope(database) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <Discover xmlns="urn:schemas-microsoft-com:xml-analysis">
      <RequestType>MDSCHEMA_CUBES</RequestType>
      <Restrictions>
        <RestrictionList>
          <CATALOG_NAME>${escapeXml(database)}</CATALOG_NAME>
        </RestrictionList>
      </Restrictions>
      <Properties>
        <PropertyList>
          <Catalog>${escapeXml(database)}</Catalog>
          <Format>Tabular</Format>
        </PropertyList>
      </Properties>
    </Discover>
  </Body>
</Envelope>`;
}

/**
 * Parse CUBE_NAME from XMLA Discover MDSCHEMA_CUBES rowset response.
 * Returns the first cube name, or null if not found.
 */
function parseCubeNameFromDiscover(xmlResponse) {
  // Rowset has <row> elements with <CUBE_NAME>...</CUBE_NAME>
  const match = /<CUBE_NAME>([^<]*)<\/CUBE_NAME>/i.exec(xmlResponse);
  return match ? match[1].trim() : null;
}

// ── Schema cache (dimensions/levels for MDX generation) ─────────────────────────
let _schemaCache = null;

/**
 * Build XMLA Discover SOAP envelope for MDSCHEMA_LEVELS to get dimension/level names.
 */
function buildLevelsDiscoverEnvelope(database, cubeName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
  <Body>
    <Discover xmlns="urn:schemas-microsoft-com:xml-analysis">
      <RequestType>MDSCHEMA_LEVELS</RequestType>
      <Restrictions>
        <RestrictionList>
          <CATALOG_NAME>${escapeXml(database)}</CATALOG_NAME>
          <CUBE_NAME>${escapeXml(cubeName)}</CUBE_NAME>
        </RestrictionList>
      </Restrictions>
      <Properties>
        <PropertyList>
          <Catalog>${escapeXml(database)}</Catalog>
          <Format>Tabular</Format>
        </PropertyList>
      </Properties>
    </Discover>
  </Body>
</Envelope>`;
}

/**
 * Parse LEVEL_UNIQUE_NAME and LEVEL_CAPTION from MDSCHEMA_LEVELS rowset.
 * Returns array of { levelUniqueName, levelCaption } for attribute levels (LEVEL_NUMBER 0 or 1).
 */
function parseLevelsFromDiscover(xmlResponse) {
  const rows = [];
  const rowRegex = /<row>([\s\S]*?)<\/row>/gi;
  let match;
  while ((match = rowRegex.exec(xmlResponse)) !== null) {
    const rowXml = match[1];
    const getVal = (name) => {
      const re = new RegExp(`<${name}[^>]*>([^<]*)<\\/${name}>`, "i");
      const m = re.exec(rowXml);
      return m ? m[1].trim() : "";
    };
    const levelNumber = parseInt(getVal("LEVEL_NUMBER"), 10);
    // Keep attribute levels (Tabular can use 0–4 for table columns)
    if (isNaN(levelNumber) || levelNumber > 4) continue;
    const levelUniqueName = getVal("LEVEL_UNIQUE_NAME");
    const levelCaption = getVal("LEVEL_CAPTION");
    if (levelUniqueName && levelCaption) {
      rows.push({ levelUniqueName, levelCaption });
    }
  }
  return rows;
}

/**
 * Discover dimension/level names from the cube (cached). Use these exact names in MDX.
 * @returns {Promise<Array<{ levelUniqueName: string, levelCaption: string }>>}
 */
async function discoverSchema() {
  if (_schemaCache) return _schemaCache;

  const endpoint = process.env.AAS_XMLA_ENDPOINT;
  const database = process.env.AAS_DATABASE;
  if (!endpoint || !database) {
    throw new Error("AAS_XMLA_ENDPOINT and AAS_DATABASE must be set in .env");
  }

  let regionHost, serverName;
  if (endpoint.startsWith("asazure://")) {
    const withoutScheme = endpoint.replace("asazure://", "");
    const parts = withoutScheme.split("/");
    regionHost = parts[0];
    serverName = parts[1] || parts[0];
  } else {
    throw new Error("AAS_XMLA_ENDPOINT must be asazure://region.asazure.windows.net/servername");
  }

  const clusterFQDN = await resolveClusterFqdn(regionHost, serverName);
  const xmlaUrl = `https://${clusterFQDN}/webapi/xmla`;
  const token = await getAzureAdToken();
  const cubeName = await discoverCubeName(xmlaUrl, serverName, token, database);

  const envelope = buildLevelsDiscoverEnvelope(database, cubeName);
  logger.info("AAS: Discovering schema (MDSCHEMA_LEVELS)", { database, cubeName });

  const response = await axios.post(xmlaUrl, envelope, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Authorization": `Bearer ${token}`,
      "SOAPAction": "urn:schemas-microsoft-com:xml-analysis:Discover",
      "x-ms-xmlaserver": serverName,
      "User-Agent": "XmlaClient",
      "x-ms-xmlacaps-negotiation-flags": "1,0,0,0,0",
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`AAS schema discover failed: status ${response.status}`);
  }
  const rawXml = response.data;
  if (rawXml.includes("<faultcode>") || rawXml.includes(":Fault>")) {
    const faultMatch = /<faultstring>([^<]+)<\/faultstring>/i.exec(rawXml);
    throw new Error(faultMatch ? faultMatch[1] : "AAS schema discover returned a fault");
  }

  const levels = parseLevelsFromDiscover(rawXml);
  _schemaCache = levels;
  logger.info("AAS: Schema discovered", { levelCount: levels.length, sample: levels.slice(0, 5) });
  return levels;
}

/**
 * Discover the cube name for the given database via XMLA Discover; result is cached.
 */
async function discoverCubeName(xmlaUrl, serverName, token, database) {
  if (_cubeNameCache[database]) {
    return _cubeNameCache[database];
  }
  const envelope = buildDiscoverEnvelope(database);
  logger.info("AAS: Discovering cube name", { database });

  const response = await axios.post(xmlaUrl, envelope, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Authorization": `Bearer ${token}`,
      "SOAPAction": "urn:schemas-microsoft-com:xml-analysis:Discover",
      "x-ms-xmlaserver": serverName,
      "User-Agent": "XmlaClient",
      "x-ms-xmlacaps-negotiation-flags": "1,0,0,0,0",
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`AAS Discover failed: status ${response.status}`);
  }
  const rawXml = response.data;
  if (rawXml.includes("<faultcode>") || rawXml.includes(":Fault>")) {
    const faultMatch = /<faultstring>([^<]+)<\/faultstring>/i.exec(rawXml);
    throw new Error(faultMatch ? faultMatch[1] : "AAS Discover returned a fault");
  }

  const cubeName = parseCubeNameFromDiscover(rawXml);
  if (!cubeName) {
    throw new Error(
      "AAS Discover did not return a cube name. Check that AAS_DATABASE matches a model on the server."
    );
  }
  _cubeNameCache[database] = cubeName;
  logger.info("AAS: Cube name discovered", { database, cubeName });
  return cubeName;
}

// ── Parse XMLA Tabular response ───────────────────────────────────────────────
/**
 * Parses the raw XMLA XML response into columns + rows.
 * Handles both the xsd:element column definitions and <row> data blocks.
 */
function parseXmlaResponse(xmlResponse) {
  const columns = [];
  const rows = [];

  // ── Extract column names from xsd:element definitions ─────────────────────
  // Pattern: <xsd:element name="ColumnName" .../>
  const colRegex = /<xsd:element[^>]+name="([^"]+)"[^>]*/gi;
  let match;
  while ((match = colRegex.exec(xmlResponse)) !== null) {
    const name = match[1];
    // Skip internal XMLA schema columns (start with _)
    if (!name.startsWith("_") && !columns.includes(name)) {
      columns.push(name);
    }
  }

  logger.info("AAS: Parsed columns from XMLA", { columns });

  // ── Extract rows: support both <row> and <prefix:row> (e.g. rowset namespace) ─
  const rowRegex = /<(?:[\w.-]+:)?row(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?row>/gi;
  const rowBlocks = [];
  while ((match = rowRegex.exec(xmlResponse)) !== null) {
    rowBlocks.push(match[1]);
  }

  // When COLUMNS axis is empty, Tabular may not emit xsd:element; derive columns from first row
  if (columns.length === 0 && rowBlocks.length > 0) {
    const firstRowXml = rowBlocks[0];
    // Match <TagName>value</TagName> — allow colons in tag names (e.g. namespace)
    const tagRegex = /<([^>\s/]+)(?:\s[^>]*)?>([^<]*)<\/\1>/gi;
    const seen = new Set();
    let tagMatch;
    while ((tagMatch = tagRegex.exec(firstRowXml)) !== null) {
      const tagName = tagMatch[1];
      if (!tagName.startsWith("_") && !seen.has(tagName)) {
        seen.add(tagName);
        columns.push(tagName);
      }
    }
    logger.info("AAS: Derived columns from first row (empty COLUMNS axis)", { columns });
  }

  if (columns.length === 0) {
    // Log snippet to debug response shape when no rows/columns found
    const snippet = xmlResponse.slice(0, 1200).replace(/\s+/g, " ");
    logger.warn("AAS: No columns found in XMLA response — check MDX query or cube model", {
      rowBlockCount: rowBlocks.length,
      xmlSnippet: snippet.length >= 1200 ? snippet + "..." : snippet,
    });
    return { columns: [], rows: [] };
  }

  for (const rowXml of rowBlocks) {
    const row = {};
    for (const col of columns) {
      const safeCol = col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const cellRegex = new RegExp(`<${safeCol}[^>]*>([^<]*)<\\/${safeCol}>`, "i");
      const cellMatch = cellRegex.exec(rowXml);
      row[col] = cellMatch ? decodeXmlEntities(cellMatch[1].trim()) : null;
    }
    rows.push(row);
  }

  // Remove dummy calculated member column if present (used to avoid empty COLUMNS axis)
  const dummyCol = columns.find((c) => /_Val|Measures\._Val/i.test(c) || c === "_Val");
  if (dummyCol && columns.length > 1) {
    const idx = columns.indexOf(dummyCol);
    columns.splice(idx, 1);
    rows.forEach((r) => delete r[dummyCol]);
  }

  logger.info("AAS: Parsed rows from XMLA", { rowCount: rows.length });
  return { columns, rows };
}

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ── Validate MDX — basic safety check ────────────────────────────────────────
function validateMdx(mdx) {
  const upper = mdx.trim().toUpperCase();

  // Allow standard MDX/DAX read patterns
  if (!upper.startsWith("SELECT") && !upper.startsWith("WITH") && !upper.startsWith("EVALUATE") && !upper.startsWith("DEFINE")) {
    return { valid: false, reason: "Only SELECT, WITH, EVALUATE, or DEFINE queries are permitted." };
  }

  const blocked = ["CREATE", "DROP", "ALTER", "INSERT", "UPDATE", "DELETE", "CALL"];
  for (const kw of blocked) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) {
      return { valid: false, reason: `Restricted MDX operation detected: ${kw}` };
    }
  }

  return { valid: true };
}

// ── Resolve AAS cluster FQDN (required before XMLA calls) ──────────────────────
/**
 * Azure AAS uses a two-step flow: first resolve the cluster endpoint via
 * webapi/clusterResolve, then send XMLA to https://{clusterFQDN}/webapi/xmla.
 * See: https://stackoverflow.com/questions/44518734 (msmdpump / Azure AAS HTTP)
 *
 * @param {string} regionHost - e.g. southeastasia.asazure.windows.net
 * @param {string} serverName - e.g. gnindiacube
 * @returns {Promise<string>} cluster FQDN, e.g. prefix-southeastasia.asazure.windows.net
 */
async function resolveClusterFqdn(regionHost, serverName) {
  const resolveUrl = `https://${regionHost}/webapi/clusterResolve`;
  logger.info("[AAS] 1. Resolving cluster (clusterResolve)", { resolveUrl, serverName });

  let response;
  try {
    response = await axios.post(
      resolveUrl,
      { serverName },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15_000,
        validateStatus: () => true,
      }
    );
  } catch (err) {
    logger.error("[AAS] 1. clusterResolve request failed", { error: err.message });
    throw new Error(
      `AAS clusterResolve failed: ${err.message}. Check AAS server name and region.`
    );
  }

  if (response.status !== 200) {
    const body =
      typeof response.data === "object"
        ? JSON.stringify(response.data)
        : String(response.data || "").slice(0, 200);
    logger.error("[AAS] 1. clusterResolve returned non-200", { status: response.status, body });
    throw new Error(
      `AAS clusterResolve returned ${response.status}. ${body}`
    );
  }

  const clusterFQDN = response.data?.clusterFQDN;
  if (!clusterFQDN) {
    logger.error("[AAS] 1. clusterResolve missing clusterFQDN", { data: response.data });
    throw new Error(
      "AAS clusterResolve did not return clusterFQDN. Response: " +
        JSON.stringify(response.data || response.status)
    );
  }

  logger.info("[AAS] 2. Cluster resolved", { clusterFQDN });
  return clusterFQDN;
}

// ── Main execute function ──────────────────────────────────────────────────────
/**
 * Executes a validated MDX query against Azure Analysis Services.
 *
 * @param {string} mdx - A validated, read-only MDX SELECT query.
 * @returns {Promise<{ columns: string[], rows: Object[], rawXml: string }>}
 */
async function executeMdxQuery(mdx) {
  const endpoint = process.env.AAS_XMLA_ENDPOINT;
  const database = process.env.AAS_DATABASE;

  if (!endpoint || !database) {
    throw new Error("AAS_XMLA_ENDPOINT and AAS_DATABASE must be set in .env");
  }

  // ── Validate MDX ──────────────────────────────────────────────────────────
  const validation = validateMdx(mdx);
  if (!validation.valid) {
    throw new Error(`MDX validation failed: ${validation.reason}`);
  }

  // ── Parse asazure:// URI ───────────────────────────────────────────────────
  // asazure://southeastasia.asazure.windows.net/gnindiacube → regionHost + serverName
  let regionHost, serverName;
  if (endpoint.startsWith("asazure://")) {
    const withoutScheme = endpoint.replace("asazure://", "");
    const parts = withoutScheme.split("/");
    regionHost = parts[0];
    serverName = parts[1] || parts[0];
  } else {
    throw new Error("AAS_XMLA_ENDPOINT must be asazure://region.asazure.windows.net/servername");
  }

  // ── Resolve cluster and get token ───────────────────────────────────────────
  const clusterFQDN = await resolveClusterFqdn(regionHost, serverName);
  const xmlaUrl = `https://${clusterFQDN}/webapi/xmla`;
  const token = await getAzureAdToken();

  const isDax = /^\s*(EVALUATE|DEFINE)\s+/i.test(mdx);
  let normalizedMdx;

  if (isDax) {
    normalizedMdx = mdx.trim();
    logger.info("[AAS] 3. Executing DAX query", { database, daxPreview: normalizedMdx.slice(0, 120) });
  } else {
    // ── Discover cube name; use in FROM clause (MDX only) ─────────────────────
    const cubeName = await discoverCubeName(xmlaUrl, serverName, token, database);
    normalizedMdx = mdx.replace(
      /FROM\s*\[\s*[^\]]+\s*\]/gi,
      `FROM [${cubeName}]`
    );
    // Empty COLUMNS axis can cause Tabular to return a non-standard rowset
    if (/\{\s*\}\s*ON\s*COLUMNS/i.test(normalizedMdx)) {
      normalizedMdx = normalizedMdx.replace(/\{\s*\}\s*ON\s*COLUMNS/gi, "{ [Measures].[_Val] } ON COLUMNS");
      normalizedMdx = "WITH MEMBER [Measures].[_Val] AS 1 " + normalizedMdx;
      logger.info("[AAS] 3. Normalized empty COLUMNS", { mdxPreview: normalizedMdx.slice(0, 140) });
    }
    logger.info("[AAS] 3. Executing MDX query", { database, cubeName, mdxPreview: normalizedMdx.slice(0, 120) });
  }

  // ── Build SOAP envelope and send Execute ──────────────────────────────────
  const envelope = buildXmlaEnvelope(normalizedMdx, database);

  logger.info("[AAS] 4. Sending XMLA request", { url: xmlaUrl, serverName });

  let response;
  try {
    response = await axios.post(xmlaUrl, envelope, {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "Authorization": `Bearer ${token}`,
        "SOAPAction": "urn:schemas-microsoft-com:xml-analysis:Execute",
        "x-ms-xmlaserver": serverName,
        "User-Agent": "XmlaClient",
        "x-ms-xmlacaps-negotiation-flags": "1,0,0,0,0",
      },
      timeout: 30_000,
      validateStatus: () => true, // accept any status so we can inspect and handle errors
    });
  } catch (err) {
    const msg = err.response?.data
      ? String(err.response.data).slice(0, 200)
      : err.message;
    throw new Error(`AAS XMLA request failed: ${msg}`);
  }

  if (response.status !== 200) {
    const body = response.data != null ? String(response.data).slice(0, 300) : "";
    throw new Error(
      `AAS query error: Request failed with status code ${response.status}. ${body}`
    );
  }

  const rawXml = response.data;

  // ── Check for SOAP faults ─────────────────────────────────────────────────
  if (rawXml.includes("<faultcode>") || rawXml.includes("SOAP-ENV:Fault") || rawXml.includes(":Fault>")) {
    const faultMatch = /<faultstring>([^<]+)<\/faultstring>/i.exec(rawXml);
    const descMatch = /<ErrorCode>([^<]+)<\/ErrorCode>/i.exec(rawXml);
    const fault = faultMatch ? faultMatch[1] : (descMatch ? descMatch[1] : "Unknown XMLA fault");
    logger.error("[AAS] 4. SOAP fault received", { fault, rawXmlSnippet: rawXml.slice(0, 500) });
    throw new Error(`AAS query failed: ${fault}`);
  }

  // ── Parse and return ──────────────────────────────────────────────────────
  const { columns, rows } = parseXmlaResponse(rawXml);

  logger.info("[AAS] 5. Query completed", { columnCount: columns.length, rowCount: rows.length });

  return { columns, rows, rawXml };
}

// ── Process / Refresh model (alternative to Sync; works without Standard tier) ───
/**
 * Process (refresh) the AAS database so it loads data from the data source.
 * Use this instead of "Synchronize model" when Sync requires Standard tier.
 * Your service principal needs Process permission on the database (not just Reader).
 *
 * @param {string} [database] - Database name (default: AAS_DATABASE from env)
 * @param {string} [refreshType] - "full" | "dataOnly" | "automatic" (default: "full")
 * @returns {Promise<void>}
 */
async function processModel(database = process.env.AAS_DATABASE, refreshType = "full") {
  const endpoint = process.env.AAS_XMLA_ENDPOINT;
  const db = database || process.env.AAS_DATABASE;
  if (!endpoint || !db) {
    throw new Error("AAS_XMLA_ENDPOINT and AAS_DATABASE must be set in .env");
  }

  let regionHost, serverName;
  if (endpoint.startsWith("asazure://")) {
    const withoutScheme = endpoint.replace("asazure://", "");
    const parts = withoutScheme.split("/");
    regionHost = parts[0];
    serverName = parts[1] || parts[0];
  } else {
    throw new Error("AAS_XMLA_ENDPOINT must be asazure://region.asazure.windows.net/servername");
  }

  const clusterFQDN = await resolveClusterFqdn(regionHost, serverName);
  const xmlaUrl = `https://${clusterFQDN}/webapi/xmla`;
  const token = await getAzureAdToken();

  const tmsl = JSON.stringify({
    refresh: {
      type: refreshType,
      objects: [{ database: db }],
    },
  });

  const envelope = buildTmslEnvelope(tmsl, db);
  logger.info("AAS: Sending Process (Refresh) command", { database: db, type: refreshType });

  const response = await axios.post(xmlaUrl, envelope, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Authorization": `Bearer ${token}`,
      "SOAPAction": "urn:schemas-microsoft-com:xml-analysis:Execute",
      "x-ms-xmlaserver": serverName,
      "User-Agent": "XmlaClient",
      "x-ms-xmlacaps-negotiation-flags": "1,0,0,0,0",
    },
    timeout: 300_000, // 5 min for full refresh
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    const body = response.data != null ? String(response.data).slice(0, 400) : "";
    throw new Error(`AAS Process failed: status ${response.status}. ${body}`);
  }

  const rawXml = response.data;
  if (rawXml.includes("<faultcode>") || rawXml.includes(":Fault>")) {
    const faultMatch = /<faultstring>([^<]+)<\/faultstring>/i.exec(rawXml);
    throw new Error(faultMatch ? faultMatch[1] : "AAS Process returned a fault");
  }

  logger.info("AAS: Process (Refresh) completed successfully", { database: db });
}

module.exports = { executeMdxQuery, discoverSchema, processModel };