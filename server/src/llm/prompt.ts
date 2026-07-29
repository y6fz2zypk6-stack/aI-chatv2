import type {
  CalendarConfig,
  Character,
  Chat,
  ChatState,
  Location,
  LorebookEntry,
  Memory,
  Message,
  Persona,
  Scenario,
  Settings,
  Summary,
  World,
} from '../../../shared/types.js';
import { daylightOf, formatGameTime, toGameTime } from '../domain/calendar.js';
import { fireLorebook, type LoreFireResult } from '../domain/lorebook.js';
import type { ChatMessage } from './openrouter.js';

// ---- 固定文 ----

/** §5.2 応答フォーマット指示 */
export function formatInstructions(stateEnabled: boolean): string {
  let s = `# 応答フォーマット
- 行頭に「話者名: 」を置いて発話者を示す。
- セリフは「」で囲む。それ以外は地の文として書く。
- 動作・表情・地の文・セリフを1つの発話にまとめてよい。段落で発話を分けない。
- 1発話 = 1つの吹き出しとして表示される。
- *や_で地の文を囲まない。
- ユーザーの発言を代弁しない。
- その場限りの脇役（店員・通行人など）に発話させる場合は、
  話者名を「NPC[短い名前]: 」の形式で書く。例: NPC[店主]: 「らっしゃい」
  登録された人物をこの形式で書いてはならない。`;
  if (stateEnabled) {
    s += `

# 状態の更新
応答の最後に、以下の形式でステートの差分を返すこと。
@@@STATE
elapsed_minutes: この応答内で経過した時間（分）。会話のみなら5〜15、移動や場面転換があれば実際の所要時間
location: 場面終了時点の場所。ID一覧から選ぶ。一覧にない場所に移動した場合は日本語の短い地名をそのまま書く
present_add: その場に加わった人物ID（カンマ区切り。なければ空）
present_remove: その場を離れた人物ID（カンマ区切り。なければ空）。場面転換で同行しない人物もここに書く
@@@END

描写の中に時刻や日付を明示する必要はない。時間はシステムが管理している。`;
  }
  return s;
}

/** §6.3 設定情報の扱い */
export const SETTINGS_HANDLING = `# 設定情報の扱い
- 与えられた世界設定は参照用であり、すべてを描写に登場させる必要はない。
- 場面に関係のない設定を持ち出さず、その場に必要な情報のみを使うこと。
- 設定の説明ではなく、あくまで場面の描写と会話を優先する。`;

const DEFAULT_NARRATOR_PROMPT = `# ナレーター
情景・環境・第三者の動きは「ナレーター: 」の話者で地の文として描写する。
ナレーターはキャラクターの内心を断定せず、観察できる事実と雰囲気を書く。`;

// ---- 現在の状況ブロック（§6.4） ----

export interface SituationInput {
  calendar: CalendarConfig;
  state: ChatState;
  locations: Location[];
  participants: Character[];
  npcPool: Character[];
  persona: Persona | null;
  dayChanged: boolean;
}

export function buildSituationBlock(input: SituationInput): string {
  const { calendar, state, locations } = input;
  const gt = toGameTime(calendar, state.time);
  const loc = locations.find((l) => l.id === state.location);
  const locName = state.location_note || loc?.name || state.location || '不明';
  const lines: string[] = ['# 現在の状況'];

  // 行1: 季節・週・曜日・時刻 ／ 場所 ／ 天候（屋内なら天候省略）
  let line1 = `${formatGameTime(gt)} ／ 場所:${locName}`;
  const indoor = !state.location_note && loc?.indoor === 1;
  if (!indoor && state.weather) line1 += ` ／ 天候:${state.weather}`;
  lines.push(line1);

  // 行2: 日照状態
  lines.push(`${daylightOf(calendar, state.time)}。`);

  // 行5: 在席者（ペルソナのみなら省略）
  const allChars = [...input.participants, ...input.npcPool];
  const presentNames = state.present
    .map((id) => allChars.find((c) => c.id === id)?.name)
    .filter((n): n is string => !!n);
  if (presentNames.length) lines.push(`その場にいる人物:${presentNames.join('、')}`);

  // 行6: 使用可能なID一覧（場所は全件、人物は参加キャラ+準レギュラー全件）
  if (locations.length) {
    lines.push(`場所ID: ${locations.map((l) => `${l.id}=${l.name}`).join(', ')}`);
  }
  if (allChars.length) {
    lines.push(`人物ID: ${allChars.map((c) => `${c.id}=${c.name}`).join(', ')}`);
  }

  // 行7: 日付が変わったターンのみ
  if (input.dayChanged) {
    lines.push(`日付が変わり、天候は${state.weather}になった。`);
  }

  return lines.join('\n');
}

