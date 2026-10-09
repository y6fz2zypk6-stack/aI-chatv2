// クライアントの日時表記（client/src/format.ts）とモデルの表示名（shared/types.ts）。純粋な関数なので、Node でそのまま読み込んで見る。
// 「今日・昨日・今年」は now を決め打ちにして固定する
import { formatDateTime, formatListStamp } from '../../client/src/format.ts';
import { CURATED_MODELS, isLatestAlias, modelLabel } from '../../shared/types.ts';

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  — ${JSON.stringify(actual)} (期待 ${JSON.stringify(expected)})`}`);
}

console.log('\n── 日時の表記（format.ts）');
// ローカル時刻で組む（TZに依存しない）
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const now = at(2026, 10, 1, 15, 30);

check('今日 → 時刻', formatListStamp(at(2026, 10, 1, 14, 13), now), '14:13');
check('今日の0時台は0埋め', formatListStamp(at(2026, 10, 1, 0, 5), now), '00:05');
check('昨日の23:59 → 昨日', formatListStamp(at(2026, 9, 30, 23, 59), now), '昨日');
check('昨日の0:00 → 昨日', formatListStamp(at(2026, 9, 30, 0, 0), now), '昨日');
check('一昨日 → 月/日', formatListStamp(at(2026, 9, 29, 12, 0), now), '9/29');
check('今年の1月 → 月/日（0埋めしない）', formatListStamp(at(2026, 1, 5, 12, 0), now), '1/5');
check('去年 → 年/月/日', formatListStamp(at(2025, 9, 28, 12, 0), now), '2025/9/28');
check('月をまたぐ昨日（1日の昨日 = 前月末）', formatListStamp(at(2026, 9, 30, 8, 0), at(2026, 10, 1, 0, 1)), '昨日');
check('年をまたぐ昨日（1/1 の昨日 = 12/31）', formatListStamp(at(2025, 12, 31, 20, 0), at(2026, 1, 1, 9, 0)), '昨日');
check('未来の日付でも壊れない（来年）', formatListStamp(at(2027, 1, 2, 12, 0), now), '2027/1/2');
check('年月日と時分は0埋め', formatDateTime(at(2026, 1, 5, 9, 7)), '2026/01/05 09:07');
check('年月日と時分（2桁）', formatDateTime(at(2026, 10, 1, 14, 13)), '2026/10/01 14:13');

console.log('\n── モデルの表示名（shared/types.ts、§6.6）');
check('「最新」は「系列（最新）」', modelLabel('~anthropic/claude-opus-latest'), 'Opus（最新）');
check('Claude 以外の「最新」', modelLabel('~openai/gpt-latest'), 'GPT（最新）');
check('候補に無い「最新」も（最新）を付ける', modelLabel('~anthropic/claude-haiku-latest'), 'claude-haiku（最新）');
check('版を固定したもの', modelLabel('anthropic/claude-opus-5.5'), 'Opus 5.5');
check('接続先付きの未知のモデルはIDの末尾', modelLabel('01ABC::local-llama'), 'local-llama');
check('空は既定', modelLabel(''), '既定');
check('「最新」の判定', isLatestAlias('~x-ai/grok-latest'), true);
check('版の指定は「最新」ではない', isLatestAlias('x-ai/grok-4.7'), false);
check('~ が無ければ「最新」ではない', isLatestAlias('anthropic/claude-opus-latest'), false);
check('候補の先頭6件が「最新」', CURATED_MODELS.slice(0, 6).every((m) => m.latest && isLatestAlias(m.id)), true);
check('「最新」の印と名前の形が一致する', CURATED_MODELS.every((m) => Boolean(m.latest) === isLatestAlias(m.id)), true);

if (failed) {
  console.error(`\n日時とモデルの表記: ${failed} 件失敗`);
  process.exit(1);
}
console.log('\n日時とモデルの表記: すべて通りました');
