import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import {
  Save,
  Trash2,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Flag,
  ListChecks,
  Plus,
  Pencil,
  Star,
  ChevronDown,
  ChevronRight,
  Lock,
  X,
} from "lucide-react";
import { storage } from "./storage";

const PAGES_KEY = "slot-pages-v1";
const historyKey = (pageId) => `slot-history-${pageId}`;
const recommendKey = (pageId) => `slot-recommend-${pageId}`;
const EVENT_NAMES_KEY = "slot-event-names-v1";
const STRONG_EVENTS_KEY = "slot-strong-events-v1";
const SEMI_EVENTS_KEY = "slot-semi-events-v1";
const CLOSED_DAYS_KEY = "slot-closed-days-v1";
const DATE_EVENT_MAP_KEY = "slot-date-event-map-v1";

// a single date can now have MULTIPLE event tags (e.g. "2のつく日" AND "新台
//入れ替え" on the same day) — stored as one delimited string so every
// existing piece of code that treats dateEventMap[date] / h.event as a plain
// string (display, propagation to page histories, etc.) keeps working as-is
const EVENT_DELIMITER = "、";
function splitEventNames(compositeStr) {
  return (compositeStr || "")
    .split(EVENT_DELIMITER)
    .map((s) => s.trim())
    .filter(Boolean);
}
function joinEventNames(names) {
  return names.filter(Boolean).join(EVENT_DELIMITER);
}
// v6.8: page.officialName は今まで通り1つの文字列のまま保存するが、
// イベント名と同じ「、」区切りで複数の機種名を束ねられるようにする
// （例：「サンダーV、アレックスV、クレアA」を1ページで一括管理する
// 「理由Aタイプ」ページ向け）。既存の単一機種ページ（区切り文字なし）は
// 無改修でそのまま動く。
function splitModelNameList(officialName) {
  return splitEventNames(officialName); // same delimiter/behavior, reused as-is
}
const OVERALL_SUMMARY_KEY = "slot-overall-summary-v1";
const OVERALL_RECOMMEND_KEY = "slot-overall-recommend-v1"; // {modelName: [{id,startDate,endDate,label}]}
// v6.7: アナスロ（店全体・全機種・台番号単位の一括表貼り付け）— 個別データ
// 入力（台データ入力）を廃止し、これに一本化。1週間（月曜始まり）で1キー
// にまとめて保存する（雑餉隈スレッドでの検証結果：1日1キーは日数分の
// リクエストが発生して遅い、1ヶ月1キーはFirestoreの1フィールドあたり
// 約1MBの上限を超えることがある、週単位が両方のバランスが良かった）。
// 別途、登録済み日付の索引キーを持たせ、必要な週のキーだけをGETする。
const RAW_FULLTABLE_KEY_PREFIX = "slot-raw-fulltable-v1:";
const RAW_FULLTABLE_INDEX_KEY = "slot-raw-fulltable-index-v1"; // JSON array of "YYYY-MM-DD" strings
// Monday-anchored ISO-ish week start, as a plain "YYYY-MM-DD" string
function weekStartOf(date) {
  const d = new Date(`${date}T00:00:00`);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function rawFullTableWeekKey(date) {
  return `${RAW_FULLTABLE_KEY_PREFIX}week:${weekStartOf(date)}`;
}
const UNDO_HISTORY_KEY = "slot-undo-history-v1";
const DATALIST_ID = "slot-event-name-options";
const MODEL_NAME_DATALIST_ID = "slot-model-name-options";
const FULLTABLE_MODEL_NAME_DATALIST_ID = "slot-fulltable-model-name-options";

const PALETTE = [
  "#e8b34c", "#4fd1c5", "#e5697a", "#7aa2f7", "#9ece6a",
  "#bb9af7", "#f6a04d", "#5fd3bc", "#e0af68", "#7dcfff",
];

const STRONG_COLORS = ["#e5484d", "#f2a541", "#4fd1c5", "#7aa2f7", "#bb9af7", "#9ece6a"];
const STRONG_EVENT_COLOR = "#e5484d"; // 強いイベントは常に赤（塗りつぶし★）
const SEMI_EVENT_COLOR = "#9ece6a"; // 準イベント is always green — no per-event color choice
const EVENT_STAR_COLOR = "#f2d24b"; // ordinary (non-strong/semi) registered events — yellow star
const DIGIT2_COLOR = "#7dcfff";
const DIGIT7_COLOR = "#f6a04d";

// v6.6: 雑餉隈スレッド（v6.5→v6.9.17）から、アナスロに関わらない部分をまと
// めて移植。
// ①民レポのバラエティ（1台設置機種）列ズレ修正（parseSummaryTable）＋
//   壊れた過去データの修復ツール（共通設定に追加、G数は差枚と出率から推定
//   復元）。②機種名の表記ゆれ吸収（normalizeModelNameForMatch/
//   modelNamesMatch）を正式名称→おすすめ機種期間の連携に適用。③機種×日付
//   マトリクス表にバラエティ日のセル色付け、長い機種名の省略表示（スマホ
//   対応）。④民レポの日付ピッカーで未入力日を選んでも前の内容が残るバグを
//   修正、登録済みの日付一覧をクリックしてその日を編集用に読み込めるように
//   （handleEditOverall）。⑤共通設定を管理者用の一元窓口にする整理：全体
//   ランキングタブを削除、民レポのデータ入力・登録済み日付一覧を全体データ
//   タブから共通設定タブへ移動、各機種ページ・各タブに個別にあった暗証番号
//   解除フォーム／ロックボタンを削除し、共通設定の1箇所に統一。⑥正式名称
//   欄が暗証番号解除なしでも編集できてしまっていたバグを修正、スマホでの
//   はみ出し対策（flexWrap・minWidth:0）。⑦不要になった全体ランキング用の
//   重い計算（allPagesPickList）を削除。
// v6.7: アナスロ（店全体・全機種・台番号単位の一括表貼り付け）を新規実装
// し、台データ入力（個別ページの表貼り付け）は廃止。
// ・保存方式：週単位（月曜始まり）1キー＋登録済み日付の索引キー、保存時の
//   競合状態対策（refをawait前に同期更新＋週キー単位の書き込みキュー、
//   race_test.mjsで5並列保存でもデータが消えないことを確認済み）。
// ・parseFullStoreTable/serializeFullStoreRows：機種名・台番号・G数・差枚・
//   BB・RB・合成確率・BB確率・RB確率の一括表を解析。プラザ本店IIのG数は
//   総回転数（雑餉隈の通常時回転数と違う）なので、標準の出率計算式
//   （G数×3枚投入）でそのまま出率を算出でき、既存のclassifyMachineMark
//   （▲〇マーク）をそのまま使える。設定判別（RB確率の理論値表）は今回
//   実装しない。
// ・正式名称との連携：登録・変更のたびにbackfillPageFromRawTableで過去分
//   を自動反映（バックフィル）、手動での再取込みボタンも追加。
// ・台データ入力の削除に伴い、各ページのグラフ・ピックアップ・台番号×
//   日付マトリクスはpageHistories経由のまま（アナスロ保存時に自動で
//   pageHistoriesへ反映されるので表示ロジック自体の変更は不要）。登録済み
//   日付一覧・削除・全削除・リセットは引き続き利用可能（編集は不可に）。
// ・共通設定の登録済み日付一覧を、民レポ・アナスロ両方の日付の和集合表示
//   に変更（各日付ごとに「民レポ〇/未登録」「アナスロ〇/未登録」を表示）。
// bump this on every change shipped, so the person can glance at the header
// and confirm whether a deploy actually took effect
// v6.8: 1ページで複数機種を束ねられるように（「理由Aタイプ」ページ向け：
// サンダー・アレックス・クレア等の単独設置機種をまとめて1ページで管理）。
// ・page.officialNameは今まで通り1つの文字列のまま保存し、イベント名と
//   同じ「、」区切りで複数機種名を指定できるようにした
//   （splitModelNameList、EVENT_DELIMITERを再利用）。区切り文字が無い
//   既存の単一機種ページは無改修でそのまま動く。
// ・アナスロ保存時の各ページへの反映（backfillPageFromRawTable・
//   handleSaveFullTableのファンアウト）、おすすめ機種期間の連携
//   （activePageRecommends）を、束ねた機種名のどれかに一致すれば反映する
//   ように変更。
// ・台番号はホール内で機種をまたいで一意なので、ピックアップ・チャート・
//   マトリクス表の「no」ベースの既存ロジックは変更不要。表示面だけ機種名
//   を付加（machineLabel関数）：グラフ凡例・台選択チップ・ピックアップ
//   カード・台番号×日付マトリクスの行ラベルが、複数機種ページでは
//   「サンダーV 101番」のように機種名付きで表示される。
// v6.8.1: 正式名称欄を「、」区切りの1本のテキスト欄から、1つずつ追加する
// チップ入力に変更。テキスト欄の中身を直接「サンダーV、アレックスV」の
// ように複合文字列で編集させると、2個目以降を入力中の文字列がdatalistの
// どの候補とも一致せず、ブラウザの補完が効かなくなっていた問題の対策
// （入力欄は常に機種名1個だけを打つ形になるので、補完が正しく効く）。
// v6.8.2: 【重要なバグ修正】すでに何十日分もデータが溜まっている単一機種
// ページに、あとから理由Aタイプとして別の機種名を追加しても、既存の日付
// には新しい機種のデータが一切反映されないバグを修正。backfillPageFrom
// RawTableが「その日付がpageHistoriesに既にある＝何もしない」という判定
// をしていたのが原因（新しく束ねた機種の分もその日にはもう存在すると
// 誤判定していた）。「その日にまだ無い台（機種）だけを追加マージする」に
// 修正し、race_test相当の単体テストで既存日付への正しいマージを確認済み。
// v6.9: 実データ（81日/7,459台日、▲マーク基準）を使い、指示書⑤の実測
// パターンエンジンの考え方でピックアップの点数付けを見直し。13候補
// ファミリーを総当たりで検証し、実証済みの強い基準として3つを新規採用：
// ①台番号固定の実績（この台自身のトレイリング▲率、n≈2000、±17〜18pt）
// ②前日、同じページの他の台が不調（n≈1822、-15.7pt）
// ③前日の自分自身のG数水準・大量回転/低調（n≈2400、±9〜11pt）。
// いずれも既存のSTRONG_SIGNAL_LABELS/SIGNAL_WEIGHTSの仕組みにそのまま
// 追加。個別イベント効果（爆撮・ぞろ目等）は既存のplannedEventMatch
// （イベント登録連動）が汎用的に拾うのでタイブレーカーとして機能済み、
// 追加実装不要。検証で不採用にした候補（連続4日以上=n=22で過学習
// リスク大、相対ローテーション、イベント直前トレンド、曜日傾向、凹み
// 上げ、強いイベント間トレンド）は見送り。グレード判定はS(350+)/
// A(250+)/B(150+)/C(50+)/D(-20+)/E方式を踏襲。
// v6.9.1: 【重要な設計修正】3つの新基準の「ベースレート」「証拠となる
// サンプル」は、実データ検証と同じくページ内の全台をプールして計算する
// 必要があった。最初の実装は台ごと・ページごとに個別計算していたため、
// 特に「前日、他の台が不調」「前日のG数水準」で検証結果と数値が大きく
// 乖離（サンプル不足で実質機能しない状態）。globalBaseRateA（全ページ
// プール）とcomputePageMateTroubleStats/computeTrailingGsuLevelStats
// （ページ内全台プール、ページ単位で1回だけ計算）に修正し、実データで
// 再検証してPython側の検証結果と近い数値になることを確認済み。
// v6.10: 「設定期待度」（実験的機能）を新規追加。雑餉隈スレッドの「数値」
// （初当たり＋出玉を合成した連続値）を参考に、プラザ本店IIでは通常時
// 回転数ベースのRB確率が使えないため、代わりに合成確率（BB+RB合算、
// 総回転数で計算可）と出率をページ内z-score合成したX（設定期待度スコア）
// を新設。実データ検証で、台番号固定の実績・日付末尾・イベント・前日の
// 他の台の不調・前日のG数水準——▲マークで効いていたのと同じ条件が、X
// でも同じ方向に効くことを確認済み（詳細は会話履歴のPython検証参照）。
// 【重要】Xは「翌日、差枚がプラスになるか」とは綺麗に相関しないことも
// 検証済み（設定は基本的に毎日変わるため）。そのため▲・差枚ベースの
// 既存のS〜Eグレード（本日のピックアップ）とは完全に別枠の「🎰 設定期待度
// （実験的）」カードとして表示し、合算はしない。
// v6.11: マイジャグラーV専用に、理論値表＋ポアソン尤度による本格的な
// 設定判別を追加（SETTING_PROFILES）。マイジャグラーVはAT/BT状態を持た
// ない純粋なAタイプで、G数＝総回転数＝通常時回転数が完全一致するため、
// 通常時回転数ベースの理論値表がそのまま使える唯一のケース（データ出典：
// スロベース 2026年4月時点の解析値）。最新日のBB/RB/G数から設定1〜6の
// 事後確率を計算し、「設定5+の確率」として表示。実データでの動作確認済み
// （REG回数がBIGを上回る珍しいケースで、正しく設定6の確率90%超と判定
// するなど、マイジャグラーVの既知の判別ポイントと整合）。
// A-typeページ側の束ね機種（A-SLOT+異世界かるてっと等）はBT（ボーナス
// トリガー）を持つ機種が混ざっており、G数の意味が曖昧になるため対象外
// のまま（引き続き設定期待度Xを使用）。
// v6.12: 台番号×日付のXマトリクス表を追加（雑餉隈の「数値」表示・
// 台番号×日付、色付き数値と同じ見た目）。以前実装した「翌日のXを予想
// するカード」だけでは、過去のXの値そのもの（台番号固定・日付末尾・
// イベント等の条件が本当に効いているか）を目視確認できなかったための
// 追加。renderXGrid関数で、Xをページ内パーセンタイル（0〜100）に変換し、
// fiveBandColor（赤＞黄＞緑＞青＞灰）で色分け表示。既存の▲〇マトリクス
// 表とは別枠のカードとして追加、日付・イベント絞り込みは共有。
// v6.13: 「設定期待度（X）」をメイン表示に変更（「実験的」表記を外し、
// 「本日のピックアップ（差枚・出率ベース）」より上に配置）。目的の再確認
// ：最終ゴールは「差枚がプラスになる確率」ではなく「良い設定を掴むこと」
// —設定が良さそうでも差枚がマイナスの日、その逆もあるため、両者は別の
// 質問に答える指標として扱う（点数は合算しない、あくまで並び順と表記の
// 変更のみ）。本日のピックアップの各カードにも、設定期待度のバッジ
// （高/中/低）を追加表示（renderPickCardに第3引数xLabelLookupを追加）。
// v6.14: スマホで重い・初回に「データがありません」と出る、の2点に対応。
// ①読み込み中の表示漏れ：設定期待度・設定判別・Xマトリクス・本日の
// ピックアップの4箇所が、データ読み込み中（historyLoading）でも「データ
// がありません」系のメッセージを出していた（読み込み前は配列が空になる
// ため）。全箇所に「読み込み中...」の分岐を追加。
// ②パフォーマンス：Xの計算（computeXForPage）が同じページで2回（Xグリッド
// 用・設定期待度予想用）別々に走っていたのを、1回計算して使い回す方式に
// 変更。また、computeSettingExpectationForPage内の「前日、他の台が不調」
// 「前日のG数水準」の集計が、台番号ごとに他の台の一覧をfind/filterし直す
// O(台数²×日数)の重い作りになっていたのを、日付ごとのルックアップ表を
// 先に1回だけ作る方式に直しO(台数×日数)へ改善。実データで計測したところ、
// 一番重いカバネリページ（41台・81日）でcomputeSignalsForPageが約41ms/回
// （スマホではこの数倍かかっている可能性が高い）。根本的な軽量化には、
// 画面外のセクションを開くまで計算しない等の遅延計算が今後の候補。
// v6.15: 「本日のピックアップ（差枚・出率ベース）」を折りたたみ式にして
// デフォルトで閉じ、「実証済み根拠」→「該当基準」に控えめな表現へ変更
// （実データ検証でグレードAでもベース比+1.6pt程度と効果が弱く不安定
// だったため）。【重要な訂正】設定期待度Xカードの説明に、マイジャグラー
// V専用の理論値表ベース設定判別の実績（出玉率109.3%・相関係数0.607）を
// 誤って書きそうになっていたのを訂正 — 実際に全ページ共通の一般的なXを
// ウォークフォワード検証したところ、翌日の実際の出率との相関はほぼ無し
// （相関係数0.010、n=5218）だった。109.3%の実績は理論値表を使う
// マイジャグラーV専用の設定判別（別カード）にのみ帰属する数値で、
// 各カードの説明文をそれぞれ正確な検証結果に修正した。
// v6.16: 新台入れ替えでピックアップに古い台番号が出続けるバグを修正。
// allMachineNumbers（このページの全期間の台番号の集合）を本日のピック
// アップ・設定期待度の対象台リストにそのまま使っていたため、機種が
// 入れ替わった後の台番号もずっと計算対象に残っていた。新たに
// activeMachineNumbers（最新日に実際に登場した台番号のみ）を追加し、
// pickList・settingExpectationListはこちらを使うよう変更（グラフの台
// 選択・マトリクス表は過去を振り返る用途もあるためallMachineNumbersの
// まま維持）。実データで確認：カバネリページは全期間41台のうち、最新日
// には18台しかなく、23台が対象外になるべきだった（前回指摘のあった
// カバネリの計算の重さも、対象台数が減ることで副次的に軽くなる）。
// v6.17: 新しい強い基準「機種全体の法則」を追加。マイジャグラーVの
// ポアソン尤度式設定判別に台番号固定の実績（トレイリング予想）を試した
// ところ相関係数0.024でほぼ効果無しだったのを踏まえ、「機種全体（同じ
// modelNameの他の台）の▲率トレンド」を検証したところ、n=6324で明確な
// 単調傾向（下位1/3=14.3%、中位=21.2%、上位=27.8%、相関係数0.147）。
// さらに台番号固定の実績で高低をコントロールしても、機種全体の法則を
// 追加すると両グループとも+8〜9ptの差が出ることを確認 — 独立した情報量
// があると判断し、STRONG_SIGNAL_LABELSに正式採用。computeSignalsForPage
// 内でmodelSeriesByNameをページ単位で1回だけ作り、台ごとに自分自身を
// 除外して機種全体のトレイリング▲率を計算する方式（v6.9.1の設計と同じ
// パターンで、n=6324の効果を再現できることをウォークフォワード検証済み、
// 機種全体の法則は1876回発火・A〜Eの単調な分離を維持したまま範囲が拡大）。
// マイジャグラー設定判別（理論値表ベース）は「本日の振り返り」としての
// 位置づけのまま、翌日予想の追加は見送り（台番号の持続効果が実データで
// 確認できなかったため）。
// v6.18: 【大きな設計変更】設定期待度（X）と▲・差枚ベースのA〜Gランクを
// 完全合体。従来の「設定期待度（高/中/低）」別カード、マイジャグラー
// 専用の設定判別カード（本日の振り返り）を削除。ご指摘の通り、①設定
// 判別カードは「今日の振り返り」であって翌日予想になっていなかった、
// ②機種全体の法則はX基準でも見つけて台番号固有のX法則と組み合わせるべき
// だった、という2点を反映。新たに「台番号固有のXの法則」（own trailing
// average X、computeEvPointsで得点化）「機種全体のXの法則」（同じ機種の
// 他の台のtrailing average X、この台自身は除外）をcomputeSignalsForPage
// に統合。ウォークフォワード検証で、Xベースの法則は5752回発火し、統合後
// もA〜Eの単調な分離を維持（A25.9%→B23.5%→C18.9%→D17.6%→E14.1%）。
// v6.19: ユーコーラッキー太宰府VVVのバックテスト資料（考え方のみ参考、
// 数値は使用せず自店データで再集計）をきっかけに、指示書に記載の全項目
// を実データで再検証。①マイナス連続日数→翌日反発、②直近7日重み付き
// スコア、③台番号隣接（周辺台の代用）、④純粋谷間、⑤曜日、⑥複合条件
// （差枚×連続日数）は、いずれも効果が弱いかノイズレベルで不採用。
// ⑦前日の細かい結果段階（大勝ち等）はやや効果ありだが既存の台番号固定の
// 実績と重複が大きく見送り。⑧「島内の高設定台数」だけは有効な発見：
// 前日、他の台の▲率を段階別に見ると0〜50%+まで連続的にほぼ単調増加
// しており、特に50%以上（n=138）で+8.6ptの明確な正の効果を確認。既存の
// 「前日、他の台が不調」（-5.2pt側のみ採用済み）の対になる正の信号
// 「前日、他の台が好調」として新規採用（computePageMateGoodStats/
// checkPageMateGoodToday）。ウォークフォワード検証で統合後もA〜Eの単調な
// 分離を維持（A25.3%→B23.8%→C18.8%→D17.6%→E14.1%、S24.1%まで改善）。
// v6.20: 【大きな設計変更】予想対象を「▲・差枚が当たるか」から「翌日、
// 設定期待度Xの値が高くなるか」に統一（何度もの確認の末、ようやく正しい
// 理解に至った）。古い▲・差枚ベースの判定材料（10/20/30日足・連続日数・
// 曜日・強いイベント翌日・イベント登録連動(旧)・おすすめ機種期間・相対
// ローテーション・大量回転低調・イベント間トレンド・イベント直前トレンド）
// は全部削除。実データ検証で全部Xの予想材料としても機能することを確認
// 済みの6つ（台番号固有のXの法則・機種全体のXの法則・前日他の台が好調・
// 前日のG数水準・日付末尾・イベント名）だけに絞り、computeEvPointsで統一
// スコア化。ウォークフォワード検証で綺麗な単調減少を確認：
// S(n=22)=0.126 > A(n=368)=0.075 > B(n=1518)=0.027 > C(n=2220)=0.015 >
// D(n=1234)=-0.039（以前悩まされていたSがAより低い逆転現象も解消）。
// 【副作用】民レポ（機種別サマリー・末尾別データ）にはBB・RB回数が無く
// Xが計算できないため、「全体データ」タブの機種別/末尾別ピックアップは
// 現在無効（該当UIにその旨を明記）。renderPickCardも新しいデータ構造
// （windows/streakMatch/digitDayMatch等の個別フィールドを廃止、
// scoreItemsのみ）に合わせて全面書き換え。
// v6.21: 判定材料を絞りすぎた（ユーコーラッキーは判断材料が多いから
// 9.5%〜43.9%まで広く分かれている）との指摘、説明文が淡白になった
// との指摘の2点に対応。①v6.20で削除した古い判定材料のうち、実データで
// Xの予想材料として機能することを確認できた3つ（20/30日足トレイリング
// 差枚の逆張り効果n=1428〜2018・+0.026〜0.032、準イベント翌日n=722・
// -0.051、大量回転低調の自分比n=2160〜2250・+0.035/-0.015）をXターゲット
// 版として復活、判定材料は6→9種類に。10日足・強いイベント翌日・連続
// 日数（方向つき）・おすすめ機種期間は効果が弱い/データ不足で見送り。
// ②renderPickCardに、各scoreItemの実測平均X・サンプル数を文章で説明する
// 表示を復活（バッジだけでなく詳細も見られるように）。ウォークフォワード
// 検証でEグレードが新たに出現（n=8, 翌日X平均-0.515）するなど、グレード
// の裾野が広がったことを確認。
// v6.22: 「本日のピックアップ」というカード見出しが紛らわしい（実際は
// 翌日を予想しているのに「本日」と書いてあった）との指摘を受け、実際の
// 予想対象日（月/日）を表示する見出しに変更（例：「8/16のピックアップ」）。
// 各カードの日付表示も「{日付}時点」から「{日付}までのデータで予想」に
// 変更し、それが予想対象日ではなくデータの基準日であることを明確化。
// v6.23: renderPickCardの表示を、雑餉隈スレッドの実際の表示例を参考に、
// 1行1判定材料のコンパクトな形式に変更（バッジ＋長文の2段構成より見やすい
// との指摘）。「合計{pt}pt（根拠{件数}件）{日付}までのデータで予想」を
// ヘッダーに、各判定材料は「{ラベル}：実測X {値}（n={件数}） → {符号}
// {pt}pt」の1行で、影響度（pointsの絶対値）が大きい順に並べる。
const APP_VERSION = "6.23";

const RANGE_OPTIONS = [
  { key: 10, label: "10日足" },
  { key: 20, label: "20日足" },
  { key: 30, label: "30日足" },
  { key: 60, label: "60日足" },
  { key: "all", label: "全期間" },
];

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Parse pasted hall-data table text into an array of machine records.
// some sources render negative numbers with a different Unicode character
// than a plain ASCII hyphen (e.g. U+2212 MINUS SIGN, U+FF0D FULLWIDTH
// HYPHEN-MINUS) — parseInt/parseFloat don't recognize those, so normalize first
function toAsciiMinus(text) {
  return String(text).replace(/[\u2212\uFF0D\u2010\u2011\u2013\u2014]/g, "-");
}

function parseTable(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const machines = [];
  for (const line of lines) {
    if (line.startsWith("台番")) continue; // header row
    if (line.startsWith("平均")) continue; // average row

    let cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 7) {
      cols = line.split(/\s{2,}/).map((c) => c.trim());
    }
    if (cols.length < 7) continue;

    const [noStr, sadaStr, gsuStr, shutsuStr, bbStr, rbStr, gouseiStr, bbRateStr, rbRateStr] = cols;

    const no = parseInt(String(noStr).replace(/,/g, ""), 10);
    if (Number.isNaN(no)) continue;

    const sada = parseInt(toAsciiMinus(sadaStr).replace(/,/g, ""), 10);
    const gsu = parseInt(toAsciiMinus(gsuStr).replace(/,/g, ""), 10);
    const shutsu = parseFloat(String(shutsuStr).replace("%", ""));
    const bb = bbStr === "-" || bbStr === undefined ? null : parseInt(toAsciiMinus(bbStr), 10);
    const rb = rbStr === "-" || rbStr === undefined ? null : parseInt(toAsciiMinus(rbStr), 10);
    const gouseiMatch = gouseiStr ? gouseiStr.match(/1\s*\/\s*(\d+)/) : null;
    const gousei = gouseiMatch ? parseInt(gouseiMatch[1], 10) : null;

    machines.push({
      no,
      sada: Number.isNaN(sada) ? null : sada,
      gsu: Number.isNaN(gsu) ? null : gsu,
      shutsu: Number.isNaN(shutsu) ? null : shutsu,
      bb,
      rb,
      gousei,
      bbRateStr: bbRateStr ?? "-",
      rbRateStr: rbRateStr ?? "-",
    });
  }
  return machines;
}

function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "―";
  return v.toLocaleString();
}

// min-repo's own rating marks for a 機種別サマリー row, applied to our own
// data so we can show the same "notable machines" list for any date:
// ☆ = 出率110%以上 & 勝率100%　◎ = 出率110%以上 & 勝率80%以上
// ◯ = 出率105%以上 & 勝率80%以上　▲ = 出率110%以上
// condition: 2台以上設置 かつ 平均G数3000以上
function classifyMinRepoMark(row) {
  if (!row.total || row.total < 2) return null;
  if (row.avgGsu === null || row.avgGsu === undefined || row.avgGsu < 3000) return null;
  if (row.shutsu === null || row.shutsu === undefined) return null;
  const winRate = row.wins !== null && row.wins !== undefined && row.total ? row.wins / row.total : null;
  if (winRate === null) return null;
  if (row.shutsu >= 110 && winRate >= 1) return "☆";
  if (row.shutsu >= 110 && winRate >= 0.8) return "◎";
  if (row.shutsu >= 105 && winRate >= 0.8) return "◯";
  if (row.shutsu >= 110) return "▲";
  return null;
}
const MARK_PRIORITY = { "☆": 0, "◎": 1, "◯": 2, "▲": 3 };
// color priority: 赤 ＞ 黄色 ＞ 緑 — ☆/◎ need 出率110%+ (red), ◯ needs 105%+
// (yellow), ▲ is the loosest condition (no win-rate requirement, green)
function markColor(mark) {
  if (mark === "☆" || mark === "◎") return "#e5484d";
  if (mark === "◯") return "#f2d24b";
  return "#9ece6a"; // ▲
}

// v6.8.7: 機種名の表記ゆれをより広く吸収する。単純な前方一致だけでなく、
// 全角/半角・波ダッシュ違い・記号違い・空白の有無・大文字小文字の違いを
// まとめて正規化してから比較する（例：「東京喰種」のような記号なしの
// 短い名前はたまたま一致していただけで、サブタイトル付きの機種名は
// ダッシュや波ダッシュの字体違いだけで不一致になっていた）。
function normalizeModelNameForMatch(name) {
  let s = (name || "").normalize("NFKC"); // 全角英数記号→半角、互換文字を統一
  s = s.replace(/^(スマスロ|Sマイ|パチスロ|[SL])\s*/u, ""); // 機種名接頭辞を除去
  s = s.replace(/[〜～~]/gu, "~"); // 波ダッシュ類を統一
  s = s.replace(/[‐‑–—ー−―]/gu, "-"); // ダッシュ・長音記号類を統一
  s = s.replace(/\s+/gu, ""); // 空白（全角含む）を全部除去
  return s.toLowerCase().trim();
}
function modelNamesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return normalizeModelNameForMatch(a) === normalizeModelNameForMatch(b);
}

// v6.8.18: shared 5-段階 strength scale (赤＞黄＞緑＞青＞灰、高いほど赤) —
// house convention for anything with a strength gradient
function fiveBandColor(score0to100) {
  if (score0to100 >= 75) return "#e5697a"; // 赤
  if (score0to100 >= 60) return "#e8b34c"; // 黄
  if (score0to100 >= 45) return "#9ece6a"; // 緑
  if (score0to100 >= 30) return "#7aa2f7"; // 青
  return "#5a6272"; // 灰
}

// per-MACHINE version of the same idea — an individual machine on a single
// day doesn't have a "win rate across installed units" (that concept only
// applies to a model as a whole), so this classifies by 出率 alone
function classifyMachineMark(m) {
  if (!m || m.shutsu === null || m.shutsu === undefined) return null;
  if (m.shutsu >= 110) return "▲";
  if (m.shutsu >= 105) return "◯";
  return null;
}

// v6.7: アナスロ（店全体・全機種・台番号単位の一括表）の貼り付け解析。
// 列：機種名／台番号／G数／差枚／BB／RB／合成確率／BB確率／RB確率。
// 注意：プラザ本店II（プラザ2）のG数は「総回転数」（雑餉隈の元実装は
// 「通常時回転数」だったため出率を計算していなかったが、プラザ2は総回転数
// なので標準の出率計算式がそのまま正しく使える）。
function parseFullStoreTable(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows = [];
  for (const line of lines) {
    if (line.startsWith("機種名") && line.includes("台番号")) continue; // header row
    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 7) continue;
    const [modelName, noStr, gsuStr, sadaStr, bbStr, rbStr, gouseiStr, bbRateStr, rbRateStr] = cols;
    const no = parseInt(String(noStr).replace(/,/g, ""), 10);
    if (Number.isNaN(no) || !modelName) continue;
    const gsu = parseInt(toAsciiMinus(gsuStr).replace(/,/g, ""), 10);
    const sada = parseInt(toAsciiMinus(sadaStr).replace(/,/g, ""), 10);
    const bb = bbStr === "-" || bbStr === undefined ? null : parseInt(toAsciiMinus(bbStr), 10);
    const rb = rbStr === "-" || rbStr === undefined ? null : parseInt(toAsciiMinus(rbStr), 10);
    const gouseiMatch = gouseiStr ? gouseiStr.match(/1\s*\/\s*([\d.]+)/) : null;
    const gousei = gouseiMatch ? parseFloat(gouseiMatch[1]) : null;
    const validGsu = Number.isNaN(gsu) ? null : gsu;
    const validSada = Number.isNaN(sada) ? null : sada;
    // 出率 = (総投入枚数 + 差枚) / 総投入枚数 × 100、総投入枚数 = G数 × 3枚
    const shutsu = validGsu && validGsu > 0 && validSada !== null ? ((validGsu * 3 + validSada) / (validGsu * 3)) * 100 : null;
    rows.push({
      modelName: modelName.trim(),
      no,
      gsu: validGsu,
      sada: validSada,
      shutsu,
      bb: bb !== null && Number.isNaN(bb) ? null : bb,
      rb: rb !== null && Number.isNaN(rb) ? null : rb,
      gousei,
      bbRateStr: bbRateStr ?? "-",
      rbRateStr: rbRateStr ?? "-",
    });
  }
  return rows;
}

// v6.7: inverse of parseFullStoreTable — reconstructs the pasteable
// tab-separated text for a date already saved in rawFullTable, so picking
// an existing date can show what's there instead of an empty box
function serializeFullStoreRows(rows) {
  return (rows || [])
    .map((r) => {
      const gousei = r.gousei === null || r.gousei === undefined ? "-" : `1/${r.gousei}`;
      return [
        r.modelName,
        r.no,
        r.gsu === null || r.gsu === undefined ? "" : r.gsu,
        r.sada === null || r.sada === undefined ? "" : r.sada,
        r.bb === null || r.bb === undefined ? "-" : r.bb,
        r.rb === null || r.rb === undefined ? "-" : r.rb,
        gousei,
        r.bbRateStr || "-",
        r.rbRateStr || "-",
      ].join("\t");
    })
    .join("\n");
}

// v6.7: a stable fingerprint of a day's worth of アナスロ rows, used to
// catch an accidental copy-paste of the wrong day's data. Sorted by 台番号
// so row order in the paste doesn't matter.
function fingerprintFullTableRows(rows) {
  return [...(rows || [])]
    .sort((a, b) => a.no - b.no)
    .map((r) => `${r.no}:${r.sada}:${r.gsu}:${r.bb}:${r.rb}`)
    .join("|");
}