// ---- コンテキスト組み立て（§6.1・§6.5） ----

export interface AssembleInput {
  settings: Settings;
  world: World;
  scenario: Scenario | null;
  chat: Chat;
  participants: Character[];
  /** 未参加の準レギュラー */
  npcPool: Character[];
  persona: Persona | null;
  calendar: CalendarConfig;
  locations: Location[];
  /** スコープ済みロア（§7.1） */
  loreEntries: LorebookEntry[];
  /** ロアのキーワード走査対象テキスト */
  loreScanText: string;
  memories: { character: Character; items: Memory[] }[];
  summary: Summary | null;
  /** 履歴窓（昇順） */
  history: Message[];
  /** 基準ステート = 直前メッセージの state_after（§8.1） */
  baseState: ChatState;
  dayChanged: boolean;
  /** モデルのコンテキスト長 */
  contextLength: number;
}

export interface AssembleResult {
  messages: ChatMessage[];
  stop: string[];
  system: string;
  situationBlock: string;
  lore: LoreFireResult;
  estimatedTokens: number;
  inputBudget: number;
  trimmed: { history: number; lore: number; memories: number };
  /** 必須項目のみで予算超過（413相当） */
  overBudget: boolean;
}

/** 日本語を厳しめに見積もる保守的な文字数→トークン換算 */
function estimateTokens(chars: number): number {
  return Math.ceil(chars * 1.1);
}

function characterDef(c: Character): string {
  const parts = [`# キャラクター: ${c.name}`];
  if (c.aliases.length) parts.push(`別名: ${c.aliases.join('、')}`);
  if (c.persona) parts.push(c.persona);
  if (c.speech_style) parts.push(`## 話し方\n${c.speech_style}`);
  if (c.example_dialogue) parts.push(`## 口調例\n${c.example_dialogue}`);
  return parts.join('\n');
}

