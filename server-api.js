export const needsApiKey = false;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", json, body, keepalive = false, signal } = {}) {
  const headers = {};
  if (method === "POST") headers["X-Voice-Notes"] = "1";
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (body) {
    headers["Content-Type"] = "application/octet-stream";
  }
  const result = await fetch("/api/v1" + path, {
    method, headers, body, keepalive, signal: signal ?? AbortSignal.timeout(6000),
  });
  const payload = await result.json();
  if (!result.ok) throw new ApiError(result.status, payload.error);
  return payload;
}
