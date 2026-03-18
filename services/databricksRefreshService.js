/**
 * Fetches last run of the scheduled "Refresh_Users_Data" job (Jobs API).
 * Never log or return tokens, job IDs, or internal URLs to end users.
 */
const axios = require("axios");
const logger = require("../utils/logger");

const BASE_URL = (process.env.DATABRICKS_URL || "").replace(/\/$/, "");
const TOKEN =
    process.env.DATABRICKS_TOKEN ||
    process.env.TOKEN ||
    process.env.ACCESS_TOKEN ||
    process.env.DATABRICKS_ACCESS_TOKEN ||
    process.env.DATABRICKS_PAT;
const JOB_ID = process.env.DATABRICKS_REFRESH_JOB_ID;

const IST_LOCALE = "en-IN";
const IST_ZONE = "Asia/Kolkata";

let footerCache = { at: 0, payload: null };
const FOOTER_CACHE_MS = 60_000;

function formatEndTimeIST(endTimeMs) {
    if (!endTimeMs || endTimeMs <= 0) return null;
    return (
        new Date(endTimeMs).toLocaleString(IST_LOCALE, {
            timeZone: IST_ZONE,
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: true,
        }) + " IST"
    );
}

/**
 * @returns {Promise<{ endTimeMs: number, succeeded: boolean, durationSec: number, minutesAgo: number } | null>}
 */
async function fetchLastJobRunFromApi() {
    if (!BASE_URL || !TOKEN || !JOB_ID) {
        logger.warn("[RefreshJob] Missing DATABRICKS_URL, token, or DATABRICKS_REFRESH_JOB_ID");
        return null;
    }
    const url = `${BASE_URL}/api/2.1/jobs/runs/list`;
    try {
        const { data } = await axios.get(url, {
            headers: { Authorization: `Bearer ${TOKEN}` },
            params: { job_id: JOB_ID, limit: 1 },
            timeout: 15_000,
        });
        const run = data?.runs?.[0];
        if (!run) {
            logger.warn("[RefreshJob] No runs returned for job");
            return null;
        }
        const endTimeMs = run.end_time || 0;
        const startTimeMs = run.start_time || 0;
        const resultState = run.state?.result_state;
        const lifeCycle = run.state?.life_cycle_state;
        const succeeded = resultState === "SUCCESS";
        const failed =
            resultState === "FAILED" ||
            resultState === "TIMEDOUT" ||
            resultState === "CANCELED";

        let durationSec = 0;
        if (endTimeMs > 0 && startTimeMs > 0) {
            durationSec = Math.max(0, Math.round((endTimeMs - startTimeMs) / 1000));
        }
        const minutesAgo =
            endTimeMs > 0
                ? Math.max(0, Math.floor((Date.now() - endTimeMs) / 60_000))
                : 0;

        return {
            endTimeMs,
            succeeded,
            failed,
            durationSec,
            minutesAgo,
            resultState,
            lifeCycle,
        };
    } catch (err) {
        logger.error("[RefreshJob] Jobs API failed", {
            message: err.message,
            status: err.response?.status,
        });
        return null;
    }
}

async function fetchLastJobRunFromApiNormalized() {
    const run = await fetchLastJobRunFromApi();
    if (!run || !run.endTimeMs) return null;
    return {
        endTimeMs: run.endTimeMs,
        succeeded: run.succeeded,
        failed: run.failed,
        durationSec: run.durationSec,
        minutesAgo: run.minutesAgo,
    };
}

/**
 * Latest run (no cache) — for dedicated "last refresh" questions.
 */
async function getLastRefreshForDisplay() {
    const r = await fetchLastJobRunFromApiNormalized();
    if (!r) return null;
    const timeStr = formatEndTimeIST(r.endTimeMs);
    if (!timeStr) return null;
    const statusLine = r.succeeded ? "Succeeded" : "Failed";
    const minWord = r.minutesAgo === 1 ? "minute" : "minutes";
    const durLabel = `~${r.durationSec}s`;
    const body =
        `*Last Data Refresh*\n\n` +
        `• *Time:* ${timeStr}\n` +
        `• *Status:* ${statusLine}\n` +
        `• *Ran:* ${r.minutesAgo} ${minWord} ago\n` +
        `• *Duration:* ${durLabel}\n\n` +
        `_Data refreshes automatically every hour via Databricks._`;
    return { mrkdwn: body, timeStr };
}

/** Static reply — no last-run times (user asked when refresh happens next). */
const NEXT_REFRESH_MRKDWN =
    `*Next data refresh*\n\n` +
    `• Data is refreshed on an *hourly schedule* in Databricks (about once per hour).\n` +
    `• The exact next run time isn’t available in chat—it depends on the job schedule and workspace queue.\n` +
    `• For when the dataset was last updated, ask something like *last refresh time* or *when was the data synced*.\n\n` +
    `_Nothing is wrong with your question—we just don’t show a predicted next run here._`;

function isNextRefreshQuery(text) {
    const t = (text || "").toLowerCase().trim();
    if (t.length < 4) return false;
    if (/\bnext\b/.test(t) && /\b(refresh|sync|run|update|updated)\b/.test(t)) return true;
    if (/\bwhen\s+will\b/.test(t) && /\b(refresh|sync|update|data)\b/.test(t)) return true;
    if (/\bwhen\s+is\s+the\s+next\b/.test(t) && /\b(refresh|sync|run|update)\b/.test(t))
        return true;
    if (/\bupcoming\b/.test(t) && /\b(refresh|sync|run)\b/.test(t)) return true;
    return false;
}

/**
 * Cached IST time string for footers on data replies.
 */
async function getFooterRefreshLine() {
    const now = Date.now();
    if (footerCache.payload && now - footerCache.at < FOOTER_CACHE_MS) {
        return footerCache.payload;
    }
    const r = await fetchLastJobRunFromApiNormalized();
    if (!r) {
        return { line: "Unable to fetch last refresh time. Please try again later.", ok: false };
    }
    const timeStr = formatEndTimeIST(r.endTimeMs);
    const line = timeStr
        ? `Data last refreshed: ${timeStr}`
        : "Unable to fetch last refresh time. Please try again later.";
    footerCache = { at: now, payload: { line, ok: !!timeStr } };
    return footerCache.payload;
}

function isDataRefreshMetadataQuery(text) {
    const t = (text || "").toLowerCase().trim();
    if (t.length < 4) return false;
    if (isNextRefreshQuery(text)) return false;
    const checks = [
        /last\s+refresh/,
        /refresh\s+time/,
        /\bwhen\s+was\s+.*\b(data|sync)/,
        /when\s+.*\b(data|synced|sync)\b/,
        /data\s+sync/,
        /synced\b.*\b(when|last|time)/,
        /up\s*to\s*date/,
        /up-to-date/,
        /how\s+fresh/,
        /data\s+fresh/,
        /freshness/,
        /last\s+run(\s+time)?/,
        /is\s+the\s+data\s+(up|fresh|current)/,
        /how\s+old\s+is\s+the\s+data/,
    ];
    if (checks.some((re) => re.test(t))) return true;
    if (/\blast\s+(update|updated)\b/.test(t)) {
        if (/\b(data|sync|refresh|table|users|database|warehouse|synced)\b/.test(t))
            return true;
        if (/\bwhen\s+was\b/.test(t)) return true;
    }
    return false;
}

module.exports = {
    getLastRefreshForDisplay,
    getFooterRefreshLine,
    isDataRefreshMetadataQuery,
    isNextRefreshQuery,
    NEXT_REFRESH_MRKDWN,
};
