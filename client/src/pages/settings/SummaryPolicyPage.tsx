import { LongTextPage, More } from './parts';

/** 要約の方針（あらすじとメモリー › 要約の方針） */
export default function SummaryPolicyPage() {
  return (
    <LongTextPage
      title="要約の方針"
      back="/settings/summary"
      field="summary_policy"
      askTitle="要約の方針"
      intro="何を残し、何を落とし、どう書くか。前回分との統合・日付・文字数などの決まりは、アプリが別に付けます。"
    >
      <More summary="書き方のコツ">
        「何を落とすか」を必ず書いてください。落とす基準が無いと、短くする方法が文を詰めることしか無くなり、
        冗漫なあらすじになります。
        <br />
        前回分との統合・人物設定を書かないこと・日付の付け方・文字数は、アプリ側で必ず付けるのでここに書く必要はありません。
      </More>
    </LongTextPage>
  );
}
