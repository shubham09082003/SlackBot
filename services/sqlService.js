// src/services/sqlService.js
const sql = require("mssql");
const logger = require("../utils/logger");

const config = {
    server: process.env.AZURE_DB_SERVER,
    database: process.env.AZURE_DB_NAME,
    user: process.env.AZURE_DB_USER,
    password: process.env.AZURE_DB_PASSWORD,
    options: {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

let _pool = null;
let _lastRefresh = null;   // tracks last successful connection/refresh
const REFRESH_MS = 15 * 60 * 1000;  // 15 minutes in milliseconds

// ── Connection pool ────────────────────────────────────────────────────────────

async function getPool() {
    const now = Date.now();

    // Re-create pool if it doesn't exist OR it's been over 15 minutes
    if (!_pool || (now - _lastRefresh) >= REFRESH_MS) {
        if (_pool) {
            logger.info("SQL: Closing old connection pool for scheduled refresh");
            try { await _pool.close(); } catch (_) { }
            _pool = null;
        }

        logger.info("SQL: Creating new connection pool");
        _pool = await sql.connect(config);
        _lastRefresh = now;
        logger.info("SQL: Connection pool ready", { refreshedAt: getLastRefreshString() });
    }

    return _pool;
}

// ── Scheduled auto-refresh every 1 hour ───────────────────────────────────────

function startAutoRefresh() {
    setInterval(async () => {
        logger.info("SQL: Auto-refresh triggered (15min schedule)");
        try {
            if (_pool) {
                await _pool.close();
                _pool = null;
            }
            _pool = await sql.connect(config);
            _lastRefresh = Date.now();
            logger.info("SQL: Auto-refresh complete", { refreshedAt: getLastRefreshString() });
        } catch (err) {
            logger.error("SQL: Auto-refresh failed", { error: err.message });
        }
    }, REFRESH_MS);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getLastRefreshString() {
    if (!_lastRefresh) return "Not yet connected";
    return new Date(_lastRefresh).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
    }) + " IST";
}

function getLastRefreshTimestamp() {
    return _lastRefresh;
}

// ── Execute query ──────────────────────────────────────────────────────────────

/**
 * Executes a validated SELECT query against Azure SQL Database.
 * @param {string} query
 * @returns {Promise<{ columns: string[], rows: Object[], lastRefresh: string }>}
 */
async function executeSqlQuery(query) {
    logger.info("SQL: Executing query", { preview: query.slice(0, 120) });

    const pool = await getPool();
    const result = await pool.request().query(query);

    const rows = result.recordset;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

    logger.info("SQL: Query complete", { rowCount: rows.length });

    return {
        columns,
        rows,
        lastRefresh: getLastRefreshString(),
    };
}

module.exports = { executeSqlQuery, startAutoRefresh, getLastRefreshString, getLastRefreshTimestamp };