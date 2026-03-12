const winston = require("winston");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const extras = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : "";
      return `[${timestamp}] ${level}: ${message}${extras}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

module.exports = logger;