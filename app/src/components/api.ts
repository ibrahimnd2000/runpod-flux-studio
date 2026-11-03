/**
 * fetch + JSON that survives non-JSON replies. While the pod (re)starts, Runpod's
 * proxy answers with an HTML page; surface that as a readable error instead of
 * a JSON parse failure.
 */
export async function getJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) as T };
  } catch {
    const msg =
      res.status >= 500 || text.trimStart().startsWith("<")
        ? `The app server is restarting or unreachable (HTTP ${res.status}). Retrying…`
        : `Unexpected response (HTTP ${res.status}).`;
    return { ok: false, status: res.status, data: { error: msg } as T };
  }
}
