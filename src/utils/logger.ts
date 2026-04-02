// src/utils/logger.ts
// Structured JSON logger using Pino.
// In dev: pretty-printed. In production: JSON for log aggregators.

import pino from 'pino';
import { getConfig } from './config.js';

let _logger: pino.Logger | null = null;

export function getLogger(name?: string): pino.Logger {
  if (!_logger) {
    const config = getConfig();
    const isDev = process.env.NODE_ENV !== 'production';

    _logger = pino({
      level: config.logLevel,
      ...(isDev && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
    });
  }

  return name ? _logger.child({ component: name }) : _logger;
}
