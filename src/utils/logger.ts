type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const minLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ?? "INFO";

function formatTimestamp(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, component: string, message: string): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;
  const line = `[${formatTimestamp()}] [${level}] [${component}] ${message}`;
  if (level === "ERROR") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function createLogger(component: string) {
  return {
    debug: (msg: string) => log("DEBUG", component, msg),
    info: (msg: string) => log("INFO", component, msg),
    warn: (msg: string) => log("WARN", component, msg),
    error: (msg: string) => log("ERROR", component, msg),
  };
}
