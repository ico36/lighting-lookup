import { requireAuthWithPlan } from './_auth';
import { reserveSearch, releaseSearch, quotaFromReservation } from '../lib/quota';

// 型番テキスト・写真から後継器／互換品をWeb検索付きで調査するAPI
//
// プロンプト（システムプロンプトとユーザープロンプトの両方）はこのファイル内で
// 組み立てる。クライアントからは構造化パラメータ（modelNum / note / images）のみを
// 受け取り、req.body.system や req.body.messages は受け取らない。
//   - 中核プロンプトがブラウザのソース表示で読める状態を解消するため
//   - 有効なセッショントークンさえあれば任意のsystem/messagesでAnthropic APIを
//     呼べてしまう（照明と無関係な用途にAPIキーを使える）穴を塞ぐため
//
// web_search込みのClaude API呼び出しは数十秒かかることがあるため、
// Vercel Hobbyプランで許容される上限（60秒）まで実行時間を延長する。
export const config = { maxDuration: 60 };

// フロント側（public/index.html）の MAX_IMAGES と同じ値に揃えること
const MAX_IMAGES = 5;
// 型番・現場メモの入力上限（フロントのinputには制限がないためサーバー側で担保する）
const MAX_TEXT_LENGTH = 500;
// 画像base64のデコード後合計サイズ上限。
// フロントは長辺1024px・JPEG品質75%へ圧縮してから送るため実際は1枚あたり数百KB程度で、
// 5枚でも2MB前後に収まる。ここでは十分な余裕を見つつ、極端に大きなリクエストを弾く。
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;

// processFiles()がcanvas経由で必ずJPEGへ変換してから送ってくるため固定でよい
const IMAGE_MEDIA_TYPE = 'image/jpeg';