// parse a store-wide summary table: 機種名(or 末尾)\t平均差枚\t平均G数\t勝率(x/y)\t出率
// handles "-" as null, and labels that wrap onto their own line (e.g. "ゾロ目"
// then "(下二桁)\t231\t...") by carrying the orphan text forward as a prefix
function parseSummaryTable(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows = [];
  let pendingLabel = "";
  // v6.9.13: バラエティ（1台設置機種）セクションは列の並びが違う —
  // 「機種／台番／差枚／G数／出率」で、平均差枚が2列目ではなく3列目、
  // 勝率の列は無い（1台だけなので分数の勝率が作れない）。通常の
  // 「機種／平均差枚／平均G数／勝率／出率」ヘッダーと取り違えると、台番号
  // が差枚として読まれてしまっていた。ヘッダーの文言でどちらの並びかを
  // 判定し、以後の行をそのモードで読む。
  let varietyMode = false;
  for (const line of lines) {
    if (line.includes("機種") && line.includes("台番")) {
      varietyMode = true;
      continue; // variety-section header
    }
    if (line.includes("機種") && line.includes("平均差枚")) {
      varietyMode = false;
      continue; // header
    }
    if (line.includes("末尾") && line.includes("平均差枚")) continue; // digit-table header
    if (line === "末尾別データ") continue; // section title
    if (line.includes("バラエティ") && line.includes("1台設置機種")) continue; // section title

    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 5) {
      pendingLabel += line;
      continue;
    }
    const name = (pendingLabel + cols[0]).trim();
    pendingLabel = "";

    if (varietyMode) {
      // 機種／台番／差枚／G数／出率 — no 勝率 column at all here
      const sadaCol = toAsciiMinus(cols[2]);
      const avgSada = sadaCol === "" ? null : sadaCol === "-" ? -0.01 : parseInt(sadaCol.replace(/,/g, ""), 10);
      const avgGsu = cols[3] === "-" || cols[3] === "" ? null : parseInt(cols[3].replace(/,/g, ""), 10);
      const shutsu = cols[4] === "-" ? 99.9 : cols[4] === "" ? null : parseFloat(cols[4].replace("%", ""));
      if (!name) continue;
      rows.push({
        name,
        avgSada: Number.isNaN(avgSada) ? null : avgSada,
        avgGsu: Number.isNaN(avgGsu) ? null : avgGsu,
        wins: null,
        total: null,
        shutsu: Number.isNaN(shutsu) ? null : shutsu,
        isVariety: true, // v6.9.16: this day, this row came from the バラエティ（1台設置機種）section
      });
      continue;
    }

    const col1 = toAsciiMinus(cols[1]);
    // min-repo shows a bare "-" for 平均差枚 specifically when the average
    // was NEGATIVE (not when data is missing) — so treat it as "a loss of
    // unknown size" rather than silently dropping the day from the series.
    // Using a near-zero negative sentinel correctly counts it as a losing
    // day for win-rate/streak purposes without meaningfully distorting
    // magnitude-based averages (since we have no real number to use).
    const avgSada = col1 === "" ? null : col1 === "-" ? -0.01 : parseInt(col1.replace(/,/g, ""), 10);
    const avgGsu = cols[2] === "-" || cols[2] === "" ? null : parseInt(cols[2].replace(/,/g, ""), 10);
    const winMatch = cols[3] ? cols[3].match(/(\d+)\s*\/\s*(\d+)/) : null;
    const wins = winMatch ? parseInt(winMatch[1], 10) : null;
    const total = winMatch ? parseInt(winMatch[2], 10) : null;
    const shutsu = cols[4] === "-" ? 99.9 : cols[4] === "" ? null : parseFloat(cols[4].replace("%", ""));
    if (!name) continue;
    rows.push({
      name,
      avgSada: Number.isNaN(avgSada) ? null : avgSada,
      avgGsu: Number.isNaN(avgGsu) ? null : avgGsu,
      wins,
      total,
      isVariety: false,
      shutsu: Number.isNaN(shutsu) ? null : shutsu,
    });
  }
  return rows;
}

// splits a combined paste (機種別サマリー + 末尾別データ) at the "末尾別データ" divider
function parseOverallSummary(text) {
  const idx = text.indexOf("末尾別データ");
  const modelText = idx === -1 ? text : text.slice(0, idx);
  const digitText = idx === -1 ? "" : text.slice(idx);
  return { modelRows: parseSummaryTable(modelText), digitRows: parseSummaryTable(digitText) };
}

// v6.8: inverse of parseSummaryTable — reconstructs pasteable tab-separated
// text from already-stored rows, so clicking a past 民レポ date can reload
// it into the edit textarea instead of only offering delete
function serializeSummaryRows(rows) {
  return (rows || [])
    .map((r) => {
      const avgSada = r.avgSada === null || r.avgSada === undefined ? "" : r.avgSada;
      const avgGsu = r.avgGsu === null || r.avgGsu === undefined ? "-" : r.avgGsu;
      const winFrac = r.wins === null || r.total === null || r.wins === undefined || r.total === undefined ? "" : `${r.wins}/${r.total}`;
      const shutsu = r.shutsu === null || r.shutsu === undefined ? "" : `${r.shutsu}%`;
      return [r.name, avgSada, avgGsu, winFrac, shutsu].join("\t");
    })
    .join("\n");
}
function serializeOverallSummary(s) {
  const modelText = serializeSummaryRows(s.modelRows);
  const digitText = serializeSummaryRows(s.digitRows);
  return digitText ? `${modelText}\n末尾別データ\n${digitText}` : modelText;
}

// Build (trailing N-day total, next day's differential) pairs from a
// chronological series of {date, sada} for one machine.
function buildTrailingPairs(series, windowSize) {
  const pairs = [];
  for (let k = windowSize - 1; k < series.length - 1; k++) {
    let sum = 0;
    for (let j = k - windowSize + 1; j <= k; j++) sum += series[j].sada;
    const next = series[k + 1];
    pairs.push({ trailingSum: sum, nextSada: next.sada, nextDate: next.date });
  }
  return pairs;
}

// Search candidate thresholds and find the "total >= T" and "total <= T"
// splits that give the best next-day-positive win rate (with a minimum
// sample size so it isn't just picking a fluke single data point).
function findBestThresholds(pairs, minSample = 5, baseRate = 0.5) {
  if (pairs.length < minSample) return null;
  const thresholds = Array.from(new Set(pairs.map((p) => p.trailingSum))).sort((a, b) => a - b);

  let bestAbove = null;
  let bestBelow = null;
  thresholds.forEach((T) => {
    const above = pairs.filter((p) => p.trailingSum >= T);
    if (above.length >= minSample) {
      const wins = above.filter((p) => p.nextSada > 0).length;
      const winRate = wins / above.length;
      const avgNext = above.reduce((a, p) => a + p.nextSada, 0) / above.length;
      // only accept as "favorable" if it beats this machine's OWN overall
      // base rate — not a fixed 50%, since a machine's unconditional odds
      // of a positive day may themselves sit above or below half
      if (winRate > baseRate && (!bestAbove || winRate > bestAbove.winRate || (winRate === bestAbove.winRate && above.length > bestAbove.sampleSize))) {
        bestAbove = { threshold: T, winRate, sampleSize: above.length, avgNext };
      }
    }
    const below = pairs.filter((p) => p.trailingSum <= T);
    if (below.length >= minSample) {
      const wins = below.filter((p) => p.nextSada > 0).length;
      const winRate = wins / below.length;
      const avgNext = below.reduce((a, p) => a + p.nextSada, 0) / below.length;
      if (winRate > baseRate && (!bestBelow || winRate > bestBelow.winRate || (winRate === bestBelow.winRate && below.length > bestBelow.sampleSize))) {
        bestBelow = { threshold: T, winRate, sampleSize: below.length, avgNext };
      }
    }
  });

  return { totalPairs: pairs.length, bestAbove, bestBelow };
}

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function weekdayOf(dateStr) {
  return new Date(dateStr + "T00:00:00").getDay();
}

// this machine's own unconditional odds of a positive day — the correct
// baseline to compare conditional patterns against (not a fixed 50%)
function computeBaseRate(series) {
  if (series.length === 0) return 0.5;
  const wins = series.filter((s) => s.sada > 0).length;
  return wins / series.length;
}

// rough letter-grade banding for the overall score, for at-a-glance ranking.
// these cutoffs are just for readability, not a statistically rigorous scale.
const GRADE_BANDS = [
  { min: 0.8, grade: "S" },
  { min: 0.7, grade: "A" },
  { min: 0.62, grade: "B" },
  { min: 0.56, grade: "C" },
  { min: 0.52, grade: "D" },
  { min: 0.48, grade: "E" },
  { min: 0.42, grade: "F" },
  { min: -Infinity, grade: "G" },
];
function scoreToGrade(score) {
  if (score === null || score === undefined) return null;
  return GRADE_BANDS.find((b) => score >= b.min).grade;
}

// backtesting (real hall data, walk-forward) showed these specific signals
// have a genuine, repeatable edge; everything else is kept as a smaller
// tie-breaker rather than being dropped, since it still carries some signal
// v6.20: 「翌日、Xの値が高くなるところを予想する」に統一。実データ検証で
// 全部Xの予想材料としても機能することを確認済みの6つの判定材料だけに
// 絞った（古い▲・差枚ベースの判定材料は全部削除）。
const STRONG_SIGNAL_LABELS = new Set([
  // v6.9→v6.20: 台番号固有のXの法則。実データ検証：上位1/3でbase比+0.045、
  // 下位1/3で-0.020と、方向一貫かつ大サンプル(各n=2101)で確認済み
  "台番号固有のXの法則",
  // v6.17→v6.20: 機種全体のXの法則。台番号固有の実績とは独立した情報量
  // がある。実データ検証：上位1/3でbase比+0.031、下位1/3で-0.035
  "機種全体のXの法則",
  // v6.19→v6.20: 前日、他の台が好調（▲率50%+）。実データ検証：+0.058
  "前日、他の台が好調",
  // v6.9→v6.20: 前日のG数水準（大量回転/低調）。実データ検証：大量回転
  // +0.023、低調-0.025
  "前日のG数水準",
]);
function isStrongSignalLabel(label) {
  const baseLabel = label.replace(/[（(].*[）)]/g, "").trim();
  return STRONG_SIGNAL_LABELS.has(baseLabel) || baseLabel.startsWith("日付末尾") || baseLabel.startsWith("イベント「");
}

// grade bands for the hybrid score: count-of-proven-signals * 100, plus a
// capped tie-breaker from every other (weaker but non-zero) signal
const POINT_GRADE_BANDS = [
  { min: 350, grade: "S" },
  { min: 250, grade: "A" },
  { min: 150, grade: "B" },
  { min: 50, grade: "C" },
  { min: -20, grade: "D" },
  { min: -Infinity, grade: "E" },
];
function pointsToGrade(points) {
  if (points === null || points === undefined) return null;
  return POINT_GRADE_BANDS.find((b) => points >= b.min).grade;
}

// how much weight to give one signal's diff, based on how many historical
// samples it's built on — a 5-sample "100%" streak shouldn't count nearly as
// much as a 30-sample 60% edge. sqrt curve: 5 samples ≈ half weight, 20+ ≈ full.
function sampleWeight(sampleSize) {
  if (!sampleSize || sampleSize <= 0) return 0;
  return Math.min(1, Math.sqrt(sampleSize / 20));
}

// core building block for the new scoring system: (winRate - baseline) in
// percentage points, scaled down when the sample size is small. the diff
// itself is capped — an in-sample threshold search can occasionally turn up
// an extreme (90%+) win rate purely from overfitting a small history, and
// without a cap that one signal would swamp everything else in the total
function computePoints(winRate, baseline, sampleSize) {
  if (winRate === null || winRate === undefined || baseline === null || baseline === undefined) return 0;
  const diff = Math.max(-0.15, Math.min(0.15, winRate - baseline));
  return diff * 100 * sampleWeight(sampleSize);
}

// expected-value component: how much better/worse is the AVERAGE payout
// under this signal, compared to the machine's own typical day? expressed
// relative to the machine's own typical daily swing so it's comparable
// across machines with very different scales, then capped so one huge
// outlier day can't dominate the score
function computeEvPoints(signalAvg, baselineAvg, typicalMagnitude, sampleSize) {
  if (signalAvg === null || signalAvg === undefined || !typicalMagnitude) return 0;
  const diff = signalAvg - (baselineAvg || 0);
  const normalized = diff / typicalMagnitude;
  const capped = Math.max(-1, Math.min(1, normalized));
  return capped * 8 * sampleWeight(sampleSize);
}

// per-signal weight multipliers, calibrated from a walk-forward backtest on
// real hall data (see conversation history) — signals that turned out to
// have little/no real predictive edge are dialed down rather than removed
// outright, in case future data tells a different story
// v6.20: 「翌日、Xの値が高くなるところを予想する」に統一したため、古い
// ▲・差枚ベースの判定材料は一旦全部削除したが、v6.21で判定材料が
// 少なすぎる（ユーコーラッキーのような幅広いグレード分布にならない）
// との指摘を受け、実データでXの予想材料として機能することを確認できた
// 3つ（20/30日足逆張り・準イベント翌日・大量回転低調(自分比)）を
// Xターゲット版として復活。
const SIGNAL_WEIGHTS = {
  digitDay: 1, // 日付末尾 — 実データ検証で強く確認（=0で-0.150、=2で+0.141）
  plannedEvent: 1.5, // イベント名ごと — 実データ検証で強く確認（爆撮+0.201、百獣撮-0.143等）
  fixedNoX: 1.5, // 台番号固有のXの法則 — 上位1/3で+0.045、下位1/3で-0.020
  modelWideX: 1.5, // 機種全体のXの法則 — 上位1/3で+0.031、下位1/3で-0.035
  gsuLevel: 1.2, // 前日のG数水準（大量回転/低調） — 大量回転+0.023、低調-0.025
  pageMateGood: 1.3, // 前日、他の台が好調（50%+） — +0.058
  // v6.21: 復活した3つ
  trailingWindow: 1.0, // 20/30日足トレイリング差枚（逆張り） — n=1428〜2018、+0.026〜+0.032
  semiFollow: 1.0, // 準イベント翌日 — n=722、-0.051（注意信号）
  volumeMismatch: 1.0, // 大量回転・低調（自分比） — n=2160〜2250、+0.035/-0.015
};

// consecutive same-sign run lengths, day by day, for a {date,sada} series
function computeStreaks(series) {
  const streaks = [];
  series.forEach((pt, i) => {
    const dir = pt.sada > 0 ? "plus" : pt.sada < 0 ? "minus" : "flat";
    if (i === 0 || streaks[i - 1].dir !== dir) {
      streaks.push({ dir, len: 1 });
    } else {
      streaks.push({ dir, len: streaks[i - 1].len + 1 });
    }
  });
  return streaks;
}

// does a long enough plus/minus streak predict next-day-positive (relative
// to this machine's own base rate)?
function evaluateStreakPattern(series, baseRate = 0.5) {
  const streaks = computeStreaks(series);
  const pairs = [];
  for (let i = 0; i < series.length - 1; i++) {
    pairs.push({ dir: streaks[i].dir, len: streaks[i].len, nextSada: series[i + 1].sada });
  }
  function bestForDir(dir) {
    const subset = pairs.filter((p) => p.dir === dir);
    if (subset.length < 8) return null;
    const lens = Array.from(new Set(subset.map((p) => p.len))).sort((a, b) => a - b);
    let best = null;
    lens.forEach((L) => {
      const matched = subset.filter((p) => p.len >= L);
      if (matched.length < 5) return;
      const wins = matched.filter((p) => p.nextSada > 0).length;
      const winRate = wins / matched.length;
      if (winRate > baseRate && (!best || winRate > best.winRate || (winRate === best.winRate && matched.length > best.sampleSize))) {
        best = { minLen: L, winRate, sampleSize: matched.length, avgNext: matched.reduce((a, p) => a + p.nextSada, 0) / matched.length };
      }
    });
    return best;
  }
  // stat for EXACTLY this streak length (not "N or more"), which is what
  // actually applies to the day right after the current streak — only
  // returned if it actually beats this machine's base rate
  function exactForDir(dir, length) {
    const subset = pairs.filter((p) => p.dir === dir && p.len === length);
    if (subset.length < 4) return null;
    const wins = subset.filter((p) => p.nextSada > 0).length;
    const winRate = wins / subset.length;
    if (winRate <= baseRate) return null;
    return {
      len: length,
      winRate,
      sampleSize: subset.length,
      avgNext: subset.reduce((a, p) => a + p.nextSada, 0) / subset.length,
    };
  }
  // ungated variant: returns the stat for this exact streak length regardless
  // of whether it beats base rate — needed for the additive/subtractive
  // scoring system, which wants the SIGNED difference, not just "does it win"
  function exactForDirRaw(dir, length) {
    const subset = pairs.filter((p) => p.dir === dir && p.len === length);
    if (subset.length < 4) return null;
    const wins = subset.filter((p) => p.nextSada > 0).length;
    const winRate = wins / subset.length;
    return {
      len: length,
      winRate,
      sampleSize: subset.length,
      avgNext: subset.reduce((a, p) => a + p.nextSada, 0) / subset.length,
    };
  }
  return { plus: bestForDir("plus"), minus: bestForDir("minus"), currentStreak: streaks[streaks.length - 1] || null, exactForDir, exactForDirRaw };
}

// per-weekday average 差枚 for a {date,sada} series
function computeWeekdayStats(series) {
  const buckets = Array.from({ length: 7 }, () => ({ sum: 0, count: 0, wins: 0 }));
  series.forEach((pt) => {
    const wd = weekdayOf(pt.date);
    buckets[wd].sum += pt.sada;
    buckets[wd].count += 1;
    if (pt.sada > 0) buckets[wd].wins += 1;
  });
  return buckets.map((b) => ({
    avg: b.count ? b.sum / b.count : null,
    count: b.count,
    winRate: b.count ? b.wins / b.count : null,
  }));
}

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 8) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}

// does the day AFTER a registered strong-event day tend to be better than usual?
function evaluateStrongFollow(series, strongDateSet) {
  const pairs = [];
  for (let i = 0; i < series.length - 1; i++) {
    pairs.push({ isStrong: strongDateSet.has(series[i].date), nextSada: series[i + 1].sada });
  }
  function summarize(arr) {
    if (arr.length < 3) return null;
    const wins = arr.filter((p) => p.nextSada > 0).length;
    return { sampleSize: arr.length, winRate: wins / arr.length, avgNext: arr.reduce((a, p) => a + p.nextSada, 0) / arr.length };
  }
  return { strong: summarize(pairs.filter((p) => p.isStrong)), normal: summarize(pairs.filter((p) => !p.isStrong)) };
}

// does the 差枚 trend BETWEEN the last registered event and today predict
// whether an UPCOMING event day (tomorrow) will itself be a good day? this
// only returns a result when tomorrow is actually a registered event —
// otherwise there's nothing to predict
function evaluateInterEventTrend(seriesFullWithEvent, isTomorrowEvent, eventDateSet) {
  if (!isTomorrowEvent) return null;
  const eventIdx = [];
  seriesFullWithEvent.forEach((s, i) => {
    const isEventDay = eventDateSet ? eventDateSet.has(s.date) : s.event && s.event.trim();
    if (isEventDay) eventIdx.push(i);
  });
  if (eventIdx.length < 2) return null;

  // historical calibration: for every past pair of consecutive event days,
  // bucket the LATER event day's own result by whether the days strictly
  // between them trended up or down
  const upOutcomes = [];
  const downOutcomes = [];
  for (let k = 1; k < eventIdx.length; k++) {
    const i1 = eventIdx[k - 1];
    const i2 = eventIdx[k];
    if (i2 - i1 < 2) continue; // no gap days between them
    const between = seriesFullWithEvent.slice(i1 + 1, i2);
    if (between.length === 0) continue;
    const betweenSum = between.reduce((a, s) => a + s.sada, 0);
    (betweenSum > 0 ? upOutcomes : downOutcomes).push(seriesFullWithEvent[i2].sada);
  }

  // current trend: from the most recent past event through today (inclusive)
  const lastEventIdx = eventIdx[eventIdx.length - 1];
  const todayIdx = seriesFullWithEvent.length - 1;
  if (todayIdx - lastEventIdx < 1) return null; // today itself IS that last event; no gap to measure yet
  const currentBetween = seriesFullWithEvent.slice(lastEventIdx + 1, todayIdx + 1);
  if (currentBetween.length === 0) return null;
  const currentSum = currentBetween.reduce((a, s) => a + s.sada, 0);
  const isUp = currentSum > 0;

  const relevant = isUp ? upOutcomes : downOutcomes;
  if (relevant.length < 5) return null;
  const wins = relevant.filter((v) => v > 0).length;
  return {
    direction: isUp ? "上昇" : "下降",
    winRate: wins / relevant.length,
    avg: relevant.reduce((a, v) => a + v, 0) / relevant.length,
    sampleSize: relevant.length,
  };
}

// how has this machine historically done the day AFTER any occurrence of a
// specific named event (not limited to the curated "strong" list)?
function evaluateEventNamePerformance(series, historyByDate, eventName) {
  const matchVals = [];
  const otherVals = [];
  series.forEach((s) => {
    const entry = historyByDate[s.date];
    const isMatch = entry && entry.event && splitEventNames(entry.event).includes(eventName);
    (isMatch ? matchVals : otherVals).push(s.sada);
  });
  if (matchVals.length < 3) return null;
  function summarize(arr) {
    if (arr.length < 3) return null;
    const wins = arr.filter((v) => v > 0).length;
    return { sampleSize: arr.length, winRate: wins / arr.length, avgNext: arr.reduce((a, v) => a + v, 0) / arr.length };
  }
  const matched = summarize(matchVals);
  const other = summarize(otherVals);
  return {
    sampleSize: matched.sampleSize,
    winRate: matched.winRate,
    avgNext: matched.avgNext,
    // the win rate on days that AREN'T this event — the correct baseline
    // for judging this event's real edge, since frequent events (every ~10
    // days) are otherwise already baked into the machine's overall base rate
    normalRate: other ? other.winRate : null,
    normalAvg: other ? other.avgNext : null,
  };
}

// does the trailing 10-day 差枚 trend BEFORE a named event's own past
// occurrences predict how THAT event day itself went? backtested per-event
// (not blanket "any event") since the effect size varies a lot by name —
// e.g. real and large for "2のつく日"/"7のつく日", much weaker for others
function evaluatePreEventTrend(series, historyByDate, eventName, windowSize = 10) {
  const upVals = [];
  const downVals = [];
  for (let i = windowSize; i < series.length; i++) {
    const entry = historyByDate[series[i].date];
    if (!entry || !entry.event || !splitEventNames(entry.event).includes(eventName)) continue;
    const pre = series.slice(i - windowSize, i);
    const preSum = pre.reduce((a, p) => a + p.sada, 0);
    (preSum > 0 ? upVals : downVals).push(series[i].sada);
  }
  function summarize(arr) {
    if (arr.length < 5) return null;
    const wins = arr.filter((v) => v > 0).length;
    return { sampleSize: arr.length, winRate: wins / arr.length, avg: arr.reduce((a, v) => a + v, 0) / arr.length };
  }
  return { up: summarize(upVals), down: summarize(downVals) };
}

// every calendar date from start to end, inclusive (used for recommend periods)
function enumerateDateRange(start, end) {
  const dates = [];
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < 400) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return dates;
}

// how has this machine performed ON days that fall inside a given date set
// (e.g. a hall-declared "recommended" period), vs its usual base rate?
function evaluateMembershipPerformance(series, dateSet) {
  const memberDays = series.filter((s) => dateSet.has(s.date));
  if (memberDays.length < 3) return null;
  const wins = memberDays.filter((s) => s.sada > 0).length;
  return {
    sampleSize: memberDays.length,
    winRate: wins / memberDays.length,
    avg: memberDays.reduce((a, s) => a + s.sada, 0) / memberDays.length,
  };
}

// heavy play (high G数) without a proportional payout — a caution flag, not a "buy" signal
function evaluateVolumeMismatch(seriesWithGsu) {
  const gsuVals = seriesWithGsu.map((s) => s.gsu).filter((v) => v !== null && v !== undefined);
  if (gsuVals.length < 5) return null;
  const avgGsu = gsuVals.reduce((a, b) => a + b, 0) / gsuVals.length;

  function isMismatch(pt) {
    return pt.gsu !== null && pt.gsu !== undefined && pt.gsu >= avgGsu * 1.15 && pt.sada !== null && pt.sada <= 0;
  }

  const last = seriesWithGsu[seriesWithGsu.length - 1];
  if (!isMismatch(last)) return null;

  // past occurrences of this same pattern (never includes "last" itself,
  // since we're looking at what happened AFTER earlier instances)
  const nextDayVals = [];
  const twoDayVals = [];
  for (let i = 0; i < seriesWithGsu.length - 1; i++) {
    if (!isMismatch(seriesWithGsu[i])) continue;
    if (seriesWithGsu[i + 1].sada !== null) nextDayVals.push(seriesWithGsu[i + 1].sada);
    if (i + 2 < seriesWithGsu.length && seriesWithGsu[i + 2].sada !== null) twoDayVals.push(seriesWithGsu[i + 2].sada);
  }
  function summarize(arr) {
    if (arr.length < 3) return null;
    const wins = arr.filter((v) => v > 0).length;
    return { sampleSize: arr.length, winRate: wins / arr.length, avg: arr.reduce((a, b) => a + b, 0) / arr.length };
  }

  return {
    lastDate: last.date,
    lastGsu: last.gsu,
    avgGsu,
    lastSada: last.sada,
    nextDayStats: summarize(nextDayVals),
    twoDayStats: summarize(twoDayVals),
  };
}

// per-day, per-machine "suspected setting" flag based on how this machine's
// G数 ranks against every OTHER machine on the same page that same day (not
// against its own historical average) — this way, hall-wide rotation being
// boosted on event days doesn't get mistaken for one machine being popular.
// 'good': played a lot relative to peers, and didn't lose much (people kept feeding it)
// 'low': played little relative to peers despite being ahead (people gave up early)
// v6.10: 「設定期待度」（X）— 合成確率（BB+RB合算）と出率を、ページ内で
// z-score化して0.4:0.6で合成した連続値。RB確率だけを使う設定判別（通常時
// 回転数が必要）はプラザ本店IIでは組めないため、代わりに総回転数でも
// 計算できる合成確率＋出率の組み合わせで「その日、設定が良さそうだった
// か」を数値化した。実データ検証で、台番号固定の実績・日付末尾・イベン
// ト・前日の他の台の不調・前日のG数水準など、▲マークで効いていたのと
// 同じ条件がXでも同じ方向に効くことを確認済み（±0.15前後の効果）。
// 【重要】Xは「設定が良さそうか」の目安であり、「差枚がプラスになるか」
// とは別物 — 検証でも綺麗な相関は出なかった（設定は日替わりなので当然）。
// そのため▲ベースのS〜Eグレードとは完全に別枠の「設定期待度」表示として
// 使う（合算しない）。
function computeGouseiFromMachine(m) {
  const totalHits = (m.bb || 0) + (m.rb || 0);
  return m.gsu && totalHits > 0 ? m.gsu / totalHits : null; // "1/X" の X 部分。小さいほど良い
}
// z-score a set of values (object: key -> value), returns key -> zscore
function zScoreMap(valuesByKey) {
  const vals = Object.values(valuesByKey).filter((v) => v !== null && v !== undefined);
  if (vals.length < 5) {
    const out = {};
    Object.keys(valuesByKey).forEach((k) => { out[k] = null; });
    return out;
  }
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
  const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  const std = Math.sqrt(variance) || 1;
  const out = {};
  Object.keys(valuesByKey).forEach((k) => {
    const v = valuesByKey[k];
    out[k] = v !== null && v !== undefined ? (v - mean) / std : null;
  });
  return out;
}
const X_GOUSEI_WEIGHT = 0.4; // 実データ検証で試した中で無難だった重み（0.3〜0.6の間で大差なし）
// v6.10: ページ全体（全台・全日）をプールしてXを計算する（1台だけでは
// z-score化に必要なサンプルが足りない日が多いため）。返り値は
// {date: {no: X}} — pageSortedHistory一式に対して1回だけ呼ぶ。
function computeXForPage(pageSortedHistory) {
  const gouseiByKey = {};
  const shutsuByKey = {};
  const keys = [];
  pageSortedHistory.forEach((h) => {
    h.machines.forEach((m) => {
      const key = `${h.date}|${m.no}`;
      gouseiByKey[key] = computeGouseiFromMachine(m);
      shutsuByKey[key] = m.shutsu !== null && m.shutsu !== undefined ? m.shutsu : null;
      keys.push(key);
    });
  });
  const gouseiZ = zScoreMap(gouseiByKey);
  const shutsuZ = zScoreMap(shutsuByKey);
  const xByDate = {};
  keys.forEach((key) => {
    const [date, noStr] = key.split("|");
    const no = parseInt(noStr, 10);
    const gz = gouseiZ[key];
    const sz = shutsuZ[key];
    const x = gz !== null && sz !== null ? X_GOUSEI_WEIGHT * -gz + (1 - X_GOUSEI_WEIGHT) * sz : null;
    if (!xByDate[date]) xByDate[date] = {};
    xByDate[date][no] = x;
  });
  return xByDate;
}

// v6.12: Xの生値（だいたい-2〜+2くらいのz-score合成値）は数値として直感
// 的でないので、表示用にページ内でのパーセンタイル順位（0〜100）へ変換
// する。雑餉隈の「数値」表示（台番号×日付、色付き数値）と同じ見た目に
// するため。
function computeXPercentiles(xByDate) {
  const allVals = [];
  Object.values(xByDate).forEach((dayMap) => {
    Object.values(dayMap).forEach((x) => { if (x !== null && x !== undefined) allVals.push(x); });
  });
  allVals.sort((a, b) => a - b);
  const n = allVals.length;
  function percentileOf(x) {
    if (n === 0) return null;
    // binary search for insertion point
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (allVals[mid] < x) lo = mid + 1; else hi = mid;
    }
    return Math.round((lo / n) * 100);
  }
  const pctByDate = {};
  Object.entries(xByDate).forEach(([date, dayMap]) => {
    pctByDate[date] = {};
    Object.entries(dayMap).forEach(([no, x]) => {
      pctByDate[date][no] = x !== null && x !== undefined ? percentileOf(x) : null;
    });
  });
  return pctByDate;
}

// v6.9: shared "hit" definition for the new ▲-mark-based signals below —
// matches classifyMachineMark's own ▲ threshold (出率110%以上)
// v6.11: 本格的な設定判別（理論値表＋ポアソン尤度）。マイジャグラーVは
// 純粋なAタイプ（AT/BT状態なし）で、G数＝総回転数＝通常時回転数が完全に
// 一致するため、通常時回転数ベースの理論値表がそのまま使える（プラザ2の
// アナスロが総回転数である問題が発生しない唯一のケース）。
// A-typeページの束ね機種（A-SLOT+異世界かるてっと等）は、BT（ボーナス
// トリガー）という連チャン状態を持つ機種が混ざっており、G数の意味が
// 曖昧になる恐れがあるため対象外（Xシステムのまま）。
// データ出典：スロベース (https://slobase.jp/machines/myjuggler5) 2026年
// 4月時点の解析値。BIG/REG確率（1/X の X の値、大きいほど当たりにくい）。
const SETTING_PROFILES = {
  "マイジャグラーV": {
    settings: [1, 2, 3, 4, 5, 6],
    big: [273.1, 270.8, 266.4, 254.0, 240.1, 229.1],
    reg: [409.6, 385.5, 336.1, 290.0, 268.6, 229.1],
  },
};

// ポアソン確率質量関数: P(観測回数=k | 期待値λ)。javascriptには階乗の
// 組み込みが無いので対数空間で計算し（大きいkでもオーバーフローしない）、
// 最後にexpで戻す。
function poissonLogPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 0 : -Infinity;
  // log(P) = -λ + k*log(λ) - log(k!)、log(k!)はスターリング近似ではなく
  // 素直にΣlog(i)で計算（このアプリの規模のkなら十分速い）
  let logFactorialK = 0;
  for (let i = 2; i <= k; i++) logFactorialK += Math.log(i);
  return -lambda + k * Math.log(lambda) - logFactorialK;
}

// v6.11: 1日分のBB/RB回数とG数から、設定1〜6それぞれの「もっともらしさ」
// を計算し、事後確率（合計100%になるよう正規化）を返す。事前分布は一様
// （どの設定も同じ確率であり得る）と仮定 — 実際のホールの設定配分に
// 偏りがあっても、そこまでは分からないため中立に扱う。
function evaluateSettingLikelihood(profile, bb, rb, gsu) {
  if (!profile || !gsu || gsu <= 0 || bb === null || bb === undefined || rb === null || rb === undefined) return null;
  const logLikelihoods = profile.settings.map((_, i) => {
    const bigLambda = gsu / profile.big[i];
    const regLambda = gsu / profile.reg[i];
    return poissonLogPmf(bb, bigLambda) + poissonLogPmf(rb, regLambda);
  });
  const maxLog = Math.max(...logLikelihoods);
  const rel = logLikelihoods.map((l) => Math.exp(l - maxLog)); // avoid underflow: shift by max before exponentiating
  const sum = rel.reduce((a, v) => a + v, 0);
  const posterior = rel.map((v) => v / sum);
  const bySetting = {};
  profile.settings.forEach((s, i) => { bySetting[s] = posterior[i]; });
  return bySetting;
}

function isHitA(shutsu) {
  return shutsu !== null && shutsu !== undefined && shutsu >= 110;
}

// v6.9: page-wide ▲ base rate — the baseline every one of the 3 new
// signals below is compared against (実データ検証で使ったのと同じ基準）
function computePageBaseRateA(pageSortedHistory) {
  let n = 0, hits = 0;
  pageSortedHistory.forEach((h) => {
    h.machines.forEach((m) => {
      if (m.shutsu === null || m.shutsu === undefined) return;
      n += 1;
      if (isHitA(m.shutsu)) hits += 1;
    });
  });
  return n > 0 ? hits / n : 0.21; // 0.21 ≈ observed baseline as a fallback for a brand-new page with no data yet
}

// v6.9: page-wide G数 33rd/66th percentile — used to bucket a day's own G数
// into 低調/普通/大量回転, the same way computeDailySettingFlags already
// does it for its own (different) purpose
function computePageGsuPercentiles(pageSortedHistory) {
  const vals = [];
  pageSortedHistory.forEach((h) => h.machines.forEach((m) => { if (m.gsu !== null && m.gsu !== undefined) vals.push(m.gsu); }));
  if (vals.length < 10) return null;
  vals.sort((a, b) => a - b);
  return { p33: vals[Math.floor(vals.length / 3)], p66: vals[Math.floor((2 * vals.length) / 3)] };
}

// v6.9: 【実証済み・強い基準】「前日、同じページの他の台の当たり(▲)率が低
// かった」→ 今日この台が当たるか。実データ検証で n=1822, 的中率15.9%
// （ベース21.1%比 -5.2pt）と明確な負の効果が確認できた（店全体が渋い日は
// 翌日も渋い傾向、という解釈が自然）。「他の台が好調だった」側は効果が
// 弱かったので、不調側だけを本采用する。
// v6.9.1: 証拠（勝率の元になるサンプル）は「その台自身の過去」だけに限定
// せず、ページ内の全台をプールして集計する（実データ検証もそうしていた
// ため）。1台だけの実績に限定すると、80日程度のデータでは「前日ページが
// 不調だった」という状況自体が数回しか起きず、十分なサンプルが集まらない。
// この関数はページ単位で1回だけ呼び、結果をどの台にも共通で使う。
function computePageMateTroubleStats(pageSortedHistory) {
  let n = 0, hits = 0;
  for (let i = 1; i < pageSortedHistory.length; i++) {
    const prevDay = pageSortedHistory[i - 1];
    const curDay = pageSortedHistory[i];
    const prevValid = prevDay.machines.filter((m) => m.shutsu !== null && m.shutsu !== undefined);
    if (prevValid.length < 2) continue;
    const prevHitRate = prevValid.filter((m) => isHitA(m.shutsu)).length / prevValid.length;
    if (prevHitRate > 0.1) continue; // only the "bad page day" bucket
    curDay.machines.forEach((m) => {
      if (m.shutsu === null || m.shutsu === undefined) return;
      n += 1;
      if (isHitA(m.shutsu)) hits += 1;
    });
  }
  return n >= 15 ? { winRate: hits / n, sampleSize: n } : null;
}
// per-machine check: was YESTERDAY (for this machine's page-mates,
// excluding itself) a "bad page day"? if so, the page-wide stats apply today
function checkPageMateTroubleToday(pageMateTroubleStats, pageHistoryByDate, lastDate, no) {
  if (!pageMateTroubleStats) return null;
  const lastDayRec = pageHistoryByDate[lastDate];
  if (!lastDayRec) return null;
  const lastMates = lastDayRec.machines.filter((m) => m.no !== no && m.shutsu !== null && m.shutsu !== undefined);
  if (lastMates.length < 2) return null;
  const lastMateHitRate = lastMates.filter((m) => isHitA(m.shutsu)).length / lastMates.length;
  if (lastMateHitRate > 0.1) return null;
  return pageMateTroubleStats;
}

