import type { Settings } from '../../../shared/types.js';
import { getChat, updateChat } from '../db/repo/chats.js';
import { getCharacters } from '../db/repo/characters.js';
import { createMemory, listMemories } from '../db/repo/memories.js';
import { messagesAfterSeq } from '../db/repo/messages.js';
import { completeText } from '../llm/openrouter.js';

/**
 * 知識抽出（§8.4）。長期記憶対象は char のみ。
 * この処理のみJSONモードを使用し、既存分を重複除けとしてモデルに渡す。
 */
export async function runExtract(chatId: string, settings: Settings): Promise<number> {
  const chat = getChat(chatId);
  if (!chat) return 0;
  const targets = messagesAfterSeq(chatId, chat.extracted_up_to_seq ?? 0);
  if (targets.length === 0) return 0;

  const participants = getCharacters(chat.participant_ids).filter((c) => !c.is_npc_pool);
  if (participants.length === 0) return 0;

  const convo = targets.map((m) => m.content).join('\n');
  const model = settings.utility_model || settings.default_model;
  let added = 0;

  for (const c of participants) {
    const existing = listMemories(c.id);
    const prompt = `以下のロールプレイ会話から、キャラクター「${c.name}」が長期的に記憶すべき事実を抽出せよ。
- 出来事・約束・相手について知った事実など、今後の会話で参照価値のあるものだけ
- 容姿・口調・設定そのものは抽出しない（ロアブックが保持している）
- 既存の記憶と重複するものは出力しない
- 最大5件。なければ空配列

既存の記憶:
${existing.map((m) => `- ${m.content}`).join('\n') || '（なし）'}

会話:
${convo}

次のJSON形式のみで出力: {"memories": [{"subject": "関連する人物ID（なければ空文字）", "content": "記憶する事実"}]}`;

    try {
      const raw = await completeText({
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
        json: true,
      });
      const parsed = JSON.parse(raw) as { memories?: { subject?: string; content?: string }[] };
      for (const m of parsed.memories ?? []) {
        if (!m.content) continue;
        createMemory(c.id, { subject: m.subject || '', content: m.content, source: 'auto' });
        added++;
      }
    } catch (err) {
      console.error(`[memory] ${c.name} の抽出に失敗:`, (err as Error).message);
    }
  }

  const last = targets[targets.length - 1];
  updateChat(chatId, { extracted_up_to: last.id, extracted_up_to_seq: last.seq });
  return added;
}
