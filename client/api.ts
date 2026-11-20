import type { Preview } from '../shared/types'
export class ApiError extends Error {
  constructor(
    message: string,
    readonly preview?: Preview,
  ) {
    super(message)
  }
}
export type { Snapshot, Question, Preview, Slot, Phase } from '../shared/types'
export async function api<T>(
  path: string,
  token?: string,
  data?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (data !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch('/api/' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: 'no-store',
  })
  const result = await res.json()
  if (!res.ok) throw new ApiError(result.error ?? '請求失敗', result.preview)
  return result
}
