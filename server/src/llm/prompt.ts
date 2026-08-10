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
import {
  daylightOf,
  formatGameTime,
  lastTrainLine,
  memoryDateLabel,
  openStatusOf,
  toGameTime,
} from '../domain/calendar.js';
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

  // 行3: 現在地と同じ area の店の営業状況（location_note 使用中・該当なしは省略）
  if (!state.location_note && loc?.area) {
    const statuses = locations
      .filter((l) => l.area === loc.area && l.id !== loc.id)
      .map((l) => ({ name: l.name, status: openStatusOf(l.open_min, l.close_min, state.time) }))
      .filter((x): x is { name: string; status: NonNullable<ReturnType<typeof openStatusOf>> } => x.status !== null);
    if (statuses.length) {
      lines.push(statuses.map((x) => `${x.name}は${x.status}`).join('。') + '。');
    }
  }

  // 行4: 終電の状況（通知窓の中でだけ表示 §6.4）
  const trainLine = lastTrainLine(calendar, state.time);
  if (trainLine) lines.push(trainLine);

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
  /** 進行状況ブロック（v1.5.3 §3.3）。vars_enabled = 1 のときのみ */
  varsBlock?: string;
  /** 進行フラグの更新指示（v1.5.3 §3.1） */
  varsInstruction?: string;
  /** 「発生中の出来事」（inject_mode = fact） */
  eventFacts?: string;
  /** 「今回の演出指示」（inject_mode = instruction） */
  eventInstructions?: string;
  /** オートプレイ: ユーザー入力なしで場面を続ける指示を添える（§8.7） */
  autoContinueNudge?: boolean;
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
    // enabled = 0 は注入しない。記録としては残っている（§10.2）
    const usable = items.filter(
      (m) =>
        m.enabled !== 0 &&
        (!m.subject || presentSet.has(m.subject) || firedCharIds.has(m.subject)),
    );
    if (usable.length) memoryBlocks.push({ charName: character.name, items: usable });
  }

  // ---- system の構成順序（§6.1） ----
  // 1〜6（フォーマット〜参加キャラ）→ 7 準レギュラー → 8〜9（ナレーター・ペルソナ）
  // の順にそのまま並べる。削減対象にしない部分を required としてまとめる
  const sysHead: string[] = [];
  // separate_call モードでは本文にフェンスを書かせない（抽出は別コール §5.7）
  sysHead.push(
    formatInstructions(settings.state_enabled === 1 && settings.state_extraction_mode === 'fenced'),
  );
  // 進行フラグの更新指示は、機能が有効で書き込み可能なキーがあるときだけ出す（§1.2）
  if (input.varsInstruction) sysHead.push(input.varsInstruction);
  sysHead.push(SETTINGS_HANDLING);
  if (settings.system_prompt) sysHead.push(settings.system_prompt);
  if (input.world.system_prompt) sysHead.push(input.world.system_prompt);
  if (input.scenario?.description) sysHead.push(`# シナリオ設定\n${input.scenario.description}`);
  for (const c of input.participants) sysHead.push(characterDef(c));

  const optionalNpcDefs = activeNpcPool.map(characterDef);

  const sysTail: string[] = [];
  if (input.chat.narrator_enabled) {
    sysTail.push(input.world.narrator_prompt || DEFAULT_NARRATOR_PROMPT);
  }
  if (input.persona) {
    sysTail.push(
      `# 対話相手（ユーザーの分身）\n名前: ${input.persona.name}\n${input.persona.description}`,
    );
  }
  const required = [...sysHead, ...sysTail];

  // 「いつの話か」が伝わるよう、記録されているものは日付を頭に添える（§8.4）。
  // 日付不明（旧データ・手動追加）は何も付けず、以前と同じ形のまま出す
  const memoryLine = (m: Memory): string => {
    const label = memoryDateLabel(input.calendar, m.game_time, input.baseState.time);
    return label ? `- (${label}) ${m.content}` : `- ${m.content}`;
  };
  let memories = memoryBlocks.map(
    (b) => `# ${b.charName}が記憶している事実\n${b.items.map(memoryLine).join('\n')}`,
  );
  const summaryBlock = input.summary?.content
    ? `# これまでのあらすじ\n${input.summary.content}`
    : '';

  let situationBlock = buildSituationBlock({
    calendar: input.calendar,
    state: input.baseState,
    locations: input.locations,
    participants: input.participants,
    npcPool: input.npcPool,
    persona: input.persona,
    dayChanged: input.dayChanged,
  });
  // 末尾systemのブロック順序は固定（v1.5.3 §6.3）:
  //   現在の状況 → 進行状況 → 発生中の出来事 → 今回の演出指示
  // 後ろほど強く参照されるので、事実を読ませてから「どう出すか」の指示を当てる
  for (const block of [
    input.varsBlock,
    input.eventFacts,
    input.eventInstructions,
  ]) {
    if (block) situationBlock += `\n\n${block}`;
  }
  if (input.autoContinueNudge) {
    situationBlock +=
      '\n\nユーザーの発言を待たず、場面の続きを描写すること。ユーザーの発言を代弁してはならない。';
  }

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
  const sys: string[] = [
    ...sysHead, // 1〜6. フォーマット・設定の扱い・共通/世界/シナリオ・参加キャラ
    ...optionalNpcDefs, // 7. 準レギュラー
    ...sysTail, // 8〜9. ナレーター・ペルソナ
    ...memories, // 10. メモリー
  ];
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
