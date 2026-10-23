// Journal de debug. En dehors de VS Code (tests), écrit sur la console si DEBUG est défini.

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

let sink: (line: string) => void = (line) => {
  if (process.env.AGENT_HUB_DEBUG) console.log(line);
};

export function setLogSink(fn: (line: string) => void): void {
  sink = fn;
}

/** Masque tout ce qui ressemble à une clé d'API avant de loguer. */
export function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{10,}|sk-ant-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g, '***')
    .replace(/((?:api[_-]?key|token|authorization|bearer)["'\s:=]+)[^\s"',}]+/gi, '$1***');
}

export function createLogger(scope: string): Logger {
  const write = (level: string, msg: string) =>
    sink(`[${new Date().toISOString()}] [${level}] [${scope}] ${redact(msg)}`);
  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}
