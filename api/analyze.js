// このファイルはサーバー側で実行されます。
// ブラウザから直接見えることはなく、APIキーも安全に保たれます。

export default async function handler(req, res) {
  // POST以外は受け付けない
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 簡易アクセス制限（共有する3人だけが使えるパスコード方式）
  const accessCode = req.headers['x-access-code'];
  if (accessCode !== process.env.APP_ACCESS_CODE) {
    return res.status(401).json({ error: 'アクセスコードが正しくありません' });
  }

  try {
    const { messages, system } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: system,
        messages: messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'API error' });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
