import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { check, key, type Store, Problem } from './db'
import { type Book, type Sheets, type Edit, type Tab } from './sheets'

const sheetsUrl = 'https://sheets.googleapis.com/v4/spreadsheets/'
const tokenUrl = 'https://oauth2.googleapis.com/token'
export class GoogleSheets implements Sheets {
  constructor(private db: Store) {}
  config() {
    const {
      GOOGLE_CLIENT_ID: client_id,
      GOOGLE_CLIENT_SECRET: client_secret,
      GOOGLE_REDIRECT_URI: redirect_uri,
      QUIZ_TOKEN_KEY: secret,
    } = process.env
    check(
      client_id &&
        client_secret &&
        redirect_uri &&
        secret &&
        /^[a-f\d]{64}$/i.test(secret),
      '尚未設定 Google OAuth 與憑證加密金鑰',
      503,
    )
    return { client_id, client_secret, redirect_uri, secret }
  }
  authorize(owner: string) {
    const { client_id, redirect_uri } = this.config(),
      state = key()
    this.db.run(
      'INSERT INTO oauth VALUES(?,?,?)',
      state,
      owner,
      Date.now() + 600000,
    )
    const params = new URLSearchParams({
      client_id,
      redirect_uri,
      state,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope:
        'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly',
    })
    return {
      state,
      url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params,
    }
  }
  private async token(fields: Record<string, string>) {
    const { client_id, client_secret } = this.config()
    const response = await fetch(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({ ...fields, client_id, client_secret }),
      signal: AbortSignal.timeout(15000),
    })
    check(response.ok, 'Google 授權失效，請重新連結帳號', 403)
    return response.json() as Promise<{
      refresh_token?: string
      access_token: string
    }>
  }
  private cache = new Map<string, { access: string; until: number }>()
  async callback(state: string, code: string) {
    const record = this.db.one(
      'DELETE FROM oauth WHERE state=? AND expires>? RETURNING teacher',
      state,
      Date.now(),
    )
    check(record, 'Google 授權已過期')
    const { redirect_uri, secret } = this.config()
    const tokens = await this.token({
      code,
      redirect_uri,
      grant_type: 'authorization_code',
    })
    check(tokens.refresh_token, '請重新同意離線授權')
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), iv)
    const data = Buffer.concat([
      cipher.update(tokens.refresh_token, 'utf8'),
      cipher.final(),
    ])
    this.db.run(
      'UPDATE teachers SET google=? WHERE name=?',
      [iv, data, cipher.getAuthTag()]
        .map((x) => x.toString('base64'))
        .join('.'),
      record.teacher,
    )
    this.cache.delete(record.teacher)
  }
  private async access(owner: string) {
    const cache = this.cache.get(owner)
    if (cache && cache.until > Date.now()) return cache.access
    const encoded = this.db.one(
      'SELECT google FROM teachers WHERE name=?',
      owner,
    )?.google
    check(encoded, '請先連結 Google 帳號', 403)
    const [iv, data, tag] = String(encoded)
      .split('.')
      .map((v) => Buffer.from(v, 'base64'))
    const dec = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(this.config().secret, 'hex'),
      iv,
    )
    dec.setAuthTag(tag)
    const refresh_token = Buffer.concat([
      dec.update(data),
      dec.final(),
    ]).toString()
    const token = await this.token({
      refresh_token,
      grant_type: 'refresh_token',
    })
    this.cache.set(owner, {
      access: token.access_token,
      until: Date.now() + 3000000,
    })
    return token.access_token
  }
  private async call(owner: string, url: string, body?: unknown) {
    const bearer = await this.access(owner)
    const r = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + bearer,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) {
      this.cache.delete(owner)
      throw new Problem('Google Sheets 讀寫失敗（HTTP ' + r.status + '）', 502)
    }
    return r.json()
  }
  async read(owner: string, id: string): Promise<Book> {
    const book = encodeURIComponent(id)
    const [meta, data] = await Promise.all([
      this.call(
        owner,
        'https://www.googleapis.com/drive/v3/files/' +
          book +
          '?fields=capabilities(canEdit)&supportsAllDrives=true',
      ),
      this.call(owner, sheetsUrl + book + '?includeGridData=true'),
    ])
    return {
      id,
      title: data.properties.title,
      editable: !!meta.capabilities?.canEdit,
      tabs: data.sheets.map(
        (s: any): Tab => ({
          id: s.properties.sheetId,
          title: s.properties.title,
          merges: s.merges ?? [],
          protections: s.protectedRanges ?? [],
          rows: (s.data?.[0]?.rowData ?? []).map((r: any) => r.values ?? []),
        }),
      ),
    }
  }
  async batchUpdate(owner: string, book: string, requests: unknown[]) {
    return this.call(
      owner,
      sheetsUrl + encodeURIComponent(book) + ':batchUpdate',
      { requests },
    )
  }
  async write(owner: string, book: string, tab: number, edits: Edit[]) {
    await this.batchUpdate(
      owner,
      book,
      edits.map((e) => ({
        updateCells: {
          start: { sheetId: tab, rowIndex: e.row, columnIndex: e.col },
          fields: 'userEnteredValue',
          rows: [{ values: [{ userEnteredValue: { stringValue: e.text } }] }],
        },
      })),
    )
  }
}
