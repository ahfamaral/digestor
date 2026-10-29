/** JSON error body shared by every API route: `{ error: "<human message>" }`. */
export function errorResponse(status: number, error: string, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers });
}
