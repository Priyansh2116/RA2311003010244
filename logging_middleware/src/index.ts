import axios, { AxiosError } from 'axios';

//  avoid repeated env lookups on every log call
const EVALUATION_SERVER = process.env.EVALUATION_BASE_URL ?? 'http://20.207.122.201/evaluation-service';
const DISPATCH_TIMEOUT_MS = 5_000;

export type Severity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

// Module-scoped credential set once at application startup so individual
let bearerCredential: string | null = null;

export function configureBearerToken(token: string): void {
  bearerCredential = token;
}

// Kept as a pure function so it can be unit-tested independently of axios
function assembleRequestHeaders(): Record<string, string> {
  const base: Record<string, string> = { 'Content-Type': 'application/json' };
  return bearerCredential
    ? { ...base, Authorization: `Bearer ${bearerCredential}` }
    : base;
}

async function transmitToEvaluationServer(body: object): Promise<void> {
  await axios.post(`${EVALUATION_SERVER}/log`, body, {
    headers: assembleRequestHeaders(),
    timeout: DISPATCH_TIMEOUT_MS,
  });
}

/**
 *
 * @param callStack  
 * @param severity   
 * @param moduleName - originating package name
 * @param detail     - descriptive message with runtime context
 */
export async function Log(
  callStack: string,
  severity: Severity,
  moduleName: string,
  detail: string,
): Promise<void> {
  const payload = {
    stack: callStack,
    level: severity,
    package: moduleName,
    message: detail,
  };

  try {
    await transmitToEvaluationServer(payload);
  } catch (err) {
    // Surface just enough context on stderr without re-throwing
    const reason = err instanceof AxiosError ? err.message : String(err);
    console.error(
      `[logging-middleware] ${severity} | ${moduleName} | ${callStack} | ${detail} (dispatch failed: ${reason})`,
    );
  }
}

// Legacy alias — keeps existing call-sites working without a mass rename
export { configureBearerToken as setAuthToken };