// v6.19: 【実証済み・強い基準】前日、同じページの他の台の当たり(▲)率が
// 高かった（50%以上）→ 今日この台が当たるか。当初「他の台が好調だった」
// 側は効果が弱いと判断して不採用にしていたが、指示書（ユーコーラッキー
// スレッド）の「島内の高設定台数」という着眼点をきっかけに、台数ではなく
// 率で細かく区切って再検証したところ、50%以上のところだけ明確な正の効果
// （n=138, 的中率29.7%、ベース比+8.6pt）を発見。0〜10%（不調）〜50%+
// （好調）まで連続的にほぼ単調増加する構造だったことも判明。
function computePageMateGoodStats(pageSortedHistory) {
  let n = 0, hits = 0;
  for (let i = 1; i < pageSortedHistory.length; i++) {
    const prevDay = pageSortedHistory[i - 1];
    const curDay = pageSortedHistory[i];
    const prevValid = prevDay.machines.filter((m) => m.shutsu !== null && m.shutsu !== undefined);
    if (prevValid.length < 2) continue;
    const prevHitRate = prevValid.filter((m) => isHitA(m.shutsu)).length / prevValid.length;
    if (prevHitRate < 0.5) continue; // only the "good page day" bucket
    curDay.machines.forEach((m) => {
      if (m.shutsu === null || m.shutsu === undefined) return;
      n += 1;
      if (isHitA(m.shutsu)) hits += 1;
    });
  }
  return n >= 15 ? { winRate: hits / n, sampleSize: n } : null;
}
function checkPageMateGoodToday(pageMateGoodStats, pageHistoryByDate, lastDate, no) {
  if (!pageMateGoodStats) return null;
  const lastDayRec = pageHistoryByDate[lastDate];
  if (!lastDayRec) return null;
  const lastMates = lastDayRec.machines.filter((m) => m.no !== no && m.shutsu !== null && m.shutsu !== undefined);
  if (lastMates.length < 2) return null;
  const lastMateHitRate = lastMates.filter((m) => isHitA(m.shutsu)).length / lastMates.length;
  if (lastMateHitRate < 0.5) return null;
  return pageMateGoodStats;
}

// v6.9: 【実証済み・強い基準】前日の自分自身のG数水準（大量回転/低調）→
// 翌日当たるか。実データ検証：前日大量回転→翌日24.6%(+3.5pt)、前日低調→
// 翌日18.1%(-3.0pt)。当日のG数で判定すると強い相関が出るが、それは終わって
// みないとわからない値なのでリーク（使えない）。必ず前日のG数で判定する。
// v6.9.1: pageMateTroubleと同じ理由で、証拠はページ内の全台をプールして
// 集計する（1台の実績だけに限定するとサンプルが少なすぎる）。
function computeTrailingGsuLevelStats(pageSortedHistory, pageGsuPercentiles) {
  if (!pageGsuPercentiles) return null;
  const { p33, p66 } = pageGsuPercentiles;
  let highN = 0, highHits = 0, lowN = 0, lowHits = 0;
  for (let i = 1; i < pageSortedHistory.length; i++) {
    const prevDay = pageSortedHistory[i - 1];
    const curDay = pageSortedHistory[i];
    const prevByNo = new Map(prevDay.machines.map((m) => [m.no, m.gsu]));
    curDay.machines.forEach((m) => {
      const prevGsu = prevByNo.get(m.no);
      if (prevGsu === null || prevGsu === undefined || m.shutsu === null || m.shutsu === undefined) return;
      if (prevGsu >= p66) { highN += 1; if (isHitA(m.shutsu)) highHits += 1; }
      else if (prevGsu <= p33) { lowN += 1; if (isHitA(m.shutsu)) lowHits += 1; }
    });
  }
  return {
    高: highN >= 15 ? { winRate: highHits / highN, sampleSize: highN } : null,
    低: lowN >= 15 ? { winRate: lowHits / lowN, sampleSize: lowN } : null,
  };
}
// per-machine check: was MY OWN yesterday's G数 high or low? if so, the
// page-wide bucket stats apply today
function checkTrailingGsuLevelToday(gsuLevelStats, seriesWithShutsu, pageGsuPercentiles) {
  if (!gsuLevelStats || !pageGsuPercentiles) return null;
  const lastGsu = seriesWithShutsu[seriesWithShutsu.length - 1].gsu;
  if (lastGsu === null || lastGsu === undefined) return null;
  const { p33, p66 } = pageGsuPercentiles;
  if (lastGsu >= p66 && gsuLevelStats.高) return { level: "大量回転", ...gsuLevelStats.高 };
  if (lastGsu <= p33 && gsuLevelStats.低) return { level: "低調", ...gsuLevelStats.低 };
  return null;
}

// v6.20: 【Xターゲット版】前日、同じページの他の台の▲率が高かった/低
// かった → 翌日の自分のXが高くなるか。実データ検証（会話履歴参照）で、
// 好調(▲率50%+)は+0.058、不調(▲率10%以下)は+0.027（不調側はXでは向きが
// 弱いので採用せず、好調側だけ本採用）。
function computePageMateGoodStatsX(pageSortedHistory, pageXByDate) {
  let n = 0, xSum = 0;
  for (let i = 1; i < pageSortedHistory.length; i++) {
    const prevDay = pageSortedHistory[i - 1];
    const curDay = pageSortedHistory[i];
    const prevValid = prevDay.machines.filter((m) => m.shutsu !== null && m.shutsu !== undefined);
    if (prevValid.length < 3) continue;
    const prevHitRate = prevValid.filter((m) => isHitA(m.shutsu)).length / prevValid.length;
    if (prevHitRate < 0.5) continue; // only the "good page day" bucket
    curDay.machines.forEach((m) => {
      const x = (pageXByDate[curDay.date] || {})[m.no];
      if (x === null || x === undefined) return;
      n += 1; xSum += x;
    });
  }
  return n >= 15 ? { avgX: xSum / n, sampleSize: n } : null;
}
function checkPageMateGoodTodayX(stats, pageHistoryByDate, lastDate, no) {
  if (!stats) return null;
  const lastDayRec = pageHistoryByDate[lastDate];
  if (!lastDayRec) return null;
  const lastMates = lastDayRec.machines.filter((m) => m.no !== no && m.shutsu !== null && m.shutsu !== undefined);
  if (lastMates.length < 3) return null;
  const lastMateHitRate = lastMates.filter((m) => isHitA(m.shutsu)).length / lastMates.length;
  if (lastMateHitRate < 0.5) return null;
  return stats;
}

// v6.20: 【Xターゲット版】前日の自分自身のG数水準（大量回転/低調）→
// 翌日のXが高くなるか。実データ検証：低調→-0.025、大量回転→+0.023。
function computeTrailingGsuLevelStatsX(pageSortedHistory, pageGsuPercentiles, pageXByDate) {
  if (!pageGsuPercentiles) return null;
  const { p33, p66 } = pageGsuPercentiles;
  let highN = 0, highXSum = 0, lowN = 0, lowXSum = 0;
  for (let i = 1; i < pageSortedHistory.length; i++) {
    const prevDay = pageSortedHistory[i - 1];
    const curDay = pageSortedHistory[i];
    const prevByNo = new Map(prevDay.machines.map((m) => [m.no, m.gsu]));
    curDay.machines.forEach((m) => {
      const prevGsu = prevByNo.get(m.no);
      const x = (pageXByDate[curDay.date] || {})[m.no];
      if (prevGsu === null || prevGsu === undefined || x === null || x === undefined) return;
      if (prevGsu >= p66) { highN += 1; highXSum += x; }
      else if (prevGsu <= p33) { lowN += 1; lowXSum += x; }
    });
  }
  return {
    高: highN >= 15 ? { avgX: highXSum / highN, sampleSize: highN } : null,
    低: lowN >= 15 ? { avgX: lowXSum / lowN, sampleSize: lowN } : null,
  };
}
function checkTrailingGsuLevelTodayX(gsuLevelStatsX, seriesWithShutsu, pageGsuPercentiles) {
  if (!gsuLevelStatsX || !pageGsuPercentiles) return null;
  const lastGsu = seriesWithShutsu[seriesWithShutsu.length - 1].gsu;
  if (lastGsu === null || lastGsu === undefined) return null;
  const { p33, p66 } = pageGsuPercentiles;
  if (lastGsu >= p66 && gsuLevelStatsX.高) return { level: "大量回転", ...gsuLevelStatsX.高 };
  if (lastGsu <= p33 && gsuLevelStatsX.低) return { level: "低調", ...gsuLevelStatsX.低 };
  return null;
}

// v6.10: 設定期待度（predicted X）予想エンジン。実データ検証で確認した
// 5つの条件（台番号固定の実績・日付末尾・イベント・前日の他の台の不調・
// 前日のG数水準）を使い、翌日のXがどれくらい高くなりそうかを予想する。
// ▲ベースのcomputeSignalsForPageとは完全に別系統・別スコア（合算しない）。
function computeSettingExpectationForPage(machineNumbers, pageSortedHistory, pageHistoryByDate, dateEventMapParam, xByDateParam) {
  // v6.14: xByDateはページ単位で1回計算すれば十分（Xグリッド表示と
  // ここで別々に計算していたのが無駄だったため、呼び出し側で共有する）
  const xByDate = xByDateParam || computeXForPage(pageSortedHistory);
  // page全体のXの平均（このページの基準値）
  let allXCount = 0, allXSum = 0;
  Object.values(xByDate).forEach((dayMap) => {
    Object.values(dayMap).forEach((x) => { if (x !== null) { allXCount += 1; allXSum += x; } });
  });
  const pageBaseX = allXCount > 0 ? allXSum / allXCount : 0;
  const referenceDate = pageSortedHistory.length > 0 ? pageSortedHistory[pageSortedHistory.length - 1].date : null;
  if (!referenceDate) return [];
  const tomorrowDate = addDays(referenceDate, 1);

  // v6.14: 台番号ごとの.find()呼び出しを毎回繰り返すと機種数×日数の
  // 二乗オーダーになって重い（スマホでの動作が重いという指摘への対策）。
  // 日付ごとのgsuルックアップ・Xの合計/件数を先に1回だけ作っておく。
  const gsuByDateNo = {}; // {date: {no: gsu}}
  const xSumByDate = {}; // {date: {sum, count}}
  pageSortedHistory.forEach((h) => {
    gsuByDateNo[h.date] = {};
    let sum = 0, count = 0;
    h.machines.forEach((m) => {
      gsuByDateNo[h.date][m.no] = m.gsu ?? null;
      const x = (xByDate[h.date] || {})[m.no];
      if (x !== null && x !== undefined) { sum += x; count += 1; }
    });
    xSumByDate[h.date] = { sum, count };
  });

  // 前日のページ全体の様子（他の台のXの平均）は全台共通なので1回だけ計算
  const lastDayMap = xByDate[referenceDate] || {};
  const lastDayXVals = Object.values(lastDayMap).filter((v) => v !== null);
  const lastDayXAvg = lastDayXVals.length >= 2 ? lastDayXVals.reduce((a, v) => a + v, 0) / lastDayXVals.length : null;

  // 前日のG数パーセンタイル（ページ全体）
  const gsuVals = [];
  pageSortedHistory.forEach((h) => h.machines.forEach((m) => { if (m.gsu !== null && m.gsu !== undefined) gsuVals.push(m.gsu); }));
  gsuVals.sort((a, b) => a - b);
  const p33 = gsuVals.length >= 10 ? gsuVals[Math.floor(gsuVals.length / 3)] : null;
  const p66 = gsuVals.length >= 10 ? gsuVals[Math.floor((2 * gsuVals.length) / 3)] : null;

  const results = [];
  machineNumbers.forEach((no) => {
    // この台のX系列（日付順）— gsuByDateNoのルックアップ表を使うので.find()不要
    const xSeries = pageSortedHistory
      .map((h) => ({ date: h.date, x: (xByDate[h.date] || {})[no] ?? null, gsu: gsuByDateNo[h.date][no] ?? null }))
      .filter((r) => r.x !== null);
    if (xSeries.length === 0) return;

    const items = []; // { label, diff, sampleSize } — diffはXの単位（baseとの差）

    // ①台番号固定の実績（own trailing X average, リーク無し）
    if (xSeries.length >= 10) {
      const ownAvg = xSeries.reduce((a, r) => a + r.x, 0) / xSeries.length;
      items.push({ label: "台番号固定の実績", diff: ownAvg - pageBaseX, sampleSize: xSeries.length });
    }

    // ②日付末尾（この台の過去、翌日と同じ末尾の日のXが高い/低いか）
    const tomorrowDigit = parseInt(tomorrowDate.slice(-2), 10) % 10;
    const digitVals = xSeries.filter((r) => parseInt(r.date.slice(-2), 10) % 10 === tomorrowDigit).map((r) => r.x);
    if (digitVals.length >= 5) {
      const digitAvg = digitVals.reduce((a, v) => a + v, 0) / digitVals.length;
      items.push({ label: `日付末尾=${tomorrowDigit}`, diff: digitAvg - pageBaseX, sampleSize: digitVals.length });
    }

    // ③イベント（明日登録されているイベント名の、過去のX平均）
    const tomorrowEventNames = splitEventNames(dateEventMapParam[tomorrowDate] || "");
    tomorrowEventNames.forEach((name) => {
      const matchVals = pageSortedHistory
        .filter((h) => h.event && splitEventNames(h.event).includes(name))
        .map((h) => (xByDate[h.date] || {})[no])
        .filter((v) => v !== null && v !== undefined);
      if (matchVals.length >= 5) {
        const avg = matchVals.reduce((a, v) => a + v, 0) / matchVals.length;
        items.push({ label: `イベント「${name}」`, diff: avg - pageBaseX, sampleSize: matchVals.length });
      }
    });

    // ④前日、同じページの他の台のXが低かった — xSumByDateのO(1)ルックアップ
    // で「他の台の平均」を出す（Object.entries+filterを毎台繰り返さない）
    if (lastDayXAvg !== null && lastDayXAvg <= -0.3) {
      const followVals = [];
      for (let i = 1; i < pageSortedHistory.length; i++) {
        const prevDate = pageSortedHistory[i - 1].date;
        const daySum = xSumByDate[prevDate];
        const myPrevX = (xByDate[prevDate] || {})[no];
        if (!daySum || myPrevX === null || myPrevX === undefined) continue;
        const mateCount = daySum.count - 1;
        if (mateCount < 2) continue;
        const mateAvg = (daySum.sum - myPrevX) / mateCount;
        if (mateAvg > -0.3) continue;
        const myX = (xByDate[pageSortedHistory[i].date] || {})[no];
        if (myX !== null && myX !== undefined) followVals.push(myX);
      }
      if (followVals.length >= 15) {
        const avg = followVals.reduce((a, v) => a + v, 0) / followVals.length;
        items.push({ label: "前日、他の台が不調", diff: avg - pageBaseX, sampleSize: followVals.length });
      }
    }

    // ⑤前日のG数水準（大量回転/低調）— gsuByDateNoのルックアップ表を使う
    if (p33 !== null && p66 !== null) {
      const lastGsu = xSeries.length > 0 ? xSeries[xSeries.length - 1].gsu : null;
      if (lastGsu !== null) {
        const level = lastGsu >= p66 ? "high" : lastGsu <= p33 ? "low" : null;
        if (level) {
          const followVals = [];
          for (let i = 1; i < pageSortedHistory.length; i++) {
            const prevGsu = gsuByDateNo[pageSortedHistory[i - 1].date][no];
            if (prevGsu === null || prevGsu === undefined) continue;
            const prevLevel = prevGsu >= p66 ? "high" : prevGsu <= p33 ? "low" : null;
            if (prevLevel !== level) continue;
            const myX = (xByDate[pageSortedHistory[i].date] || {})[no];
            if (myX !== null && myX !== undefined) followVals.push(myX);
          }
          if (followVals.length >= 15) {
            const avg = followVals.reduce((a, v) => a + v, 0) / followVals.length;
            items.push({ label: `前日のG数水準（${level === "high" ? "大量回転" : "低調"}）`, diff: avg - pageBaseX, sampleSize: followVals.length });
          }
        }
      }
    }

    if (items.length === 0) return;

    // 各項目のdiffをサンプル数で重み付けして全部足し合わせる（複数の
    // 条件が同時に当てはまるほど期待度が上がる、既存のtieBreaker方式と
    // 同じ考え方）
    const totalDelta = items.reduce((a, it) => a + it.diff * sampleWeight(it.sampleSize), 0);
    const finalPredictedX = pageBaseX + totalDelta;
    const label = finalPredictedX >= pageBaseX + 0.1 ? "高" : finalPredictedX <= pageBaseX - 0.1 ? "低" : "中";

    results.push({ no, predictedX: finalPredictedX, label, items, matchCount: items.length });
  });

  results.sort((a, b) => b.predictedX - a.predictedX);
  return results;
}

function computeDailySettingFlags(pageSortedHistory) {
  const perDateFlags = {};
  pageSortedHistory.forEach((h) => {
    const gsuVals = h.machines.map((m) => m.gsu).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    const dayFlags = {};
    if (gsuVals.length >= 5) {
      const pctOf = (v) => {
        if (v === null || v === undefined) return null;
        let count = 0;
        for (const x of gsuVals) if (x <= v) count += 1;
        return count / gsuVals.length;
      };
      h.machines.forEach((m) => {
        const pct = pctOf(m.gsu);
        if (pct === null || m.sada === null) {
          dayFlags[m.no] = null;
        } else if (pct >= 0.75 && m.sada >= -1000) {
          dayFlags[m.no] = "good";
        } else if (pct <= 0.25 && m.sada > 0) {
          dayFlags[m.no] = "low";
        } else {
          dayFlags[m.no] = null;
        }
      });
    }
    perDateFlags[h.date] = dayFlags;
  });
  return perDateFlags;
}

// does yesterday's "suspected good/low setting" flag predict today's result?
function evaluateSuspectedSettingFollow(seriesFull, flagByDate) {
  const goodVals = [];
  const lowVals = [];
  for (let i = 0; i < seriesFull.length - 1; i++) {
    const flag = flagByDate.get(seriesFull[i].date);
    const next = seriesFull[i + 1].sada;
    if (next === null || next === undefined) continue;
    if (flag === "good") goodVals.push(next);
    if (flag === "low") lowVals.push(next);
  }
  function summarize(arr) {
    if (arr.length < 3) return null;
    const wins = arr.filter((v) => v > 0).length;
    return { sampleSize: arr.length, winRate: wins / arr.length, avg: arr.reduce((a, b) => a + b, 0) / arr.length };
  }
  return { good: summarize(goodVals), low: summarize(lowVals) };
}

// On a categorical date axis, a single day has zero width, so widen it by
// one neighboring day so the hatched band is actually visible.
function getBandRange(dateList, date) {
  const idx = dateList.indexOf(date);
  if (idx === -1) return null;
  if (idx < dateList.length - 1) return { x1: date, x2: dateList[idx + 1] };
  if (idx > 0) return { x1: dateList[idx - 1], x2: date };
  return { x1: date, x2: date };
}

