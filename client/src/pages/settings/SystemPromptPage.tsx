import { LongTextPage } from './parts';

/** すべての世界・会話に共通の指示 */
export default function SystemPromptPage() {
  return (
    <LongTextPage
      title="共通の指示"
      field="system_prompt"
      askTitle="共通の指示"
      intro="すべての世界・会話のシステムプロンプトに入ります。文体や表現の範囲など、世界ごとの指示は世界の設定に書きます。"
    />
  );
}
