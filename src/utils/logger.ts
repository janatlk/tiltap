import winston from "winston";
import { config } from "../config";

export const logger = winston.createLogger({
  level: config.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: "tiltab-backend" },
  transports: [
    new winston.transports.Console({
      format:
        config.NODE_ENV === "development"
          ? winston.format.combine(
              winston.format.colorize(),
              winston.format.printf(({ level, message, timestamp, ...metadata }) => {
                let msg = `${timestamp} [${level}]: ${message}`;
                if (Object.keys(metadata).length > 0 && metadata.service === undefined) {
                  msg += ` ${JSON.stringify(metadata)}`;
                } else if (Object.keys(metadata).length > 1) {
                  const { service, ...rest } = metadata;
                  msg += ` ${JSON.stringify(rest)}`;
                }
                return msg;
              })
            )
          : winston.format.json(),
    }),
  ],
});

export const logRequest = (method: string, path: string, statusCode: number, durationMs: number) => {
  logger.info("HTTP request", { method, path, statusCode, durationMs });
};
