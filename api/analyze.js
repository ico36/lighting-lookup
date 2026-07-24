import { requireAuth } from './_auth';

// このファイルはサーバー側で実行されます。
// ブラウザから直接見えることはなく、APIキーも安全に保たれます。
// web_search込みのClaude API呼び出しは数十秒かかることがあるため、
// Vercel Hobbyプランで許容される上限（60秒）まで実行時間を延長する。
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // POST以外は受け付けない
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // ログイン済みかどうかを確認（メール＋Stripeサブスク確認済みトークン）
  const email = requireAuth(req, res);
  if (!email) return; // requireAuth内で既に401レスポンス済み

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
        max_tokens: 1500,
        system: system,
        messages: messages,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search'
          }
        ]
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