export function assembleContext(input: AssembleInput): AssembleResult {
  const { settings } = input;
  const gt = toGameTime(input.calendar, input.baseState.time);

  // ロア発火（§7）
  const lore = fireLorebook({
    entries: input.loreEntries,
    scanText: input.loreScanText,
    currentLocationId: input.baseState.location_note ? '' : input.baseState.location,
    currentSeason: gt.season,
    recursion: settings.lore_recursion,
    budgetChars: settings.lore_budget_chars,
  });

  // 発火ロアに紐づく準レギュラー（§4.3: 該当ロア発火時のみ定義注入）
  const firedCharIds = new Set(
    lore.adopted.map((e) => e.character_id).filter((id): id is string => !!id),
  );
  const activeNpcPool = input.npcPool.filter((c) => firedCharIds.has(c.id));

  // メモリー: subject 空 → 常時。subject あり → 在席中 or 関連ロア発火時のみ（§4.14）
  const presentSet = new Set(input.baseState.present);
  const memoryBlocks: { charName: string; items: Memory[] }[] = [];
  for (const { character, items } of input.memories) {
    const usable = items.filter(
      (m) => !m.subject || presentSet.has(m.subject) || firedCharIds.has(m.subject),
    );
    if (usable.length) memoryBlocks.push({ charName: character.name, items: usable });
  }

  // ---- system の構成順序（§6.1） ----
  const required: string[] = [];
  required.push(formatInstructions(settings.state_enabled === 1));
  required.push(SETTINGS_HANDLING);
  if (settings.system_prompt) required.push(settings.system_prompt);
  if (input.world.system_prompt) required.push(input.world.system_prompt);
  if (input.scenario?.description) required.push(`# シナリオ設定\n${input.scenario.description}`);
  for (const c of input.participants) required.push(characterDef(c));

  const optionalNpcDefs = activeNpcPool.map(characterDef);

  if (input.chat.narrator_enabled) {
    required.push(input.world.narrator_prompt || DEFAULT_NARRATOR_PROMPT);
  }
  if (input.persona) {
    required.push(
      `# 対話相手（ユーザーの分身）\n名前: ${input.persona.name}\n${input.persona.description}`,
    );
  }

  let memories = memoryBlocks.map(
    (b) => `# ${b.charName}が記憶している事実\n${b.items.map((m) => `- ${m.content}`).join('\n')}`,
  );
  const summaryBlock = input.summary?.content
    ? `# これまでのあらすじ\n${input.summary.content}`
    : '';

  const situationBlock = buildSituationBlock({
    calendar: input.calendar,
    state: input.baseState,
    locations: input.locations,
    participants: input.participants,
    npcPool: input.npcPool,
    persona: input.persona,
    dayChanged: input.dayChanged,
  });

  const personaName = input.persona?.name || 'あなた';
  const historyToMessages = (history: Message[]): ChatMessage[] =>
    history.map((m) =>
      m.role === 'user'
        ? { role: 'user' as const, content: `${personaName}: ${m.content}` }
        : { role: 'assistant' as const, content: m.content },
    );

  // ---- 予算（§6.5） ----
  const inputBudget =
    input.contextLength - (settings.max_tokens + 200) - settings.context_safety_tokens;

  let history = [...input.history];
  let adoptedLore = [...lore.adopted];
  const trimmed = { history: 0, lore: 0, memories: 0 };

  const totalChars = (): number => {
    const sys =
      required.join('\n\n').length +
      optionalNpcDefs.join('\n\n').length +
      memories.join('\n\n').length +
      summaryBlock.length +
      adoptedLore.reduce((s, e) => s + e.content.length, 0);
    const hist = history.reduce((s, m) => s + m.content.length + 20, 0);
    return sys + hist + situationBlock.length;
  };

  // 削減順: ②履歴の古い方 → ③低priorityキーワードロア → ④低priority場所季節ロア → ⑤メモリー
  const overBudgetNow = () => estimateTokens(totalChars()) > inputBudget;

  while (overBudgetNow() && history.length > 2) {
    history.shift();
    trimmed.history++;
  }
  if (overBudgetNow()) {
    // キーワード発火分を priority 昇順で落とす
    const isTag = (e: LorebookEntry) => e.always === 1 ||
      e.trigger_locations.length > 0 || e.trigger_seasons.length > 0;
    const dropOrder = adoptedLore
      .filter((e) => e.always !== 1)
      .sort((a, b) => {
        const at = isTag(a) ? 1 : 0;
        const bt = isTag(b) ? 1 : 0;
        if (at !== bt) return at - bt; // キーワード発火を先に落とす
        return a.priority - b.priority;
      });
    for (const e of dropOrder) {
      if (!overBudgetNow()) break;
      adoptedLore = adoptedLore.filter((x) => x.id !== e.id);
      trimmed.lore++;
    }
  }
  while (overBudgetNow() && memories.length) {
    memories = memories.slice(0, -1);
    trimmed.memories++;
  }

  const overBudget = overBudgetNow() && history.length <= 2;

  // ---- 最終組み立て（§6.1の順序） ----
  const sys: string[] = [];
  let reqIdx = 0;
  sys.push(required[reqIdx++]); // 1. フォーマット
  sys.push(required[reqIdx++]); // 2. 設定情報の扱い
  if (settings.system_prompt) sys.push(required[reqIdx++]); // 3. 共通
  if (input.world.system_prompt) sys.push(required[reqIdx++]); // 4. 世界
  if (input.scenario?.description) sys.push(required[reqIdx++]); // 5. シナリオ
  for (let i = 0; i < input.participants.length; i++) sys.push(required[reqIdx++]); // 6. 参加キャラ
  sys.push(...optionalNpcDefs); // 7. 準レギュラー
  while (reqIdx < required.length) sys.push(required[reqIdx++]); // 8〜9. ナレーター・ペルソナ
  sys.push(...memories); // 10. メモリー
  if (summaryBlock) sys.push(summaryBlock); // 11. あらすじ
  if (adoptedLore.length) {
    sys.push(`# 関連する世界観情報\n${adoptedLore.map((e) => e.content).join('\n\n')}`); // 12. ロア
  }
  const system = sys.join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...historyToMessages(history),
    { role: 'system', content: situationBlock },
  ];

  // §5.5 stopシーケンス（先頭の改行は1文字目での誤停止対策）
  const stop = [`\n${personaName}:`, '\nuser:'];

  return {
    messages,
    stop,
    system,
    situationBlock,
    lore: { ...lore, adopted: adoptedLore, dropped: [...lore.dropped, ...lore.adopted.filter((e) => !adoptedLore.includes(e))] },
    estimatedTokens: estimateTokens(totalChars()),
    inputBudget,
    trimmed,
    overBudget,
  };
}
