// tests/support/fakeHttp.mjs
// api/*.js の default export は Vercel の (req, res) 形式の関数。
// テストから直接呼ぶための最小限の req/res スタブ。

/**
 * @param {object} [body] リクエストボディ(POST/PATCH向け)
 * @param {{method?: string, query?: object, headers?: object}} [overrides]
 *   method既定は'POST'(api/checkout.js向けの元の既定を維持)。GETや
 *   req.query(例: api/cases/[id].js の { id })が要る場合はここで指定する。
 * @returns {{method: string, headers: object, body: object, query: object}}
 */
export function fakeReq(body, overrides = {}) {
  return {
    method: overrides.method || 'POST',
    headers: { authorization: 'Bearer dummy-token', ...overrides.headers },
    body,
    query: overrides.query || {},
  };
}

/**
 * res.status(code).json(obj) を記録するだけのスタブ。
 * setHeader()は405応答(Allow ヘッダ)向けの呼び出しを受け止めるだけのno-op。
 * @returns {{status: Function, json: Function, setHeader: Function, statusCode: number|null, body: any}}
 */
export function fakeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
    setHeader() {
      return res;
    },
  };
  return res;
}
