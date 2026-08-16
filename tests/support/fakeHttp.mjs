// tests/support/fakeHttp.mjs
// api/checkout.js の default export は Vercel の (req, res) 形式の関数。
// テストから直接呼ぶための最小限の req/res スタブ。

/**
 * @param {{action: string, [key: string]: any}} body
 * @returns {{method: string, headers: object, body: object}}
 */
export function fakeReq(body) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer dummy-token' },
    body,
  };
}

/**
 * res.status(code).json(obj) を記録するだけのスタブ。
 * @returns {{status: Function, json: Function, statusCode: number|null, body: any}}
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
  };
  return res;
}
