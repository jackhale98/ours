// SPDX-License-Identifier: AGPL-3.0-or-later
/** Minimal JSON client for the Ours API. Bearer token auth; no cookies. */
import { API_URL } from '../config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

let token: string | null = null;
export const setToken = (t: string | null) => {
  token = t;
};

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean; raw?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API_URL.replace(/\/$/, '')}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError(0, 'offline', 'You seem to be offline.');
  }
  // `raw`: the caller wants the body as text (e.g. a relayed calendar).
  if (init.raw && res.ok) return (await res.text()) as T;
  const json = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json?.error ?? 'error',
      json?.message ?? 'Something went wrong.',
      json,
    );
  }
  return json as T;
}
