type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const VALID_LEVELS: readonly string[] = ["DEBUG", "INFO", "WARN", "ERROR"];
const rawLevel = process.env.LOG_LEVEL ?? "INFO";
if (!VALID_LEVELS.includes(rawLevel)) {
  console.error(
    `[WARN] Invalid LOG_LEVEL "${rawLevel}", defaulting to INFO. Valid: ${VALID_LEVELS.join(", ")}`
  );
}
const minLevel: LogLevel = VALID_LEVELS.includes(rawLevel)
  ? (rawLevel as LogLevel)
  : "INFO";

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

/** Format an error for logging, preserving stack trace */
export function errStr(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}
