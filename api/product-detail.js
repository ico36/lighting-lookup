import { requireAuth } from './_auth';

// 後継器の詳細情報（仕様・市場価格目安・販売ページ）をWeb検索付きで調査するAPI
// web_search込みのClaude API呼び出しは数十秒かかることがあるため、
// Vercel Hobbyプランで許容される上限（60秒）まで実行時間を延長する。
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // ログイン済みかどうかを確認（メール＋Stripeサブスク確認済みトークン）
  const email = requireAuth(req, res);
  if (!email) return; // requireAuth内で既に401レスポンス済み

  try {
    const { manufacturer, model, name } = req.body;
    if (!model) {
      return res.status(400).json({ error: '型番が指定されていません' });
    }
    const systemPrompt = `あなたは日本の照明器具・電材の専門家です。指定された型番についてWeb検索を行い、電気工事士が見積りに使える実用的な情報をまとめてください。
重要：検索の経緯や説明は一切書かず、JSONオブジェクトのみを出力してください。前置き・後書き・マークダウンのコードブロック記号は不要です。出力の最初の文字は必ず { にしてください。
必ず以下のJSON形式のみで返答してください:
{
  "model": "型番",
  "manufacturer": "メーカー名",
  "specs": {
    "size": "サイズ・寸法（わかれば）",
    "power": "電源方式・消費電力（わかれば）",
    "color_temp": "色温度・光色（わかれば）",
    "weight": "重量（わかれば）",
    "other": "その他の仕様補足（わかれば）"
  },
  "price_estimate": {
    "low": "価格帯の下限（数値、円。不明なら null）",
    "high": "価格帯の上限（数値、円。不明なら null）",
    "note": "価格についての補足（販売店によって差がある、税込/税抜など）",
    "source_note": "価格情報の参照元の傾向（例：複数のECサイトの掲載価格を参考）"
  },
  "catalog_url": "メーカー公式サイトの製品ページまたはカタログURL（わかれば。なければ null）",
  "purchase_links": [
    { "site": "販売店名", "url": "URL" }
  ],
  "confidence": "high" or "medium" or "low"
}
価格は実勢価格の目安であり、保証された正確な数字ではないことを前提に、見つかった情報から合理的な範囲を示してください。情報が見つからない項目はnullにしてください。`;
    const userMessage = `型番「${model}」（メーカー: ${manufacturer || '不明'}、製品名: ${name || '不明'}）について、仕様・市場価格目安・購入先情報を調べてください。`;
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
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
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
