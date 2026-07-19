import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const logFormat = winston.format.printf(({ timestamp, level, message }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${message}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
      )
    }),
    // Vercel's serverless functions have a read-only filesystem (only /tmp
    // is writable) — writing to a relative 'logs/' path throws EROFS at
    // startup and crashes the function before it can handle any request.
    // Skip the file transport there; stdout is already captured by Vercel's
    // own logging. Render's filesystem is a regular writable container, so
    // this stays on for that deployment.
    ...(process.env.VERCEL ? [] : [
      new DailyRotateFile({
        filename: 'logs/server-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
      }),
    ]),
  ]
});

export default logger;
