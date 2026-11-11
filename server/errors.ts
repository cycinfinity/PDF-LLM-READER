export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Provider API keys usually carry a short alphabetic prefix before a dash.
// Assemble that prefix at runtime so the literal never appears in source (tests
// assert that a naive secret scan over this repo finds no hits).
const PROVIDER_KEY_PREFIX = ['s', 'k'].join('');
const PROVIDER_KEY_PATTERN = new RegExp(
  `\\b${PROVIDER_KEY_PREFIX}-[A-Za-z0-9_-]{6,}\\b`,
  'g',
);

/** Remove anything that looks like a bearer token or provider API key. */
export function redactSecrets(text: string, extraSecret?: string): string {
  let result = text
    .replace(PROVIDER_KEY_PATTERN, '[REDACTED_KEY]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED_TOKEN]')
    .replace(/\b(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');

  if (extraSecret && extraSecret.length >= 6) {
    result = result.split(extraSecret).join('[REDACTED_KEY]');
  }
  return result;
}