const SYSTEM_PROMPT = `あなたは日本の照明器具の専門家です。電気工事士が使う業務ツールとして、照明器具の型番や写真から現行品かどうかを判定し、必要に応じて後継器・互換品を調べて返答します。

複数枚の画像が送られてくる場合は、同一の器具を異なる角度・距離から撮影したものです（型番ラベルの接写、器具全体、設置状況など）。すべての画像を合わせて型番・仕様を判断し、最も確度の高い型番を特定してください。画像間で読み取れる情報に矛盾がある場合は、ラベルに最も近い接写画像を優先してください。

【取付方式の判定（重要・写真判定時は特に慎重に）】
後継器・代替品を提案する前に、必ず元の器具の取付方式を判定してください。取付方式は「直付」「埋込」「シーリング」「ペンダント」のいずれか、または判断できない場合は「不明」としてください。
- 型番プレートが読み取れて型番から取付方式が確定できる場合は、それを最優先の根拠にしてください。
- 写真のみから見た目で判断する場合は特に誤りやすい点に注意してください。天井に密着して段差が小さい直付器具と、天井に埋め込まれた埋込器具は、角度や距離によって非常に似て見えることがあります。取付面（天井）との境目・出っ張りの有無・枠の形状がはっきり写っている写真を優先し、それでも自信を持って判断できない場合は無理に断定せず「不明」としてください。
- 「不明」とした場合は、mounting_type_confidence を "low" にし、caution に写真だけでは取付方式を確定できない旨と、追加の写真（取付面がわかるアングル）または型番の確認をお願いする一文を必ず含めてください。

【後継器・代替品の絞り込みルール】
- successor_models・alternative_models に入れる候補は、判定した取付方式と一致するものだけにしてください。取付方式が異なる器具（例：直付器具に対して埋込器具）を候補に含めてはいけません。
- 取付方式が「不明」の場合のみ、候補ごとに取付方式が異なる可能性がある旨を note に明記した上で候補を出しても構いません。

【ステータス判定の重要なルール】
- Web検索で型番をメーカー公式サイト・主要ECサイト（モノタロウ、電材堂、楽天市場など）で確認し、現在も購入可能・カタログに掲載されている場合は必ず「現行品」としてください。
- メーカー公式サイトの「生産終了品」「販売終了」一覧に明確に載っている場合のみ「廃番」としてください。
- 検索しても情報が十分に見つからず判断できない場合は「不明」としてください。憶測で「廃番」と判定しないでください。
- 「古そうな型番だから」「情報が少ないから」という理由だけで廃番と判定するのは禁止です。実際に検索して確認してください。

【出力する内容の分岐】
- status が「現行品」の場合：successor_models は空配列にしてください。代わりに current_product_info にその型番自体の情報を入れてください。もし上位機種・推奨される代替品があれば alternative_models に入れてください（なくても良い）。
- status が「廃番」の場合：successor_models に後継器・互換品を入れてください。current_product_info は null にしてください。
- status が「不明」の場合：successor_models に互換性がありそうな候補があれば入れてください。current_product_info は null にしてください。

必ず以下のJSON形式のみで返答してください（マークダウン不要、説明文も不要、出力の最初の文字は必ず { ）:
{
  "original_model": "入力された型番（写真から読み取った場合はその型番）",
  "manufacturer": "メーカー名",
  "product_name": "製品名（わかる範囲で）",
  "mounting_type": "直付" or "埋込" or "シーリング" or "ペンダント" or "不明",
  "mounting_type_confidence": "high" or "medium" or "low",
  "status": "廃番" or "現行品" or "不明",
  "current_product_info": {
    "model": "型番（originalと同じ）",
    "manufacturer": "メーカー名",
    "name": "製品名",
    "note": "現行品としての補足（在庫状況、価格傾向などわかれば）"
  } or null,
  "alternative_models": [
    {
      "model": "型番",
      "manufacturer": "メーカー名",
      "name": "製品名",
      "note": "上位機種・代替品としての補足（現行品の場合のみ。なければ空配列）"
    }
  ],
  "successor_models": [
    {
      "model": "型番",
      "manufacturer": "メーカー名",
      "name": "製品名",
      "note": "互換性・違いなどの補足（廃番の場合のみ。現行品なら空配列）"
    }
  ],
  "order_text": "材料屋への発注メモ文（型番・メーカー・数量欄を含む短い文章）",
  "caution": "工事士へのワンポイント注意（取付穴径、電源方式の違いなど）",
  "confidence": "high" or "medium" or "low"
}`;

/**
 * ユーザープロンプト（messages配列）を組み立てる。
 * 写真ありの場合は画像ブロックを積んだ配列、なしの場合は単一の文字列を content にする。
 * @param {string} modelNum 型番（trim済み）
 * @param {string} note 現場メモ（trim済み）
 * @param {string[]} images base64文字列の配列
 */
function buildMessages(modelNum, note, images) {
  if (images.length > 0) {
    const content = [];

    images.forEach((base64) => {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: IMAGE_MEDIA_TYPE, data: base64 }
      });
    });

    let text = images.length > 1
      ? `${images.length}枚の画像（同一器具の異なる角度・型番ラベルなど）から型番を読み取り、後継器・互換品を調べてください。`
      : '画像から型番を読み取り、後継器・互換品を調べてください。';
    text += '\n特に、取付方式（直付／埋込／シーリング／ペンダント）を写真から慎重に判定してください。天井との取付面がはっきり写っている画像があればそれを優先し、自信が持てない場合は無理に断定せず「不明」としてください。';
    if (modelNum) text += `\n入力された型番: ${modelNum}`;
    if (note) text += `\n現場メモ: ${note}`;

    content.push({ type: 'text', text });
    return [{ role: 'user', content }];
  } else {
    let text = `型番: ${modelNum} の後継器・互換品を調べてください。`;
    if (note) text += `\n現場メモ: ${note}`;
    return [{ role: 'user', content: text }];
  }
}

