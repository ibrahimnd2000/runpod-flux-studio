export interface JsonResult<T> {
  ok: boolean;
  /** HTTP status, or 0 when the request never got a response (offline, DNS, CORS). */
  status: number;
  data: T;
  /** Human-readable reason when !ok. */
  error?: string;
}

/**
 * fetch + JSON that never throws. While the pod (re)starts, Runpod's proxy answers
 * with an HTML page; that, network failures and server errors all come back as
 * { ok: false, error } instead of an exception or a JSON parse message.
 */
export async function getJson<T>(url: string, init?: RequestInit): Promise<JsonResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    return { ok: false, status: 0, data: {} as T, error: "Network error: check your connection." };
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    const error = text.trimStart().startsWith("<")
      ? "The app server is restarting or unreachable."
      : `Unexpected response from the server (HTTP ${res.status}).`;
    return { ok: false, status: res.status, data: {} as T, error };
  }
  const serverError = (data as { error?: unknown })?.error;
  return {
    ok: res.ok,
    status: res.status,
    data: data as T,
    error: res.ok ? undefined : typeof serverError === "string" ? serverError : `HTTP ${res.status}`,
  };
}

/** Server errors and network failures are worth retrying; 4xx are not. */
export const isTransient = (status: number) => status === 0 || status >= 500;