export default function SlotDataTracker() {
  // ---- pages (機種) ----
  const [pages, setPages] = useState([]);
  const [pagesLoaded, setPagesLoaded] = useState(false);
  const [activePageId, setActivePageId] = useState(null);
  const [pageHistories, setPageHistories] = useState({});
  const [confirmDeletePage, setConfirmDeletePage] = useState(null);
  const loadedHistoryRef = useRef(new Set());

  // ---- top-level tab: a normal 機種 page, or the shared "共通設定" tab ----
  const [viewMode, setViewMode] = useState("page"); // "page" | "common"

  // ---- recommended-model periods (page-scoped, since a page = one 機種) ----
  // managed from the 共通設定 tab via a dropdown, so pages don't need their
  // own copy of this UI — but the data itself still lives per page
  const [pageRecommends, setPageRecommends] = useState({});
  const loadedRecommendRef = useRef(new Set());
  const [recommendTargetPageId, setRecommendTargetPageId] = useState(null);
  const [recommendStart, setRecommendStart] = useState(todayStr());
  const [recommendEnd, setRecommendEnd] = useState(todayStr());
  const [recommendLabel, setRecommendLabel] = useState("");
  const [recommendStatus, setRecommendStatus] = useState(null);

  // ---- おすすめ機種期間, keyed by MODEL NAME instead of page — for models
  // in 全体データ (機種別サマリー) that aren't necessarily one of the
  // tracked pages. a tracked page whose 正式名称 matches a name here will
  // also see these periods in its own daily pickup. ----
  const [overallRecommends, setOverallRecommends] = useState({});
  const [overallRecommendModelName, setOverallRecommendModelName] = useState("");
  const [overallRecommendStart, setOverallRecommendStart] = useState(todayStr());
  const [overallRecommendEnd, setOverallRecommendEnd] = useState(todayStr());
  const [overallRecommendLabel, setOverallRecommendLabel] = useState("");
  const [overallRecommendStatus, setOverallRecommendStatus] = useState(null);

  // ---- 全体データ: イベントを選択して過去を見る / 機種を選択して過去一覧を見る ----
  const [eventHistorySelection, setEventHistorySelection] = useState("");
  const [overallGridEventFilter, setOverallGridEventFilter] = useState([]);
  const [pageGridEventFilter, setPageGridEventFilter] = useState([]);
  const [modelHistorySelection, setModelHistorySelection] = useState("");
  const [modelHistoryEventFilter, setModelHistoryEventFilter] = useState("");

  // ---- global event registries ----
  const [eventNames, setEventNames] = useState([]);
  const [strongEvents, setStrongEvents] = useState([]); // [{name,color}] - matched by event NAME, not a specific date
  const [strongName, setStrongName] = useState("");
  const [strongStatus, setStrongStatus] = useState(null);

  // ---- 準イベント (semi events): a third, weaker tier — 強いイベント ＞ イベント ＞ 準イベント ----
  const [semiEvents, setSemiEvents] = useState([]); // [{name,color}]
  const [semiName, setSemiName] = useState("");
  const [semiStatus, setSemiStatus] = useState(null);

  // ---- closed days (global, shared across all pages) ----
  const [closedDays, setClosedDays] = useState([]); // [{date}]
  const [closedDate, setClosedDate] = useState(todayStr());
  const [closedStatus, setClosedStatus] = useState(null);

  // ---- date -> event name (global, shared across all pages, so an event
  // typed while entering one page's data auto-fills for the same date on
  // every other page, even after a reload / on another device) ----
  const [dateEventMap, setDateEventMap] = useState({});

  // ---- future events (pre-register a date's event before that day's data exists) ----
  const [futureEventDate, setFutureEventDate] = useState(addDays(todayStr(), 1));
  const [futureEventName, setFutureEventName] = useState("");
  const [futureEventStatus, setFutureEventStatus] = useState(null);

  // ---- store-wide overall summary (機種別サマリー + 末尾別データ), global,
  //      irregular entries, one snapshot per date ----
  const [overallSummaries, setOverallSummaries] = useState([]); // [{date,event,modelRows,digitRows}]
  const [overallSummariesLoaded, setOverallSummariesLoaded] = useState(false);
  const [overallDate, setOverallDate] = useState(todayStr());
  const [overallPasteText, setOverallPasteText] = useState("");
  const [overallStatus, setOverallStatus] = useState(null);
  const [confirmDeleteOverall, setConfirmDeleteOverall] = useState(null);
  const [confirmDeleteAllOverall, setConfirmDeleteAllOverall] = useState(false);
  // v6.9.14: one-time repair tool for the バラエティ（1台設置機種）misparse
  // bug (fixed in v6.9.13, see parseSummaryTable)
  const [varietyRepairPreview, setVarietyRepairPreview] = useState(null); // { fixCandidates: [...], deleteCandidates: [...] } | null if not scanned yet
  const [varietyRepairDone, setVarietyRepairDone] = useState(false);

  // ---- undo history: snapshots taken right before a destructive action,
  //      so any reset/delete can be reversed with one click. shown as a
  //      fixed panel regardless of which tab/page is currently open ----
  const [undoHistory, setUndoHistory] = useState([]);
  const [undoHistoryLoaded, setUndoHistoryLoaded] = useState(false);
  const [undoPanelOpen, setUndoPanelOpen] = useState(false);

  // ---- per-page form / view state ----
  // v6.7: 台データ入力（表貼り付け形式）を廃止（アナスロに一本化）に伴い、
  // pasteText/entryDate は削除。以下 status/selectedMachines/range 等は
  // 登録済み日付一覧の削除・リセット操作やグラフ表示に引き続き使うので残す
  const [status, setStatus] = useState(null);
  const [selectedMachines, setSelectedMachines] = useState([]);
  const [officialNameInput, setOfficialNameInput] = useState(""); // v6.8.1: text currently being typed to add a new bundled 機種名
  const [range, setRange] = useState(30);

  // ---- アナスロ（店全体・全機種・台番号単位の一括表）----
  const [rawFullTable, setRawFullTable] = useState({}); // { [date]: [{modelName,no,gsu,sada,shutsu,bb,rb,gousei,bbRateStr,rbRateStr}] }
  // v6.7: kept in lockstep with rawFullTable so handleSaveFullTable can read
  // the up-to-the-millisecond merged state even when saving several dates
  // back-to-back faster than React re-renders — reading from the ref
  // instead of the closed-over state is what avoids a lost-update bug
  // where the middle date of several rapid saves disappears.
  const rawFullTableRef = useRef({});
  const rawFullTableWeekWriteQueueRef = useRef({}); // weekKey -> queue promise, so two saves for the same week never race
  const rawFullTableIndexRef = useRef([]); // current known list of dates, kept in lockstep with storage
  const rawFullTableIndexWriteQueueRef = useRef(Promise.resolve()); // single queue, since there's only one index key
  const [rawFullTableLoaded, setRawFullTableLoaded] = useState(false);
  const [rawFullTableStatus, setRawFullTableStatus] = useState(null);
  const [fullTableDate, setFullTableDate] = useState(todayStr());
  const [fullTablePasteText, setFullTablePasteText] = useState("");
  const [fullTableStatus, setFullTableStatus] = useState(null);
  const [fullTableDuplicateWarning, setFullTableDuplicateWarning] = useState(null); // { conflictingDate } | null
  const [fullTableDuplicateCheckResults, setFullTableDuplicateCheckResults] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDeleteDate, setConfirmDeleteDate] = useState(null);
  const [dateListOpen, setDateListOpen] = useState(true);
  const [useCustomRange, setUseCustomRange] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [luckyDigit, setLuckyDigit] = useState(null);
  const [analysisWindow, setAnalysisWindow] = useState(10);

  // ---- PIN lock for the data-entry panels (session-only, never persisted) ----
  const UNLOCK_PIN = "5246";
  const [unlocked, setUnlocked] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(false);

  // ---- day-detail viewer ----
  const [viewDate, setViewDate] = useState(todayStr());
  const [viewWindow, setViewWindow] = useState(7);

  // ---- load pages + global registries on mount ----
  useEffect(() => {
    (async () => {
      let loadedPages = null;
      try {
        const res = await storage.get(PAGES_KEY, false);
        if (res && res.value) loadedPages = JSON.parse(res.value);
      } catch (e) {
        // no pages saved yet
      }
      if (!Array.isArray(loadedPages) || loadedPages.length === 0) {
        loadedPages = Array.from({ length: 4 }).map((_, i) => ({
          id: `page-${i + 1}`,
          name: "",
        }));
        try {
          await storage.set(PAGES_KEY, JSON.stringify(loadedPages), false);
        } catch (e) {
          // ignore
        }
      }
      setPages(loadedPages);
      setActivePageId(loadedPages[0].id);
      setPagesLoaded(true);

      try {
        const r2 = await storage.get(EVENT_NAMES_KEY, false);
        if (r2 && r2.value) setEventNames(JSON.parse(r2.value));
      } catch (e) {
        // none yet
      }
      try {
        const r3 = await storage.get(STRONG_EVENTS_KEY, false);
        if (r3 && r3.value) {
          const raw = JSON.parse(r3.value);
          if (Array.isArray(raw)) {
            // migrate old {date,name,color} records -> unique-by-name {name,color}
            const byName = {};
            raw.forEach((item) => {
              const name = (item.name || "").trim();
              if (!name) return;
              if (!byName[name]) byName[name] = { name, color: item.color || STRONG_COLORS[0] };
            });
            setStrongEvents(Object.values(byName));
          }
        }
      } catch (e) {
        // none yet
      }
      try {
        const rSemi = await storage.get(SEMI_EVENTS_KEY, false);
        if (rSemi && rSemi.value) {
          const raw = JSON.parse(rSemi.value);
          if (Array.isArray(raw)) setSemiEvents(raw);
        }
      } catch (e) {
        // none yet
      }
      try {
        const rOverallRec = await storage.get(OVERALL_RECOMMEND_KEY, false);
        if (rOverallRec && rOverallRec.value) {
          const raw = JSON.parse(rOverallRec.value);
          if (raw && typeof raw === "object") setOverallRecommends(raw);
        }
      } catch (e) {
        // none yet
      }
      try {
        const r4 = await storage.get(CLOSED_DAYS_KEY, false);
        if (r4 && r4.value) setClosedDays(JSON.parse(r4.value));
      } catch (e) {
        // none yet
      }
      try {
        const r5 = await storage.get(DATE_EVENT_MAP_KEY, false);
        if (r5 && r5.value) setDateEventMap(JSON.parse(r5.value));
      } catch (e) {
        // none yet
      }
      try {
        const r6 = await storage.get(OVERALL_SUMMARY_KEY, false);
        if (r6 && r6.value) {
          const val = JSON.parse(r6.value);
          if (Array.isArray(val)) setOverallSummaries(val);
        }
      } catch (e) {
        // none yet
      } finally {
        setOverallSummariesLoaded(true);
      }
      // v6.7: アナスロ — read the index first (list of dates that have
      // data), compute which WEEK keys those dates fall into, then fetch
      // only those weeks (far fewer requests than one per date)
      try {
        let knownDates = [];
        try {
          const idx = await storage.get(RAW_FULLTABLE_INDEX_KEY, false);
          if (idx && idx.value) {
            const parsed = JSON.parse(idx.value);
            if (Array.isArray(parsed)) knownDates = parsed;
          }
        } catch (e) {
          setRawFullTableStatus({ type: "error", msg: `アナスロの索引の読み込みに失敗しました：${e && e.message ? e.message : "不明なエラー"}` });
        }
        const next = {};
        if (knownDates.length > 0) {
          const weekKeys = Array.from(new Set(knownDates.map((d) => rawFullTableWeekKey(d))));
          const results = await Promise.all(
            weekKeys.map(async (key) => {
              try {
                const r = await storage.get(key, false);
                if (!r || !r.value) return { key, ok: true, data: null };
                return { key, ok: true, data: JSON.parse(r.value) };
              } catch (e) {
                return { key, ok: false };
              }
            })
          );
          const failedKeys = [];
          results.forEach((r) => {
            if (!r.ok) {
              failedKeys.push(r.key);
              return;
            }
            if (r.data && typeof r.data === "object") Object.assign(next, r.data);
          });
          if (failedKeys.length > 0) {
            setRawFullTableStatus({ type: "error", msg: `アナスロの一部データ（${failedKeys.join(", ")}）の読み込みに失敗しました。ページを再読み込みしてみてください。` });
          }
        }
        rawFullTableIndexRef.current = Object.keys(next).sort();
        rawFullTableRef.current = next;
        setRawFullTable(next);
      } catch (e) {
        setRawFullTableStatus({ type: "error", msg: `アナスロの生データ読み込み中に予期しないエラーが発生しました：${e && e.message ? e.message : "不明なエラー"}` });
      } finally {
        setRawFullTableLoaded(true);
      }
      try {
        const r7 = await storage.get(UNDO_HISTORY_KEY, false);
        if (r7 && r7.value) {
          const val = JSON.parse(r7.value);
          if (Array.isArray(val)) setUndoHistory(val);
        }
      } catch (e) {
        // none yet
      } finally {
        setUndoHistoryLoaded(true);
      }
    })();
  }, []);

  // ---- lazy-load history for whichever page becomes active ----
  useEffect(() => {
    if (!activePageId) return;
    if (loadedHistoryRef.current.has(activePageId)) return;
    loadedHistoryRef.current.add(activePageId);
    (async () => {
      try {
        const res = await storage.get(historyKey(activePageId), false);
        const val = res && res.value ? JSON.parse(res.value) : [];
        setPageHistories((prev) => ({ ...prev, [activePageId]: Array.isArray(val) ? val : [] }));
      } catch (e) {
        setPageHistories((prev) => ({ ...prev, [activePageId]: [] }));
      }
    })();
  }, [activePageId]);

  // ---- also eagerly load every OTHER page's history in the background, so
  //      the hall-wide combined ranking works even for tabs you haven't
  //      visited yet this session ----
  useEffect(() => {
    pages.forEach((p) => {
      if (loadedHistoryRef.current.has(p.id)) return;
      loadedHistoryRef.current.add(p.id);
      (async () => {
        try {
          const res = await storage.get(historyKey(p.id), false);
          const val = res && res.value ? JSON.parse(res.value) : [];
          setPageHistories((prev) => ({ ...prev, [p.id]: Array.isArray(val) ? val : [] }));
        } catch (e) {
          setPageHistories((prev) => ({ ...prev, [p.id]: [] }));
        }
      })();
    });
  }, [pages]);

  // ---- lazy-load recommended-model periods for every page, so the shared
  //      共通設定 tab's machine dropdown works regardless of which 機種 tab
  //      is currently active ----
  useEffect(() => {
    pages.forEach((p) => {
      if (loadedRecommendRef.current.has(p.id)) return;
      loadedRecommendRef.current.add(p.id);
      (async () => {
        try {
          const res = await storage.get(recommendKey(p.id), false);
          const val = res && res.value ? JSON.parse(res.value) : [];
          setPageRecommends((prev) => ({ ...prev, [p.id]: Array.isArray(val) ? val : [] }));
        } catch (e) {
          setPageRecommends((prev) => ({ ...prev, [p.id]: [] }));
        }
      })();
    });
    if (!recommendTargetPageId && pages.length > 0) {
      setRecommendTargetPageId(pages[0].id);
    }
  }, [pages, recommendTargetPageId]);

  // ---- reset ephemeral per-page UI state when switching pages ----
  useEffect(() => {
    setSelectedMachines([]);
    setStatus(null);
    setConfirmDeleteDate(null);
    setOfficialNameInput("");
  }, [activePageId]);

  const persistPages = useCallback(async (next) => {
    setPages(next);
    try {
      await storage.set(PAGES_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistPageHistory = useCallback(async (pageId, next) => {
    setPageHistories((prev) => ({ ...prev, [pageId]: next }));
    try {
      const res = await storage.set(historyKey(pageId), JSON.stringify(next), false);
      if (!res) setStatus({ type: "error", msg: "保存に失敗しました。もう一度お試しください。" });
    } catch (e) {
      setStatus({ type: "error", msg: "保存中にエラーが発生しました。" });
    }
  }, []);

  // v6.7: 新しいページ登録・正式名称の設定/変更のたびに呼ばれ、アナスロに
  // すでに貯まっている過去日について、その正式名称に一致する機種名の行を
  // このページの pageHistories に反映する。
  // v6.8.2: 「日付がすでにある＝何もしない」ではなく、「その日にまだ入って
  // いない台（機種）だけを追加マージする」に修正。以前の実装だと、単一
  // 機種ページとしてすでに何十日分もデータが溜まっている状態で、あとから
  // 正式名称に別の機種を追加しても（理由Aタイプへの束ね直し）、既存の
  // 日付には新しく追加した機種のデータが一切反映されないバグがあった
  // （byDate.has(date)で即returnしていたため）。
  // これで台データ入力を廃止しても、各ページのグラフ・ピックアップ・
  // マトリクス表は今まで通り pageHistories を見るだけで動く。
  const backfillPageFromRawTable = useCallback(
    async (pageId, officialName) => {
      if (!officialName) return;
      const nameList = splitModelNameList(officialName); // v6.8: supports "サンダーV、アレックスV、..." bundles
      if (nameList.length === 0) return;
      const dates = Object.keys(rawFullTableRef.current).sort();
      if (dates.length === 0) return;
      const existingHistory = pageHistories[pageId] || [];
      const byDate = new Map(existingHistory.map((h) => [h.date, h]));
      let changed = false;
      dates.forEach((date) => {
        const rows = rawFullTableRef.current[date] || [];
        const matched = rows.filter((r) => nameList.some((n) => modelNamesMatch(r.modelName, n)));
        if (matched.length === 0) return;
        const existingEntry = byDate.get(date);
        const existingNos = existingEntry ? new Set(existingEntry.machines.map((m) => m.no)) : new Set();
        const newMachines = matched
          .filter((r) => !existingNos.has(r.no)) // don't touch machines already present for this date
          .map((r) => ({
            no: r.no,
            modelName: r.modelName, // v6.8: kept so multi-機種ページ can show which model each 台番号 belongs to
            sada: r.sada,
            gsu: r.gsu,
            shutsu: r.shutsu,
            bb: r.bb,
            rb: r.rb,
            gousei: r.gousei,
            bbRateStr: r.bbRateStr,
            rbRateStr: r.rbRateStr,
          }));
        if (newMachines.length === 0) return; // this date already has everything that matches
        if (existingEntry) {
          byDate.set(date, { ...existingEntry, machines: [...existingEntry.machines, ...newMachines] });
        } else {
          const autoEvent = (dateEventMap[date] || "").trim();
          byDate.set(date, { date, event: autoEvent, machines: newMachines });
        }
        changed = true;
      });
      if (!changed) return;
      const next = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
      await persistPageHistory(pageId, next);
    },
    [pageHistories, dateEventMap, persistPageHistory]
  );

  async function handleDeleteFullTableDate(date) {
    const nextRaw = { ...rawFullTableRef.current };
    delete nextRaw[date];
    rawFullTableRef.current = nextRaw;
    setRawFullTable(nextRaw);
    const weekKey = rawFullTableWeekKey(date);
    const previousWeekWrite = rawFullTableWeekWriteQueueRef.current[weekKey] || Promise.resolve();
    const thisWeekWrite = previousWeekWrite.then(async () => {
      const weekStart = weekStartOf(date);
      const bucket = {};
      Object.keys(rawFullTableRef.current).forEach((d) => {
        if (weekStartOf(d) === weekStart) bucket[d] = rawFullTableRef.current[d];
      });
      if (Object.keys(bucket).length === 0) {
        return storage.delete(weekKey, false);
      }
      return storage.set(weekKey, JSON.stringify(bucket), false);
    });
    rawFullTableWeekWriteQueueRef.current[weekKey] = thisWeekWrite.catch(() => null);
    try {
      await thisWeekWrite;
    } catch (e) {
      // storage write failing isn't fatal here — the in-memory state above
      // already reflects the removal; next full reload will just re-fetch
      // whatever's actually still in storage
    }
    rawFullTableIndexRef.current = rawFullTableIndexRef.current.filter((d) => d !== date);
    try {
      await storage.set(RAW_FULLTABLE_INDEX_KEY, JSON.stringify(rawFullTableIndexRef.current), false);
    } catch (e) {
      // if this fails, next load's reconciliation will self-correct
    }
    setConfirmDeleteOverall(null);
  }

  // clicking an already-registered date reloads it into the paste box so a
  // typo can be fixed and re-saved; also used by the 民レポ date list so
  // clicking a date jumps アナスロ's own panel to it too
  const loadFullTableForDate = useCallback(
    (date) => {
      setFullTableDate(date);
      const existing = rawFullTable[date];
      if (existing && existing.length > 0) {
        setFullTablePasteText(serializeFullStoreRows(existing));
        setFullTableStatus({ type: "ok", msg: `${date} は登録済み（${existing.length}台分）です。編集用に読み込みました。` });
      } else {
        setFullTablePasteText("");
        setFullTableStatus(null);
      }
    },
    [rawFullTable]
  );

  // scans every currently-known アナスロ date against every other one and
  // reports any pairs whose content is identical — a retroactive version of
  // the same accidental-copy-paste check done on every new save
  const handleCheckFullTableDuplicates = useCallback(() => {
    const entries = Object.entries(rawFullTableRef.current);
    const fingerprints = entries.map(([date, rows]) => [date, fingerprintFullTableRows(rows)]);
    const pairs = [];
    for (let i = 0; i < fingerprints.length; i++) {
      for (let j = i + 1; j < fingerprints.length; j++) {
        if (fingerprints[i][1] === fingerprints[j][1]) {
          pairs.push([fingerprints[i][0], fingerprints[j][0]].sort());
        }
      }
    }
    setFullTableDuplicateCheckResults(pairs);
  }, []);

  const persistPageRecommends = useCallback(async (pageId, next) => {
    setPageRecommends((prev) => ({ ...prev, [pageId]: next }));
    try {
      await storage.set(recommendKey(pageId), JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistOverallRecommends = useCallback(async (next) => {
    setOverallRecommends(next);
    try {
      await storage.set(OVERALL_RECOMMEND_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistEventNames = useCallback(async (next) => {
    setEventNames(next);
    try {
      await storage.set(EVENT_NAMES_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistStrongEvents = useCallback(async (next) => {
    setStrongEvents(next);
    try {
      await storage.set(STRONG_EVENTS_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistSemiEvents = useCallback(async (next) => {
    setSemiEvents(next);
    try {
      await storage.set(SEMI_EVENTS_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistClosedDays = useCallback(async (next) => {
    setClosedDays(next);
    try {
      await storage.set(CLOSED_DAYS_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistDateEventMap = useCallback(async (next) => {
    setDateEventMap(next);
    try {
      await storage.set(DATE_EVENT_MAP_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistOverallSummaries = useCallback(async (next) => {
    setOverallSummaries(next);
    try {
      await storage.set(OVERALL_SUMMARY_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  // ---- undo history: call this with the CURRENT (about-to-be-overwritten)
  //      value right before any destructive write, so it can be restored
  //      with one click later. Shown in a fixed panel regardless of tab. ----
  const persistUndoHistory = useCallback(async (next) => {
    setUndoHistory(next);
    try {
      await storage.set(UNDO_HISTORY_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  function pushUndoEntry(label, storageKey, previousValue) {
    const entry = { id: `undo-${Date.now()}`, timestamp: Date.now(), label, storageKey, previousValue };
    const next = [entry, ...undoHistory].slice(0, 10);
    persistUndoHistory(next);
  }

  // maps a storage key back to the React state setter that mirrors it, so a
  // restored value shows up immediately without needing a page reload
  function applyRestoredValue(storageKey, value) {
    if (storageKey === PAGES_KEY) {
      setPages(value || []);
    } else if (storageKey === OVERALL_SUMMARY_KEY) {
      setOverallSummaries(value || []);
    } else if (storageKey === CLOSED_DAYS_KEY) {
      setClosedDays(value || []);
    } else if (storageKey === STRONG_EVENTS_KEY) {
      setStrongEvents(value || []);
    } else if (storageKey === SEMI_EVENTS_KEY) {
      setSemiEvents(value || []);
    } else if (storageKey === OVERALL_RECOMMEND_KEY) {
      setOverallRecommends(value || {});
    } else if (storageKey === DATE_EVENT_MAP_KEY) {
      setDateEventMap(value || {});
    } else if (storageKey.startsWith("slot-history-")) {
      const pageId = storageKey.slice("slot-history-".length);
      setPageHistories((prev) => ({ ...prev, [pageId]: value || [] }));
    } else if (storageKey.startsWith("slot-recommend-")) {
      const pageId = storageKey.slice("slot-recommend-".length);
      setPageRecommends((prev) => ({ ...prev, [pageId]: value || [] }));
    }
  }

  async function handleRestoreUndo(entry) {
    try {
      await storage.set(entry.storageKey, JSON.stringify(entry.previousValue), false);
    } catch (e) {
      // ignore, still update local state below so the user sees the restore
    }
    applyRestoredValue(entry.storageKey, entry.previousValue);
    persistUndoHistory(undoHistory.filter((h) => h.id !== entry.id));
  }

  function handleDismissUndoEntry(id) {
    persistUndoHistory(undoHistory.filter((h) => h.id !== id));
  }

  function handleSaveOverall() {
    if (!overallDate) {
      setOverallStatus({ type: "error", msg: "日付を入力してください。" });
      return;
    }
    const { modelRows, digitRows } = parseOverallSummary(overallPasteText);
    if (modelRows.length === 0 && digitRows.length === 0) {
      setOverallStatus({ type: "error", msg: "データを読み取れませんでした。表をそのまま貼り付けてください。" });
      return;
    }
    const eventForDate = (dateEventMap[overallDate] || "").trim();
    const next = [
      ...overallSummaries.filter((s) => s.date !== overallDate),
      { date: overallDate, event: eventForDate, modelRows, digitRows },
    ];
    persistOverallSummaries(next);
    setOverallStatus({
      type: "ok",
      msg: `${overallDate} のデータを保存しました（機種${modelRows.length}件・末尾${digitRows.length}件）。`,
    });
    setOverallPasteText("");
  }

  function handleDeleteOverall(date) {
    pushUndoEntry(`全体データ ${date} を削除`, OVERALL_SUMMARY_KEY, overallSummaries);
    persistOverallSummaries(overallSummaries.filter((s) => s.date !== date));
    setConfirmDeleteOverall(null);
  }

  // v6.8: clicking a past 登録済みの日付 reloads it into the edit textarea
  // instead of only offering delete
  function handleEditOverall(s) {
    setOverallDate(s.date);
    setOverallPasteText(serializeOverallSummary(s));
    setOverallStatus({ type: "ok", msg: `${s.date} のデータを編集用に読み込みました。修正して保存すると上書きされます。` });
  }

  function handleDeleteAllOverall() {
    pushUndoEntry("全体データを全部削除", OVERALL_SUMMARY_KEY, overallSummaries);
    persistOverallSummaries([]);
    setConfirmDeleteAllOverall(false);
  }

  // v6.9.14: one-time repair tool for the バラエティ（1台設置機種）
  // misparse bug (fixed in v6.9.13) — before the fix, those rows had
  // 台番号 saved into avgSada and the real 差枚 saved into avgGsu (真の
  // G数 was lost entirely, since it fell in the column the old parser
  // tried to read as a 勝率 fraction and failed). Detected by exactly that
  // failure signature: wins/total both null, which normal rows essentially
  // never have (a real machine's day always has *some* win/loss fraction).
  // Not name-based on purpose — the バラエティ lineup itself changes with
  // 新台入れ替え, so any fixed name list would go stale immediately.
  // v6.9.15: also detects a second, unrelated corruption from the same-era
  // bug — the "バラエティ（1台設置機種）" section-title LINE itself wasn't
  // recognized as a title before the fix, so it got glued onto the very
  // next line (that section's own header row) and saved as one garbage
  // "machine" entry (name literally containing both "バラエティ" and
  // "機種", every numeric field null since none of the header's own text
  // parses as a number). There's nothing real to recover from that one —
  // it's flagged for deletion, not repair.
  // v6.9.17: 差枚と出率が両方残っていれば、標準的な1G=3枚投入の計算式
  // （出率 = (G数×3+差枚) / (G数×3) × 100）を逆算して、消えたG数を高い
  // 精度で推定できる（実データで検証、ほとんどの機種で誤差1%未満。ただし
  // 出率が100%に近いほど、分母が小さくなり誤差が拡大するので注意）。
  function estimateGsuFromSadaAndShutsu(sada, shutsu) {
    if (sada === null || sada === undefined || shutsu === null || shutsu === undefined) return null;
    const denom = 3 * (shutsu / 100 - 1);
    if (denom === 0) return null; // exactly 100% shutsu — can't divide, no reliable estimate
    const estimate = sada / denom;
    if (!Number.isFinite(estimate) || estimate <= 0) return null;
    return Math.round(estimate);
  }

  function scanVarietyRepairCandidates() {
    const fixCandidates = [];
    const deleteCandidates = [];
    overallSummaries.forEach((s) => {
      (s.modelRows || []).forEach((r, idx) => {
        if (r.name && r.name.includes("バラエティ") && r.name.includes("機種")) {
          deleteCandidates.push({ date: s.date, rowIndex: idx, name: r.name });
          return;
        }
        if (r.wins === null && r.total === null && r.avgSada !== null && r.avgSada !== undefined) {
          const fixedAvgSada = r.avgGsu;
          fixCandidates.push({
            date: s.date,
            rowIndex: idx,
            name: r.name,
            oldAvgSada: r.avgSada, // was actually 台番号
            oldAvgGsu: r.avgGsu, // was actually 差枚
            fixedAvgSada, // recovered 差枚
            estimatedAvgGsu: estimateGsuFromSadaAndShutsu(fixedAvgSada, r.shutsu), // 推定G数（出率が100%付近だとnullのまま=推定できない）
          });
        }
      });
    });
    setVarietyRepairPreview({ fixCandidates, deleteCandidates });
  }

  function applyVarietyRepair() {
    if (!varietyRepairPreview) return;
    const { fixCandidates, deleteCandidates } = varietyRepairPreview;
    if (fixCandidates.length === 0 && deleteCandidates.length === 0) return;
    pushUndoEntry("バラエティ機種の差枚を修復", OVERALL_SUMMARY_KEY, overallSummaries);
    const fixByDate = {};
    fixCandidates.forEach((c) => {
      if (!fixByDate[c.date]) fixByDate[c.date] = new Map();
      fixByDate[c.date].set(c.rowIndex, c.estimatedAvgGsu);
    });
    const deleteByDate = {};
    deleteCandidates.forEach((c) => {
      if (!deleteByDate[c.date]) deleteByDate[c.date] = new Set();
      deleteByDate[c.date].add(c.rowIndex);
    });
    const nextSummaries = overallSummaries.map((s) => {
      const rowIndicesToFix = fixByDate[s.date];
      const rowIndicesToDelete = deleteByDate[s.date];
      if (!rowIndicesToFix && !rowIndicesToDelete) return s;
      const nextModelRows = s.modelRows
        .filter((r, idx) => !(rowIndicesToDelete && rowIndicesToDelete.has(idx)))
        .map((r, idx) => {
          // re-filtering changes indices, so match on identity instead for the fix pass
          const originalIdx = s.modelRows.indexOf(r);
          if (rowIndicesToFix && rowIndicesToFix.has(originalIdx)) {
            return { ...r, avgSada: r.avgGsu, avgGsu: rowIndicesToFix.get(originalIdx) };
          }
          return r;
        });
      return { ...s, modelRows: nextModelRows };
    });
    persistOverallSummaries(nextSummaries);
    setVarietyRepairPreview(null);
    setVarietyRepairDone(true);
  }

  // export every piece of stored data as one JSON file — used for offline
  // analysis / backtesting of the pickup scoring rules
  function handleExportData() {
    const exportObj = {
      exportedAt: new Date().toISOString(),
      pages,
      pageHistories,
      pageRecommends,
      overallRecommends,
      dateEventMap,
      strongEvents,
      semiEvents,
      closedDays,
      overallSummaries,
      rawFullTable,
      eventNames,
    };
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `slot-tracker-export-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // race-safe upsert: merges against the LATEST state (via the functional
  // setState form) instead of a value captured in a stale closure, so
  // saving several dates back-to-back can't silently drop earlier entries
  const upsertDateEvent = useCallback(
    async (date, name) => {
      setDateEventMap((prev) => {
        const next = { ...prev, [date]: name };
        storage.set(DATE_EVENT_MAP_KEY, JSON.stringify(next), false).catch(() => {});
        return next;
      });
      // retroactively patch every OTHER page's already-saved record for this
      // date too, so registering an event once is truly the only step needed
      for (const p of pages) {
        let hist = pageHistories[p.id];
        if (hist === undefined) {
          try {
            const res = await storage.get(historyKey(p.id), false);
            hist = res && res.value ? JSON.parse(res.value) : [];
          } catch (e) {
            hist = [];
          }
        }
        const idx = hist.findIndex((h) => h.date === date);
        if (idx === -1 || hist[idx].event === name) continue;
        const nextHist = hist.map((h, i) => (i === idx ? { ...h, event: name } : h));
        loadedHistoryRef.current.add(p.id);
        setPageHistories((prev) => ({ ...prev, [p.id]: nextHist }));
        storage.set(historyKey(p.id), JSON.stringify(nextHist), false).catch(() => {});
      }
      // also patch 全体データ（機種別サマリー・末尾別データ）— this was missing,
      // so events registered/edited after an overall-data day was saved never
      // showed up there even though every per-page record got fixed
      setOverallSummaries((prevSummaries) => {
        const idx = prevSummaries.findIndex((s) => s.date === date);
        if (idx === -1 || prevSummaries[idx].event === name) return prevSummaries;
        const next = prevSummaries.map((s, i) => (i === idx ? { ...s, event: name } : s));
        storage.set(OVERALL_SUMMARY_KEY, JSON.stringify(next), false).catch(() => {});
        return next;
      });
    },
    [pages, pageHistories]
  );

  function rememberEventName(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    if (!eventNames.includes(trimmed)) {
      persistEventNames([...eventNames, trimmed]);
    }
  }

  // ---- page management ----
  function handleAddPage() {
    const next = [...pages, { id: `page-${Date.now()}`, name: "" }];
    persistPages(next);
    setActivePageId(next[next.length - 1].id);
    setViewMode("page");
  }

  function handleRenamePage(pageId, name) {
    persistPages(pages.map((p) => (p.id === pageId ? { ...p, name } : p)));
  }

  function handleSetOfficialName(pageId, officialName) {
    persistPages(pages.map((p) => (p.id === pageId ? { ...p, officialName } : p)));
    // v6.7: registering/renaming a page's 正式名称 immediately replays any
    // already-collected アナスロ data for that model into this page
    if (officialName) backfillPageFromRawTable(pageId, officialName);
  }

  // v6.8.1: 正式名称欄を「1つずつ追加するチップ入力」に変更（1回の入力が
  // 常に機種名1個だけになるので、ブラウザのdatalist補完がそのまま効く。
  // 「、」区切りのテキストを直接編集させると、2個目以降を入力中の文字列が
  // 「サンダーV、アレ」のような複合文字列になり、候補と一致しなくなって
  // 補完が効かなくなっていた問題の対策）
  function addOfficialNameToPage(pageId, nameToAdd) {
    const page = pages.find((p) => p.id === pageId);
    if (!page) return;
    const trimmed = (nameToAdd || "").trim();
    if (!trimmed) return;
    const current = splitModelNameList(page.officialName || "");
    if (current.some((n) => modelNamesMatch(n, trimmed))) return; // already there
    handleSetOfficialName(pageId, joinEventNames([...current, trimmed]));
  }
  function removeOfficialNameFromPage(pageId, nameToRemove) {
    const page = pages.find((p) => p.id === pageId);
    if (!page) return;
    const current = splitModelNameList(page.officialName || "");
    const next = current.filter((n) => n !== nameToRemove);
    handleSetOfficialName(pageId, joinEventNames(next));
  }

  function handleDeletePage(pageId) {
    const deletedPage = pages.find((p) => p.id === pageId);
    const next = pages.filter((p) => p.id !== pageId);
    pushUndoEntry(`ページ「${deletedPage && deletedPage.name ? deletedPage.name : "無題"}」を削除`, PAGES_KEY, pages);
    persistPages(next);
    setConfirmDeletePage(null);
    if (activePageId === pageId && next.length > 0) {
      setActivePageId(next[0].id);
    }
  }

  const currentHistory = pageHistories[activePageId] || [];
  const historyLoading = activePageId && pageHistories[activePageId] === undefined;
  const currentPage = pages.find((p) => p.id === activePageId);
  // this page's own recommend periods (used for this page's own predictions)
  const activePageRecommends = useMemo(() => {
    const own = pageRecommends[activePageId] || [];
    const officialName = currentPage && currentPage.officialName;
    // v6.8.7: exact-string lookup missed periods registered under a
    // slightly different表記（全角/半角・波ダッシュ・接頭辞違いなど）—
    // match by normalized name instead so registration doesn't silently
    // fail to link just because of a notation difference.
    // v6.8: officialName can now be a "、"区切り bundle of several model
    // names（理由Aタイプページ）— pool every matching model's periods.
    let linked = [];
    if (officialName) {
      const nameList = splitModelNameList(officialName);
      Object.keys(overallRecommends).forEach((name) => {
        if (nameList.some((n) => modelNamesMatch(name, n))) {
          linked = linked.concat(overallRecommends[name] || []);
        }
      });
    }
    return linked.length > 0 ? [...own, ...linked] : own;
  }, [pageRecommends, activePageId, currentPage, overallRecommends]);
  // whichever page is selected in the 共通設定 tab's dropdown (used for that UI)
  const recommendTargetList = pageRecommends[recommendTargetPageId] || [];

  // actual realized performance for each registered おすすめ機種期間 (per-page
  // list) — pools every machine's daily result within that date range
  const recommendPeriodStats = useMemo(() => {
    const hist = pageHistories[recommendTargetPageId];
    const stats = {};
    if (!hist) return stats;
    recommendTargetList.forEach((r) => {
      let total = 0, wins = 0, sum = 0;
      hist.forEach((h) => {
        if (h.date < r.startDate || h.date > r.endDate) return;
        h.machines.forEach((m) => {
          if (m.sada === null || m.sada === undefined) return;
          total += 1;
          if (m.sada > 0) wins += 1;
          sum += m.sada;
        });
      });
      stats[r.id] = total > 0 ? { total, winRate: wins / total, avg: sum / total } : null;
    });
    return stats;
  }, [pageHistories, recommendTargetPageId, recommendTargetList]);

  // v6.9: グローバル（全ページ共通）の▲ベースレート — 実データ検証は全
  // ページを1つのプールとして計算していたので、ページごとに計算し直すと
  // 数値が変わってしまう（各ページ自身の平均を基準にすると、そのページの
  // 中での差が小さく見えてしまうため）。必ずこの値を computeSignalsForPage
  // に渡す。
  const globalBaseRateA = useMemo(() => {
    let n = 0, hits = 0;
    Object.values(pageHistories).forEach((hist) => {
      (hist || []).forEach((h) => {
        h.machines.forEach((m) => {
          if (m.shutsu === null || m.shutsu === undefined) return;
          n += 1;
          if (m.shutsu >= 110) hits += 1;
        });
      });
    });
    return n > 0 ? hits / n : 0.21;
  }, [pageHistories]);

  const allMachineNumbers = useMemo(() => {
    const set = new Set();
    currentHistory.forEach((h) => h.machines.forEach((m) => set.add(m.no)));
    return Array.from(set).sort((a, b) => a - b);
  }, [currentHistory]);

  // v6.16: 新台入れ替えでこのページの機種が別の台番号に変わった場合、
  // 過去のallMachineNumbers（全期間の台番号の集合）には入れ替え前の
  // 台番号がずっと残り続け、ピックアップに古い台番号が出てきてしまう
  // 問題があった。ピックアップ・設定期待度は「最新日に実際に登場した
  // 台番号」だけを対象にする（グラフの台選択・マトリクス表は、過去を
  // 振り返る用途もあるのでallMachineNumbersのまま維持）。
  useEffect(() => {
    if (!historyLoading && selectedMachines.length === 0 && allMachineNumbers.length > 0) {
      setSelectedMachines(allMachineNumbers.slice(0, Math.min(6, allMachineNumbers.length)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLoading, allMachineNumbers]);

  const sortedHistory = useMemo(
    () => [...currentHistory].sort((a, b) => a.date.localeCompare(b.date)),
    [currentHistory]
  );

  // v6.16: 新台入れ替えでこのページの機種が別の台番号に変わった場合、
  // 過去のallMachineNumbers（全期間の台番号の集合）には入れ替え前の
  // 台番号がずっと残り続け、ピックアップに古い台番号が出てきてしまう
  // 問題があった。ピックアップ・設定期待度は「最新日に実際に登場した
  // 台番号」だけを対象にする（グラフの台選択・マトリクス表は、過去を
  // 振り返る用途もあるのでallMachineNumbersのまま維持）。
  const activeMachineNumbers = useMemo(() => {
    if (sortedHistory.length === 0) return [];
    const lastDay = sortedHistory[sortedHistory.length - 1];
    return Array.from(new Set(lastDay.machines.map((m) => m.no))).sort((a, b) => a - b);
  }, [sortedHistory]);

  // v6.8: 台番号 -> 機種名（このページが複数機種を束ねている「理由Aタイプ」
  // ページの場合、台番号だけでは機種がわからないので表示に使う。最新の
  // 記録を優先。ホール内の台番号は機種をまたいで一意なので、"no"だけを
  // キーにしたピックアップ・チャート・マトリクスの既存ロジックは変更不要。
  const noToModelName = useMemo(() => {
    const map = {};
    sortedHistory.forEach((h) => {
      h.machines.forEach((m) => {
        if (m.modelName) map[m.no] = m.modelName;
      });
    });
    return map;
  }, [sortedHistory]);
  const isMultiModelPage = useMemo(
    () => !!(currentPage && splitModelNameList(currentPage.officialName || "").length > 1),
    [currentPage]
  );
  function machineLabel(no) {
    return isMultiModelPage && noToModelName[no] ? `${noToModelName[no]} ${no}番` : `${no}番`;
  }

  const historyByDate = useMemo(() => {
    const map = {};
    currentHistory.forEach((h) => {
      map[h.date] = h;
    });
    return map;
  }, [currentHistory]);

  const closedDateSet = useMemo(() => new Set(closedDays.map((c) => c.date)), [closedDays]);

  // v6.7: アナスロの保存本体。1週間1キーへの複数日連続保存で途中の日付が
  // 消える競合状態対策として、①ref をawaitの前に同期更新する、②同じ週
  // キーへの書き込みは必ずキューで順番待ちさせる、の両方を行う（雑餉隈で
  // 実際にこれでデータを消失した事故があったための対策）。
  const handleSaveFullTable = useCallback(async (options) => {
    const force = options && options.force;
    if (closedDateSet.has(fullTableDate)) {
      setFullTableStatus({ type: "error", msg: `${fullTableDate} は店休日として登録されているため、データを保存できません。` });
      return;
    }
    const rows = parseFullStoreTable(fullTablePasteText);
    if (rows.length === 0) {
      setFullTableStatus({ type: "error", msg: "データを読み取れませんでした。表をそのまま貼り付けてください。" });
      return;
    }
    // catch an accidental copy-paste of a DIFFERENT day's table
    if (!force) {
      const thisFingerprint = fingerprintFullTableRows(rows);
      const conflictingDate = Object.entries(rawFullTableRef.current).find(
        ([date, existingRows]) => date !== fullTableDate && fingerprintFullTableRows(existingRows) === thisFingerprint
      );
      if (conflictingDate) {
        setFullTableDuplicateWarning({ conflictingDate: conflictingDate[0] });
        return;
      }
    }
    setFullTableDuplicateWarning(null);

    const previousRaw = rawFullTableRef.current;
    const nextRaw = { ...previousRaw, [fullTableDate]: rows };
    // update SYNCHRONOUSLY, before any await — this is what lets a rapid
    // second save (same week) see this date already merged in, regardless
    // of whether this save's own network round-trip has finished yet.
    // Reverted below if this save ultimately fails.
    rawFullTableRef.current = nextRaw;
    const weekKey = rawFullTableWeekKey(fullTableDate);
    const previousWeekWrite = rawFullTableWeekWriteQueueRef.current[weekKey] || Promise.resolve();
    const thisWeekWrite = previousWeekWrite.then(() => {
      const weekStart = weekStartOf(fullTableDate);
      const bucket = {};
      Object.keys(rawFullTableRef.current).forEach((d) => {
        if (weekStartOf(d) === weekStart) bucket[d] = rawFullTableRef.current[d];
      });
      bucket[fullTableDate] = rows; // ensure this date is in the bucket even if the ref hasn't caught up yet
      return storage.set(weekKey, JSON.stringify(bucket), false);
    });
    rawFullTableWeekWriteQueueRef.current[weekKey] = thisWeekWrite.catch(() => null);
    try {
      const res = await thisWeekWrite;
      if (!res) {
        rawFullTableRef.current = previousRaw; // don't let a failed save poison a later same-week save's bucket
        setFullTableStatus({ type: "error", msg: "生データの保存に失敗しました（storage.setがfalsyな結果を返しました）。もう一度お試しください。" });
        return;
      }
    } catch (e) {
      rawFullTableRef.current = previousRaw;
      setFullTableStatus({ type: "error", msg: `生データの保存中にエラーが発生しました：${e && e.message ? e.message : "詳細不明"}` });
      return;
    }
    setRawFullTable(nextRaw); // only reflect success in the visible UI state once the write is confirmed

    // update the shared INDEX key — same lesson: chain through a single
    // queue, and always build the written value from the current ref.
    const previousIndexWrite = rawFullTableIndexWriteQueueRef.current;
    const thisIndexWrite = previousIndexWrite.then(async () => {
      if (!rawFullTableIndexRef.current.includes(fullTableDate)) {
        rawFullTableIndexRef.current = [...rawFullTableIndexRef.current, fullTableDate].sort();
      }
      return storage.set(RAW_FULLTABLE_INDEX_KEY, JSON.stringify(rawFullTableIndexRef.current), false);
    });
    rawFullTableIndexWriteQueueRef.current = thisIndexWrite.catch(() => null);
    const indexRes = await thisIndexWrite.catch((e) => {
      setFullTableStatus({ type: "error", msg: `この日のデータ自体は保存できましたが、索引の更新に失敗しました：${e && e.message ? e.message : "詳細不明"}。次回起動時に自動で見つからない可能性があります。` });
      return null;
    });
    if (indexRes === null) return; // date data is safely saved either way — just flag the index concern above and stop here

    // fan out into every page whose 正式名称 matches a 機種名 in this paste
    const autoEvent = (dateEventMap[fullTableDate] || "").trim();
    let updatedPageCount = 0;
    for (const page of pages) {
      if (!page.officialName) continue;
      const nameList = splitModelNameList(page.officialName);
      const matched = rows.filter((r) => nameList.some((n) => modelNamesMatch(r.modelName, n)));
      if (matched.length === 0) continue;
      const machines = matched.map((r) => ({
        no: r.no,
        modelName: r.modelName,
        sada: r.sada,
        gsu: r.gsu,
        shutsu: r.shutsu,
        bb: r.bb,
        rb: r.rb,
        gousei: r.gousei,
        bbRateStr: r.bbRateStr,
        rbRateStr: r.rbRateStr,
      }));
      const existingHistory = pageHistories[page.id] || [];
      const nextHistory = [...existingHistory.filter((h) => h.date !== fullTableDate), { date: fullTableDate, event: autoEvent, machines }];
      await persistPageHistory(page.id, nextHistory);
      updatedPageCount += 1;
    }

    setFullTableStatus({
      type: "ok",
      msg: `${fullTableDate} のデータを保存しました（全${rows.length}台分、うち${updatedPageCount}ページに反映）。`,
    });
    setFullTablePasteText("");
    setFullTableDate(addDays(fullTableDate, -1));
  }, [fullTablePasteText, fullTableDate, pages, pageHistories, dateEventMap, closedDateSet, persistPageHistory]);

  // this PAGE's own recommend periods, for its own machines' predictions
  const recommendDateSet = useMemo(() => {
    const set = new Set();
    activePageRecommends.forEach((p) => {
      enumerateDateRange(p.startDate, p.endDate).forEach((d) => set.add(d));
    });
    return set;
  }, [activePageRecommends]);

  // whichever page the 共通設定 dropdown has selected, for the registration UI

  // merge in closed days (within the recorded date range) so they appear on the axis
  const timelineDates = useMemo(() => {
    if (sortedHistory.length === 0) return [];
    const historyDates = sortedHistory.map((h) => h.date);
    const minDate = historyDates[0];
    const maxDate = historyDates[historyDates.length - 1];
    const closedInRange = closedDays.map((c) => c.date).filter((d) => d >= minDate && d <= maxDate);
    return Array.from(new Set([...historyDates, ...closedInRange])).sort((a, b) => a.localeCompare(b));
  }, [sortedHistory, closedDays]);

  const visibleTimelineDates = useMemo(() => {
    if (useCustomRange && customStart && customEnd) {
      return timelineDates.filter((d) => d >= customStart && d <= customEnd);
    }
    if (range === "all" || timelineDates.length === 0) return timelineDates;
    return timelineDates.slice(-range);
  }, [timelineDates, range, useCustomRange, customStart, customEnd]);

  const chartData = useMemo(() => {
    return visibleTimelineDates.map((date) => {
      const entry = historyByDate[date];
      const closed = closedDateSet.has(date);
      const row = { date, event: entry ? entry.event || "" : "", closed };
      selectedMachines.forEach((no) => {
        const m = entry ? entry.machines.find((mm) => mm.no === no) : null;
        row[String(no)] = m ? m.sada : null;
      });
      return row;
    });
  }, [visibleTimelineDates, historyByDate, closedDateSet, selectedMachines]);

  const strongEventColorByName = useMemo(() => {
    const map = {};
    strongEvents.forEach((s) => {
      map[s.name] = s.color;
    });
    return map;
  }, [strongEvents]);

  // every date in THIS page's history whose event name matches a registered
  // strong-event name — so registering a name once flags every occurrence,
  // past or future, without re-registering each date
  const strongDatesInHistory = useMemo(() => {
    const result = [];
    sortedHistory.forEach((h) => {
      if (!h.event) return;
      const matched = splitEventNames(h.event).find((n) => strongEventColorByName[n]);
      if (matched) result.push({ date: h.date, name: matched, color: strongEventColorByName[matched] });
    });
    return result;
  }, [sortedHistory, strongEventColorByName]);

  // dates flagged as "strong" / "closed" that actually fall within the visible chart
  const strongDatesInView = useMemo(() => {
    const visibleDates = new Set(visibleTimelineDates);
    return strongDatesInHistory.filter((se) => visibleDates.has(se.date));
  }, [strongDatesInHistory, visibleTimelineDates]);

  const closedDatesInView = useMemo(() => {
    const visibleDates = new Set(visibleTimelineDates);
    return closedDays.filter((c) => visibleDates.has(c.date));
  }, [closedDays, visibleTimelineDates]);

  // "2のつく日" (2nd/12th/22nd) and "7のつく日" (7th/17th/27th) — auto-detected, no registration needed
  const digit2DatesInView = useMemo(
    () => visibleTimelineDates.filter((d) => parseInt(d.slice(-2), 10) % 10 === 2),
    [visibleTimelineDates]
  );
  const digit7DatesInView = useMemo(
    () => visibleTimelineDates.filter((d) => parseInt(d.slice(-2), 10) % 10 === 7),
    [visibleTimelineDates]
  );

  const strongDateSet = useMemo(() => new Set(strongDatesInHistory.map((s) => s.date)), [strongDatesInHistory]);
  const strongColorByDate = useMemo(() => {
    const map = {};
    strongDatesInHistory.forEach((s) => {
      map[s.date] = s.color;
    });
    return map;
  }, [strongDatesInHistory]);

  const semiEventColorByName = useMemo(() => {
    const map = {};
    semiEvents.forEach((s) => {
      map[s.name] = s.color;
    });
    return map;
  }, [semiEvents]);

  const strongEventNameSet = useMemo(() => new Set(Object.keys(strongEventColorByName)), [strongEventColorByName]);
  const semiEventNameSet = useMemo(() => new Set(Object.keys(semiEventColorByName)), [semiEventColorByName]);

  // 準イベント: same idea as strong events but the weaker, third tier —
  // 強いイベント ＞ イベント ＞ 準イベント. a date only counts as 準イベント
  // if it's registered here AND not already a strong event (strong wins)
  const semiDatesInHistory = useMemo(() => {
    const result = [];
    sortedHistory.forEach((h) => {
      if (!h.event) return;
      const names = splitEventNames(h.event);
      if (names.some((n) => strongEventColorByName[n])) return; // already strong, don't double-count as semi
      const matched = names.find((n) => semiEventColorByName[n]);
      if (matched) result.push({ date: h.date, name: matched, color: semiEventColorByName[matched] });
    });
    return result;
  }, [sortedHistory, semiEventColorByName, strongEventColorByName]);

  const semiDatesInView = useMemo(() => {
    const visibleDates = new Set(visibleTimelineDates);
    return semiDatesInHistory.filter((se) => visibleDates.has(se.date));
  }, [semiDatesInHistory, visibleTimelineDates]);

  const semiDateSet = useMemo(() => new Set(semiDatesInHistory.map((s) => s.date)), [semiDatesInHistory]);
  const semiColorByDate = useMemo(() => {
    const map = {};
    semiDatesInHistory.forEach((s) => {
      map[s.date] = s.color;
    });
    return map;
  }, [semiDatesInHistory]);

  // ordinary (non-strong) events, shown as a gold star marker
  const eventDates = useMemo(
    () =>
      visibleTimelineDates
        .map((d) => historyByDate[d])
        .filter((e) => e && e.event && e.event.trim().length > 0 && !strongDateSet.has(e.date) && !semiDateSet.has(e.date)),
    [visibleTimelineDates, historyByDate, strongDateSet, semiDateSet]
  );

  const machineSummaries = useMemo(() => {
    return selectedMachines.map((no) => {
      let dataCount = 0;
      let cum = 0;
      let started = false;
      let lastSeenDate = null;
      const rawSeries = [];
      visibleTimelineDates.forEach((date) => {
        const entry = historyByDate[date];
        const m = entry ? entry.machines.find((mm) => mm.no === no) : null;
        if (m && m.sada !== null) {
          cum += m.sada;
          started = true;
          dataCount += 1;
          lastSeenDate = date;
        }
        // carry the running total forward on days with no data, instead of
        // breaking the line, so it always ends exactly at the total shown
        rawSeries.push({ date, value: started ? cum : null });
      });
      // once the machine stops appearing for good (e.g. 新台入れ替え), cut the
      // line off there instead of flat-lining all the way to the end —
      // a temporary one-off gap in the middle still just bridges through
      const series = rawSeries.map((pt) =>
        lastSeenDate && pt.date > lastSeenDate ? { ...pt, value: null } : pt
      );
      const totalSada = cum;
      const seriesDates = new Set(series.map((s) => s.date));
      const strongInSeries = strongDatesInHistory.filter((se) => seriesDates.has(se.date));
      const closedInSeries = closedDays.filter((c) => seriesDates.has(c.date));
      const digit2InSeries = series.map((s) => s.date).filter((d) => parseInt(d.slice(-2), 10) % 10 === 2);
      const digit7InSeries = series.map((s) => s.date).filter((d) => parseInt(d.slice(-2), 10) % 10 === 7);
      return { no, totalSada, dataCount, series, strongInSeries, closedInSeries, digit2InSeries, digit7InSeries };
    });
  }, [selectedMachines, visibleTimelineDates, historyByDate, strongDatesInHistory, closedDays]);

  // "○のつく日" (e.g. digit 2 → the 2nd/12th/22nd) average 差枚 per machine,
  // computed across this page's entire recorded history (not limited by range)
  const luckyDayStats = useMemo(() => {
    if (luckyDigit === null) return [];
    const matchingEntries = sortedHistory.filter((h) => {
      const day = parseInt(h.date.slice(-2), 10);
      return day % 10 === luckyDigit;
    });
    const map = {};
    matchingEntries.forEach((h) => {
      h.machines.forEach((m) => {
        if (m.sada === null) return;
        if (!map[m.no]) map[m.no] = { sum: 0, count: 0 };
        map[m.no].sum += m.sada;
        map[m.no].count += 1;
      });
    });
    return Object.entries(map)
      .map(([no, v]) => ({ no: parseInt(no, 10), avg: v.sum / v.count, count: v.count }))
      .sort((a, b) => b.avg - a.avg);
  }, [luckyDigit, sortedHistory]);

  // "○のつく日" overall total: for each matching date, sum every machine's
  // 差枚 that day, then average that daily total across all matching dates
  const luckyDayOverall = useMemo(() => {
    if (luckyDigit === null) return null;
    const matchingEntries = sortedHistory.filter((h) => parseInt(h.date.slice(-2), 10) % 10 === luckyDigit);
    if (matchingEntries.length === 0) return null;
    const dailyTotals = matchingEntries.map((h) =>
      h.machines.reduce((sum, m) => sum + (m.sada ?? 0), 0)
    );
    const avgTotal = dailyTotals.reduce((a, b) => a + b, 0) / dailyTotals.length;
    return { avgTotal, dayCount: matchingEntries.length };
  }, [luckyDigit, sortedHistory]);

  // for each selected machine: does a big trailing-N-day total tend to predict
  // whether the next day is positive? (both "total is high" and "total is low" directions)
  const thresholdAnalyses = useMemo(() => {
    return selectedMachines.map((no) => {
      const series = sortedHistory
        .map((h) => {
          const m = h.machines.find((mm) => mm.no === no);
          return m && m.sada !== null ? { date: h.date, sada: m.sada } : null;
        })
        .filter(Boolean);

      const baseRate = computeBaseRate(series);
      const allPairs = buildTrailingPairs(series, analysisWindow);
      const overall = findBestThresholds(allPairs, 5, baseRate);
      const digit2Pairs = allPairs.filter((p) => parseInt(p.nextDate.slice(-2), 10) % 10 === 2);
      const digit7Pairs = allPairs.filter((p) => parseInt(p.nextDate.slice(-2), 10) % 10 === 7);
      const digit2 = findBestThresholds(digit2Pairs, 3, baseRate);
      const digit7 = findBestThresholds(digit7Pairs, 3, baseRate);

      return {
        no,
        overall,
        digit2,
        digit7,
        baseRate,
        validDays: series.length,
        overallPairsCount: allPairs.length,
        digit2PairsCount: digit2Pairs.length,
        digit7PairsCount: digit7Pairs.length,
      };
    });
  }, [selectedMachines, sortedHistory, analysisWindow]);

  // evaluate one window size for one machine's series: does the CURRENT
  // trailing total already meet a historically favorable threshold?
  function evaluateWindow(series, windowSize, baseRate) {
    if (series.length < windowSize + 1) return null;
    const pairs = buildTrailingPairs(series, windowSize);
    const result = findBestThresholds(pairs, 5, baseRate);
    if (!result) return null;
    const currentWindow = series.slice(-windowSize);
    if (currentWindow.length < windowSize) return null;
    const currentTrailing = currentWindow.reduce((a, s) => a + s.sada, 0);
    const reasons = [];
    if (result.bestAbove && currentTrailing >= result.bestAbove.threshold) {
      reasons.push({ direction: "above", ...result.bestAbove });
    }
    if (result.bestBelow && currentTrailing <= result.bestBelow.threshold) {
      reasons.push({ direction: "below", ...result.bestBelow });
    }
    return { currentTrailing, reasons };
  }

  // machines whose CURRENT trailing total already meets a historically
  // favorable threshold, checked across the 10/20/30-day windows together,
  // with a combined "総合判断" verdict, plus several other pickup signals
  // (computed across all machines this page has ever seen)
  // core per-machine signal computation, parameterized so it can be reused
  // for both the active page and the store-wide 機種別/末尾別 summaries
  // v6.20: 【大きな設計変更】このエンジンが予想する対象を「▲・差枚が
  // 当たるか」から「翌日、Xの値が高くなるか」に統一。以前は▲ベースの
  // 古い判定材料（10/20/30日足・連続日数・曜日・強いイベント翌日・
  // イベント登録連動・おすすめ機種期間・相対ローテーション・大量回転低調・
  // イベント間トレンド等）と、新しいX/▲ベースの判定材料が混在していた
  // が、指示（「翌日Xの値が高くなるところを予想する」）に合わせて、古い
  // 判定材料は全部削除し、実データ検証で全部Xの予想材料としても機能する
  // ことを確認済みの6つの判定材料だけに絞った：
  // ①台番号固有のXの法則 ②機種全体のXの法則 ③前日、他の台が好調
  // ④前日のG数水準 ⑤日付末尾 ⑥イベント名（登録されているイベント）
  function computeSignalsForPage(machineNumbers, pageSortedHistory, pageHistoryByDate, pageRecommendsList, pageStrongDateSet, pageSemiDateSet, strongNameSet, semiNameSet, globalBaseRateAParam, pageXByDateParam) {
    const results = [];
    if (!pageXByDateParam) return results; // Xが計算できていなければ何も予想できない

    const pageGsuPercentiles = computePageGsuPercentiles(pageSortedHistory);
    const pageMateGoodStatsX = computePageMateGoodStatsX(pageSortedHistory, pageXByDateParam);
    const gsuLevelStatsX = computeTrailingGsuLevelStatsX(pageSortedHistory, pageGsuPercentiles, pageXByDateParam);

    // modelNameごとに日付順でプールしたシリーズ（機種全体のXの法則用）
    const modelSeriesByName = {};
    let pageXSum = 0, pageXCount = 0;
    pageSortedHistory.forEach((h) => {
      h.machines.forEach((m) => {
        const mn = m.modelName || "__unknown__";
        if (!modelSeriesByName[mn]) modelSeriesByName[mn] = [];
        const xVal = (pageXByDateParam[h.date] || {})[m.no];
        modelSeriesByName[mn].push({ date: h.date, no: m.no, event: h.event, x: xVal !== undefined ? xVal : null });
        if (xVal !== null && xVal !== undefined) { pageXSum += xVal; pageXCount += 1; }
      });
    });
    const pageXAvg = pageXCount > 0 ? pageXSum / pageXCount : 0;
    let pageXAbsSum = 0;
    Object.values(modelSeriesByName).forEach((arr) => {
      arr.forEach((r) => { if (r.x !== null && r.x !== undefined) pageXAbsSum += Math.abs(r.x - pageXAvg); });
    });
    const pageXTypicalMagnitude = pageXCount > 0 ? pageXAbsSum / pageXCount || 1 : 1;

    const referenceDate = pageSortedHistory.length > 0 ? pageSortedHistory[pageSortedHistory.length - 1].date : null;
    if (!referenceDate) return results;
    const tomorrowDate = addDays(referenceDate, 1);
    const tomorrowDigit = parseInt(tomorrowDate.slice(-2), 10) % 10;
    const tomorrowEventNames = splitEventNames(dateEventMap[tomorrowDate] || "");

    machineNumbers.forEach((no) => {
      const xSeries = pageSortedHistory
        .map((h) => {
          const m = h.machines.find((mm) => mm.no === no);
          if (!m) return null;
          const x = (pageXByDateParam[h.date] || {})[no];
          return { date: h.date, gsu: m.gsu, sada: m.sada, x: x !== undefined ? x : null, event: h.event, modelName: m.modelName };
        })
        .filter((r) => r && r.x !== null && r.x !== undefined);
      if (xSeries.length === 0) return;
      const lastDate = xSeries[xSeries.length - 1].date;
      const thisMachineModelName = xSeries[xSeries.length - 1].modelName;

      const scoreItems = []; // { label, points }

      // ①台番号固有のXの法則（トレイリング平均X、この台自身の過去実績）
      let fixedNoXMatch = null;
      if (xSeries.length >= 10) {
        const avgX = xSeries.reduce((a, r) => a + r.x, 0) / xSeries.length;
        fixedNoXMatch = { avgX, sampleSize: xSeries.length };
      }
      if (fixedNoXMatch) {
        const evPts = computeEvPoints(fixedNoXMatch.avgX, pageXAvg, pageXTypicalMagnitude, fixedNoXMatch.sampleSize);
        scoreItems.push({ label: "台番号固有のXの法則", points: evPts * SIGNAL_WEIGHTS.fixedNoX, detail: { avgX: fixedNoXMatch.avgX, sampleSize: fixedNoXMatch.sampleSize } });
      }

      // ②機種全体のXの法則（同じ機種名の他の台のトレイリング平均X、この台は除外）
      let modelWideXMatch = null;
      if (thisMachineModelName && modelSeriesByName[thisMachineModelName]) {
        const otherModelXVals = modelSeriesByName[thisMachineModelName]
          .filter((r) => r.no !== no && r.x !== null && r.x !== undefined)
          .map((r) => r.x);
        if (otherModelXVals.length >= 10) {
          const avgX = otherModelXVals.reduce((a, v) => a + v, 0) / otherModelXVals.length;
          modelWideXMatch = { avgX, sampleSize: otherModelXVals.length };
        }
      }
      if (modelWideXMatch) {
        const evPts = computeEvPoints(modelWideXMatch.avgX, pageXAvg, pageXTypicalMagnitude, modelWideXMatch.sampleSize);
        scoreItems.push({ label: "機種全体のXの法則", points: evPts * SIGNAL_WEIGHTS.modelWideX, detail: { avgX: modelWideXMatch.avgX, sampleSize: modelWideXMatch.sampleSize } });
      }

      // ③前日、他の台が好調（▲率50%以上）だった → 翌日の自分のX
      const pageMateGoodMatch = checkPageMateGoodTodayX(pageMateGoodStatsX, pageHistoryByDate, lastDate, no);
      if (pageMateGoodMatch) {
        const evPts = computeEvPoints(pageMateGoodMatch.avgX, pageXAvg, pageXTypicalMagnitude, pageMateGoodMatch.sampleSize);
        scoreItems.push({ label: "前日、他の台が好調", points: evPts * SIGNAL_WEIGHTS.pageMateGood, detail: { avgX: pageMateGoodMatch.avgX, sampleSize: pageMateGoodMatch.sampleSize } });
      }

      // ④前日のG数水準（大量回転/低調、ページ全体のパーセンタイル基準）→ 翌日の自分のX
      const gsuLevelMatch = checkTrailingGsuLevelTodayX(gsuLevelStatsX, xSeries, pageGsuPercentiles);
      if (gsuLevelMatch) {
        const evPts = computeEvPoints(gsuLevelMatch.avgX, pageXAvg, pageXTypicalMagnitude, gsuLevelMatch.sampleSize);
        scoreItems.push({ label: `前日のG数水準（${gsuLevelMatch.level}）`, points: evPts * SIGNAL_WEIGHTS.gsuLevel, detail: { avgX: gsuLevelMatch.avgX, sampleSize: gsuLevelMatch.sampleSize } });
      }

      // ⑤日付末尾（この台の過去、翌日と同じ末尾の日のXが高い/低いか）
      const digitVals = xSeries.filter((r) => parseInt(r.date.slice(-2), 10) % 10 === tomorrowDigit).map((r) => r.x);
      if (digitVals.length >= 5) {
        const avgX = digitVals.reduce((a, v) => a + v, 0) / digitVals.length;
        const evPts = computeEvPoints(avgX, pageXAvg, pageXTypicalMagnitude, digitVals.length);
        scoreItems.push({ label: `日付末尾=${tomorrowDigit}`, points: evPts * SIGNAL_WEIGHTS.digitDay, detail: { avgX, sampleSize: digitVals.length } });
      }

      // ⑥イベント（明日登録されているイベント名の、過去のX平均）
      tomorrowEventNames.forEach((name) => {
        const matchVals = xSeries.filter((r) => r.event && splitEventNames(r.event).includes(name)).map((r) => r.x);
        if (matchVals.length >= 5) {
          const avgX = matchVals.reduce((a, v) => a + v, 0) / matchVals.length;
          const evPts = computeEvPoints(avgX, pageXAvg, pageXTypicalMagnitude, matchVals.length);
          scoreItems.push({ label: `イベント「${name}」`, points: evPts * SIGNAL_WEIGHTS.plannedEvent, detail: { avgX, sampleSize: matchVals.length, eventName: name } });
        }
      });

      // v6.21: 復活＆Xターゲット化した3つの判定材料（ユーコーラッキー資料
      // をきっかけに判定材料を絞りすぎたとの指摘を受け、実データで再検証
      // した上で復活）

      // ⑦20日足・30日足トレイリング差枚（逆張り）→ 翌日X。実データ検証：
      // 20日足はマイナス圏でn=2018・base比+0.032、30日足はマイナス圏で
      // n=1428・base比+0.026と、意外にも「長期でマイナスの方が翌日Xは
      // 高い」という平均回帰型の効果を確認（10日足は弱いので不採用）。
      [20, 30].forEach((window) => {
        if (xSeries.length < window) return;
        const trailing = xSeries.slice(-window);
        if (trailing.some((r) => r.sada === null || r.sada === undefined)) return;
        const total = trailing.reduce((a, r) => a + r.sada, 0);
        const isMinusZone = total < 0;
        // マイナス圏の時だけ、過去の「マイナス圏だった翌日」のX平均を集計
        if (!isMinusZone) return;
        const followVals = [];
        for (let i = window; i < xSeries.length; i++) {
          const w = xSeries.slice(i - window, i);
          if (w.some((r) => r.sada === null || r.sada === undefined)) continue;
          const t = w.reduce((a, r) => a + r.sada, 0);
          if (t < 0) followVals.push(xSeries[i].x);
        }
        if (followVals.length >= 15) {
          const avgX = followVals.reduce((a, v) => a + v, 0) / followVals.length;
          const evPts = computeEvPoints(avgX, pageXAvg, pageXTypicalMagnitude, followVals.length);
          scoreItems.push({ label: `${window}日足トレイリング差枚（マイナス圏）`, points: evPts * SIGNAL_WEIGHTS.trailingWindow, detail: { avgX, sampleSize: followVals.length } });
        }
      });

      // ⑧準イベント翌日 → 翌日X。実データ検証：n=722・base比-0.051と
      // 明確な負の効果（注意信号として採用）。強いイベント翌日は
      // base比-0.009とほぼ効果が無かったため不採用。
      if (pageSemiDateSet && pageSemiDateSet.has(lastDate)) {
        const followVals = [];
        for (let i = 1; i < xSeries.length; i++) {
          if (pageSemiDateSet.has(xSeries[i - 1].date)) followVals.push(xSeries[i].x);
        }
        if (followVals.length >= 15) {
          const avgX = followVals.reduce((a, v) => a + v, 0) / followVals.length;
          const evPts = computeEvPoints(avgX, pageXAvg, pageXTypicalMagnitude, followVals.length);
          scoreItems.push({ label: "準イベント翌日", points: evPts * SIGNAL_WEIGHTS.semiFollow, detail: { avgX, sampleSize: followVals.length } });
        }
      }

      // ⑨大量回転・低調（この台自身の平均G数との比較）→ 翌日X。実データ
      // 検証：自分の平均の1.3倍以上でn=2160・+0.035、0.7倍以下でn=2250・
      // -0.015。前日のG数水準（ページ全体パーセンタイル基準）とは別の
      // 切り口（この台自身の基準に対する相対値）。
      if (xSeries.length >= 10) {
        const gsuVals = xSeries.map((r) => r.gsu).filter((v) => v !== null && v !== undefined);
        const ownAvgGsu = gsuVals.length >= 10 ? gsuVals.reduce((a, v) => a + v, 0) / gsuVals.length : null;
        if (ownAvgGsu) {
          const lastGsu = xSeries[xSeries.length - 1].gsu;
          if (lastGsu !== null && lastGsu !== undefined) {
            const ratio = lastGsu / ownAvgGsu;
            const level = ratio >= 1.3 ? "大量回転" : ratio <= 0.7 ? "低調" : null;
            if (level) {
              const followVals = [];
              for (let i = 1; i < xSeries.length; i++) {
                const prevGsu = xSeries[i - 1].gsu;
                if (prevGsu === null || prevGsu === undefined) continue;
                const r2 = prevGsu / ownAvgGsu;
                const lv = r2 >= 1.3 ? "大量回転" : r2 <= 0.7 ? "低調" : null;
                if (lv === level) followVals.push(xSeries[i].x);
              }
              if (followVals.length >= 15) {
                const avgX = followVals.reduce((a, v) => a + v, 0) / followVals.length;
                const evPts = computeEvPoints(avgX, pageXAvg, pageXTypicalMagnitude, followVals.length);
                scoreItems.push({ label: `大量回転・低調（自分比・${level}）`, points: evPts * SIGNAL_WEIGHTS.volumeMismatch, detail: { avgX, sampleSize: followVals.length } });
              }
            }
          }
        }
      }

      if (scoreItems.length === 0) return;

      let strongSignalCount = 0;
      let tieBreakerPoints = 0;
      scoreItems.forEach((s) => {
        if (isStrongSignalLabel(s.label) && s.points > 0) strongSignalCount += 1;
        else tieBreakerPoints += s.points;
      });
      const totalPoints = strongSignalCount * 100 + Math.max(-40, Math.min(40, tieBreakerPoints));
      const signalCount = scoreItems.length;
      const grade = pointsToGrade(totalPoints);

      results.push({
        no,
        lastDate,
        scoreItems,
        totalPoints,
        strongSignalCount,
        tieBreakerPoints,
        signalCount,
        grade,
      });
    });
    return results;
  }

  function sortPickResults(results) {
    results.sort((a, b) => {
      const aScore = a.totalPoints ?? -Infinity;
      const bScore = b.totalPoints ?? -Infinity;
      if (bScore !== aScore) return bScore - aScore;
      return b.signalCount - a.signalCount;
    });
    return results;
  }

  // v6.14: Xの生値はページ単位で1回だけ計算する（以前は複数箇所で別々に
  // 計算していて無駄だった）
  // v6.18: 台番号固有・機種全体のXの法則をcomputeSignalsForPageに統合
  // したため、pickListより先に計算しておく必要がある
  const pageXByDate = useMemo(() => {
    if (sortedHistory.length < 15) return null;
    return computeXForPage(sortedHistory);
  }, [sortedHistory]);

  // v6.18: ▲・差枚ベースの法則とX（設定期待度）ベースの法則を1つの
  // ランク（S〜G）に統合。以前は「設定期待度（高/中/低）」として別カード
  // だったが、完全合体してこちらの1本にした（マイジャグラー専用の
  // 設定判別カードは、翌日予想として機能しないことが実データ検証で
  // わかったため削除）。
  const pickList = useMemo(() => {
    return sortPickResults(computeSignalsForPage(activeMachineNumbers, sortedHistory, historyByDate, activePageRecommends, strongDateSet, semiDateSet, strongEventNameSet, semiEventNameSet, globalBaseRateA, pageXByDate));
  }, [activeMachineNumbers, sortedHistory, strongDateSet, semiDateSet, strongEventNameSet, semiEventNameSet, historyByDate, dateEventMap, activePageRecommends, globalBaseRateA, pageXByDate]);

  // store-wide 機種別サマリー / 末尾別データ, reusing the exact same signal
  // engine (it doesn't care whether "no" is a machine number, a model name,
  // or a last-digit label — it just needs {date, sada, gsu} per entity)
  const overallSortedSummaries = useMemo(
    () => [...overallSummaries].sort((a, b) => a.date.localeCompare(b.date)),
    [overallSummaries]
  );

  // every model name that has ever appeared in a 機種別サマリー snapshot —
  // used as autocomplete options for 正式名称 and for the model-name-based
  // おすすめ機種期間 registration
  const allKnownModelNames = useMemo(
    () => Array.from(new Set(overallSummaries.flatMap((s) => s.modelRows.map((r) => r.name)))).sort(),
    [overallSummaries]
  );

  // v6.7: アナスロに登場した機種名の一覧（正式名称欄のオートコンプリート用）
  const allKnownModelNamesFromFullTable = useMemo(
    () => Array.from(new Set(Object.values(rawFullTable).flatMap((rows) => rows.map((r) => r.modelName)))).sort(),
    [rawFullTable]
  );

  // actual realized performance for each registered おすすめ機種期間 (machine
  // name based, 全体データ用) — pools every 機種別サマリー day within range
  // for that specific model name
  const overallRecommendPeriodStats = useMemo(() => {
    const stats = {};
    Object.entries(overallRecommends).forEach(([name, periods]) => {
      stats[name] = {};
      periods.forEach((r) => {
        let total = 0, wins = 0, sum = 0;
        overallSortedSummaries.forEach((s) => {
          if (s.date < r.startDate || s.date > r.endDate) return;
          const row = s.modelRows.find((mr) => mr.name === name);
          if (!row || row.avgSada === null || row.avgSada === undefined) return;
          total += 1;
          if (row.avgSada > 0) wins += 1;
          sum += row.avgSada;
        });
        stats[name][r.id] = total > 0 ? { total, winRate: wins / total, avg: sum / total } : null;
      });
    });
    return stats;
  }, [overallRecommends, overallSortedSummaries]);

  // store-wide 総差枚/平均差枚/平均G数 per date, reconstructed from the
  // 機種別サマリー rows (avgSada × 台数, summed across every model) — this
  // recovers the real negative totals that min-repo's own report list hides
  const dailyStoreTotals = useMemo(() => {
    return [...overallSortedSummaries]
      .map((s) => {
        let totalSamai = 0;
        let totalGsuWeighted = 0;
        let machineCount = 0;
        s.modelRows.forEach((r) => {
          if (r.total && r.avgSada !== null && r.avgSada !== undefined && r.avgGsu !== null && r.avgGsu !== undefined) {
            totalSamai += r.avgSada * r.total;
            totalGsuWeighted += r.avgGsu * r.total;
            machineCount += r.total;
          }
        });
        const names = splitEventNames(s.event);
        const isStrong = names.some((n) => strongEventColorByName[n]);
        const isSemi = !isStrong && names.some((n) => semiEventColorByName[n]);
        const eventTier = isStrong ? "strong" : isSemi ? "semi" : names.length > 0 ? "event" : null;
        const marks = s.modelRows
          .map((r) => ({ name: r.name, mark: classifyMinRepoMark(r) }))
          .filter((m) => m.mark)
          .sort((a, b) => MARK_PRIORITY[a.mark] - MARK_PRIORITY[b.mark]);
        return {
          date: s.date,
          event: s.event,
          eventTier,
          machineCount,
          totalSamai: machineCount > 0 ? Math.round(totalSamai) : null,
          avgSamai: machineCount > 0 ? totalSamai / machineCount : null,
          avgGsu: machineCount > 0 ? totalGsuWeighted / machineCount : null,
          marks,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date)); // newest first
  }, [overallSortedSummaries, strongEventColorByName, semiEventColorByName]);

  // every distinct event name ever registered (any tier) — used as the
  // selector options for "イベントを選択して過去を見る"
  const allKnownEventNames = useMemo(() => {
    const set = new Set();
    Object.values(dateEventMap).forEach((composite) => splitEventNames(composite).forEach((n) => set.add(n)));
    return Array.from(set).sort();
  }, [dateEventMap]);

  // past occurrences of the selected event, reusing dailyStoreTotals (which
  // already has totals + ☆◎◯▲ marks computed per date)
  const eventHistoryResults = useMemo(() => {
    if (!eventHistorySelection) return [];
    return dailyStoreTotals.filter((d) => d.event && splitEventNames(d.event).includes(eventHistorySelection));
  }, [dailyStoreTotals, eventHistorySelection]);

  // full per-date history for the selected model name, optionally filtered
  // to only dates that also had a specific event registered
  const modelHistoryResults = useMemo(() => {
    if (!modelHistorySelection) return [];
    return overallSortedSummaries
      .map((s) => {
        const row = s.modelRows.find((r) => r.name === modelHistorySelection);
        if (!row) return null;
        if (modelHistoryEventFilter && !splitEventNames(s.event).includes(modelHistoryEventFilter)) return null;
        return {
          date: s.date,
          event: s.event,
          avgSada: row.avgSada,
          avgGsu: row.avgGsu,
          shutsu: row.shutsu,
          wins: row.wins,
          total: row.total,
          mark: classifyMinRepoMark(row),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [overallSortedSummaries, modelHistorySelection, modelHistoryEventFilter]);

  // ---- 全体データ用マトリクス表: 機種名（台数順）× 日付、セルは☆◎◯▲ ----
  const overallGridDates = useMemo(() => {
    let dates;
    if (overallGridEventFilter.length > 0) {
      dates = overallSortedSummaries
        .filter((s) => s.event && splitEventNames(s.event).some((n) => overallGridEventFilter.includes(n)))
        .map((s) => s.date);
    } else {
      dates = overallSortedSummaries.slice(-30).map((s) => s.date);
    }
    return [...dates].sort((a, b) => b.localeCompare(a)); // newest first (left side)
  }, [overallSortedSummaries, overallGridEventFilter]);

  const overallGridRows = useMemo(() => {
    const totalByName = {};
    overallSortedSummaries.forEach((s) => {
      s.modelRows.forEach((r) => {
        if (r.total) totalByName[r.name] = Math.max(totalByName[r.name] || 0, r.total);
      });
    });
    return Object.keys(totalByName).sort((a, b) => (totalByName[b] || 0) - (totalByName[a] || 0));
  }, [overallSortedSummaries]);

  const overallGridMarks = useMemo(() => {
    const map = {};
    overallSortedSummaries.forEach((s) => {
      s.modelRows.forEach((r) => {
        if (!map[r.name]) map[r.name] = {};
        map[r.name][s.date] = classifyMinRepoMark(r);
      });
    });
    return map;
  }, [overallSortedSummaries]);

  // v6.9.16: which (date, 機種名) CELLS should be flagged as「バラエティ
  // コーナー」(1台設置) in the matrix table — per-cell, not per-機種: a day
  // where this 機種 was in the バラエティ section gets flagged; a day where
  // the SAME 機種 had multiple machines (e.g. before/after 新台入れ替えで
  // 台数が変わった) does not, even though it's the same row. isVariety is
  // undefined on data saved before this version — treated as「対象外」
  // （安全側のデフォルト）。
  const overallGridVarietyCells = useMemo(() => {
    const cells = new Set();
    overallSortedSummaries.forEach((s) => {
      s.modelRows.forEach((r) => {
        if (r.isVariety) cells.add(`${s.date}|${r.name}`);
      });
    });
    return cells;
  }, [overallSortedSummaries]);

  // ---- 機種ページ用マトリクス表: 台番号 × 日付、セルは出率ベースの簡易マーク ----
  const pageGridDates = useMemo(() => {
    let dates;
    if (pageGridEventFilter.length > 0) {
      dates = sortedHistory
        .filter((h) => h.event && splitEventNames(h.event).some((n) => pageGridEventFilter.includes(n)))
        .map((h) => h.date);
    } else {
      dates = sortedHistory.slice(-30).map((h) => h.date);
    }
    return [...dates].sort((a, b) => b.localeCompare(a)); // newest first (left side)
  }, [sortedHistory, pageGridEventFilter]);

  const pageGridRows = useMemo(() => {
    const nos = new Set();
    sortedHistory.forEach((h) => h.machines.forEach((m) => nos.add(m.no)));
    return Array.from(nos).sort((a, b) => a - b);
  }, [sortedHistory]);

  const pageGridMarks = useMemo(() => {
    const map = {};
    sortedHistory.forEach((h) => {
      h.machines.forEach((m) => {
        if (!map[m.no]) map[m.no] = {};
        map[m.no][h.date] = classifyMachineMark(m);
      });
    });
    return map;
  }, [sortedHistory]);

  // v6.12: 台番号×日付のXマトリクス表用データ（設定期待度・数値表示）
  const pageGridXPercentiles = useMemo(() => {
    if (!pageXByDate) return {};
    const pctByDate = computeXPercentiles(pageXByDate);
    const map = {};
    Object.entries(pctByDate).forEach(([date, dayMap]) => {
      Object.entries(dayMap).forEach(([noStr, pct]) => {
        const no = parseInt(noStr, 10);
        if (!map[no]) map[no] = {};
        map[no][date] = pct;
      });
    });
    return map;
  }, [pageXByDate]);

  const overallModelPickList = useMemo(() => {
    const sortedH = overallSortedSummaries.map((s) => ({
      date: s.date,
      event: s.event,
      machines: s.modelRows.map((r) => ({ no: r.name, sada: r.avgSada, gsu: r.avgGsu, shutsu: r.shutsu })),
    }));
    const hbd = {};
    sortedH.forEach((h) => {
      hbd[h.date] = h;
    });
    const names = Array.from(new Set(sortedH.flatMap((h) => h.machines.map((m) => m.no)))).sort();
    const oStrongDateSet = new Set(
      sortedH.filter((h) => h.event && splitEventNames(h.event).some((n) => strongEventColorByName[n])).map((h) => h.date)
    );
    const oSemiDateSet = new Set(
      sortedH
        .filter((h) => h.event && !splitEventNames(h.event).some((n) => strongEventColorByName[n]) && splitEventNames(h.event).some((n) => semiEventColorByName[n]))
        .map((h) => h.date)
    );
    return sortPickResults(computeSignalsForPage(names, sortedH, hbd, overallRecommends, oStrongDateSet, oSemiDateSet, strongEventNameSet, semiEventNameSet, globalBaseRateA));
  }, [overallSortedSummaries, strongEventColorByName, semiEventColorByName, strongEventNameSet, semiEventNameSet, dateEventMap, overallRecommends, globalBaseRateA]);

  const overallDigitPickList = useMemo(() => {
    const sortedH = overallSortedSummaries.map((s) => ({
      date: s.date,
      event: s.event,
      machines: s.digitRows.map((r) => ({ no: r.name, sada: r.avgSada, gsu: r.avgGsu, shutsu: r.shutsu })),
    }));
    const hbd = {};
    sortedH.forEach((h) => {
      hbd[h.date] = h;
    });
    const names = Array.from(new Set(sortedH.flatMap((h) => h.machines.map((m) => m.no)))).sort();
    const oStrongDateSet = new Set(
      sortedH.filter((h) => h.event && splitEventNames(h.event).some((n) => strongEventColorByName[n])).map((h) => h.date)
    );
    const oSemiDateSet = new Set(
      sortedH
        .filter((h) => h.event && !splitEventNames(h.event).some((n) => strongEventColorByName[n]) && splitEventNames(h.event).some((n) => semiEventColorByName[n]))
        .map((h) => h.date)
    );
    return sortPickResults(computeSignalsForPage(names, sortedH, hbd, [], oStrongDateSet, oSemiDateSet, strongEventNameSet, semiEventNameSet, globalBaseRateA));
  }, [overallSortedSummaries, strongEventColorByName, semiEventColorByName, strongEventNameSet, semiEventNameSet, dateEventMap, globalBaseRateA]);

  // system-wide reference accuracy: aggregates every 10/20/30-day threshold
  // rule found across every machine on this page, weighted by sample size.
  // NOTE: this is an in-sample measure (the rule was derived from, and is
  // being checked against, the same historical data) — not a true walk-
  // forward backtest — so treat it as a rough reference, not a guarantee.
  const overallBacktestStats = useMemo(() => {
    let totalWins = 0;
    let totalSamples = 0;
    allMachineNumbers.forEach((no) => {
      const series = sortedHistory
        .map((h) => {
          const m = h.machines.find((mm) => mm.no === no);
          return m && m.sada !== null ? { date: h.date, sada: m.sada } : null;
        })
        .filter(Boolean);
      [10, 20, 30].forEach((w) => {
        const pairs = buildTrailingPairs(series, w);
        const baseRate = computeBaseRate(series);
        const result = findBestThresholds(pairs, 5, baseRate);
        if (result?.bestAbove) {
          totalWins += result.bestAbove.winRate * result.bestAbove.sampleSize;
          totalSamples += result.bestAbove.sampleSize;
        }
        if (result?.bestBelow) {
          totalWins += result.bestBelow.winRate * result.bestBelow.sampleSize;
          totalSamples += result.bestBelow.sampleSize;
        }
      });
    });
    return totalSamples > 0 ? { winRate: totalWins / totalSamples, totalSamples } : null;
  }, [allMachineNumbers, sortedHistory]);

  // machine-to-machine correlation: does machine A's daily 差枚 tend to move
  // with machine B's, on days both have data? (Pearson correlation)
  const machineCorrelations = useMemo(() => {
    const seriesByMachine = {};
    allMachineNumbers.forEach((no) => {
      const map = {};
      sortedHistory.forEach((h) => {
        const m = h.machines.find((mm) => mm.no === no);
        if (m && m.sada !== null) map[h.date] = m.sada;
      });
      seriesByMachine[no] = map;
    });

    const results = [];
    for (let i = 0; i < allMachineNumbers.length; i++) {
      for (let j = i + 1; j < allMachineNumbers.length; j++) {
        const noA = allMachineNumbers[i];
        const noB = allMachineNumbers[j];
        const mapA = seriesByMachine[noA];
        const mapB = seriesByMachine[noB];
        const commonDates = Object.keys(mapA).filter((d) => d in mapB);
        if (commonDates.length < 10) continue;
        const xs = commonDates.map((d) => mapA[d]);
        const ys = commonDates.map((d) => mapB[d]);
        const r = pearsonCorrelation(xs, ys);
        if (r === null) continue;
        if (Math.abs(r) >= 0.4) {
          results.push({ noA, noB, r, sampleSize: commonDates.length });
        }
      }
    }
    results.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    return results.slice(0, 20);
  }, [allMachineNumbers, sortedHistory]);

  function handleDeleteDate(date) {
    persistPageHistory(activePageId, currentHistory.filter((h) => h.date !== date));
    setConfirmDeleteDate(null);
  }

  function handleResetAll() {
    const pageLabel = currentPage && currentPage.name ? currentPage.name : "このページ";
    pushUndoEntry(`「${pageLabel}」のデータをリセット`, historyKey(activePageId), currentHistory);
    persistPageHistory(activePageId, []);
    setSelectedMachines([]);
    setConfirmReset(false);
    setStatus({ type: "ok", msg: "このページのデータを削除しました。" });
  }

  function toggleMachine(no) {
    setSelectedMachines((prev) =>
      prev.includes(no) ? prev.filter((x) => x !== no) : [...prev, no].sort((a, b) => a - b)
    );
  }

  function handleAddStrongEvent() {
    const name = strongName.trim();
    if (!name) {
      setStrongStatus({ type: "error", msg: "イベント名を入力してください。" });
      return;
    }
    const next = [...strongEvents.filter((s) => s.name !== name), { name, color: STRONG_EVENT_COLOR }];
    persistStrongEvents(next);
    rememberEventName(name);
    setStrongStatus({
      type: "ok",
      msg: `「${name}」を強いイベントとして登録しました。このイベント名が付いた日付は、過去・今後を問わず自動で強いイベント扱いになります。`,
    });
    setStrongName("");
  }

  function handleRemoveStrongEvent(name) {
    pushUndoEntry(`強いイベント「${name}」を削除`, STRONG_EVENTS_KEY, strongEvents);
    persistStrongEvents(strongEvents.filter((s) => s.name !== name));
  }

  function handleAddSemiEvent() {
    const name = semiName.trim();
    if (!name) {
      setSemiStatus({ type: "error", msg: "イベント名を入力してください。" });
      return;
    }
    const next = [...semiEvents.filter((s) => s.name !== name), { name, color: SEMI_EVENT_COLOR }];
    persistSemiEvents(next);
    rememberEventName(name);
    setSemiStatus({
      type: "ok",
      msg: `「${name}」を準イベントとして登録しました（強いイベントより弱い扱いになります）。`,
    });
    setSemiName("");
  }

  function handleRemoveSemiEvent(name) {
    pushUndoEntry(`準イベント「${name}」を削除`, SEMI_EVENTS_KEY, semiEvents);
    persistSemiEvents(semiEvents.filter((s) => s.name !== name));
  }

  function handleAddClosedDay() {
    if (!closedDate) {
      setClosedStatus({ type: "error", msg: "日付を入力してください。" });
      return;
    }
    if (closedDays.some((c) => c.date === closedDate)) {
      setClosedStatus({ type: "error", msg: "すでに登録されています。" });
      return;
    }
    const next = [...closedDays, { date: closedDate }];
    persistClosedDays(next);
    setClosedStatus({ type: "ok", msg: `${closedDate} を店休日として登録しました。` });
    setClosedDate(addDays(closedDate, 1));
  }

  function handleRemoveClosedDay(date) {
    pushUndoEntry(`店休日 ${date} を削除`, CLOSED_DAYS_KEY, closedDays);
    persistClosedDays(closedDays.filter((c) => c.date !== date));
  }

  function handleAddRecommend() {
    if (!recommendTargetPageId) return;
    if (!recommendStart || !recommendEnd) {
      setRecommendStatus({ type: "error", msg: "開始日と終了日を入力してください。" });
      return;
    }
    if (recommendStart > recommendEnd) {
      setRecommendStatus({ type: "error", msg: "終了日は開始日より後にしてください。" });
      return;
    }
    const label = recommendLabel.trim() || "おすすめ期間";
    const next = [...recommendTargetList, { id: `rec-${Date.now()}`, startDate: recommendStart, endDate: recommendEnd, label }];
    persistPageRecommends(recommendTargetPageId, next);
    setRecommendStatus({ type: "ok", msg: `${recommendStart}〜${recommendEnd} を「${label}」として登録しました。` });
    setRecommendLabel("");
  }

  function handleRemoveRecommend(id) {
    if (!recommendTargetPageId) return;
    pushUndoEntry("おすすめ機種期間を削除", recommendKey(recommendTargetPageId), recommendTargetList);
    persistPageRecommends(recommendTargetPageId, recommendTargetList.filter((r) => r.id !== id));
  }

  function handleResyncOverallEvents() {
    let changedCount = 0;
    const next = overallSummaries.map((s) => {
      const correctEvent = (dateEventMap[s.date] || "").trim();
      if (s.event === correctEvent) return s;
      changedCount += 1;
      return { ...s, event: correctEvent };
    });
    if (changedCount === 0) {
      setOverallStatus({ type: "ok", msg: "既にすべて最新の状態です。直す必要はありませんでした。" });
      return;
    }
    pushUndoEntry("全体データのイベントを再同期", OVERALL_SUMMARY_KEY, overallSummaries);
    persistOverallSummaries(next);
    setOverallStatus({ type: "ok", msg: `${changedCount}件の日付のイベントを最新の登録内容に合わせて直しました。` });
  }

  function handleAddOverallRecommend() {
    const name = overallRecommendModelName.trim();
    if (!name) {
      setOverallRecommendStatus({ type: "error", msg: "機種名を入力してください。" });
      return;
    }
    if (!overallRecommendStart || !overallRecommendEnd) {
      setOverallRecommendStatus({ type: "error", msg: "開始日と終了日を入力してください。" });
      return;
    }
    if (overallRecommendStart > overallRecommendEnd) {
      setOverallRecommendStatus({ type: "error", msg: "終了日は開始日より後にしてください。" });
      return;
    }
    const label = overallRecommendLabel.trim() || "おすすめ期間";
    const existing = overallRecommends[name] || [];
    const next = { ...overallRecommends, [name]: [...existing, { id: `orec-${Date.now()}`, startDate: overallRecommendStart, endDate: overallRecommendEnd, label }] };
    persistOverallRecommends(next);
    setOverallRecommendStatus({ type: "ok", msg: `「${name}」の${overallRecommendStart}〜${overallRecommendEnd}を「${label}」として登録しました。` });
    setOverallRecommendLabel("");
  }

  function handleRemoveOverallRecommend(name, id) {
    pushUndoEntry(`おすすめ機種期間「${name}」を削除`, OVERALL_RECOMMEND_KEY, overallRecommends);
    const remaining = (overallRecommends[name] || []).filter((r) => r.id !== id);
    const next = { ...overallRecommends };
    if (remaining.length > 0) next[name] = remaining;
    else delete next[name];
    persistOverallRecommends(next);
  }

  async function handleAddFutureEvent() {
    const name = futureEventName.trim();
    if (!futureEventDate || !name) {
      setFutureEventStatus({ type: "error", msg: "日付とイベント名を入力してください。" });
      return;
    }
    const existingNames = splitEventNames(dateEventMap[futureEventDate]);
    if (existingNames.includes(name)) {
      setFutureEventStatus({ type: "error", msg: `${futureEventDate} には既に「${name}」が登録されています。` });
      return;
    }
    const combined = joinEventNames([...existingNames, name]);
    await upsertDateEvent(futureEventDate, combined);
    rememberEventName(name);
    const msg =
      existingNames.length > 0
        ? `${futureEventDate} に「${name}」を追加しました（登録済み：${combined}）。既に保存済みの全ページのデータも更新しました。`
        : `${futureEventDate} に「${name}」を登録しました（既に保存済みの全ページのデータも更新しました）。`;
    setFutureEventStatus({ type: "ok", msg });
    setFutureEventName("");
    setFutureEventDate(addDays(futureEventDate, 1));
  }

  async function handleRemoveDateEvent(date, tagName) {
    const existingNames = splitEventNames(dateEventMap[date]);
    const remainingNames = tagName ? existingNames.filter((n) => n !== tagName) : [];
    const remainingComposite = joinEventNames(remainingNames);
    const label = tagName ? `イベント登録 ${date} の「${tagName}」を削除` : `イベント登録 ${date} を削除`;
    pushUndoEntry(label, DATE_EVENT_MAP_KEY, dateEventMap);
    setDateEventMap((prev) => {
      const next = { ...prev };
      if (remainingComposite) {
        next[date] = remainingComposite;
      } else {
        delete next[date];
      }
      storage.set(DATE_EVENT_MAP_KEY, JSON.stringify(next), false).catch(() => {});
      return next;
    });
    for (const p of pages) {
      let hist = pageHistories[p.id];
      if (hist === undefined) {
        try {
          const res = await storage.get(historyKey(p.id), false);
          hist = res && res.value ? JSON.parse(res.value) : [];
        } catch (e) {
          hist = [];
        }
      }
      const idx = hist.findIndex((h) => h.date === date);
      if (idx === -1 || !hist[idx].event) continue;
      const nextHist = hist.map((h, i) => (i === idx ? { ...h, event: remainingComposite } : h));
      loadedHistoryRef.current.add(p.id);
      setPageHistories((prev) => ({ ...prev, [p.id]: nextHist }));
      storage.set(historyKey(p.id), JSON.stringify(nextHist), false).catch(() => {});
    }
    setOverallSummaries((prevSummaries) => {
      const idx = prevSummaries.findIndex((s) => s.date === date);
      if (idx === -1 || !prevSummaries[idx].event) return prevSummaries;
      const next = prevSummaries.map((s, i) => (i === idx ? { ...s, event: remainingComposite } : s));
      storage.set(OVERALL_SUMMARY_KEY, JSON.stringify(next), false).catch(() => {});
      return next;
    });
  }

  function handleUnlock() {
    if (pinInput.trim() === UNLOCK_PIN) {
      setUnlocked(true);
      setPinInput("");
      setPinError(false);
    } else {
      setPinError(true);
    }
  }

  const viewDateMachines = useMemo(() => {
    const entry = historyByDate[viewDate];
    if (!entry) return null;
    return [...entry.machines].sort((a, b) => (b.sada ?? -Infinity) - (a.sada ?? -Infinity));
  }, [historyByDate, viewDate]);

  // for each machine present on the picked date, a cumulative 差枚 trend for
  // the trailing `viewWindow` days ending on (and including) that date
  const viewWindowDates = useMemo(() => {
    const datesUpTo = sortedHistory.map((h) => h.date).filter((d) => d <= viewDate);
    return datesUpTo.slice(-viewWindow);
  }, [sortedHistory, viewDate, viewWindow]);

  const viewWindowSeries = useMemo(() => {
    if (!viewDateMachines) return [];
    return viewDateMachines.map((vm) => {
      const no = vm.no;
      let cum = 0;
      let started = false;
      let lastSeenDate = null;
      const raw = [];
      viewWindowDates.forEach((date) => {
        const entry = historyByDate[date];
        const m = entry ? entry.machines.find((mm) => mm.no === no) : null;
        if (m && m.sada !== null) {
          cum += m.sada;
          started = true;
          lastSeenDate = date;
        }
        raw.push({ date, value: started ? cum : null });
      });
      const series = raw.map((pt) => (lastSeenDate && pt.date > lastSeenDate ? { ...pt, value: null } : pt));
      const zeroAnchorDate = viewWindowDates.length > 0 ? addDays(viewWindowDates[0], -1) : null;
      const seriesWithZero = zeroAnchorDate ? [{ date: zeroAnchorDate, value: 0 }, ...series] : series;
      return { no, total: cum, series: seriesWithZero };
    });
  }, [viewDateMachines, viewWindowDates, historyByDate]);

  function renderThresholdResult(result, label, pairsCount, minSample) {
    if (!result) {
      return (
        <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "6px" }}>
          {label}：十分なデータがありません（有効な組み合わせ {pairsCount ?? 0}件、最低{minSample ?? 5}件必要）
        </div>
      );
    }
    const { bestAbove, bestBelow } = result;
    return (
      <div style={{ marginBottom: "8px" }}>
        <div style={{ fontSize: "11px", color: "#8b93a3", marginBottom: "2px" }}>{label}</div>
        {bestAbove ? (
          <div style={{ fontSize: "12px", color: "#c7cbd4" }}>
            総差枚が <span className="mono" style={{ color: "#e8b34c" }}>{bestAbove.threshold >= 0 ? "+" : ""}{fmtNum(Math.round(bestAbove.threshold))}枚</span> 以上 →
            翌日プラス率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(bestAbove.winRate * 100)}%</span>
            （{bestAbove.sampleSize}件中、平均{bestAbove.avgNext >= 0 ? "+" : ""}{fmtNum(Math.round(bestAbove.avgNext))}枚）
          </div>
        ) : (
          <div style={{ fontSize: "11px", color: "#5a6272" }}>以上パターン：この台の基準勝率を上回るしきい値は見つかりませんでした（有効な組み合わせ {pairsCount ?? 0}件）</div>
        )}
        {bestBelow ? (
          <div style={{ fontSize: "12px", color: "#c7cbd4" }}>
            総差枚が <span className="mono" style={{ color: "#e8b34c" }}>{bestBelow.threshold >= 0 ? "+" : ""}{fmtNum(Math.round(bestBelow.threshold))}枚</span> 以下 →
            翌日プラス率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(bestBelow.winRate * 100)}%</span>
            （{bestBelow.sampleSize}件中、平均{bestBelow.avgNext >= 0 ? "+" : ""}{fmtNum(Math.round(bestBelow.avgNext))}枚）
          </div>
        ) : (
          <div style={{ fontSize: "11px", color: "#5a6272" }}>以下パターン：この台の基準勝率を上回るしきい値は見つかりませんでした（有効な組み合わせ {pairsCount ?? 0}件）</div>
        )}
      </div>
    );
  }

  // shared card renderer for pickList / overallModelPickList / overallDigitPickList
  // so all three show the exact same signal breakdown (windows, streak, weekday,
  // strong-event follow, planned event, recommend period, relative rotation, etc.)
  function toggleEventFilter(list, setList, name) {
    setList(list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);
  }

  function renderEventMultiSelect(selectedList, setSelectedList) {
    return (
      <div className="scrollbar" style={{ maxHeight: "120px", overflowY: "auto", display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px", padding: "8px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px" }}>
        {allKnownEventNames.length === 0 && <span style={{ fontSize: "11px", color: "#5a6272" }}>登録済みのイベントがまだありません。</span>}
        {allKnownEventNames.map((n) => {
          const active = selectedList.includes(n);
          return (
            <button
              key={n}
              onClick={() => toggleEventFilter(selectedList, setSelectedList, n)}
              style={{
                fontSize: "11px", padding: "3px 8px", borderRadius: "999px", cursor: "pointer",
                border: active ? "1px solid #7aa2f7" : "1px solid #2a323f",
                background: active ? "rgba(122,162,247,0.15)" : "transparent",
                color: active ? "#7aa2f7" : "#8b93a3",
              }}
            >
              {n}
            </button>
          );
        })}
      </div>
    );
  }

  function renderMarkGrid(dates, rows, marksMap, rowLabelFn, varietyCells) {
    if (rows.length === 0 || dates.length === 0) {
      return <div style={{ fontSize: "12px", color: "#5a6272" }}>表示できるデータがまだありません。</div>;
    }
    return (
      <div className="scrollbar" style={{ overflowX: "auto", maxWidth: "100%", width: "100%", WebkitOverflowScrolling: "touch", overscrollBehaviorX: "contain" }}>
        <table style={{ borderCollapse: "collapse", fontSize: "11px" }}>
          <thead>
            <tr>
              <th style={{ position: "sticky", left: 0, zIndex: 2, background: "#12161d", padding: "4px 8px", textAlign: "left", borderBottom: "1px solid #2a323f" }} />
              {dates.map((d) => (
                <th key={d} className="mono" style={{ background: "#12161d", padding: "4px 3px", color: "#5a6272", borderBottom: "1px solid #2a323f", fontSize: "9px", whiteSpace: "nowrap" }}>
                  {d.slice(5)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              return (
              <tr key={row}>
                <td
                  title={rowLabelFn(row)}
                  style={{
                    position: "sticky", left: 0,
                    background: "#12161d",
                    color: "#c7cbd4",
                    padding: "4px 8px", borderBottom: "1px solid #1c2129", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    maxWidth: "112px", boxSizing: "border-box",
                  }}
                >
                  {rowLabelFn(row)}
                </td>
                {dates.map((d) => {
                  const mark = marksMap[row] && marksMap[row][d];
                  const isVarietyCell = varietyCells && varietyCells.has(`${d}|${row}`);
                  return (
                    <td
                      key={d}
                      className="mono"
                      title={isVarietyCell ? "バラエティコーナー（1台設置）" : undefined}
                      style={{
                        padding: "4px 3px", textAlign: "center", color: mark ? markColor(mark) : "#2a323f", borderBottom: "1px solid #1c2129",
                        background: isVarietyCell ? "rgba(122,162,247,0.18)" : undefined,
                        boxShadow: isVarietyCell ? "inset 0 0 0 1px rgba(122,162,247,0.5)" : undefined,
                      }}
                    >
                      {mark || "・"}
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // v6.12: 台番号×日付のXマトリクス表（雑餉隈の「数値」表示と同じ見た目：
  // 色付きの数値をそのまま並べる）。valuesMap は {no: {date: 0-100の
  // パーセンタイル}}。
  function renderXGrid(dates, rows, valuesMap, rowLabelFn) {
    if (rows.length === 0 || dates.length === 0) {
      return <div style={{ fontSize: "12px", color: "#5a6272" }}>表示できるデータがまだありません。</div>;
    }
    return (
      <div className="scrollbar" style={{ overflowX: "auto", maxWidth: "100%", width: "100%", WebkitOverflowScrolling: "touch", overscrollBehaviorX: "contain" }}>
        <table style={{ borderCollapse: "collapse", fontSize: "11px" }}>
          <thead>
            <tr>
              <th style={{ position: "sticky", left: 0, zIndex: 2, background: "#12161d", padding: "4px 8px", textAlign: "left", borderBottom: "1px solid #2a323f" }} />
              {dates.map((d) => (
                <th key={d} className="mono" style={{ background: "#12161d", padding: "4px 3px", color: "#5a6272", borderBottom: "1px solid #2a323f", fontSize: "9px", whiteSpace: "nowrap" }}>
                  {d.slice(5)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row}>
                <td
                  title={rowLabelFn(row)}
                  style={{
                    position: "sticky", left: 0,
                    background: "#12161d",
                    color: "#c7cbd4",
                    padding: "4px 8px", borderBottom: "1px solid #1c2129", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    maxWidth: "112px", boxSizing: "border-box",
                  }}
                >
                  {rowLabelFn(row)}
                </td>
                {dates.map((d) => {
                  const v = valuesMap[row] && valuesMap[row][d];
                  return (
                    <td
                      key={d}
                      className="mono"
                      style={{ padding: "4px 3px", textAlign: "center", color: v !== null && v !== undefined ? fiveBandColor(v) : "#2a323f", borderBottom: "1px solid #1c2129" }}
                    >
                      {v !== null && v !== undefined ? v : "・"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  function renderPickCard(p, labelOverride, xLabelLookup) {
    const xInfo = xLabelLookup ? xLabelLookup(p.no) : null;
    // v6.23: 雑餉隈スタイルの1行フォーマットに変更（バッジ＋長文の2段構成
    // より、こちらの方が見やすいとの指摘）。影響度が大きい順に並べる。
    const sortedItems = p.scoreItems ? [...p.scoreItems].sort((a, b) => Math.abs(b.points) - Math.abs(a.points)) : [];

    return (
      <div key={p.no} style={{ background: "#12161d", border: "1px solid #2a323f", borderRadius: "8px", padding: "10px 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className="mono" style={{ fontSize: "13px", fontWeight: 700, color: "#e8b34c" }}>{labelOverride ? labelOverride(p) : `${p.no}番`}</span>
            {p.grade && (
              <span className="mono" style={{
                fontSize: "13px", fontWeight: 800, width: "22px", height: "22px", lineHeight: "22px",
                textAlign: "center", borderRadius: "50%", color: "#12161d",
                background: { S: "#f2d24b", A: "#9ece6a", B: "#4fd1c5", C: "#7aa2f7", D: "#c7cbd4", E: "#f6a04d", F: "#e5697a", G: "#e5484d" }[p.grade],
              }}>
                {p.grade}
              </span>
            )}
            {xInfo && (
              <span
                className="mono"
                title={`設定期待度: ${xInfo.label}（X予想 ${xInfo.predictedX >= 0 ? "+" : ""}${xInfo.predictedX.toFixed(2)}）`}
                style={{
                  fontSize: "10px", fontWeight: 800, padding: "1px 6px", borderRadius: "999px",
                  color: xInfo.label === "高" ? "#12161d" : xInfo.label === "低" ? "#e7e9ee" : "#c7cbd4",
                  background: xInfo.label === "高" ? "#9ece6a" : xInfo.label === "低" ? "#e5697a" : "#2a323f",
                  cursor: "help",
                }}
              >
                設定{xInfo.label}
              </span>
            )}
          </span>
        </div>
        <div className="mono" style={{ fontSize: "11px", color: p.totalPoints >= 0 ? "#9ece6a" : "#e5697a", marginBottom: "6px", fontWeight: 700 }}>
          合計{p.totalPoints >= 0 ? "+" : ""}{p.totalPoints.toFixed(1)}pt（根拠{p.signalCount}件） {p.lastDate}までのデータで予想
        </div>

        {sortedItems.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: "1px" }}>
            {sortedItems.map((s, i) => (
              <div key={i} className="mono" style={{ fontSize: "11px", color: s.points >= 0 ? "#8b93a3" : "#c99", display: "flex", justifyContent: "space-between", gap: "8px" }}>
                <span>
                  {s.label}
                  {s.detail && (
                    <span style={{ color: "#5a6272" }}>
                      ：実測X {s.detail.avgX >= 0 ? "+" : ""}{s.detail.avgX.toFixed(3)}（n={s.detail.sampleSize}）
                    </span>
                  )}
                </span>
                <span style={{ color: s.points >= 0 ? "#9ece6a" : "#e5697a", fontWeight: 700, whiteSpace: "nowrap" }}>
                  → {s.points >= 0 ? "+" : ""}{s.points.toFixed(1)}pt
                </span>
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: "10px", color: "#5a6272", marginTop: "8px", fontStyle: "italic" }}>
          ※ 「翌日、設定期待度（X）が高くなりそうか」を予想したスコアです。差枚のプラス/マイナスとは別物（設定は基本的に毎日変わるため）で、精度が検証された予測ではないので、あくまで判断材料の一つとして見てください。
        </div>
      </div>
    );
  }

  if (!pagesLoaded) {
    return (
      <div style={{ padding: "24px", color: "#8b93a3", fontFamily: "sans-serif", fontSize: "13px" }}>
        読み込み中...
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: "'Inter', 'Hiragino Sans', sans-serif",
        background: "#12161d",
        color: "#e7e9ee",
        minHeight: "100%",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <datalist id={DATALIST_ID}>
        {eventNames.map((n) => (
          <option value={n} key={n} />
        ))}
      </datalist>

      <style>{`
        .mono { font-family: 'JetBrains Mono', 'Menlo', monospace; font-variant-numeric: tabular-nums; }
        .card { background: #1b212b; border: 1px solid #2a323f; border-radius: 10px; min-width: 0; max-width: 100%; }
        .chip { transition: all .15s ease; cursor: pointer; user-select: none; }
        .chip:hover { transform: translateY(-1px); }
        input[type="date"] { color-scheme: dark; }
        textarea::placeholder { color: #5a6272; }
        .scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .scrollbar::-webkit-scrollbar-thumb { background: #333c4a; border-radius: 3px; }
        .page-tab { cursor: pointer; border: 1px solid #2a323f; border-radius: 8px 8px 0 0; padding: 8px 14px; font-size: 12px; font-weight: 700; background: #1b212b; color: #8b93a3; }
        .page-tab.active { background: #12161d; color: #e8b34c; border-bottom: 1px solid #12161d; }
      `}</style>

      <div style={{ marginBottom: "14px" }}>
        <div style={{ fontSize: "12px", letterSpacing: "0.14em", color: "#e8b34c", fontWeight: 600 }}>
          SLOT HALL DATA TERMINAL
        </div>
        <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "4px 0 2px", display: "flex", alignItems: "baseline", gap: "8px" }}>
          台データ推移トラッカー
          <span className="mono" style={{ fontSize: "12px", fontWeight: 600, color: "#5a6272" }}>v{APP_VERSION}</span>
        </h1>
        <div style={{ fontSize: "13px", color: "#8b93a3" }}>
          表を貼り付けるだけで台ごとに自動集計・グラフ化します
        </div>
      </div>

      {/* page tabs */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: "4px", marginBottom: "0", flexWrap: "wrap" }}>
        <div
          className={"page-tab" + (viewMode === "common" ? " active" : "")}
          onClick={() => setViewMode("common")}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <span>🔧 共通設定</span>
        </div>
        <div
          className={"page-tab" + (viewMode === "overall" ? " active" : "")}
          onClick={() => setViewMode("overall")}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <span>📊 全体データ</span>
        </div>
        {pages.map((p, i) => (
          <div
            key={p.id}
            className={"page-tab" + (viewMode === "page" && p.id === activePageId ? " active" : "")}
            onClick={() => { setActivePageId(p.id); setViewMode("page"); }}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
          >
            <span>{p.name && p.name.trim() ? p.name : `機種${i + 1}`}</span>
            {p.id === activePageId && pages.length > 1 && unlocked && (
              confirmDeletePage === p.id ? (
                <span style={{ display: "flex", gap: "4px" }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeletePage(p.id); }}
                    style={{ fontSize: "10px", color: "#e5697a", background: "none", border: "none", cursor: "pointer" }}
                  >
                    削除
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDeletePage(null); }}
                    style={{ fontSize: "10px", color: "#5a6272", background: "none", border: "none", cursor: "pointer" }}
                  >
                    取消
                  </button>
                </span>
              ) : (
                <Trash2
                  size={11}
                  onClick={(e) => { e.stopPropagation(); setConfirmDeletePage(p.id); }}
                  style={{ opacity: 0.5 }}
                />
              )
            )}
          </div>
        ))}
        {unlocked && (
          <button
            onClick={handleAddPage}
            className="page-tab"
            style={{ display: "flex", alignItems: "center", gap: "4px", color: "#4fd1c5" }}
          >
            <Plus size={12} /> ページ追加
          </button>
        )}
      </div>

      <div style={{ borderTop: "1px solid #2a323f", marginBottom: "16px" }} />

      {viewMode === "common" ? (
        <div style={{ maxWidth: "760px" }}>
          {unlocked ? (
            <>
          {/* v6.9.10: 民レポのデータ入力・登録済み日付一覧を「全体データ」
              タブから移動。共通設定を暗証番号解除の唯一の窓口にする整理の
              一環（各ページ・各タブに個別の解除フォームを置かない） */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              民レポ データ入力（機種別サマリー＋末尾別データ）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              両方の表をそのまま1つに貼り付けてください（「末尾別データ」の行で自動的に区切ります）。日付にはイベント登録の内容が自動で反映されます。
            </div>
            <div style={{ marginBottom: "10px" }}>
              <label style={{ fontSize: "11px", color: "#8b93a3" }}>日付</label>
              <input
                type="date"
                value={overallDate}
                onChange={(e) => {
                  // v6.9.2: previously this only updated the date, leaving
                  // whatever was last pasted sitting in the textarea even
                  // for an empty/未入力 date — confusing when re-entering
                  // data. Now: 登録済みならその内容を読み込み、未登録なら
                  // 空欄にする。
                  const newDate = e.target.value;
                  setOverallDate(newDate);
                  const existing = overallSummaries.find((s) => s.date === newDate);
                  if (existing) {
                    setOverallPasteText(serializeOverallSummary(existing));
                    setOverallStatus({ type: "ok", msg: `${newDate} は登録済みです。編集用に読み込みました。` });
                  } else {
                    setOverallPasteText("");
                    setOverallStatus(null);
                  }
                }}
                style={{
                  display: "block", marginTop: "4px", background: "#12161d", border: "1px solid #2a323f",
                  borderRadius: "6px", padding: "7px 8px", color: "#e7e9ee", fontSize: "13px",
                }}
              />
            </div>
            {dateEventMap[overallDate] && (
              <div style={{
                fontSize: "12px", color: "#e8b34c", marginBottom: "10px", padding: "7px 8px",
                background: "rgba(232,179,76,0.08)", border: "1px solid #2a323f", borderRadius: "6px",
                display: "flex", alignItems: "center", gap: "6px",
              }}>
                <Flag size={12} />
                この日のイベント：{dateEventMap[overallDate]}
              </div>
            )}
            <textarea
              className="mono scrollbar"
              value={overallPasteText}
              onChange={(e) => setOverallPasteText(e.target.value)}
              placeholder={"機種\t平均差枚\t平均G数\t勝率\t出率\nLアズールレーン THE ANIMATION\t3,500\t3,596\t2/4\t132.4%\n...\n末尾別データ\n末尾\t平均差枚\t平均G数\t勝率\t出率\n0\t868\t5,513\t24/56\t105.2%\n..."}
              rows={12}
              style={{
                width: "100%", background: "#0e1218", border: "1px solid #2a323f", borderRadius: "6px",
                padding: "8px", color: "#d7dae0", fontSize: "11.5px", lineHeight: 1.5, resize: "vertical",
                boxSizing: "border-box", marginBottom: "10px",
              }}
            />
            <button
              onClick={handleSaveOverall}
              style={{
                width: "100%", background: "#e8b34c", color: "#1b1508", border: "none", borderRadius: "8px",
                padding: "10px", fontWeight: 700, fontSize: "13px", cursor: "pointer",
              }}
            >
              この日のデータを保存
            </button>
            {overallStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: overallStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {overallStatus.msg}
              </div>
            )}

            <div style={{ marginTop: "20px", borderTop: "1px solid #2a323f", paddingTop: "14px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
                🗂 アナスロ
              </div>
              <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
                機種名・台番号・G数・差枚・BB・RB・合成確率・BB確率・RB確率の一覧表を、店全体分まとめて貼り付けます。正式名称が一致するページ全部に自動反映されます（機種ごとの個別入力は廃止しました）。出率（☆◎◯▲マーク）は差枚とG数から自動で計算されます。
              </div>
              <div style={{ marginBottom: "10px" }}>
                <label style={{ fontSize: "11px", color: "#8b93a3" }}>日付</label>
                <input
                  type="date"
                  value={fullTableDate}
                  onChange={(e) => loadFullTableForDate(e.target.value)}
                  style={{
                    display: "block", marginTop: "4px", background: "#12161d", border: "1px solid #2a323f",
                    borderRadius: "6px", padding: "7px 8px", color: "#e7e9ee", fontSize: "13px",
                  }}
                />
                <div style={{ marginTop: "4px", fontSize: "11px", color: rawFullTable[fullTableDate] ? "#9ece6a" : "#5a6272" }}>
                  {rawFullTable[fullTableDate] ? `この日は登録済み（${rawFullTable[fullTableDate].length}台分）` : "この日はまだ未登録です"}
                </div>
              </div>
              <textarea
                className="mono scrollbar"
                value={fullTablePasteText}
                onChange={(e) => setFullTablePasteText(e.target.value)}
                placeholder={"機種名\t台番号\tG数\t差枚\tBB\tRB\t合成確率\tBB確率\tRB確率\nモンキーターンV\t185\t4,318\t169\t40\t15\t1/78.5\t1/108.0\t1/287.9\n..."}
                rows={10}
                style={{
                  width: "100%", background: "#0e1218", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "8px", color: "#d7dae0", fontSize: "11.5px", lineHeight: 1.5, resize: "vertical",
                  boxSizing: "border-box", marginBottom: "10px",
                }}
              />
              <button
                onClick={() => handleSaveFullTable()}
                style={{
                  width: "100%", background: "#4fd1c5", color: "#0b1f1c", border: "none", borderRadius: "8px",
                  padding: "10px", fontWeight: 700, fontSize: "13px", cursor: "pointer",
                }}
              >
                この日の一括データを保存
              </button>
              {fullTableDuplicateWarning && (
                <div style={{
                  marginTop: "8px", padding: "10px", borderRadius: "6px", fontSize: "12px",
                  background: "#2a1418", border: "1px solid #7a3038", color: "#e5697a",
                }}>
                  ⚠ この内容は {fullTableDuplicateWarning.conflictingDate} と完全に同じデータです。日付を間違えて同じ表を貼り付けていませんか？
                  <div style={{ marginTop: "8px", display: "flex", gap: "8px" }}>
                    <button
                      onClick={() => handleSaveFullTable({ force: true })}
                      style={{ fontSize: "11px", background: "none", border: "1px solid #7a3038", borderRadius: "6px", color: "#e5697a", padding: "5px 8px", cursor: "pointer" }}
                    >
                      同じで間違いない・無視して保存
                    </button>
                    <button
                      onClick={() => setFullTableDuplicateWarning(null)}
                      style={{ fontSize: "11px", background: "none", border: "1px solid #2a323f", borderRadius: "6px", color: "#8b93a3", padding: "5px 8px", cursor: "pointer" }}
                    >
                      取消（貼り直す）
                    </button>
                  </div>
                </div>
              )}
              {fullTableStatus && (
                <div style={{ marginTop: "8px", fontSize: "11px", color: fullTableStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                  {fullTableStatus.msg}
                </div>
              )}
              <div style={{ marginTop: "10px" }}>
                <button
                  onClick={handleCheckFullTableDuplicates}
                  style={{ fontSize: "11px", background: "none", border: "1px solid #2a323f", borderRadius: "6px", color: "#8b93a3", padding: "6px 10px", cursor: "pointer" }}
                >
                  🔍 登録済み日付を重複チェック
                </button>
                {fullTableDuplicateCheckResults && (
                  <div style={{ marginTop: "8px", fontSize: "11px" }}>
                    {fullTableDuplicateCheckResults.length === 0 ? (
                      <span style={{ color: "#9ece6a" }}>重複は見つかりませんでした。</span>
                    ) : (
                      <div style={{ color: "#e5697a" }}>
                        {fullTableDuplicateCheckResults.length}件の重複ペアが見つかりました：
                        <ul style={{ margin: "4px 0 0", paddingLeft: "18px" }}>
                          {fullTableDuplicateCheckResults.map(([a, b]) => (
                            <li key={`${a}-${b}`}>{a} ⇔ {b}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {rawFullTableStatus && (
                <div style={{ marginTop: "8px", fontSize: "11px", color: rawFullTableStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                  {rawFullTableStatus.msg}
                </div>
              )}
            </div>

            <div style={{ marginTop: "16px", borderTop: "1px solid #2a323f", paddingTop: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4" }}>
                  登録済みの日付（{new Set([...overallSummaries.map((s) => s.date), ...Object.keys(rawFullTable)]).size}件）
                </div>
                {overallSummaries.length > 0 && (
                  confirmDeleteAllOverall ? (
                    <span style={{ display: "flex", gap: "6px" }}>
                      <span style={{ fontSize: "11px", color: "#e5697a" }}>本当に全部削除しますか？</span>
                      <button onClick={handleDeleteAllOverall} style={{ fontSize: "11px", color: "#e5697a", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>
                        削除する
                      </button>
                      <button onClick={() => setConfirmDeleteAllOverall(false)} style={{ fontSize: "11px", color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>
                        取消
                      </button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmDeleteAllOverall(true)} style={{ fontSize: "11px", color: "#5a6272", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}>
                      <Trash2 size={11} />
                      民レポを全部削除
                    </button>
                  )
                )}
              </div>
              <div className="scrollbar" style={{ maxHeight: "220px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
                {(!overallSummariesLoaded || !rawFullTableLoaded) && <div style={{ fontSize: "12px", color: "#5a6272" }}>読み込み中...</div>}
                {overallSummariesLoaded && rawFullTableLoaded && overallSortedSummaries.length === 0 && Object.keys(rawFullTable).length === 0 && (
                  <div style={{ fontSize: "12px", color: "#5a6272" }}>まだデータがありません。</div>
                )}
                {(() => {
                  const overallByDate = {};
                  overallSortedSummaries.forEach((s) => { overallByDate[s.date] = s; });
                  // v6.7: 民レポ・アナスロ両方の日付の和集合 — 片方しか登録
                  // されていない日も一覧に出す
                  const allDates = Array.from(new Set([...overallSortedSummaries.map((s) => s.date), ...Object.keys(rawFullTable)])).sort();
                  return [...allDates].reverse().map((date) => {
                    const s = overallByDate[date] || null;
                    const hasFullTable = !!rawFullTable[date];
                    return (
                  <div
                    key={date}
                    onClick={() => (s ? handleEditOverall(s) : (setOverallDate(date), setOverallPasteText(""), setOverallStatus(null), loadFullTableForDate(date)))}
                    title="クリックでこの日のデータを編集"
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                      background: "#12161d", border: "1px solid #232b37", borderRadius: "6px", padding: "6px 8px",
                      cursor: "pointer",
                    }}>
                    <div>
                      <span className="mono">{date}</span>
                      {s && s.event && (() => {
                        const names = splitEventNames(s.event);
                        const isStrong = names.some((n) => strongEventColorByName[n]);
                        const isSemi = !isStrong && names.some((n) => semiEventColorByName[n]);
                        if (isStrong) {
                          return (
                            <span style={{ marginLeft: "6px", color: STRONG_EVENT_COLOR }}>
                              <Star size={10} style={{ display: "inline", marginRight: "2px" }} fill={STRONG_EVENT_COLOR} />
                              {s.event}
                            </span>
                          );
                        }
                        if (isSemi) {
                          return (
                            <span style={{ marginLeft: "6px", color: SEMI_EVENT_COLOR }}>
                              <Flag size={10} style={{ display: "inline", marginRight: "2px" }} />
                              {s.event}
                            </span>
                          );
                        }
                        return (
                          <span style={{ marginLeft: "6px", color: EVENT_STAR_COLOR }}>
                            <Star size={10} style={{ display: "inline", marginRight: "2px" }} />
                            {s.event}
                          </span>
                        );
                      })()}
                      {s && <span style={{ marginLeft: "6px", color: "#5a6272" }}>機種{s.modelRows.length}・末尾{s.digitRows.length}</span>}
                      <span style={{ marginLeft: "6px", color: s ? "#9ece6a" : "#e5697a" }}>
                        民レポ{s ? "〇" : "未登録"}
                      </span>
                      <span style={{ marginLeft: "6px", color: hasFullTable ? "#9ece6a" : "#e5697a" }}>
                        アナスロ{hasFullTable ? "〇" : "未登録"}
                      </span>
                    </div>
                    {s || hasFullTable ? (
                      confirmDeleteOverall === date ? (
                        <div style={{ display: "flex", gap: "6px" }} onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => (s ? handleDeleteOverall(date) : handleDeleteFullTableDate(date))}
                            style={{ fontSize: "11px", color: "#e5697a", background: "none", border: "none", cursor: "pointer" }}
                          >
                            削除する
                          </button>
                          <button onClick={() => setConfirmDeleteOverall(null)} style={{ fontSize: "11px", color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>取消</button>
                        </div>
                      ) : (
                        <button onClick={(e) => { e.stopPropagation(); setConfirmDeleteOverall(date); }} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }}>
                          <Trash2 size={13} />
                        </button>
                      )
                    ) : null}
                  </div>
                    );
                  });
                })()}
              </div>
            </div>
          </div>

          {/* export everything for offline analysis / backtesting */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              📤 データをエクスポート
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              全機種のデータ（日付・イベント名・台番号ごとの差枚/G数/出率/BB/RB/合成）、共通のイベント登録、強いイベント、店休日、おすすめ機種期間、全体データを、まとめて1つのJSONファイルとして書き出します。
            </div>
            <button
              onClick={handleExportData}
              style={{
                width: "100%", background: "#7aa2f7", color: "#12161d", border: "none", borderRadius: "8px",
                padding: "10px", fontWeight: 700, fontSize: "13px", cursor: "pointer",
              }}
            >
              ダウンロード
            </button>
          </div>

          {/* v6.9.14: one-time repair for the バラエティ misparse bug (v6.9.13) */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🛠 バラエティ機種の差枚を修復（v6.9.13より前のバグ対応）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              以前のバグで、民レポの「バラエティ（1台設置機種）」の行は台番号が差枚として、差枚がG数として保存されてしまっていました。「勝率が読み取れなかった行」を目印に自動で候補を探し、内容を確認してから直せます（機種名では判定していないので、新台入れ替えでラインナップが変わっても対応できます）。G数自体は元のバグでどこにも残っていませんが、差枚と出率から標準的な計算式（1G＝3枚投入）で逆算した推定値で埋めます（実データで検証済み、多くの場合誤差1%未満。出率が100%に近い台だけ推定できません）。
            </div>
            <button
              onClick={scanVarietyRepairCandidates}
              style={{
                background: "none", border: "1px solid #2a323f", borderRadius: "6px", color: "#8b93a3",
                padding: "7px 12px", fontSize: "12px", cursor: "pointer", marginBottom: "10px",
              }}
            >
              修復候補を探す
            </button>
            {varietyRepairDone && (
              <div style={{ fontSize: "12px", color: "#9ece6a", marginBottom: "10px" }}>✓ 修復を反映しました。</div>
            )}
            {varietyRepairPreview && (
              varietyRepairPreview.fixCandidates.length === 0 && varietyRepairPreview.deleteCandidates.length === 0 ? (
                <div style={{ fontSize: "12px", color: "#5a6272" }}>修復・削除が必要そうな行は見つかりませんでした。</div>
              ) : (
                <>
                  {varietyRepairPreview.fixCandidates.length > 0 && (
                    <>
                      <div style={{ fontSize: "12px", color: "#e8b34c", marginBottom: "8px" }}>
                        {varietyRepairPreview.fixCandidates.length}件、差枚の修復候補が見つかりました。G数は差枚と出率から逆算した推定値です（出率が100%に近い機種は精度が落ちます、その場合は空欄のままにします）。
                      </div>
                      <div className="scrollbar" style={{ maxHeight: "220px", overflowY: "auto", marginBottom: "14px" }}>
                        <table style={{ width: "100%", fontSize: "11px", borderCollapse: "collapse" }}>
                          <thead>
                            <tr style={{ color: "#5a6272", textAlign: "left" }}>
                              <th style={{ padding: "3px 6px" }}>日付</th>
                              <th style={{ padding: "3px 6px" }}>機種名</th>
                              <th style={{ padding: "3px 6px" }}>今の平均差枚(実は台番号)</th>
                              <th style={{ padding: "3px 6px" }}>→ 修復後の平均差枚</th>
                              <th style={{ padding: "3px 6px" }}>推定G数</th>
                            </tr>
                          </thead>
                          <tbody>
                            {varietyRepairPreview.fixCandidates.map((c, i) => (
                              <tr key={i} style={{ borderTop: "1px solid #1c2129" }}>
                                <td style={{ padding: "3px 6px", color: "#8b93a3" }} className="mono">{c.date}</td>
                                <td style={{ padding: "3px 6px", color: "#c7cbd4" }}>{c.name}</td>
                                <td style={{ padding: "3px 6px", color: "#e5697a" }} className="mono">{c.oldAvgSada}</td>
                                <td style={{ padding: "3px 6px", color: "#9ece6a" }} className="mono">{c.fixedAvgSada}</td>
                                <td style={{ padding: "3px 6px", color: c.estimatedAvgGsu !== null ? "#7aa2f7" : "#5a6272" }} className="mono">
                                  {c.estimatedAvgGsu !== null ? `約${c.estimatedAvgGsu}` : "推定不可"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                  {varietyRepairPreview.deleteCandidates.length > 0 && (
                    <>
                      <div style={{ fontSize: "12px", color: "#e5697a", marginBottom: "8px" }}>
                        {varietyRepairPreview.deleteCandidates.length}件、中身が空のゴミ行（見出し行とヘッダー行がくっついたもの）が見つかりました。復元できる数字が無いため削除します。
                      </div>
                      <div className="scrollbar" style={{ maxHeight: "160px", overflowY: "auto", marginBottom: "14px" }}>
                        <table style={{ width: "100%", fontSize: "11px", borderCollapse: "collapse" }}>
                          <thead>
                            <tr style={{ color: "#5a6272", textAlign: "left" }}>
                              <th style={{ padding: "3px 6px" }}>日付</th>
                              <th style={{ padding: "3px 6px" }}>削除される行の名前</th>
                            </tr>
                          </thead>
                          <tbody>
                            {varietyRepairPreview.deleteCandidates.map((c, i) => (
                              <tr key={i} style={{ borderTop: "1px solid #1c2129" }}>
                                <td style={{ padding: "3px 6px", color: "#8b93a3" }} className="mono">{c.date}</td>
                                <td style={{ padding: "3px 6px", color: "#e5697a" }}>{c.name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                  <button
                    onClick={applyVarietyRepair}
                    style={{
                      background: "#e8b34c", color: "#1b1508", border: "none", borderRadius: "6px",
                      padding: "8px 14px", fontSize: "12px", fontWeight: 700, cursor: "pointer",
                    }}
                  >
                    修復{varietyRepairPreview.fixCandidates.length}件・削除{varietyRepairPreview.deleteCandidates.length}件を反映する
                  </button>
                </>
              )
            )}
          </div>

          {/* recommended-model periods — one shared panel, target machine chosen via dropdown */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🏆 おすすめ機種期間
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              このお店の「月のおすすめ」「期間限定のおすすめ」など、機種が対象になっている期間を自由な日付範囲で登録できます（月曜〜金曜や7日間である必要はありません）。対象の機種を選んでから登録してください。「本日のピックアップ」で、その機種のこの期間中の実績も見ます。
            </div>
            <div style={{ marginBottom: "10px" }}>
              <label style={{ fontSize: "11px", color: "#8b93a3" }}>対象の機種</label>
              <select
                value={recommendTargetPageId || ""}
                onChange={(e) => setRecommendTargetPageId(e.target.value)}
                style={{
                  width: "100%", marginTop: "4px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", boxSizing: "border-box",
                }}
              >
                {pages.map((p, i) => (
                  <option key={p.id} value={p.id}>{p.name && p.name.trim() ? p.name : `機種${i + 1}`}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
              <input
                type="date"
                value={recommendStart}
                onChange={(e) => setRecommendStart(e.target.value)}
                style={{
                  flex: "1 1 120px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
              <span style={{ color: "#5a6272", alignSelf: "center" }}>〜</span>
              <input
                type="date"
                value={recommendEnd}
                onChange={(e) => setRecommendEnd(e.target.value)}
                style={{
                  flex: "1 1 120px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
            </div>
            <input
              type="text"
              value={recommendLabel}
              onChange={(e) => setRecommendLabel(e.target.value)}
              placeholder="ラベル（例：7月のおすすめ、今週のイチ押し など）"
              style={{
                width: "100%", marginBottom: "8px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", boxSizing: "border-box",
              }}
            />
            <button
              onClick={handleAddRecommend}
              style={{
                width: "100%", background: "#bb9af7", color: "#12161d", border: "none", borderRadius: "8px",
                padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
              }}
            >
              おすすめ期間として登録
            </button>
            {recommendStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: recommendStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {recommendStatus.msg}
              </div>
            )}

            <div className="scrollbar" style={{ marginTop: "12px", maxHeight: "160px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {[...recommendTargetList].sort((a, b) => b.startDate.localeCompare(a.startDate)).map((r) => (
                <div key={r.id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                  background: "#12161d", border: "1px solid #2a2540", borderRadius: "6px", padding: "5px 8px", gap: "8px",
                }}>
                  <span style={{ minWidth: 0 }}>
                    <span className="mono" style={{ color: "#bb9af7" }}>{r.startDate}〜{r.endDate}</span>
                    <span style={{ marginLeft: "6px", color: "#c7cbd4" }}>{r.label}</span>
                    {recommendPeriodStats[r.id] && (
                      <div style={{ fontSize: "10px", color: "#5a6272", marginTop: "2px" }}>
                        実績：勝率<span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(recommendPeriodStats[r.id].winRate * 100)}%</span>
                        ・平均{recommendPeriodStats[r.id].avg >= 0 ? "+" : ""}{fmtNum(Math.round(recommendPeriodStats[r.id].avg))}枚
                        （{recommendPeriodStats[r.id].total}件）
                      </div>
                    )}
                  </span>
                  <button onClick={() => handleRemoveRecommend(r.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272", flexShrink: 0 }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {recommendTargetList.length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録されたおすすめ期間はまだありません。</div>
              )}
            </div>
          </div>

          {/* recommended-model periods keyed by MODEL NAME — for 全体データ
              (機種別サマリー) models, including ones that aren't a tracked
              page. a tracked page whose 正式名称 matches will also see these
              periods in its own daily pickup. */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🏆 おすすめ機種期間（機種名で登録・全体データ用）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              追跡していない機種も含めて、機種名を直接指定しておすすめ期間を登録できます。「全体データ」タブの機種別ピックアップに反映されます。ページの「正式名称」欄と同じ名前を使うと、そのページ自身の毎日のピックアップにも反映されます。
            </div>
            <div style={{ marginBottom: "10px" }}>
              <label style={{ fontSize: "11px", color: "#8b93a3" }}>機種名</label>
              <input
                type="text"
                list={MODEL_NAME_DATALIST_ID}
                value={overallRecommendModelName}
                onChange={(e) => setOverallRecommendModelName(e.target.value)}
                placeholder="例：Lパチスロからくりサーカス2"
                style={{
                  width: "100%", marginTop: "4px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", boxSizing: "border-box",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
              <input
                type="date"
                value={overallRecommendStart}
                onChange={(e) => setOverallRecommendStart(e.target.value)}
                style={{
                  flex: "1 1 120px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
              <span style={{ color: "#5a6272", alignSelf: "center" }}>〜</span>
              <input
                type="date"
                value={overallRecommendEnd}
                onChange={(e) => setOverallRecommendEnd(e.target.value)}
                style={{
                  flex: "1 1 120px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
            </div>
            <input
              type="text"
              value={overallRecommendLabel}
              onChange={(e) => setOverallRecommendLabel(e.target.value)}
              placeholder="ラベル（例：7月のおすすめ、今週のイチ押し など）"
              style={{
                width: "100%", marginBottom: "8px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", boxSizing: "border-box",
              }}
            />
            <button
              onClick={handleAddOverallRecommend}
              style={{
                width: "100%", background: "#bb9af7", color: "#12161d", border: "none", borderRadius: "8px",
                padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
              }}
            >
              おすすめ期間として登録
            </button>
            {overallRecommendStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: overallRecommendStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {overallRecommendStatus.msg}
              </div>
            )}

            <div className="scrollbar" style={{ marginTop: "12px", maxHeight: "220px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {Object.entries(overallRecommends)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .flatMap(([name, periods]) =>
                  [...periods]
                    .sort((a, b) => b.startDate.localeCompare(a.startDate))
                    .map((r) => ({ name, ...r }))
                )
                .map((r) => (
                  <div key={r.id} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                    background: "#12161d", border: "1px solid #2a2540", borderRadius: "6px", padding: "5px 8px", gap: "8px",
                  }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ color: "#e8b34c", fontWeight: 700 }}>{r.name}</span>
                      <br />
                      <span className="mono" style={{ color: "#bb9af7" }}>{r.startDate}〜{r.endDate}</span>
                      <span style={{ marginLeft: "6px", color: "#c7cbd4" }}>{r.label}</span>
                      {overallRecommendPeriodStats[r.name] && overallRecommendPeriodStats[r.name][r.id] && (
                        <div style={{ fontSize: "10px", color: "#5a6272", marginTop: "2px" }}>
                          実績：勝率<span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(overallRecommendPeriodStats[r.name][r.id].winRate * 100)}%</span>
                          ・平均{overallRecommendPeriodStats[r.name][r.id].avg >= 0 ? "+" : ""}{fmtNum(Math.round(overallRecommendPeriodStats[r.name][r.id].avg))}枚
                          （{overallRecommendPeriodStats[r.name][r.id].total}日）
                        </div>
                      )}
                    </span>
                    <button onClick={() => handleRemoveOverallRecommend(r.name, r.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272", flexShrink: 0 }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              {Object.keys(overallRecommends).length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録されたおすすめ期間はまだありません。</div>
              )}
            </div>
          </div>

          {/* strong event management (global, shared across all pages) */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4", display: "flex", alignItems: "center", gap: "6px" }}>
              <Star size={13} color={STRONG_EVENT_COLOR} fill={STRONG_EVENT_COLOR} />
              強いイベント（全ページ共通）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              イベント名を1度登録すれば、そのイベント名が付いた日付は過去・今後を問わず全ページのグラフに自動で表示されます（日付ごとの再登録は不要です）。グラフでは赤い塗りつぶしの★で表示されます。
            </div>

            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                type="text"
                list={DATALIST_ID}
                value={strongName}
                onChange={(e) => setStrongName(e.target.value)}
                placeholder="イベント名（例：末尾7の日）"
                style={{
                  flex: 1, background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", minWidth: 0,
                }}
              />
            </div>
            <button
              onClick={handleAddStrongEvent}
              style={{
                width: "100%", background: STRONG_EVENT_COLOR, color: "#12161d", border: "none", borderRadius: "8px",
                padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
              }}
            >
              強いイベントとして登録
            </button>
            {strongStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: strongStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {strongStatus.msg}
              </div>
            )}

            <div className="scrollbar" style={{ marginTop: "12px", maxHeight: "160px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {[...strongEvents].sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
                <div key={s.name} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                  background: "#12161d", border: "1px solid #2a2229", borderRadius: "6px", padding: "5px 8px",
                }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: s.color || "#e5484d", display: "inline-block" }} />
                    <span style={{ color: "#c7cbd4" }}>{s.name}</span>
                  </span>
                  <button onClick={() => handleRemoveStrongEvent(s.name)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {strongEvents.length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録された強いイベントはまだありません。</div>
              )}
            </div>
          </div>

          {/* semi event management — a third, weaker tier: 強いイベント ＞ イベント ＞ 準イベント */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4", display: "flex", alignItems: "center", gap: "6px" }}>
              <Flag size={12} color={SEMI_EVENT_COLOR} />
              準イベント（全ページ共通・強いイベントより弱い扱い）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              「理由はあるけど強いイベントというほどではない」ものを登録します。強いイベントと同じ日付には登録しないでください（強いイベントの方が優先されます）。グラフでは緑の点線・旗マークで表示され、ピックアップでは強いイベントより控えめな重みで反映されます。
            </div>

            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                type="text"
                list={DATALIST_ID}
                value={semiName}
                onChange={(e) => setSemiName(e.target.value)}
                placeholder="イベント名（例：末尾5の日）"
                style={{
                  flex: 1, background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", minWidth: 0,
                }}
              />
            </div>
            <button
              onClick={handleAddSemiEvent}
              style={{
                width: "100%", background: SEMI_EVENT_COLOR, color: "#12161d", border: "none", borderRadius: "8px",
                padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
              }}
            >
              準イベントとして登録
            </button>
            {semiStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: semiStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {semiStatus.msg}
              </div>
            )}

            <div className="scrollbar" style={{ marginTop: "12px", maxHeight: "160px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {[...semiEvents].sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
                <div key={s.name} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                  background: "#12161d", border: "1px solid #232b37", borderRadius: "6px", padding: "5px 8px",
                }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: s.color || "#7aa2f7", display: "inline-block" }} />
                    <span style={{ color: "#c7cbd4" }}>{s.name}</span>
                  </span>
                  <button onClick={() => handleRemoveSemiEvent(s.name)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {semiEvents.length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録された準イベントはまだありません。</div>
              )}
            </div>
          </div>

          {/* the ONE place to register an event for any date — past, today, or future.
              Saving any page automatically pulls the event from here, and registering
              here retroactively patches every page's already-saved data too. */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              📅 イベント登録（全ページ共通）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              過去・今日・未来、どの日付でもここでイベント名を登録できます。同じ日に複数のイベント（例：「2のつく日」＋「新台入れ替え」）を追加登録することもできます。各ページの「データ入力」にはイベント欄はもう無く、保存するときにここの登録内容を自動で読み込みます。ここで登録・削除すると、既に保存済みの全ページのデータも自動で書き換わります（再保存は不要です）。
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                type="date"
                value={futureEventDate}
                onChange={(e) => setFutureEventDate(e.target.value)}
                style={{
                  flex: "0 0 130px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
              <input
                type="text"
                list={DATALIST_ID}
                value={futureEventName}
                onChange={(e) => setFutureEventName(e.target.value)}
                placeholder="イベント名（例：末尾7の日）"
                style={{
                  flex: 1, background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", minWidth: 0,
                }}
              />
            </div>
            <button
              onClick={handleAddFutureEvent}
              style={{
                width: "100%", background: "#7aa2f7", color: "#12161d", border: "none", borderRadius: "8px",
                padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
              }}
            >
              イベントとして登録
            </button>
            {futureEventStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: futureEventStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {futureEventStatus.msg}
              </div>
            )}

            <div className="scrollbar" style={{ marginTop: "12px", maxHeight: "200px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {Object.entries(dateEventMap)
                .sort((a, b) => b[0].localeCompare(a[0]))
                .map(([d, composite]) => (
                  <div key={d} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                    background: "#12161d", border: "1px solid #232b37", borderRadius: "6px", padding: "5px 8px", gap: "8px",
                  }}>
                    <span className="mono" style={{ color: "#7aa2f7", flexShrink: 0 }}>{d}</span>
                    <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", flex: 1 }}>
                      {splitEventNames(composite).map((tag) => (
                        <span key={tag} style={{
                          display: "inline-flex", alignItems: "center", gap: "4px",
                          background: "#1b212b", borderRadius: "4px", padding: "2px 6px", color: "#c7cbd4",
                        }}>
                          {tag}
                          <button
                            onClick={() => handleRemoveDateEvent(d, tag)}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272", padding: 0, display: "flex" }}
                            title={`「${tag}」だけ削除`}
                          >
                            <Trash2 size={10} />
                          </button>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              {Object.keys(dateEventMap).length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録されたイベントはまだありません。</div>
              )}
            </div>
          </div>

          {/* closed days (global, shared across all pages) */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              店休日（全ページ共通）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              登録した日付は、全ページのグラフにグレーの帯「休」で表示されます
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                type="date"
                value={closedDate}
                onChange={(e) => setClosedDate(e.target.value)}
                style={{
                  flex: 1, background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
              <button
                onClick={handleAddClosedDay}
                style={{
                  background: "#3a4150", color: "#e7e9ee", border: "none", borderRadius: "6px",
                  padding: "0 12px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
                }}
              >
                登録
              </button>
            </div>
            {closedStatus && (
              <div style={{ marginBottom: "8px", fontSize: "11px", color: closedStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {closedStatus.msg}
              </div>
            )}
            <div className="scrollbar" style={{ maxHeight: "140px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {[...closedDays].sort((a, b) => b.date.localeCompare(a.date)).map((c) => (
                <div key={c.date} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                  background: "#12161d", border: "1px solid #232b37", borderRadius: "6px", padding: "5px 8px",
                }}>
                  <span className="mono" style={{ color: "#c7cbd4" }}>{c.date}　休</span>
                  <button onClick={() => handleRemoveClosedDay(c.date)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {closedDays.length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録された店休日はまだありません。</div>
              )}
            </div>
          </div>

              <button
                onClick={() => { setUnlocked(false); setPinInput(""); setPinError(false); }}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
                  width: "100%", background: "transparent", border: "1px solid #2a323f", borderRadius: "8px",
                  padding: "8px", color: "#5a6272", fontSize: "12px", cursor: "pointer",
                }}
              >
                <Lock size={12} /> ロックする（データ入力・共通設定すべて）
              </button>
            </>
          ) : (
            <div className="card" style={{ padding: "18px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "8px", color: "#c7cbd4", display: "flex", alignItems: "center", gap: "6px" }}>
                <Lock size={14} /> ロック中です
              </div>
              <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
                暗証番号を入力すると、民レポ・台データの入力、イベント登録・強いイベント・店休日・おすすめ機種期間の編集など、データ入力に関わる操作をこの1箇所で解除できます（各ページ個別の解除は不要です）。この解除状態は今開いているこの画面だけのもので、他の端末や再読み込み後には引き継がれません。
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  type="password"
                  inputMode="numeric"
                  value={pinInput}
                  onChange={(e) => { setPinInput(e.target.value); setPinError(false); }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleUnlock(); }}
                  placeholder="暗証番号"
                  style={{
                    flex: 1, background: "#12161d", border: "1px solid " + (pinError ? "#e5697a" : "#2a323f"),
                    borderRadius: "6px", padding: "8px", color: "#e7e9ee", fontSize: "13px",
                  }}
                />
                <button
                  onClick={handleUnlock}
                  style={{
                    background: "#e8b34c", color: "#1b1508", border: "none", borderRadius: "8px",
                    padding: "0 16px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
                  }}
                >
                  解除
                </button>
              </div>
              {pinError && (
                <div style={{ marginTop: "8px", fontSize: "11px", color: "#e5697a" }}>暗証番号が違います。</div>
              )}
            </div>
          )}
        </div>
      ) : viewMode === "overall" ? (
        <div style={{ maxWidth: "760px" }}>
          {/* one-click fix for stale event fields on already-saved 全体データ
              days — needed because retroactive event registration only
              patches records going forward from when it happens, not data
              saved before that fix existed */}
          {unlocked && (
            <>
          <div className="card" style={{ padding: "14px 18px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
            <div style={{ fontSize: "11px", color: "#5a6272" }}>
              過去に登録・変更したイベントが、全体データ側に反映されていないことがあります。ボタンを押すと、今のイベント登録内容に合わせて全部の日付を最新化します。
            </div>
            <button
              onClick={handleResyncOverallEvents}
              style={{
                background: "#4fd1c5", color: "#12161d", border: "none", borderRadius: "8px",
                padding: "8px 14px", fontWeight: 700, fontSize: "12px", cursor: "pointer", flexShrink: 0,
              }}
            >
              イベントを再同期
            </button>
          </div>
          {overallStatus && (
            <div style={{ marginTop: "-10px", marginBottom: "14px", fontSize: "11px", color: overallStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
              {overallStatus.msg}
            </div>
          )}
          </>
          )}

          {/* store-wide daily totals, reconstructed from 機種別サマリー — shows
              the real signed 総差枚/平均差枚, even on days min-repo itself hides
              the negative total */}
          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              📈 店全体の推移（総差枚・平均差枚・平均G数）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              「機種別サマリー」の平均差枚×台数を全機種分足し合わせて算出しています。マイナスも隠さずそのまま表示します。
            </div>
            {dailyStoreTotals.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>まだデータがありません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "320px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ position: "sticky", top: 0, background: "#12161d" }}>
                      <th style={{ textAlign: "left", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>日付</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>総差枚</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>平均差枚</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>平均G数</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>台数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyStoreTotals.flatMap((d) => {
                      const rows = [
                        <tr key={d.date}>
                          <td className="mono" style={{ padding: "5px 8px", color: "#c7cbd4", borderBottom: d.marks.length > 0 ? "none" : "1px solid #1c2129" }}>
                            {d.date}
                            {d.event && d.eventTier === "strong" && (
                              <span style={{ marginLeft: "6px", color: STRONG_EVENT_COLOR, fontSize: "10px" }}>★{d.event}</span>
                            )}
                            {d.event && d.eventTier === "semi" && (
                              <span style={{ marginLeft: "6px", color: SEMI_EVENT_COLOR, fontSize: "10px" }}>🚩{d.event}</span>
                            )}
                            {d.event && d.eventTier === "event" && (
                              <span style={{ marginLeft: "6px", color: EVENT_STAR_COLOR, fontSize: "10px" }}>☆{d.event}</span>
                            )}
                          </td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: d.totalSamai >= 0 ? "#9ece6a" : "#e5697a", borderBottom: d.marks.length > 0 ? "none" : "1px solid #1c2129" }}>
                            {d.totalSamai === null ? "―" : `${d.totalSamai >= 0 ? "+" : ""}${fmtNum(d.totalSamai)}`}
                          </td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: d.avgSamai >= 0 ? "#9ece6a" : "#e5697a", borderBottom: d.marks.length > 0 ? "none" : "1px solid #1c2129" }}>
                            {d.avgSamai === null ? "―" : `${d.avgSamai >= 0 ? "+" : ""}${fmtNum(Math.round(d.avgSamai))}`}
                          </td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#c7cbd4", borderBottom: d.marks.length > 0 ? "none" : "1px solid #1c2129" }}>
                            {d.avgGsu === null ? "―" : fmtNum(Math.round(d.avgGsu))}
                          </td>
                          <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#5a6272", borderBottom: d.marks.length > 0 ? "none" : "1px solid #1c2129" }}>
                            {d.machineCount || "―"}
                          </td>
                        </tr>,
                      ];
                      if (d.marks.length > 0) {
                        rows.push(
                          <tr key={d.date + "-marks"}>
                            <td colSpan={5} style={{ padding: "2px 8px 8px 8px", borderBottom: "1px solid #1c2129", fontSize: "11px" }}>
                              {d.marks.map((m, i) => (
                                <div key={i} style={{ color: markColor(m.mark) }}>
                                  {m.mark}{m.name}
                                </div>
                              ))}
                            </td>
                          </tr>
                        );
                      }
                      return rows;
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* イベントを選択して過去を見る */}
          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              📅 イベントを選択して過去を見る
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              登録済みのイベント名（強い/準/通常すべて）から選ぶと、そのイベントがあった過去の日付一覧と、その日の☆◎◯▲機種を表示します。
            </div>
            <select
              value={eventHistorySelection}
              onChange={(e) => setEventHistorySelection(e.target.value)}
              style={{
                width: "100%", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", marginBottom: "10px",
              }}
            >
              <option value="">イベントを選択...</option>
              {allKnownEventNames.map((n) => (
                <option value={n} key={n}>{n}</option>
              ))}
            </select>
            {eventHistorySelection && eventHistoryResults.length === 0 && (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>このイベントの過去データはまだありません。</div>
            )}
            {eventHistoryResults.length > 0 && (
              <div className="scrollbar" style={{ maxHeight: "320px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px" }}>
                {eventHistoryResults.map((d) => (
                  <div key={d.date} style={{ background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px", padding: "8px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px" }}>
                      <span className="mono" style={{ color: "#c7cbd4" }}>{d.date}</span>
                      <span className="mono">
                        総差枚 <span style={{ color: d.totalSamai >= 0 ? "#9ece6a" : "#e5697a", fontWeight: 700 }}>
                          {d.totalSamai === null ? "―" : `${d.totalSamai >= 0 ? "+" : ""}${fmtNum(d.totalSamai)}`}
                        </span>
                        {"　"}平均{d.avgSamai === null ? "―" : `${d.avgSamai >= 0 ? "+" : ""}${fmtNum(Math.round(d.avgSamai))}`}枚
                        {"　"}G数{d.avgGsu === null ? "―" : fmtNum(Math.round(d.avgGsu))}
                      </span>
                    </div>
                    {d.marks.length > 0 && (
                      <div style={{ fontSize: "11px" }}>
                        {d.marks.map((m, i) => (
                          <div key={i} style={{ color: markColor(m.mark) }}>
                            {m.mark}{m.name}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 機種を選択して過去一覧を見る */}
          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🎰 機種を選択して過去一覧を見る
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              機種別サマリーに登場した機種名から選ぶと、日付ごとの平均差枚・G数・出率・勝率の一覧を表示します。イベントでの絞り込みも可能です。
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "10px", flexWrap: "wrap" }}>
              <select
                value={modelHistorySelection}
                onChange={(e) => setModelHistorySelection(e.target.value)}
                style={{
                  flex: "2 1 220px", minWidth: 0, background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px",
                }}
              >
                <option value="">機種を選択...</option>
                {allKnownModelNames.map((n) => (
                  <option value={n} key={n}>{n}</option>
                ))}
              </select>
              <select
                value={modelHistoryEventFilter}
                onChange={(e) => setModelHistoryEventFilter(e.target.value)}
                style={{
                  flex: "1 1 160px", minWidth: 0, background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px",
                }}
              >
                <option value="">イベントで絞り込み（任意）</option>
                {allKnownEventNames.map((n) => (
                  <option value={n} key={n}>{n}</option>
                ))}
              </select>
            </div>
            {modelHistorySelection && modelHistoryResults.length === 0 && (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>該当するデータはまだありません。</div>
            )}
            {modelHistoryResults.length > 0 && (
              <div className="scrollbar" style={{ maxHeight: "360px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ position: "sticky", top: 0, background: "#12161d" }}>
                      <th style={{ textAlign: "left", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>日付</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>平均差枚</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>G数</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>出率</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>勝率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelHistoryResults.map((r) => (
                      <tr key={r.date}>
                        <td className="mono" style={{ padding: "5px 8px", color: "#c7cbd4", borderBottom: "1px solid #1c2129" }}>
                          {r.mark && <span style={{ marginRight: "4px", color: markColor(r.mark) }}>{r.mark}</span>}
                          {r.date}
                          {r.event && <span style={{ marginLeft: "6px", color: "#5a6272", fontSize: "10px" }}>{r.event}</span>}
                        </td>
                        <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: r.avgSada >= 0 ? "#9ece6a" : "#e5697a", borderBottom: "1px solid #1c2129" }}>
                          {r.avgSada === null ? "―" : `${r.avgSada >= 0 ? "+" : ""}${fmtNum(Math.round(r.avgSada))}`}
                        </td>
                        <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#c7cbd4", borderBottom: "1px solid #1c2129" }}>
                          {r.avgGsu === null ? "―" : fmtNum(Math.round(r.avgGsu))}
                        </td>
                        <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#c7cbd4", borderBottom: "1px solid #1c2129" }}>
                          {r.shutsu === null ? "―" : `${r.shutsu}%`}
                        </td>
                        <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#c7cbd4", borderBottom: "1px solid #1c2129" }}>
                          {r.wins === null || !r.total ? "―" : `${r.wins}/${r.total}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>


          {/* 機種×日付マトリクス表（台数順・イベント複数選択で絞り込み） */}
          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              📋 機種×日付マトリクス表
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              機種名を台数の多い順に並べ、日付ごとの☆◎◯▲を一覧表示します。イベントを選ぶと、そのイベントがあった日付だけに絞り込めます（複数選択可）。何も選ばない時は直近30日分を表示します。
            </div>
            {renderEventMultiSelect(overallGridEventFilter, setOverallGridEventFilter)}
            {renderMarkGrid(overallGridDates, overallGridRows, overallGridMarks, (name) => name, overallGridVarietyCells)}
          </div>


          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🎯 本日のおすすめ機種（未追跡の機種も含む）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              下で貼り付けた「機種別サマリー」から、台ごとの分析と同じ仕組みで判定します。
            </div>
            {overallModelPickList.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>民レポ（機種別サマリー）にはBB・RB回数が無く、設定期待度Xが計算できないため、現在この機能は無効です。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "460px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
                {overallModelPickList.map((p) => renderPickCard(p, (pp) => pp.no))}
              </div>
            )}
          </div>

          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🎯 末尾別のおすすめ
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              下で貼り付けた「末尾別データ」から、同じ仕組みで判定します。
            </div>
            {overallDigitPickList.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>民レポ（末尾別データ）にはBB・RB回数が無く、設定期待度Xが計算できないため、現在この機能は無効です。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "460px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
                {overallDigitPickList.map((p) => renderPickCard(p, (pp) => `末尾${pp.no}`))}
              </div>
            )}
          </div>

          {/* v6.9.10: データ入力・登録済み日付一覧・暗証番号解除フォームは
              共通設定タブに統合したため、ここでは案内だけを出す（全体データ
              タブ自体はロックなしで誰でも見られる） */}
          {!unlocked && (
            <div className="card" style={{ padding: "14px 18px", fontSize: "12px", color: "#8b93a3", display: "flex", alignItems: "center", gap: "8px" }}>
              <Lock size={13} />
              データ入力・登録済みの日付一覧は「🔧 共通設定」タブに移動しました。
            </div>
          )}
        </div>
      ) : (
        <>
      {/* machine model name (manual entry) for current page */}
      <div style={{ marginBottom: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
        <Pencil size={14} color="#5a6272" />
        <input
          type="text"
          value={currentPage ? currentPage.name : ""}
          onChange={(e) => handleRenamePage(activePageId, e.target.value)}
          placeholder="機種名を入力（例：ジャグラーガールズ）"
          style={{
            fontSize: "16px",
            fontWeight: 700,
            background: "transparent",
            border: "none",
            borderBottom: "1px dashed #2a323f",
            color: "#e7e9ee",
            padding: "4px 2px",
            minWidth: "260px",
          }}
        />
      </div>
      <div style={{ marginBottom: "18px" }}>
        <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "6px" }}>
          正式名称（アナスロ・全体データと連携・任意・複数機種を束ねる場合は1つずつ追加）：
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
          {splitModelNameList(currentPage ? currentPage.officialName || "" : "").map((name) => (
            <span
              key={name}
              className="mono"
              style={{
                display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "12px",
                background: "rgba(122,162,247,0.12)", border: "1px solid #2a323f", borderRadius: "999px",
                padding: "3px 6px 3px 10px", color: "#c7cbd4",
              }}
            >
              {name}
              {unlocked && (
                <button
                  onClick={() => removeOfficialNameFromPage(activePageId, name)}
                  title={`「${name}」を外す`}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272", display: "flex", padding: 0 }}
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
          {splitModelNameList(currentPage ? currentPage.officialName || "" : "").length === 0 && (
            <span style={{ fontSize: "11px", color: "#5a6272" }}>未設定です。下の欄から機種名を追加してください。</span>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <input
            type="text"
            list={FULLTABLE_MODEL_NAME_DATALIST_ID}
            value={officialNameInput}
            onChange={(e) => setOfficialNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addOfficialNameToPage(activePageId, officialNameInput);
                setOfficialNameInput("");
              }
            }}
            placeholder="機種名を入力してEnter（例：サンダーV）"
            disabled={!unlocked}
            style={{
              fontSize: "12px",
              background: unlocked ? "#12161d" : "#0d1015",
              border: "1px solid #2a323f",
              borderRadius: "6px",
              color: unlocked ? "#e7e9ee" : "#5a6272",
              padding: "5px 8px",
              flex: "1 1 200px",
              minWidth: 0,
              maxWidth: "100%",
              boxSizing: "border-box",
              cursor: unlocked ? "text" : "not-allowed",
            }}
          />
          <button
            onClick={() => { addOfficialNameToPage(activePageId, officialNameInput); setOfficialNameInput(""); }}
            disabled={!unlocked || !officialNameInput.trim()}
            style={{
              fontSize: "12px", background: "none", border: "1px solid #2a323f", borderRadius: "6px",
              color: unlocked && officialNameInput.trim() ? "#8b93a3" : "#3a3f4a",
              padding: "5px 10px", cursor: unlocked && officialNameInput.trim() ? "pointer" : "not-allowed",
              whiteSpace: "nowrap", flexShrink: 0,
            }}
          >
            追加
          </button>
          <button
            onClick={() => currentPage && currentPage.officialName && backfillPageFromRawTable(activePageId, currentPage.officialName)}
            disabled={!unlocked || !currentPage || !currentPage.officialName}
            title={unlocked ? "アナスロに貯まっている過去分を、今の正式名称でもう一度取り込み直す（読み込みタイミングの問題などで最初に取り込めなかった場合用）" : "暗証番号を解除すると使えます"}
            style={{
              fontSize: "11px", background: "none", border: "1px solid #2a323f", borderRadius: "6px",
              color: unlocked && currentPage && currentPage.officialName ? "#8b93a3" : "#3a3f4a",
              padding: "5px 8px", cursor: unlocked && currentPage && currentPage.officialName ? "pointer" : "not-allowed",
              whiteSpace: "nowrap", flexShrink: 0,
            }}
          >
            アナスロを再取込み
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "360px 1fr",
          gap: "20px",
          alignItems: "start",
        }}
        className="tracker-grid"
      >
        {/* LEFT: input panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
          {unlocked ? (
          <>
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "8px", color: "#c7cbd4" }}>
              このページのデータ
            </div>
            {/* v6.7: 台データ入力（表貼り付け形式）は廃止。今後はアナスロ
                （共通設定タブ）に一括で貼り付けると、正式名称が一致する
                ページへ自動反映される。ここには蓄積された過去データの
                一覧・削除・全削除のみ残す。 */}
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              データの入力は「🔧 共通設定」タブのアナスロから行います。正式名称が一致すると、ここには自動で反映されます。
            </div>

            {status && (
              <div style={{
                marginTop: "10px", fontSize: "12px", display: "flex", alignItems: "flex-start", gap: "6px",
                color: status.type === "ok" ? "#9ece6a" : "#e5697a",
              }}>
                {status.type === "ok" ? <CheckCircle2 size={14} style={{ marginTop: 1 }} /> : <AlertCircle size={14} style={{ marginTop: 1 }} />}
                <span>{status.msg}</span>
              </div>
            )}

            <div style={{ marginTop: "18px", borderTop: "1px solid #2a323f", paddingTop: "14px" }}>
              <button
                onClick={() => setDateListOpen((v) => !v)}
                style={{
                  display: "flex", alignItems: "center", gap: "6px", width: "100%",
                  fontSize: "12px", fontWeight: 700, color: "#c7cbd4", marginBottom: dateListOpen ? "8px" : 0,
                  background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left",
                }}
              >
                {dateListOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                登録済みの日付（{currentHistory.length}件）
              </button>
              {dateListOpen && (
              <div className="scrollbar" style={{ maxHeight: "200px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
                {historyLoading && <div style={{ fontSize: "12px", color: "#5a6272" }}>読み込み中...</div>}
                {!historyLoading && sortedHistory.length === 0 && (
                  <div style={{ fontSize: "12px", color: "#5a6272" }}>まだデータがありません。</div>
                )}
                {[...sortedHistory].reverse().map((h) => (
                  <div key={h.date} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                    background: "#12161d", border: "1px solid #232b37", borderRadius: "6px", padding: "6px 8px",
                  }}>
                    <div>
                      <span className="mono">{h.date}</span>
                      {strongDateSet.has(h.date) && (
                        <span style={{ marginLeft: "6px", color: STRONG_EVENT_COLOR }}>
                          <Star size={10} style={{ display: "inline", marginRight: "2px" }} fill={STRONG_EVENT_COLOR} />
                          {h.event}
                        </span>
                      )}
                      {!strongDateSet.has(h.date) && semiDateSet.has(h.date) && (
                        <span style={{ marginLeft: "6px", color: SEMI_EVENT_COLOR }}>
                          <Flag size={10} style={{ display: "inline", marginRight: "2px" }} />
                          {h.event}
                        </span>
                      )}
                      {!strongDateSet.has(h.date) && !semiDateSet.has(h.date) && h.event && (
                        <span style={{ marginLeft: "6px", color: EVENT_STAR_COLOR }}>
                          <Star size={10} style={{ display: "inline", marginRight: "2px" }} />
                          {h.event}
                        </span>
                      )}
                      <span style={{ marginLeft: "6px", color: "#5a6272" }}>{h.machines.length}台</span>
                    </div>
                    {confirmDeleteDate === h.date ? (
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button onClick={() => handleDeleteDate(h.date)} style={{ fontSize: "11px", color: "#e5697a", background: "none", border: "none", cursor: "pointer" }}>削除する</button>
                        <button onClick={() => setConfirmDeleteDate(null)} style={{ fontSize: "11px", color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>取消</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: "10px" }}>
                        <button onClick={() => setConfirmDeleteDate(h.date)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }} title="この日のデータを削除">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              )}

              {currentHistory.length > 0 && (
                <div style={{ marginTop: "10px" }}>
                  {confirmReset ? (
                    <div style={{ display: "flex", gap: "8px", fontSize: "12px" }}>
                      <span style={{ color: "#e5697a" }}>このページのデータを全て削除しますか？</span>
                      <button onClick={handleResetAll} style={{ color: "#e5697a", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>はい</button>
                      <button onClick={() => setConfirmReset(false)} style={{ color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>いいえ</button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmReset(true)} style={{ fontSize: "11px", color: "#5a6272", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}>
                      <RotateCcw size={11} />
                      このページのデータをリセット
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          </>
          ) : (
          <div className="card" style={{ padding: "14px 18px", fontSize: "12px", color: "#8b93a3", display: "flex", alignItems: "center", gap: "8px" }}>
            <Lock size={13} />
            データ入力はロック中です。「🔧 共通設定」タブで暗証番号を入力すると解除できます。
          </div>
          )}

          {/* 台番号×日付マトリクス表（このページ用・イベント複数選択で絞り込み）— ロック不要 */}
          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              📋 台番号×日付マトリクス表
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              このページの台番号ごとに、日付ごとの出率ベースの簡易マーク（▲＝出率110%以上・◯＝出率105%以上）を一覧表示します。イベントを選ぶと、そのイベントがあった日付だけに絞り込めます（複数選択可）。何も選ばない時は直近30日分を表示します。
            </div>
            {renderEventMultiSelect(pageGridEventFilter, setPageGridEventFilter)}
            {renderMarkGrid(pageGridDates, pageGridRows, pageGridMarks, (no) => machineLabel(no))}
          </div>

          {/* v6.12: 台番号×日付のXマトリクス表（設定期待度・雑餉隈の「数値」
              表示と同じ見た目）。▲〇マトリクスと日付・イベント絞り込みを
              共有（pageGridDates）。パーセンタイル自体は絞り込みに関係なく
              全期間データから計算するので、表示だけ絞り込まれる。 */}
          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🎰 設定期待度マトリクス表（X・実験的）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              合成確率と出率を合成したX（設定期待度スコア）を、このページ内での順位（0〜100、高いほど良い）に変換して表示します。<span style={{ color: "#e8b34c" }}>差枚のプラス/マイナスとは別物です（設定は基本的に毎日変わるため）。</span>台番号固定の実績・日付末尾・イベント等、条件を目視で確認するのに使ってください。
            </div>
            {historyLoading ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>読み込み中...</div>
            ) : sortedHistory.length < 15 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>データが15日分たまると表示されます。</div>
            ) : (
              renderXGrid(pageGridDates, pageGridRows, pageGridXPercentiles, (no) => machineLabel(no))
            )}
          </div>
        </div>

        {/* RIGHT: chart + summary */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", justifyContent: "flex-end", alignItems: "center", marginBottom: "10px" }}>
              <div style={{ display: "flex", gap: "6px" }}>
                {RANGE_OPTIONS.map((r) => (
                  <button key={r.key} onClick={() => { setRange(r.key); setUseCustomRange(false); }} className="chip" style={{
                    fontSize: "12px", padding: "6px 10px", borderRadius: "6px",
                    border: "1px solid " + (!useCustomRange && range === r.key ? "#4fd1c5" : "#2a323f"),
                    background: !useCustomRange && range === r.key ? "rgba(79,209,197,0.12)" : "transparent",
                    color: !useCustomRange && range === r.key ? "#4fd1c5" : "#c7cbd4",
                  }}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", justifyContent: "flex-end", marginBottom: "14px" }}>
              <span style={{ fontSize: "11px", color: "#5a6272" }}>期間を指定：</span>
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} style={{
                background: "#12161d", border: "1px solid " + (useCustomRange ? "#4fd1c5" : "#2a323f"), borderRadius: "6px",
                padding: "5px 6px", color: "#e7e9ee", fontSize: "11px",
              }} />
              <span style={{ fontSize: "11px", color: "#5a6272" }}>〜</span>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={{
                background: "#12161d", border: "1px solid " + (useCustomRange ? "#4fd1c5" : "#2a323f"), borderRadius: "6px",
                padding: "5px 6px", color: "#e7e9ee", fontSize: "11px",
              }} />
              <button
                onClick={() => setUseCustomRange(true)}
                disabled={!customStart || !customEnd}
                style={{
                  fontSize: "11px", padding: "5px 10px", borderRadius: "6px", border: "1px solid #4fd1c5",
                  background: useCustomRange ? "rgba(79,209,197,0.12)" : "transparent", color: "#4fd1c5",
                  cursor: customStart && customEnd ? "pointer" : "not-allowed", opacity: customStart && customEnd ? 1 : 0.5,
                }}
              >
                適用
              </button>
              {useCustomRange && (
                <button onClick={() => setUseCustomRange(false)} style={{
                  fontSize: "11px", padding: "5px 10px", borderRadius: "6px", border: "1px solid #2a323f",
                  background: "transparent", color: "#8b93a3", cursor: "pointer",
                }}>
                  解除
                </button>
              )}
            </div>

            {historyLoading ? (
              <div style={{ height: "320px", display: "flex", alignItems: "center", justifyContent: "center", color: "#5a6272", fontSize: "13px" }}>
                読み込み中...
              </div>
            ) : chartData.length === 0 ? (
              <div style={{ height: "320px", display: "flex", alignItems: "center", justifyContent: "center", color: "#5a6272", fontSize: "13px" }}>
                左のフォームからデータを保存すると、ここにグラフが表示されます。
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={chartData} margin={{ top: 6, right: 12, left: 0, bottom: 6 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#232b37" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#8b93a3" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#8b93a3" }} width={56} />
                  <Tooltip
                    contentStyle={{ background: "#1b212b", border: "1px solid #2a323f", borderRadius: "8px", fontSize: "12px" }}
                    labelFormatter={(label, payload) => {
                      const ev = payload && payload[0] && payload[0].payload ? payload[0].payload.event : "";
                      return ev ? `${label}（${ev}）` : label;
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: "11px" }} />
                  {closedDatesInView.map((c) => {
                    const dateList = chartData.map((d) => d.date);
                    const band = getBandRange(dateList, c.date);
                    if (!band) return null;
                    return (
                      <ReferenceArea key={"closed-" + c.date} x1={band.x1} x2={band.x2} fill="#5a6272" fillOpacity={0.28} stroke="none"
                        label={{ value: "休", position: "insideTop", fill: "#c7cbd4", fontSize: 10 }} />
                    );
                  })}
                  {digit2DatesInView.map((d) => (
                    <ReferenceLine key={"d2-" + d} x={d} stroke={DIGIT2_COLOR} strokeDasharray="2 2" strokeOpacity={0.55}
                      label={{ value: "2", position: "top", fill: DIGIT2_COLOR, fontSize: 9 }} />
                  ))}
                  {digit7DatesInView.map((d) => (
                    <ReferenceLine key={"d7-" + d} x={d} stroke={DIGIT7_COLOR} strokeDasharray="2 2" strokeOpacity={0.55}
                      label={{ value: "7", position: "top", fill: DIGIT7_COLOR, fontSize: 9 }} />
                  ))}
                  {strongDatesInView.map((se) => (
                    <ReferenceLine key={"strong-" + se.date} x={se.date} stroke={STRONG_EVENT_COLOR} strokeDasharray="5 3" strokeWidth={2}
                      label={{ value: "★" + se.name, position: "top", fill: STRONG_EVENT_COLOR, fontSize: 10 }} />
                  ))}
                  {semiDatesInView.map((se) => (
                    <ReferenceLine key={"semi-" + se.date} x={se.date} stroke={SEMI_EVENT_COLOR} strokeDasharray="2 4" strokeWidth={1} strokeOpacity={0.8}
                      label={{ value: "🚩" + se.name, position: "top", fill: SEMI_EVENT_COLOR, fontSize: 9 }} />
                  ))}
                  {eventDates.map((e) => (
                    <ReferenceLine key={"event-" + e.date} x={e.date} stroke={EVENT_STAR_COLOR} strokeDasharray="4 3"
                      label={{ value: "☆", position: "top", fill: EVENT_STAR_COLOR, fontSize: 11 }} />
                  ))}
                  {selectedMachines.map((no, i) => (
                    <Line key={no} type="monotone" dataKey={String(no)} name={machineLabel(no)}
                      stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
            <div style={{ fontSize: "11px", color: "#5a6272", marginTop: "6px" }}>
              単位：枚　★(赤・塗) = 強いイベント　☆(黄・抜き) = 通常イベント　🚩(緑) = 準イベント　水色点線 = 2のつく日　オレンジ点線 = 7のつく日　グレー帯 = 店休日
            </div>
          </div>

          {/* machine selector */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4", display: "flex", alignItems: "center", gap: "6px" }}>
                <ListChecks size={14} />
                表示する台番（{selectedMachines.length}/{allMachineNumbers.length}）
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <button onClick={() => setSelectedMachines(allMachineNumbers)} style={{ fontSize: "11px", color: "#4fd1c5", background: "none", border: "none", cursor: "pointer" }}>全選択</button>
                <button onClick={() => setSelectedMachines([])} style={{ fontSize: "11px", color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>全解除</button>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {allMachineNumbers.length === 0 && (
                <div style={{ fontSize: "12px", color: "#5a6272" }}>データを保存すると台番がここに表示されます。</div>
              )}
              {allMachineNumbers.map((no) => {
                const active = selectedMachines.includes(no);
                const idx = selectedMachines.indexOf(no);
                const color = active ? PALETTE[idx % PALETTE.length] : "#2a323f";
                return (
                  <button key={no} onClick={() => toggleMachine(no)} className="chip mono" style={{
                    fontSize: "12px", padding: "5px 9px", borderRadius: "6px", border: "1px solid " + color,
                    background: active ? color + "22" : "transparent", color: active ? color : "#5a6272",
                  }}>
                    {isMultiModelPage && noToModelName[no] ? `${noToModelName[no]} ${no}` : no}
                  </button>
                );
              })}
            </div>
          </div>

          {/* day-detail viewer: pick one date, see every machine's 差枚 that day */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4", marginBottom: "10px" }}>
              日別データを見る
            </div>
            <input
              type="date"
              value={viewDate}
              onChange={(e) => setViewDate(e.target.value)}
              style={{
                background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                padding: "7px 8px", color: "#e7e9ee", fontSize: "13px", marginBottom: "12px",
              }}
            />
            {viewDateMachines === null ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>この日のデータはまだありません。</div>
            ) : (
              <>
                <div className="scrollbar" style={{ maxHeight: "300px", overflowY: "auto", marginBottom: "16px" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                    <thead>
                      <tr style={{ color: "#5a6272", textAlign: "left" }}>
                        <th style={{ padding: "4px 8px", fontWeight: 600 }}>台番</th>
                        <th style={{ padding: "4px 8px", fontWeight: 600 }}>差枚</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewDateMachines.map((m) => (
                        <tr key={m.no} style={{ borderTop: "1px solid #232b37" }}>
                          <td className="mono" style={{ padding: "6px 8px", color: "#c7cbd4" }}>{m.no}</td>
                          <td className="mono" style={{ padding: "6px 8px", color: m.sada >= 0 ? "#9ece6a" : "#e5697a", fontWeight: 700 }}>
                            {m.sada === null ? "―" : (m.sada >= 0 ? "+" : "") + fmtNum(m.sada) + "枚"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ borderTop: "1px solid #2a323f", paddingTop: "14px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
                    <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4" }}>
                      この日までの差枚推移
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      {[7, 10, 20].map((w) => (
                        <button key={w} onClick={() => setViewWindow(w)} className="chip" style={{
                          fontSize: "12px", padding: "5px 9px", borderRadius: "6px",
                          border: "1px solid " + (viewWindow === w ? "#4fd1c5" : "#2a323f"),
                          background: viewWindow === w ? "rgba(79,209,197,0.12)" : "transparent",
                          color: viewWindow === w ? "#4fd1c5" : "#c7cbd4",
                        }}>
                          {w}日間
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "10px" }}>
                    {viewWindowSeries.map((s) => (
                      <div key={s.no} style={{ background: "#0e1218", border: "1px solid #232b37", borderRadius: "10px", overflow: "hidden" }}>
                        <div style={{ background: "#e7e9ee", color: "#12161d", fontWeight: 700, fontSize: "12px", textAlign: "center", padding: "3px 0" }}>
                          [{s.no}]
                        </div>
                        <div style={{ position: "relative", height: "100px" }}>
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={s.series} margin={{ top: 8, right: 6, left: 0, bottom: 0 }}>
                              <CartesianGrid vertical={false} stroke="#232b37" strokeDasharray="2 3" />
                              <YAxis hide width={0} />
                              <XAxis dataKey="date" hide />
                              <Tooltip contentStyle={{ background: "#1b212b", border: "1px solid #2a323f", borderRadius: "6px", fontSize: "11px" }} />
                              <Line type="monotone" dataKey="value" stroke="#3ecf8e" strokeWidth={1.5} dot={false} connectNulls />
                            </LineChart>
                          </ResponsiveContainer>
                          <div className="mono" style={{
                            position: "absolute", right: "6px", bottom: "4px", fontSize: "13px", fontWeight: 800,
                            color: "#f2d24b", textShadow: "0 0 8px rgba(242,210,75,0.35)",
                          }}>
                            {s.total >= 0 ? "+" : ""}{fmtNum(s.total)}枚
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* site777-style mini chart cards, one per machine */}
          {machineSummaries.length > 0 && (
            <div className="card" style={{ padding: "18px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4", marginBottom: "12px" }}>
                台別チャート（{RANGE_OPTIONS.find((r) => r.key === range)?.label}）
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "12px" }}>
                {machineSummaries.map((s) => (
                  <div key={s.no} style={{ background: "#0e1218", border: "1px solid #232b37", borderRadius: "10px", overflow: "hidden" }}>
                    <div style={{ background: "#e7e9ee", color: "#12161d", fontWeight: 700, fontSize: "13px", textAlign: "center", padding: "4px 0" }}>
                      [{s.no}]
                    </div>
                    <div style={{ position: "relative", height: "130px" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={s.series} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid vertical={false} stroke="#232b37" strokeDasharray="2 3" />
                          <YAxis hide={false} width={38} tick={{ fontSize: 9, fill: "#4a5262" }} axisLine={false} tickLine={false} />
                          <XAxis dataKey="date" hide />
                          <Tooltip contentStyle={{ background: "#1b212b", border: "1px solid #2a323f", borderRadius: "6px", fontSize: "11px" }} />
                          {s.closedInSeries.map((c) => {
                            const dateList = s.series.map((d) => d.date);
                            const band = getBandRange(dateList, c.date);
                            if (!band) return null;
                            return <ReferenceArea key={"m-closed-" + c.date} x1={band.x1} x2={band.x2} fill="#5a6272" fillOpacity={0.28} stroke="none" />;
                          })}
                          {s.digit2InSeries.map((d) => (
                            <ReferenceLine key={"m-d2-" + d} x={d} stroke={DIGIT2_COLOR} strokeDasharray="2 2" strokeOpacity={0.5} strokeWidth={1} />
                          ))}
                          {s.digit7InSeries.map((d) => (
                            <ReferenceLine key={"m-d7-" + d} x={d} stroke={DIGIT7_COLOR} strokeDasharray="2 2" strokeOpacity={0.5} strokeWidth={1} />
                          ))}
                          {s.strongInSeries.map((se) => (
                            <ReferenceLine key={"m-strong-" + se.date} x={se.date} stroke={se.color || "#e5484d"} strokeDasharray="4 2" strokeWidth={1.5} />
                          ))}
                          <Line type="monotone" dataKey="value" stroke="#3ecf8e" strokeWidth={1.75} dot={false} connectNulls />
                        </LineChart>
                      </ResponsiveContainer>
                      <div className="mono" style={{
                        position: "absolute", right: "8px", bottom: "6px", fontSize: "17px", fontWeight: 800,
                        color: "#f2d24b", textShadow: "0 0 8px rgba(242,210,75,0.35)",
                      }}>
                        {s.dataCount === 0 ? "―" : (s.totalSada >= 0 ? "+" : "") + fmtNum(s.totalSada) + "枚"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* "○のつく日" (digit day) average differential per machine */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              〇のつく日 平均差枚
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              数字を選ぶと、その数字で終わる日付（例：2 なら 2日・12日・22日）の平均差枚を台ごとに計算します（このページの全期間データが対象）
            </div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                <button key={d} onClick={() => setLuckyDigit(d === luckyDigit ? null : d)} className="mono" style={{
                  width: "32px", height: "32px", borderRadius: "8px", cursor: "pointer",
                  border: "1px solid " + (luckyDigit === d ? "#e8b34c" : "#2a323f"),
                  background: luckyDigit === d ? "rgba(232,179,76,0.15)" : "transparent",
                  color: luckyDigit === d ? "#e8b34c" : "#c7cbd4", fontSize: "13px", fontWeight: 700,
                }}>
                  {d}
                </button>
              ))}
            </div>

            {luckyDigit === null ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>上の数字を選んでください。</div>
            ) : luckyDayStats.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>該当する日付のデータがまだありません。</div>
            ) : (
              <>
                {luckyDayOverall && (
                  <div style={{
                    background: "#12161d", border: "1px solid #2a323f", borderRadius: "8px",
                    padding: "10px 12px", marginBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ fontSize: "12px", color: "#8b93a3" }}>全体合計差枚の平均（{luckyDayOverall.dayCount}日分）</span>
                    <span className="mono" style={{ fontSize: "16px", fontWeight: 800, color: luckyDayOverall.avgTotal >= 0 ? "#9ece6a" : "#e5697a" }}>
                      {luckyDayOverall.avgTotal >= 0 ? "+" : ""}{fmtNum(Math.round(luckyDayOverall.avgTotal))}枚
                    </span>
                  </div>
                )}
              <div className="scrollbar" style={{ maxHeight: "260px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ color: "#5a6272", textAlign: "left" }}>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>台番</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>平均差枚</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>該当日数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {luckyDayStats.map((s) => (
                      <tr key={s.no} style={{ borderTop: "1px solid #232b37" }}>
                        <td className="mono" style={{ padding: "6px 8px", color: "#c7cbd4" }}>{s.no}</td>
                        <td className="mono" style={{ padding: "6px 8px", color: s.avg >= 0 ? "#9ece6a" : "#e5697a", fontWeight: 700 }}>
                          {s.avg >= 0 ? "+" : ""}{Math.round(s.avg).toLocaleString()}枚
                        </td>
                        <td className="mono" style={{ padding: "6px 8px", color: "#5a6272" }}>{s.count}日</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>


          {/* v6.18: 差枚・出率ベースの法則と、X（設定期待度：合成確率＋出率の
              複合値）ベースの法則（台番号固有・機種全体）を1つのランクに
              統合。以前は「設定期待度」を別カードにしていたが、完全合体
              した。 */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              {(() => {
                if (sortedHistory.length === 0) return "ピックアップ";
                const targetDate = addDays(sortedHistory[sortedHistory.length - 1].date, 1);
                const [, m, d] = targetDate.split("-");
                return `${parseInt(m, 10)}/${parseInt(d, 10)}のピックアップ`;
              })()}
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              「翌日、設定期待度（X）が高くなりそうか」を予想します。台番号固有のXの法則・機種全体のXの法則・前日、他の台が好調・前日のG数水準・日付末尾・イベント名の6つを見て、当てはまる台をスコアが高い順に並べます（このページの全ての台が対象）。丸いバッジはスコアをS〜Gのランクにしたものです。<span style={{ color: "#e8b34c" }}>「差枚がプラスになるか」ではなく「設定が入っていたか」を見る指標です。</span>
            </div>
            {pickList.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>{historyLoading ? "読み込み中..." : "現時点で条件に当てはまる台はありません。"}</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "460px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
                {pickList.map((p) => renderPickCard(p, isMultiModelPage ? (pp) => machineLabel(pp.no) : undefined))}
              </div>
            )}
          </div>

          {/* machine-to-machine correlation */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              台同士の相関
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              日ごとの差枚が似た動きをする台の組み合わせを探します（相関係数の絶対値が0.4以上、同時データ10日分以上のペアのみ表示）。相関は因果関係を示すものではなく、偶然による見かけ上の一致も含まれる点にご注意ください。
            </div>
            {machineCorrelations.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>目立った相関の組み合わせはまだ見つかっていません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "300px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ color: "#5a6272", textAlign: "left" }}>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>台番A</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>台番B</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>相関係数</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>同時日数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {machineCorrelations.map((c) => (
                      <tr key={c.noA + "-" + c.noB} style={{ borderTop: "1px solid #232b37" }}>
                        <td className="mono" style={{ padding: "6px 8px", color: "#c7cbd4" }}>{c.noA}</td>
                        <td className="mono" style={{ padding: "6px 8px", color: "#c7cbd4" }}>{c.noB}</td>
                        <td className="mono" style={{ padding: "6px 8px", fontWeight: 700, color: c.r >= 0 ? "#9ece6a" : "#e5697a" }}>
                          {c.r >= 0 ? "+" : ""}{c.r.toFixed(2)}
                        </td>
                        <td className="mono" style={{ padding: "6px 8px", color: "#5a6272" }}>{c.sampleSize}日</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* trailing-window threshold analysis */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              総差枚しきい値分析（翌日プラスになりやすいライン）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              選んでいる台ごとに、直近N日間の総差枚が「いくら以上／以下」だと翌日プラスになりやすいかを、このページの全期間データから探します
            </div>
            <div style={{ display: "flex", gap: "6px", marginBottom: "12px" }}>
              {[10, 20, 30].map((w) => (
                <button key={w} onClick={() => setAnalysisWindow(w)} className="chip" style={{
                  fontSize: "12px", padding: "6px 10px", borderRadius: "6px",
                  border: "1px solid " + (analysisWindow === w ? "#4fd1c5" : "#2a323f"),
                  background: analysisWindow === w ? "rgba(79,209,197,0.12)" : "transparent",
                  color: analysisWindow === w ? "#4fd1c5" : "#c7cbd4",
                }}>
                  {w}日足
                </button>
              ))}
            </div>

            {thresholdAnalyses.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>台を選ぶと、ここに分析結果が表示されます。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "420px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "14px" }}>
                {thresholdAnalyses.map((a) => (
                  <div key={a.no} style={{ borderTop: "1px solid #232b37", paddingTop: "10px" }}>
                    <div className="mono" style={{ fontSize: "13px", fontWeight: 700, color: "#e8b34c", marginBottom: "6px" }}>
                      {a.no}番　
                      <span style={{ fontSize: "10px", color: "#5a6272", fontWeight: 400 }}>（有効データ {a.validDays}日分・基準勝率{Math.round(a.baseRate * 100)}%）</span>
                    </div>
                    {renderThresholdResult(a.overall, "全日", a.overallPairsCount, 5)}
                    {renderThresholdResult(a.digit2, "翌日が2のつく日のみ", a.digit2PairsCount, 3)}
                    {renderThresholdResult(a.digit7, "翌日が7のつく日のみ", a.digit7PairsCount, 3)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
        </>
      )}

      <style>{`
        @media (max-width: 860px) {
          .tracker-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* always in the DOM regardless of active tab, since inputs on multiple
          tabs (共通設定, 機種ページ) reference this same datalist by id */}
      <datalist id={MODEL_NAME_DATALIST_ID}>
        {allKnownModelNames.map((n) => (
          <option value={n} key={n} />
        ))}
      </datalist>
      <datalist id={FULLTABLE_MODEL_NAME_DATALIST_ID}>
        {allKnownModelNamesFromFullTable.map((n) => (
          <option value={n} key={n} />
        ))}
      </datalist>

      {/* fixed undo-history button, shown regardless of which tab/page is open — but only when unlocked, since it can restore/overwrite data */}
      {unlocked && (
      <div style={{ position: "fixed", right: "20px", bottom: "20px", zIndex: 50 }}>
        {undoPanelOpen && (
          <div className="card" style={{
            width: "320px", maxHeight: "400px", overflowY: "auto", padding: "14px",
            marginBottom: "10px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#c7cbd4" }}>🕐 操作履歴</div>
              <button onClick={() => setUndoPanelOpen(false)} style={{ background: "none", border: "none", color: "#5a6272", cursor: "pointer" }}>✕</button>
            </div>
            {!undoHistoryLoaded && <div style={{ fontSize: "12px", color: "#5a6272" }}>読み込み中...</div>}
            {undoHistoryLoaded && undoHistory.length === 0 && (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>取り消せる操作の履歴はまだありません。</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {undoHistory.map((entry) => (
                <div key={entry.id} style={{ background: "#12161d", border: "1px solid #2a323f", borderRadius: "8px", padding: "8px 10px" }}>
                  <div style={{ fontSize: "12px", color: "#e7e9ee", marginBottom: "4px" }}>{entry.label}</div>
                  <div style={{ fontSize: "10px", color: "#5a6272", marginBottom: "6px" }}>
                    {new Date(entry.timestamp).toLocaleString("ja-JP")}
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      onClick={() => handleRestoreUndo(entry)}
                      style={{ fontSize: "11px", fontWeight: 700, color: "#12161d", background: "#9ece6a", border: "none", borderRadius: "6px", padding: "4px 10px", cursor: "pointer" }}
                    >
                      元に戻す
                    </button>
                    <button
                      onClick={() => handleDismissUndoEntry(entry.id)}
                      style={{ fontSize: "11px", color: "#5a6272", background: "none", border: "none", cursor: "pointer" }}
                    >
                      閉じる
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <button
          onClick={() => setUndoPanelOpen((v) => !v)}
          style={{
            display: "flex", alignItems: "center", gap: "6px", background: "#1b212b", color: "#c7cbd4",
            border: "1px solid #2a323f", borderRadius: "999px", padding: "10px 16px", fontSize: "12px",
            fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 12px rgba(0,0,0,0.3)", float: "right",
          }}
        >
          🕐 操作履歴{undoHistory.length > 0 ? `（${undoHistory.length}）` : ""}
        </button>
      </div>
      )}
    </div>
  );
}