// base64文字列のデコード後バイト数を、実際にデコードせずに算出する
function base64ByteLength(str) {
  const padding = str.endsWith('==') ? 2 : str.endsWith('=') ? 1 : 0;
  return Math.floor((str.length * 3) / 4) - padding;
}

export default async function handler(req, res) {
  // POST以外は受け付けない
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // ログイン済みかどうかを確認（メール＋Stripeサブスク確認済みトークン）。
  // 検索回数の上限判定にプラン上限と請求期間が要るため requireAuthWithPlan() を使う。
  const auth = await requireAuthWithPlan(req, res);
  if (!auth) return; // requireAuthWithPlan内で既に401レスポンス済み
  const { email, limits, period } = auth;

  try {
    const { modelNum, note, images } = req.body || {};

    // --- 入力検証 ---
    if (modelNum !== undefined && typeof modelNum !== 'string') {
      return res.status(400).json({ error: '型番の形式が正しくありません' });
    }
    if (note !== undefined && typeof note !== 'string') {
      return res.status(400).json({ error: '現場メモの形式が正しくありません' });
    }
    if (images !== undefined && !Array.isArray(images)) {
      return res.status(400).json({ error: '画像データの形式が正しくありません' });
    }

    const trimmedModelNum = (modelNum || '').trim();
    const trimmedNote = (note || '').trim();
    const imageList = images || [];

    if (trimmedModelNum.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `型番は${MAX_TEXT_LENGTH}文字以内で入力してください` });
    }
    if (trimmedNote.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `現場メモは${MAX_TEXT_LENGTH}文字以内で入力してください` });
    }
    if (imageList.length > MAX_IMAGES) {
      return res.status(400).json({ error: `写真は最大${MAX_IMAGES}枚までです` });
    }
    if (!trimmedModelNum && imageList.length === 0) {
      return res.status(400).json({ error: '型番を入力するか、写真をアップロードしてください' });
    }

    let totalBytes = 0;
    for (const base64 of imageList) {
      if (typeof base64 !== 'string' || base64.length === 0) {
        return res.status(400).json({ error: '画像データが正しくありません' });
      }
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        return res.status(400).json({ error: '画像データが正しくありません' });
      }
      totalBytes += base64ByteLength(base64);
    }
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return res.status(400).json({
        error: `写真の合計サイズが上限（${Math.floor(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024))}MB）を超えています`,
      });
    }

    const messages = buildMessages(trimmedModelNum, trimmedNote, imageList);

    // --- 検索回数の枠を確保 ---
    // 入力検証をすべて通過した後、実際にAnthropicを呼ぶ直前に確保する。
    // 400で弾かれる入力（型番も写真も無い、画像が大きすぎる等）で回数を消費させないため。
    const reservation = await reserveSearch({ email, limits, period });
    if (!reservation.allowed) {
      return res.status(429).json({
        error: 'quota_exceeded',
        message: '検索回数が上限に達しました。',
        // resetAtはミリ秒エポックのまま返す（日付の整形はフロント側で行う）
        quota: {
          plan: limits.plan,
          used: reservation.used,
          limit: reservation.limit,
          resetAt: reservation.resetAt,
        },
      });
    }

    try {
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
          system: SYSTEM_PROMPT,
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
        // 調査結果を返せていないので回数は戻す（利用者から見れば検索は失敗している）。
        await releaseSearch({ email, period, counted: reservation.counted });
        return res.status(response.status).json({ error: data.error?.message || 'API error' });
      }
      return res.status(200).json({ ...data, quota: quotaFromReservation(reservation, limits) });
    } catch (err) {
      // Anthropicへの接続失敗・レスポンスのJSON解析失敗など。確保した枠を戻してから
      // 外側のcatchに投げ直す（500レスポンスの生成はそちらに任せる）。
      await releaseSearch({ email, period, counted: reservation.counted });
      throw err;
    }
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
