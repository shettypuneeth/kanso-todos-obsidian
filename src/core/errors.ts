/** Normalizes thrown values before presenting them in a widget UI. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
