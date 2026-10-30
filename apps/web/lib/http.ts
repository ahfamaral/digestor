/** JSON error body shared by every API route: `{ error: "<human message>" }`. */
export function errorResponse(status: number, error: string, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers });
}

/** The `error` sentence of a failed API response, or `fallback` when the body has none. Safe in client code. */
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === "string" && error.trim()) return error;
  } catch {
    // not JSON
  }
  return fallback;
}
