/** One JSON object per line: Cloud Logging reads `severity` and `message` from it. */
export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export function log(severity: Severity, message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ severity, message, time: new Date().toISOString(), ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  (severity === "ERROR" ? console.error : console.log)(line);
}
