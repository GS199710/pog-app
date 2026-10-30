import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import {
  Search, Upload, X, ChevronRight, Filter, Plus,
  RefreshCw, Trash2, ChevronLeft, ChevronDown, Bookmark, Dna, AlertTriangle, Settings, Check,
  Download, FileDown, ListOrdered, ChevronUp, StickyNote, Pencil, Cloud
} from "lucide-react";
import { createSyncEngine } from "./sync.js";
import SyncModal from "./SyncModal.jsx";

/* ============================================================
   デザイントークン (競馬の馬柱/勝負服をモチーフにしたダーク配色)
   ============================================================ */
const C = {
  bg: "#0E1712",
  surface: "#16211B",
  surfaceRaised: "#1D2A22",
  border: "#2A3B31",
  text: "#EDECE4",
  textDim: "#9AA79C",
  gold: "#C9A227",
  goldSoft: "#8A7327",
  danger: "#B5544A",
};
const SEX_COLOR = { "牡": "#4A6FA5", "牝": "#B5647A", "せん": "#7A7A72" };
const sexColor = (s) => SEX_COLOR[s] || "#5B6960";

const DEFAULT_CATEGORIES = [
  { id: "honmei", mark: "◎", label: "本命", color: "#D4AF37" },
  { id: "taikou", mark: "○", label: "対抗", color: "#8FB8DE" },
  { id: "tanana", mark: "▲", label: "単穴", color: "#7FBF9E" },
  { id: "renka", mark: "△", label: "連下", color: "#B7B7B0" },
  { id: "hoshi", mark: "☆", label: "注目馬・穴候補", color: "#C77DAB" },
  { id: "batsu", mark: "×", label: "指名回避", color: "#B5544A" },
];

// カテゴリ(印)編集モーダルで選べる色の一覧(ダーク+ゴールドの配色に馴染む範囲)。
const CATEGORY_COLOR_PALETTE = [
  "#D4AF37", "#8FB8DE", "#7FBF9E", "#B7B7B0", "#C77DAB", "#B5544A", "#E0956B", "#8FA0DE",
];

/* ============================================================
   年度(シーズン)管理
   ------------------------------------------------------------
   POGは年度ごとにCSV(その年の2歳馬全頭)を読み込み直して使う運用の
   ため、馬データ・印・チェック・メモは年度ごとに完全に独立した
   ストレージ領域に保存する。

   キー設計:
   - `horses-v1:<season>` / `marks-v1:<season>` / `categories-v1:<season>`
     … 年度ごとに分離(例: "horses-v1:2026")。年度をまたいでデータが
       混ざることはない。年度が「存在するかどうか」は、別途一覧を
       持たず、その場でこのキーを直接読みに行くことで判定する
       (一覧データと実データがズレて不整合を起こす余地を無くすため)。
   - `current-season-id-v1`
     … 最後に選択していた年度IDだけを覚えておく、年度をまたぐ共有
       データ。次回起動時にどの年度を開くかの復元にのみ使う。
   - `pedigree-v1` / `pedigree-conflicts-v1` (年度非依存・共有)
     … 血統データベース用。全年度で共有する。
   ------------------------------------------------------------ */
const DEFAULT_SEASON = "2026";
const CURRENT_SEASON_KEY = "current-season-id-v1";
const LAST_BACKUP_KEY = "last-json-backup-v1"; // 最後にJSONを書き出す操作をした時刻(表示用)
const PEDIGREE_STORAGE_KEY = "pedigree-v1"; // 将来の血統データベース用に予約(全年度共通・未実装)

// POG開催年度の固定選択肢(id=開始年、表示は"開始年-終了年")。
// 2026年度の既存データはid="2026"のまま(表示だけ"2026-2027"にする)ことで
// 既存のストレージキー(horses-v1:2026 等)との互換性を維持する。
const SEASON_RANGE_START = 2025;
const SEASON_RANGE_END = 2099;
function seasonLabel(id) {
  const y = parseInt(id, 10);
  return `${y}-${y + 1}`;
}
function generateSeasonOptions() {
  const list = [];
  for (let y = SEASON_RANGE_START; y <= SEASON_RANGE_END; y++) {
    const id = String(y);
    list.push({ id, label: seasonLabel(id) });
  }
  return list;
}

function seasonStorageKeys(season) {
  return {
    horses: `horses-v1:${season}`,
    marks: `marks-v1:${season}`,
    categories: `categories-v1:${season}`,
  };
}
// 旧バージョン(年度管理が無かった頃)のキー。初回起動時にのみ参照し、
// 存在すれば新形式(2026年度)へ移行したうえで削除する。
const LEGACY_STORAGE_KEYS = { horses: "horses-v1", marks: "marks-v1", categories: "categories-v1" };

const PAGE_SIZE = 40;

/* ============================================================
   CSV 取り込み: 文字コード自動判定 + 列マッピング
   ============================================================ */
async function decodeFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (e) {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

function mapHeader(h) {
  const t = (h || "").trim();
  // 完全一致を優先する。「母戦績」「(母名+生年)」など"母"を含むだけの列を
  // 誤って母/父列として拾わないようにするため、緩い部分一致は使わない。
  if (t === "登録番号" || /^id$/i.test(t)) return "id";
  if (t === "馬名" || t === "名前") return "name";
  if (t === "母父") return "damSire";
  if (t === "父") return "sire";
  if (t === "母") return "dam";
  if (t === "生年月日" || t === "誕生日" || (t.includes("生年") && !t.includes("+"))) return "birthDate";
  if (t === "性別") return "sex";
  if (t === "毛色") return "color";
  if (t === "調教師" || t === "厩舎") return "trainer";
  if (t === "東西") return "region";
  if (t === "生産者" || t === "生産牧場") return "breeder";
  if (t === "馬主") return "owner";
  if (t === "(母名+生年)") return "damNameYear";
  return null;
}

// 今後の馬登録データとして不要な列。CSV→Horseオブジェクトを生成する段階で
// 除外し、h.rawにも一切保持しない(「その他の情報」欄にも出てこない)。
const EXCLUDED_RAW_COLUMNS = new Set([
  "url",
  "母戦績",
  "主な兄弟1", "主な兄弟1URL", "主な兄弟1戦績",
  "主な兄弟2", "主な兄弟2URL", "主な兄弟2戦績",
  "主な兄弟3", "主な兄弟3URL", "主な兄弟3戦績",
  "主な兄弟4", "主な兄弟4URL", "主な兄弟4戦績",
  "主な兄弟5", "主な兄弟5URL", "主な兄弟5戦績",
]);
function isExcludedRawColumn(col) {
  const t = (col || "").trim();
  return t.toLowerCase() === "url" || EXCLUDED_RAW_COLUMNS.has(t);
}

// CSV上の生データ(栗/美)は変更せず、表示するときだけ正式名称に変換する。
const REGION_LABEL = { "栗": "栗東", "美": "美浦" };
const regionLabel = (v) => REGION_LABEL[v] || v || "";

// 所属欄が空文字/空白/null/undefinedの馬を「未定」として絞り込めるようにするための
// 特別な値。調教師フィルターの「未定」と同じ考え方で、CSVの元データやHorseオブジェクト
// にこの文字列が保存されることはない(フィルターUI上だけで使う識別子)。
const UNASSIGNED_REGION = "__region_unassigned__";
const UNASSIGNED_REGION_LABEL = "未定";

// 候補馬画面の印フィルターで「印なし」を表すための特別な値。
const CANDIDATE_NO_MARK = "__no_mark__";
const CANDIDATE_HAS_NOTE = "__has_note__";
// 生年月日(月)フィルター: 選択肢は "1"〜"12"(文字列)。birthDateは変更せず、月の取り出しだけを行う。
const BIRTH_MONTH_OPTIONS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const birthMonthLabel = (m) => `${m}月`;
// "01/09" (月/日) のほか "2024/01/09" "2024-01-09" "2024年1月9日" にも対応。取り出せなければ null
const birthMonthOf = (birthDate) => {
  const t = String(birthDate || "").trim();
  const m = t.match(/^\d{4}\s*[\/\-.年]\s*(\d{1,2})/) || t.match(/^(\d{1,2})\s*[\/\-.月]/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? String(n) : null;
};
// メモの有無判定(空文字・空白のみは「メモなし」)。保存済みnoteは変更せず判定だけに使う
const hasNote = (m) => typeof m?.note === "string" && m.note.trim().length > 0;
// メモ一覧用: 1行目だけを返し、2行目以降に内容があれば末尾に「…」を付ける(表示専用。noteは変更しない)
const noteFirstLine = (note) => {
  const lines = String(note || "").trim().split(/\r?\n/);
  const first = lines[0].trim();
  const hasMore = lines.slice(1).some((l) => l.trim().length > 0);
  return hasMore ? `${first}…` : first;
};

/* ============================================================
   調教師 読み仮名辞書(五十音順ソート用)
   ------------------------------------------------------------
   日本語の氏名は漢字だけから読みを機械的に確定できない
   （例: 安田＝やすだ／やすた、東＝あずま／ひがし、など）ため、
   このアプリでは形態素解析による自動推定ではなく、
   「実在の調教師名 → 読み仮名」を対応させる辞書方式を採用する。
   ここに載っている調教師は今回読み込んだCSVの中でも特に
   騎乗数の多い/著名な調教師を中心に、確認が取れた読みだけを
   収録している(未収録の名前は無理に推定せず、後述のフォール
   バックに委ねる)。

   将来のメンテナンス方法:
   - 表示ミスや未収録の調教師を見つけたら、この
     TRAINER_YOMI オブジェクトに「"漢字名": "よみがな"」を
     1行追加するだけでよい。これがそのまま「読み補正辞書」
     として機能する(コードの他の部分は変更不要)。
   ============================================================ */
const TRAINER_YOMI = {
  "矢作芳人": "やはぎよしと",
  "友道康夫": "ともみちやすお",
  "藤原英昭": "ふじわらひであき",
  "池江泰寿": "いけえやすとし",
  "手塚貴久": "てづかたかひさ",
  "中内田充": "なかうちだみつる",
  "堀宣行": "ほりのぶゆき",
  "斉藤崇史": "さいとうたかし",
  "高野友和": "たかのともかず",
  "木村哲也": "きむらてつや",
  "杉山晴紀": "すぎやまはるき",
  "杉山佳明": "すぎやまよしあき",
  "松永幹夫": "まつながみきお",
  "松永康利": "まつながやすとし",
  "池添学": "いけぞえまなぶ",
  "高柳瑞樹": "たかやなぎみずき",
  "高柳大輔": "たかやなぎだいすけ",
  "鈴木孝志": "すずきたかし",
  "田中克典": "たなかかつのり",
  "辻野泰之": "つじのやすゆき",
  "辻哲英": "つじてつひで",
  "栗田徹": "くりたとおる",
  "藤岡健一": "ふじおかけんいち",
  "蛯名正義": "えびなまさよし",
  "森秀行": "もりひでゆき",
  "森田直行": "もりたなおゆき",
  "平田修": "ひらたおさむ",
  "奥村武": "おくむらたけし",
  "奥村豊": "おくむらゆたか",
  "安田隆行": "やすだたかゆき",
  "安田翔伍": "やすだしょうご",
  "武井亮": "たけいりょう",
  "武幸四郎": "たけこうしろう",
  "的場均": "まとばひとし",
  "福永祐一": "ふくながゆういち",
  "柴田卓": "しばたすぐる",
  "青木孝文": "あおきたかふみ",
  "須貝尚介": "すがいしょうすけ",
  "昆貢": "こんみつぐ",
  "上村洋行": "うえむらひろゆき",
  "西園翔太": "にしぞのしょうた",
  "高橋亮": "たかはしりょう",
  "高橋康之": "たかはしやすゆき",
  "鹿戸雄一": "かのとゆういち",
  "黒岩陽一": "くろいわよういち",
  "橋口慎介": "はしぐちしんすけ",
  "畠山吉宏": "はたけやまよしひろ",
  "牧浦充徳": "まきうらみつのり",
  "清水久詞": "しみずひさし",
  "菊沢隆徳": "きくざわたかのり",
  "石坂公一": "いしざかこういち",
  "小島茂之": "こじましげゆき",
  "小崎憲": "こざきけん",
  "尾関知人": "おぜきともひと",
  "尾形和幸": "おがたかずゆき",
  "和田雄二": "わだゆうじ",
  "四位洋文": "しいひろぶみ",
  "角田晃一": "つのだこういち",
  "野中賢二": "のなかけんじ",
  "田村康仁": "たむらやすひと",
  "稲垣幸雄": "いながきゆきお",
  // 以下、今回のご指摘を受けて追加・拡充した分
  "安達昭夫": "あだちあきお",
  "伊坂重信": "いさかしげのぶ",
  "伊藤圭三": "いとうけいぞう",
  "井上智史": "いのうえさとし",
  "羽月友彦": "はづきともひこ",
  "菊川正達": "きくかわまさみち",
  "吉岡辰弥": "よしおかたつや",
  "吉村圭司": "よしむらけいじ",
  "吉田直弘": "よしだなおひろ",
  "久保田貴": "くぼたたかし",
  "宮地貴稔": "みやじたかとし",
  "上原佑紀": "うえはらゆうき",
  "上原博之": "うえはらひろゆき",
  "中尾秀正": "なかおひでまさ",
  "中川公成": "なかがわこうせい",
  "中村直也": "なかむらなおや",
  "中竹和也": "なかたけかずや",
  "今野貞一": "こんのていいち",
  "伊藤伸一": "いとうしんいち",
  "伊藤大士": "いとうだいし",
  "佐藤吉勝": "さとうよしかつ",
  "佐藤悠太": "さとうゆうた",
  "前川恭子": "まえかわきょうこ",
  "加藤和宏": "かとうかずひろ",
  "北出成人": "きたでなりひと",
  "千田輝彦": "ちだてるひこ",
  "千葉直人": "ちばなおと",
  "和田勇介": "わだゆうすけ",
  "坂口智康": "さかぐちともやす",
  "堀内岳志": "ほりうちたけし",
  "大橋勇樹": "おおはしゆうき",
  "大竹正博": "おおたけまさひろ",
  "奥平雅士": "おくひらまさし",
  "室井潔": "むろいきよし",
  "宮徹": "みやとおる",
  "宮本博": "みやもとひろし",
  "宮田敬介": "みやたけいすけ",
  "寺島良": "てらしまりょう",
  "小林真也": "こばやししんや",
  "小栗実": "おぐりみのる",
  "小野次郎": "おのじろう",
  "岩戸孝樹": "いわとたかき",
  "庄野靖志": "しょうのやすし",
  "戸田博文": "とだひろふみ",
  "斎藤誠": "さいとうまこと",
  "新開幸一": "しんかいこういち",
  "本田優": "ほんだゆう",
  "本間忍": "ほんましのぶ",
  "松尾卓哉": "まつおたくや",
  "松山将樹": "まつやままさき",
  "林徹": "はやしとおる",
  "森一誠": "もりいっせい",
  "武市康男": "たけいちやすお",
  "武藤善則": "むとうよしのり",
  "水野貴広": "みずのたかひろ",
  "池上昌和": "いけがみまさかず",
  "河嶋宏樹": "かわしまひろき",
  "浅利英明": "あさりひであき",
  "清水英克": "しみずひでかつ",
  "牧光二": "まきこうじ",
  "牧田和弥": "まきたかずや",
  "田中勝春": "たなかかつはる",
  "田島俊明": "たじまとしあき",
  "矢嶋大樹": "やじまだいき",
  "矢野英一": "やのえいいち",
  "秋山真一": "あきやましんいち",
  "秋本大介": "あきもとだいすけ",
  "竹内正洋": "たけうちまさひろ",
  "笹田和秀": "ささだかずひで",
  "粕谷昌央": "かすやまさひろ",
  "緒方努": "おがたつとむ",
  "荒川義之": "あらかわよしゆき",
  "西村真幸": "にしむらまさゆき",
  "西田雄一": "にしだゆういち",
  "谷潔": "たにきよし",
  "鈴木伸尋": "すずきのぶひろ",
  "飯田祐史": "いいだゆうじ",
  "高木登": "たかぎのぼる",
  "高橋一哉": "たかはしかずや",
  "高橋文雅": "たかはしふみまさ",
  "高橋義忠": "たかはしよしただ",
  // 以下、追加のご指摘・ご提供により登録(キーはCSV上の実データ=4文字切り詰め形に合わせている)
  "和田正一": "わだしょういちろう",   // CSV表記は「和田正一」(実際は和田正一郎)
  "岡田稲男": "おかだいなお",
  "加藤公太": "かとうこうた",
  "加藤士津": "かとうしづや",         // CSV表記は「加藤士津」(実際は加藤士津八)
  "加藤征弘": "かとうゆきひろ",
  "嘉藤貴行": "かとうたかゆき",
  "萱野浩二": "かやのこうじ",
  "橋田宜長": "はしだよしたけ",
  "金成貴史": "かなりたかし",
  "古賀慎明": "こがまさあき",
  "手塚貴徳": "てづかたかのり",
  "小笠倫弘": "おがさまさひろ",
  "小手川準": "こてがわひとし",
  "小椋研介": "おぐらけんすけ",
  "松下武士": "まつしたたけし",
  "新谷功一": "しんたにこういち",
  "深山雅史": "みやままさし",
  "杉浦宏昭": "すぎうらひろあき",
  "勢司和浩": "せいしかずひろ",
  "石栗龍彦": "いしぐりたつひこ",
  "相沢郁": "あいざわかおる",
  "村田一誠": "むらたいっせい",
  "大久保龍": "おおくぼりゅうじ",     // CSV表記は「大久保龍」(実際は大久保龍志)
  "大根田裕": "おおねだひろゆき",     // CSV表記は「大根田裕」(実際は大根田裕之)
  "大和田成": "おおわだなる",
  "茶木太樹": "ちゃきたいき",
  "中舘英二": "なかだてえいじ",
  "長谷川浩": "はせがわこうだい",     // CSV表記は「長谷川浩」(実際は長谷川浩大)
  "天間昭一": "てんましょういち",
  "田中剛": "たなかつよし",
  "田中博康": "たなかひろやす",
  "渡辺薫彦": "わたなべくにひこ",
  "東田明士": "ひがしだあきし",
  "藤野健太": "ふじのけんた",
  "梅田智之": "うめだともゆき",
  "畑端省吾": "はたばたしょうご",
  "浜田多実": "はまだたみ",
  "武英智": "たけひでのり",
  "平岩大典": "ひらいわだいすけ",
  "柄崎将寿": "つかざきまさとし",
  "鈴木慎太": "すずきしんた",
  "蛯名利弘": "えびなとしひろ",
};

// 辞書に無い名前は、五十音順の代わりに従来通りのUnicode順(localeCompare)にフォールバックする。
// これにより辞書未収録の新しい調教師がCSVに含まれてもエラーにはならない。
// (漢字から読みを機械推定する処理は行わない。辞書に登録された名前だけが正しい五十音順になる)
function trainerSortKey(name) {
  return TRAINER_YOMI[name] || name;
}

/* ------------------------------------------------------------
   調教師 表示名の補正辞書
   ------------------------------------------------------------
   CSVの調教師名は4文字に切り詰められている(例: 大久保龍志→大久保龍)。
   フルネームが判明している調教師だけ、画面表示時にここで正式名称へ
   置き換える。CSVの生データ(h.trainer)自体や、検索・複数選択の
   照合キーはこれまで通り4文字のまま扱う(表示だけを変える)。
   ------------------------------------------------------------ */
const TRAINER_FULL_NAME = {
  "加藤士津": "加藤士津八",
  "大久保龍": "大久保龍志",
  "大根田裕": "大根田裕之",
  "長谷川浩": "長谷川浩大",
  "和田正一": "和田正一郎",
};

// 調教師欄が空文字/空白/null/undefinedの馬をまとめて検索できるようにするための
// 特別な値。実際のCSVデータやHorseオブジェクトにこの文字列が保存されることはない
// (あくまでフィルターUI上だけで使う識別子)。
const UNASSIGNED_TRAINER = "__unassigned__";
const UNASSIGNED_TRAINER_LABEL = "未定";

function trainerDisplayName(raw) {
  if (raw === UNASSIGNED_TRAINER) return UNASSIGNED_TRAINER_LABEL;
  return TRAINER_FULL_NAME[raw] || raw;
}

// 「所属」条件から「調教師」候補一覧を作る共通ロジック。通常の馬一覧・候補馬画面の
// どちらからも同じ関数を使うことで、処理方法や意味が食い違わないようにする。
function computeTrainerOptions(population, region) {
  const subset = region
    ? population.filter((h) => (h.region ? h.region === region : region === UNASSIGNED_REGION))
    : population;
  const s = new Set(subset.map((h) => h.trainer).filter(Boolean));
  const sorted = Array.from(s).sort((a, b) => trainerSortKey(a).localeCompare(trainerSortKey(b), "ja"));
  const hasUnassigned = subset.some((h) => !h.trainer);
  return hasUnassigned ? [UNASSIGNED_TRAINER, ...sorted] : sorted;
}
function computeBreederOptions(population) {
  const s = new Set(population.map((h) => h.breeder).filter(Boolean));
  return Array.from(s).sort((a, b) => a.localeCompare(b, "ja"));
}

function computeDamSireOptions(population) {
  const s = new Set(population.map((h) => h.damSire).filter(Boolean));
  return Array.from(s).sort((a, b) => a.localeCompare(b, "ja"));
}

function parseHorses(csvText, season) {
  const result = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const fields = result.meta.fields || [];
  const mapping = {};
  fields.forEach((f) => { const key = mapHeader(f); if (key) mapping[f] = key; });

  return result.data.map((row, idx) => {
    const h = {
      id: null, name: "", sire: "", dam: "", damSire: "", birthDate: "",
      sex: "", color: "", trainer: "", region: "", breeder: "", owner: "",
      damNameYear: "", nameIsPlaceholder: false, raw: {},
    };
    Object.entries(row).forEach(([col, val]) => {
      const key = mapping[col];
      if (key) h[key] = (val || "").toString().trim();
      else if (col && !isExcludedRawColumn(col)) h.raw[col] = val;
    });
    // 馬名がまだ決まっていない馬(馬名欄が空白)は、CSVの「(母名+生年)」列の値を
    // 代替表示名として使う。除外はせず、通常の馬と同じように取り込む。
    if (!h.name) {
      h.name = h.damNameYear || `(馬名未定 #${idx + 1})`;
      h.nameIsPlaceholder = true;
    }
    if (!h.id) h.id = `${h.name}__${idx}`;
    // 年度をどのHorseレコードが登録された年度分かのマーキングに使う。
    // 印・チェック等の照合はh.idだけに頼らず、年度を含めたcompositeIdを
    // 使うことで、別年度に同じ登録番号の馬がいても混同しない設計にする
    // (marks/checksのストレージ自体も年度ごとに分離されているため
    // 二重の安全策になる)。
    h.season = season;
    h.compositeId = `${season}:${h.id}`;
    return h;
  }).filter((h) => h.name);
}

/* ============================================================
   血統データベース基盤 (STEP4)
   ------------------------------------------------------------
   目的: 10代までの祖先を「父→父→母」のような経路(path)付きで
   保存・参照できる土台を作る。UI(血統解析画面・検索・ツリー表示)
   は今回実装しない。既存の馬データ・印・候補馬・検索・年度別
   データ・馬詳細・メモには一切触れない、独立したモジュール。

   保存場所: PEDIGREE_STORAGE_KEY ("pedigree-v1")
   - 年度サフィックスを付けない共有データ。2026年度・2027年度の
     馬が同じ祖先(例: ノーザンダンサー)を持つ場合でも、祖先データは
     重複保存せず1件だけを共有参照する。

   データ構造:
   PedigreeDB = {
     version: 1,
     horses: {
       [pedigreeKey]: {
         name: string,       // 表示用の馬名(原文のまま)
         sireKey: string|null, // 父のpedigreeKey
         damKey: string|null,  // 母のpedigreeKey
       },
       ...
     }
   }

   pedigreeKeyは馬名を正規化(NFKC正規化+前後空白除去+大文字小文字統一)
   した文字列で、表記ゆれ("Northern Dancer" と "ノーザンダンサー" は
   別馬として扱うが、"northern dancer" と "Northern Dancer" は同一
   個体とみなす)があっても同じ祖先データを再利用できるようにする。

   世代1(父・母)と世代2の母父(母の父)は、CSVインポート時点で
   Horseオブジェクト自身が既に持っている情報(h.sire/h.dam/h.damSire)
   なので、pedigreeDBに重複して保存する必要はない。pedigreeDBは
   「CSVだけでは分からない、さらに奥の祖先」を後から追記していく
   ための領域として設計している。祖先を辿る関数(buildAncestorTree等)
   は、まずHorseオブジェクト自身の情報を使い、世代3以降が必要に
   なった時点でpedigreeDBを参照する。
   ============================================================ */

// 表記ゆれ(カタカナ表記・英字表記など)を明示的に統合するための別名辞書。
// 「ノーザンダンサー」と「Northern Dancer」のように、別表記でも同一馬だと
// 分かっている場合だけここに追記する。自動のあいまい一致は行わない
// (同名の別馬を誤って統合しないようにするため)。キーは何でもよいが、
// 値は必ずどちらか一方の"正規表記"(通常は先に登録した方の表記)に揃える。
const PEDIGREE_ALIASES = {
  // 例: "ノーザンダンサー": "Northern Dancer",
};

// 馬名を正規化してpedigreeDBのキーにする(表記ゆれを吸収するため)。
// PEDIGREE_ALIASESに登録があれば先にそちらへ変換してから正規化する。
function pedigreeKey(name) {
  if (!name) return null;
  const resolved = PEDIGREE_ALIASES[name] || name;
  return resolved.normalize("NFKC").trim().toLowerCase();
}

async function loadPedigreeDB() {
  const db = await loadJSON(PEDIGREE_STORAGE_KEY, null);
  return db && db.horses ? db : { version: 1, horses: {} };
}

// 起動時・取り込み前に使う厳密版。保存データが無ければ空のDB、読めない/壊れている場合は例外
// (空のDBとして続行して、既存の血統データを上書きしてしまわないため)。
async function loadPedigreeDBStrict() {
  const db = await loadJSONOrThrow(PEDIGREE_STORAGE_KEY, null);
  if (db === null) return { version: 1, horses: {} };
  if (!db || typeof db !== "object" || !db.horses || typeof db.horses !== "object" || Array.isArray(db.horses)) {
    throw new StorageLoadError(`血統データの形式が正しくありません(${PEDIGREE_STORAGE_KEY})`, "integrity", PEDIGREE_STORAGE_KEY);
  }
  return db;
}

async function savePedigreeDB(db, opts) {
  // 以前はsaveJSONの戻り値(成否)を握りつぶしていたため、保存が実際には
  // 失敗していても呼び出し側が気づけない不具合があった。戻り値をそのまま返す。
  return saveJSON(PEDIGREE_STORAGE_KEY, db, opts);
}

const PEDIGREE_CONFLICTS_STORAGE_KEY = "pedigree-conflicts-v1"; // 年度非依存・共有

async function loadPedigreeConflicts() {
  return loadJSON(PEDIGREE_CONFLICTS_STORAGE_KEY, []);
}
async function loadPedigreeConflictsStrict() {
  const list = await loadJSONOrThrow(PEDIGREE_CONFLICTS_STORAGE_KEY, []);
  if (!Array.isArray(list)) {
    throw new StorageLoadError(`血統の矛盾データの形式が正しくありません(${PEDIGREE_CONFLICTS_STORAGE_KEY})`, "integrity", PEDIGREE_CONFLICTS_STORAGE_KEY);
  }
  return list;
}
async function savePedigreeConflicts(conflicts) {
  return saveJSON(PEDIGREE_CONFLICTS_STORAGE_KEY, conflicts);
}

/* ------------------------------------------------------------
   1頭分の情報(名前・父・母)をpedigreeDBへマージする。
   ------------------------------------------------------------
   - 新規の馬名なら新規追加(status: "new")
   - 既存レコードの該当項目が空なら、新しい情報で埋める(status: "updated")
   - 既存レコードの該当項目に値があり、新しい情報と一致するなら
     変化なし(status: "unchanged")
   - 既存レコードの該当項目に値があり、新しい情報と食い違う場合は
     絶対に上書きせず、conflictとして報告する(status: "conflict")
   父・母それぞれ独立に判定するため、片方だけ矛盾することもある。
   ------------------------------------------------------------ */
function mergePedigreeRecord(db, name, sireName, damName) {
  const key = pedigreeKey(name);
  if (!key) return { db, statuses: [], conflicts: [] };

  const sireKey = pedigreeKey(sireName);
  const damKey = pedigreeKey(damName);
  const next = { ...db, horses: { ...db.horses } };
  const conflicts = [];
  const statuses = [];

  const cur = next.horses[key] || { name, sireKey: null, damKey: null };
  let mergedSireKey = cur.sireKey;
  let mergedDamKey = cur.damKey;

  if (sireKey) {
    if (!cur.sireKey) {
      mergedSireKey = sireKey;
      statuses.push("updated");
    } else if (cur.sireKey === sireKey) {
      statuses.push("unchanged");
    } else {
      conflicts.push({
        name: cur.name || name,
        field: "sire",
        existingName: next.horses[cur.sireKey]?.name || cur.sireKey,
        incomingName: sireName,
      });
    }
  }
  if (damKey) {
    if (!cur.damKey) {
      mergedDamKey = damKey;
      statuses.push("updated");
    } else if (cur.damKey === damKey) {
      statuses.push("unchanged");
    } else {
      conflicts.push({
        name: cur.name || name,
        field: "dam",
        existingName: next.horses[cur.damKey]?.name || cur.damKey,
        incomingName: damName,
      });
    }
  }

  const isNew = !next.horses[key];
  next.horses[key] = { name: cur.name || name, sireKey: mergedSireKey, damKey: mergedDamKey };
  if (isNew) statuses.unshift("new");

  // 父・母についても、名前だけは分かっているスタブレコードを作っておく
  // (孫世代からリンクをたどれるようにするため。既存データがあれば壊さない)。
  if (sireKey && !next.horses[sireKey]) {
    next.horses[sireKey] = { name: sireName, sireKey: null, damKey: null };
  }
  if (damKey && !next.horses[damKey]) {
    next.horses[damKey] = { name: damName, sireKey: null, damKey: null };
  }

  return { db: next, statuses, conflicts };
}

// 旧バージョンのAPIとの互換用(単発登録・矛盾は無視して補完のみ行う)。
function upsertPedigreeHorse(db, name, sireName, damName) {
  return mergePedigreeRecord(db, name, sireName, damName).db;
}

/* ------------------------------------------------------------
   CSV(馬名,父,母)を一括でpedigreeDBへ取り込む。
   1行ごとには保存せず、全行処理してから呼び出し側が1回だけ
   savePedigreeDBする想定(この関数自体はメモリ上の処理のみ)。
   ------------------------------------------------------------ */
function importPedigreeCsvRows(rows, db) {
  let workingDb = db;
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let incompleteCount = 0;
  const allConflicts = [];

  rows.forEach((row) => {
    const name = (row["馬名"] || "").toString().trim();
    const sire = (row["父"] || "").toString().trim();
    const dam = (row["母"] || "").toString().trim();
    if (!name) return; // 馬名が無い行はスキップ(登録しようがないため)
    if (!sire || !dam) incompleteCount += 1; // 父・母のどちらか/両方が空

    const { db: mergedDb, statuses, conflicts } = mergePedigreeRecord(workingDb, name, sire, dam);
    workingDb = mergedDb;
    if (statuses.includes("new")) newCount += 1;
    else if (statuses.includes("updated")) updatedCount += 1;
    else if (statuses.includes("unchanged")) unchangedCount += 1;
    allConflicts.push(...conflicts);
  });

  return { db: workingDb, newCount, updatedCount, unchangedCount, incompleteCount, conflicts: allConflicts };
}

// 現在は7代を基本とする。将来10代に拡張する場合はこの値を変更するだけでよい
// (buildAncestorTree等はすべてmaxGenerationを引数で受け取る設計にしてある)。
const PEDIGREE_MAX_GENERATION = 7;
const PEDIGREE_SIDE = { SIRE: "sire", DAM: "dam" };

// インブリード表示(「3×4」形式)だけに適用する世代の上限。血統データ自体は
// 引き続き7代(PEDIGREE_MAX_GENERATION)保持・検索の対象であり、この値は
// 画面上のインブリード表示範囲だけを狭める目的で使う。
const INBREEDING_MAX_GENERATION = 5;

/* ------------------------------------------------------------
   祖先ツリーの構築
   ------------------------------------------------------------
   root(Horseオブジェクト、または {name,sire,dam,damSire} 相当)から
   最大10代まで辿り、各祖先を
     { name, generation, path, key }
   のノードとして返す。pathは root から見た経路を 'sire'/'dam' の
   配列で表したもの(例: ['dam','sire'] は「母の父」)。
   pedigreeDBに情報が無い箇所はそこで打ち切り(null)、エラーには
   しない。
   ------------------------------------------------------------ */
function buildAncestorTree(root, pedigreeDB, maxGeneration = PEDIGREE_MAX_GENERATION) {
  const nodes = [];
  const horses = pedigreeDB?.horses || {};

  // 世代1(父・母)はrootオブジェクト自身が持っている情報を使う。
  const gen1 = [
    { side: PEDIGREE_SIDE.SIRE, name: root?.sire || null },
    { side: PEDIGREE_SIDE.DAM, name: root?.dam || null },
  ];

  const visit = (name, generation, path) => {
    if (!name || generation > maxGeneration) return;
    const key = pedigreeKey(name);
    nodes.push({ name, generation, path: [...path], key });
    if (generation >= maxGeneration) return;

    // 世代2の「母の父(母父)」はrootが既に持っている情報を優先して使う
    // (CSVの母父列由来。pedigreeDBに無くても辿れるようにするため)。
    const entry = key ? horses[key] : null;
    let sireName = (generation === 1 && path[0] === PEDIGREE_SIDE.DAM && root?.damSire) || null;
    if (!sireName && entry?.sireKey) sireName = horses[entry.sireKey]?.name || null;
    const damName = entry?.damKey ? (horses[entry.damKey]?.name || null) : null;

    visit(sireName, generation + 1, [...path, PEDIGREE_SIDE.SIRE]);
    visit(damName, generation + 1, [...path, PEDIGREE_SIDE.DAM]);
  };

  gen1.forEach(({ side, name }) => visit(name, 1, [side]));
  return nodes;
}

// 指定した祖先名(表記ゆれ・大文字小文字を無視)が何本(何箇所)存在するかを数える。
function countAncestorOccurrences(root, ancestorName, pedigreeDB, maxGeneration = PEDIGREE_MAX_GENERATION) {
  return findAncestorNodes(root, ancestorName, pedigreeDB, maxGeneration).length;
}

// 指定した祖先名に一致するノード(経路情報付き)をすべて返す。
function findAncestorNodes(root, ancestorName, pedigreeDB, maxGeneration = PEDIGREE_MAX_GENERATION) {
  const targetKey = pedigreeKey(ancestorName);
  if (!targetKey) return [];
  return buildAncestorTree(root, pedigreeDB, maxGeneration).filter((n) => n.key === targetKey);
}

// ノードが「父系(root自身の父からずっと父方だけを辿った経路)」上にあるか。
function isInSireLine(node) {
  return node.path.every((p) => p === PEDIGREE_SIDE.SIRE);
}

// ノードが「(root自身から見て)側(sire/dam)の直系男系(牡系)」上にあるか。
// 例: side="dam" なら「母の牡系」= 母→父→父→…という経路を指す。
function isInMaleLineOf(node, side) {
  if (node.path[0] !== side) return false;
  return node.path.slice(1).every((p) => p === PEDIGREE_SIDE.SIRE);
}

// 「母の牡系」に指定した祖先が存在するかどうかの判定(要望にあった例そのもの)。
function hasAncestorInDamMaleLine(root, ancestorName, pedigreeDB, maxGeneration = PEDIGREE_MAX_GENERATION) {
  return findAncestorNodes(root, ancestorName, pedigreeDB, maxGeneration)
    .some((n) => isInMaleLineOf(n, PEDIGREE_SIDE.DAM));
}

// 祖先が父側(root自身の父の血統内)・母側(root自身の母の血統内)のどちらに
// 存在するかを判定する。
function hasAncestorOnSide(root, ancestorName, pedigreeDB, side, maxGeneration = PEDIGREE_MAX_GENERATION) {
  return findAncestorNodes(root, ancestorName, pedigreeDB, maxGeneration)
    .some((n) => n.path[0] === side);
}

/* ============================================================
   血統不足検知(状態A/B/C/D・不足祖先の集計)
   ------------------------------------------------------------
   すべて既存データ(馬データ・pedigree-v1)から計算する純粋関数で、
   状態そのものは保存しない。buildAncestorTreeは変更せず、同じ走査規則
   (第1世代のみ母の父はCSVの母父を優先/DBに無い箇所で打ち切り/
   第7世代は親を探さない)を scanPedigreeGaps に複製している。
   ============================================================ */
const PEDIGREE_TOTAL_SLOTS = (() => {
  let t = 0;
  for (let g = 1; g <= PEDIGREE_MAX_GENERATION; g++) t += 2 ** g;
  return t; // 2+4+8+16+32+64+128 = 254
})();

const GAP_STATE_LABEL = { A: "254枠到達", B: "途切れ", C: "親情報なし", D: "要確認" };

/* root: { sire, dam, damSire }。戻り値:
   nodes   : buildAncestorTreeと同じ順序・同じ内容のノード(名前が分かるもの)。
             各ノードに DBレコードの有無(hasRecord)、DBの親リンクの有無(dbSire/dbDam)、
             実効的な親情報の有無(sireInfo/damInfo。第1世代の母はCSV母父も含む)を付ける。
   keyOnly : DBの親リンク先レコードが実在せず、名前が分からない祖先(キーのみ)。
   countByGen[g] : 第g世代で到達した枠数。 */
function scanPedigreeGaps(root, pedigreeDB, maxGeneration = PEDIGREE_MAX_GENERATION) {
  const horses = pedigreeDB?.horses || {};
  const nodes = [];
  const keyOnly = [];
  const countByGen = new Array(maxGeneration + 1).fill(0);

  const visit = (name, generation, path) => {
    if (!name || generation > maxGeneration) return;
    const key = pedigreeKey(name);
    const entry = key ? horses[key] : null;
    const node = {
      name, generation, path, key,
      hasRecord: !!entry,
      dbSire: !!entry?.sireKey, dbDam: !!entry?.damKey,
      sireInfo: false, damInfo: false,
    };
    nodes.push(node);
    countByGen[generation] += 1;
    if (generation >= maxGeneration) return;

    let sireName = (generation === 1 && path[0] === "d" && root?.damSire) || null;
    if (!sireName && entry?.sireKey) sireName = horses[entry.sireKey]?.name || null;
    const damName = entry?.damKey ? (horses[entry.damKey]?.name || null) : null;

    // リンク先レコードが無く名前が分からない祖先は、名前の代わりにキーだけ控える
    if (!sireName && entry?.sireKey) keyOnly.push({ key: entry.sireKey, generation: generation + 1, path: path + "s" });
    if (!damName && entry?.damKey) keyOnly.push({ key: entry.damKey, generation: generation + 1, path: path + "d" });
    node.sireInfo = !!sireName || !!entry?.sireKey;
    node.damInfo = !!damName || !!entry?.damKey;

    visit(sireName, generation + 1, path + "s");
    visit(damName, generation + 1, path + "d");
  };

  visit(root?.sire || null, 1, "s");
  visit(root?.dam || null, 1, "d");
  return { nodes, keyOnly, countByGen, reached: nodes.length, total: PEDIGREE_TOTAL_SLOTS, maxGeneration };
}

// 枠が埋まりきっていない最も浅い世代(すべて埋まっていればnull)
function firstGapGeneration(countByGen, maxGeneration = PEDIGREE_MAX_GENERATION) {
  for (let g = 1; g <= maxGeneration; g++) {
    if ((countByGen[g] || 0) < 2 ** g) return g;
  }
  return null;
}

/* 1頭分の判定。pedigreeDBが未読み込み(null)のときはnull(判定保留)を返す。
   評価順:
     1) 父/母が空欄 → D
     2) 馬データと血統DBの食い違い → D(祖先集計から除外)
     3) 第1世代の父・母のどちらかで、実効的な親情報が両方ともない → C
     4) 254枠すべて到達 → A
     5) それ以外 → B(最浅の途切れ世代)
   Dの空欄だけの馬は、存在する側の名前は確かなので祖先集計に含める。 */
function classifyPedigreeGap(horse, pedigreeDB) {
  if (!pedigreeDB || !pedigreeDB.horses) return null;
  const horses = pedigreeDB.horses;
  const reasons = [];
  let isD = false;
  let excluded = false;

  const hasSire = !!horse.sire;
  const hasDam = !!horse.dam;
  if (!hasSire || !hasDam) {
    isD = true;
    reasons.push(!hasSire && !hasDam ? "父・母が未入力" : !hasSire ? "父が未入力" : "母が未入力");
  }

  const mismatches = [];
  const dbName = (key) => horses[key]?.name || "名前不明";
  const damEntry = hasDam ? horses[pedigreeKey(horse.dam)] : null;
  if (horse.damSire && damEntry?.sireKey && pedigreeKey(horse.damSire) !== damEntry.sireKey) {
    mismatches.push(`母父がCSV「${horse.damSire}」と血統DB「${dbName(damEntry.sireKey)}」で不一致`);
  }
  // 仮の馬名(母名+生年から作った名前)は別馬のレコードと偶然一致しうるため照合しない
  if (horse.name && !horse.nameIsPlaceholder) {
    const own = horses[pedigreeKey(horse.name)];
    if (own) {
      if (own.sireKey && hasSire && own.sireKey !== pedigreeKey(horse.sire)) {
        mismatches.push(`父が馬データ「${horse.sire}」と血統DB「${dbName(own.sireKey)}」で不一致`);
      }
      if (own.damKey && hasDam && own.damKey !== pedigreeKey(horse.dam)) {
        mismatches.push(`母が馬データ「${horse.dam}」と血統DB「${dbName(own.damKey)}」で不一致`);
      }
    }
  }
  if (mismatches.length > 0) {
    isD = true;
    excluded = true;
    reasons.push(...mismatches);
  }

  const base = { reasons, excluded, scan: null, reached: 0, total: PEDIGREE_TOTAL_SLOTS, gapGeneration: null };
  const withReason = (state, extra) => {
    const all = extra ? [...reasons, extra] : reasons;
    return { ...base, state, reason: all.join(" / ") };
  };

  if (excluded) {
    return withReason("D", "祖先集計の対象外");
  }
  const scan = scanPedigreeGaps({ sire: horse.sire, dam: horse.dam, damSire: horse.damSire }, pedigreeDB);
  base.scan = scan;
  base.reached = scan.reached;
  if (isD) return withReason("D");

  // C: 第1世代の父・母それぞれについて、実効的な親情報が両方ともない(レコード無しを含む)
  const cParts = [];
  scan.nodes.filter((n) => n.generation === 1).forEach((n) => {
    if (!n.sireInfo && !n.damInfo) {
      const who = n.path === "s" ? "父" : "母";
      cParts.push(n.hasRecord ? `${who}「${n.name}」の親情報なし` : `${who}「${n.name}」が血統DB未登録`);
    }
  });
  if (cParts.length > 0) {
    reasons.push(...cParts);
    return withReason("C");
  }

  if (scan.reached === scan.total) return withReason("A", `${scan.total}/${scan.total}枠`);
  const g = firstGapGeneration(scan.countByGen, scan.maxGeneration);
  base.gapGeneration = g;
  return withReason("B", `第${g}世代で途切れ(到達 ${scan.reached}/${scan.total}) ※親が不明な可能性もあります`);
}

/* 不足祖先の集計。rows: [{ horse, result }](resultはclassifyPedigreeGapの戻り値)。
   - 食い違いでDの馬(excluded)は集計しない。
   - 同じ馬の血統表に同じ祖先が何度出ても、その馬1頭として数える(馬ごとにキーの集合で重複排除)。
   - unregistered: 血統DBにレコードが無い名前(確実な未登録)
   - needCheck   : レコードはあるがDBに親情報が無い/片方だけの名前(第7世代は親を探さないので除く)
   - nameless    : リンク先レコードが無く名前が分からない(キーのみ) */
function aggregateAncestorGaps(rows) {
  const unregistered = new Map();
  const needCheck = new Map();
  const nameless = new Map();
  let includedHorses = 0;
  let excludedHorses = 0;
  const bump = (map, key, make) => {
    const cur = map.get(key);
    if (cur) cur.count += 1; else map.set(key, { ...make(), count: 1 });
  };
  rows.forEach(({ result }) => {
    if (!result) return;
    if (result.excluded) { excludedHorses += 1; return; }
    if (!result.scan) return;
    includedHorses += 1;
    const seenU = new Set();
    const seenC = new Set();
    const seenN = new Set();
    result.scan.nodes.forEach((n) => {
      if (!n.key) return;
      if (!n.hasRecord) {
        if (seenU.has(n.key)) return;
        seenU.add(n.key);
        bump(unregistered, n.key, () => ({ key: n.key, name: n.name }));
      } else if (n.generation < result.scan.maxGeneration && !(n.dbSire && n.dbDam)) {
        if (seenC.has(n.key)) return;
        seenC.add(n.key);
        bump(needCheck, n.key, () => ({ key: n.key, name: n.name, kind: !n.dbSire && !n.dbDam ? "none" : "half" }));
      }
    });
    result.scan.keyOnly.forEach((k) => {
      if (seenN.has(k.key)) return;
      seenN.add(k.key);
      bump(nameless, k.key, () => ({ key: k.key }));
    });
  });
  const sortList = (map) => [...map.values()].sort((a, b) => b.count - a.count || (a.name || a.key).localeCompare(b.name || b.key, "ja"));
  return {
    unregistered: sortList(unregistered),
    needCheck: sortList(needCheck),
    nameless: sortList(nameless),
    includedHorses,
    excludedHorses,
  };
}

/* ============================================================
   IndexedDBベースの保存層
   ------------------------------------------------------------
   Claudeの実行環境が提供する window.storage は、このArtifactの
   プレビュー表示中しか使えない独自機能であり、Artifactを公開した
   後のページでは利用できない。また現在、書き込み・読み込みの両方が
   安定して失敗する障害が続いている。

   そこで、標準のブラウザAPIであるIndexedDBを使い、
   window.storage と全く同じ呼び出し方(get/set/delete、第2引数は
   shared)ができる代替実装をここで用意し、起動時に window.storage を
   この実装に差し替える。loadJSON・saveJSON・storageSet・
   saveHorsesChunked・runStorageSelfTest など、保存に関わるコードは
   すべてwindow.storage経由でしか呼んでいないため、呼び出し側は
   一切変更していない(保存層だけを差し替える設計)。

   IndexedDBはiOS Safariを含む主要ブラウザで標準サポートされており、
   Artifact公開後のページでも引き続き使える。
   ------------------------------------------------------------ */
const IDB_DB_NAME = "pog-manager-db";
const IDB_STORE_NAME = "kv";
const IDB_VERSION = 1;

let _idbOpenPromise = null;
// 接続を開く。失敗したPromiseはキャッシュしない(再読み込みしなくても次の呼び出しで再接続できる)。
// 接続が閉じられた/他のタブがバージョン変更を要求した場合も、キャッシュを破棄して次回取り直す。
function openIDB() {
  if (_idbOpenPromise) return _idbOpenPromise;
  const p = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    let req;
    try {
      req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const drop = () => { if (_idbOpenPromise === p) _idbOpenPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch (e) { /* 無視 */ } drop(); };
      db.onclose = drop;
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
  _idbOpenPromise = p;
  p.catch(() => { if (_idbOpenPromise === p) _idbOpenPromise = null; });
  return p;
}

// shared/非sharedで同名キーが衝突しないよう、実際の格納キーには接頭辞を付ける
// (現状のアプリはほぼ全てshared:falseだが、念のための安全策)。
function idbRealKey(key, shared) {
  return (shared ? "shared:" : "priv:") + key;
}

// 接続が閉じていた(iOSの中断・復帰など)ときのエラーか
function isStaleConnectionError(e) {
  return !!e && (e.name === "InvalidStateError" || /clos(ed|ing)/i.test(e.message || ""));
}

// 1つのトランザクションを実行し、「トランザクションの完了(oncomplete)」まで待ってから結果を返す。
// 個々のリクエストが成功しても、コミットに失敗(onabort/onerror)した場合は reject する。
// 接続が閉じていた場合は、接続を取り直して1回だけやり直す(get/put/deleteはやり直しても安全)。
// work(store, setResult) の中ではリクエストを発行するだけにする。
async function idbTx(mode, work) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const db = await openIDB();
      return await new Promise((resolve, reject) => {
        let result;
        let tx;
        try {
          tx = db.transaction(IDB_STORE_NAME, mode);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction error"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
        try {
          work(tx.objectStore(IDB_STORE_NAME), (v) => { result = v; });
        } catch (e) {
          try { tx.abort(); } catch (e2) { /* 無視 */ }
          reject(e);
        }
      });
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && isStaleConnectionError(e)) {
        _idbOpenPromise = null; // 古い接続を捨てて取り直す
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// window.storage と同じ呼び出し方(get/set/delete、戻り値の形)を持つ、
// IndexedDBバックエンドの実装。getStrict は「ない」と「エラー」を区別するための追加メソッド。
const idbStorageImpl = {
  async get(key, shared) {
    const value = await idbTx("readonly", (store, out) => {
      const req = store.get(idbRealKey(key, shared));
      req.onsuccess = () => out(req.result);
    });
    // window.storage.get は未存在キーで例外を投げる仕様だったため、挙動を合わせる。
    if (value === undefined) throw new Error("not found");
    return { key, value, shared: !!shared };
  },
  // 見つからない場合は { found:false }、読み込みに失敗した場合は例外(=エラー)。
  async getStrict(key, shared) {
    const value = await idbTx("readonly", (store, out) => {
      const req = store.get(idbRealKey(key, shared));
      req.onsuccess = () => out(req.result);
    });
    return value === undefined ? { found: false } : { found: true, value };
  },
  async set(key, value, shared) {
    await idbTx("readwrite", (store) => { store.put(value, idbRealKey(key, shared)); });
    // 保存に成功したキーをGitHub同期に知らせる(同期側の失敗は、保存の成否に影響させない)
    if (!shared && _syncEngine) { try { _syncEngine.noteWrite(key); } catch (e) { /* 無視 */ } }
    return { key, value, shared: !!shared };
  },
  async delete(key, shared) {
    const realKey = idbRealKey(key, shared);
    const existed = await idbTx("readwrite", (store, out) => {
      const getReq = store.get(realKey);
      getReq.onsuccess = () => {
        out(getReq.result !== undefined);
        store.delete(realKey);
      };
    });
    return { key, deleted: !!existed, shared: !!shared };
  },
};

/* ------------------------------------------------------------
   GitHub同期(sync.js)との接続部分
   保存層(IndexedDB)を、同期エンジンが使う最小限のインターフェースに合わせる。
   エンジンは App 内で作り、ここに登録する(idbStorageImpl.set から保存の通知を受けるため)。
   ------------------------------------------------------------ */
let _syncEngine = null;
const syncStoreAdapter = {
  getStrict: (key) => idbStorageImpl.getStrict(key, false),
  set: (key, value) => idbStorageImpl.set(key, value, false),
  // 複数のキーを、IndexedDBの1つのトランザクションでまとめて保存する(全部書けるか、全部書かないか)。
  // 途中で失敗したらトランザクション全体が取り消され、1件も反映されない。
  async setMany(entries) {
    const keys = Object.keys(entries);
    await idbTx("readwrite", (store) => {
      for (const k of keys) store.put(entries[k], idbRealKey(k, false));
    });
  },
  delete: (key) => idbStorageImpl.delete(key, false),
  async listKeys() {
    const keys = await idbTx("readonly", (store, out) => {
      const req = store.getAllKeys();
      req.onsuccess = () => out(req.result);
    });
    return (keys || []).map((k) => String(k)).filter((k) => k.startsWith("priv:")).map((k) => k.slice(5));
  },
};

/* ------------------------------------------------------------
   旧(Claude実行環境の)window.storageに読めるデータが残っていれば、
   IndexedDBへ切り替える前に一度だけコピーしておく。読めなければ
   何もしない(現状どのみち読み出せていないため、データを失うことに
   はならない)。既にIndexedDB側に同名キーがあれば上書きしない
   (誤って新しいデータを古いデータで消さないため)。
   ------------------------------------------------------------ */
async function migratePlatformStorageToIDBIfNeeded(platformStorage) {
  if (!platformStorage || typeof platformStorage.get !== "function") return;

  const tryCopy = async (key) => {
    try {
      // 既にIndexedDB側にあるか、厳密に確認する。読めない場合は何もしない(上書きしない)。
      const existing = await idbStorageImpl.getStrict(key, false);
      if (existing.found) return;
      const res = await platformStorage.get(key, false);
      if (res && res.value !== undefined) {
        await idbStorageImpl.set(key, res.value, false);
      }
    } catch (e) { /* 旧ストレージから読めなければ何もしない(現状と同じ状態) */ }
  };

  // 年度非依存の共有データ
  await tryCopy(CURRENT_SEASON_KEY);
  await tryCopy(PEDIGREE_STORAGE_KEY);
  await tryCopy(PEDIGREE_CONFLICTS_STORAGE_KEY);

  // 移行対象の年度: 既定年度 + (読めれば)直前に使っていた年度
  const seasonsToCheck = new Set([DEFAULT_SEASON]);
  try {
    const cur = await platformStorage.get(CURRENT_SEASON_KEY, false);
    if (cur && cur.value) {
      const parsedSeason = JSON.parse(cur.value);
      if (parsedSeason) seasonsToCheck.add(parsedSeason);
    }
  } catch (e) { /* 読めなければ既定年度のみ */ }

  for (const season of seasonsToCheck) {
    const keys = seasonStorageKeys(season);
    await tryCopy(keys.marks);
    await tryCopy(keys.categories);
    await tryCopy(keys.horses); // 分割保存導入前の単一キー形式(後方互換)
    await tryCopy(horsesMetaKey(season));
    try {
      const metaRes = await idbStorageImpl.get(horsesMetaKey(season), false).catch(() => null);
      const meta = metaRes ? JSON.parse(metaRes.value) : null;
      if (meta && meta.chunkCount) {
        for (let i = 0; i < meta.chunkCount; i++) {
          await tryCopy(horsesChunkKey(season, i));
        }
      }
    } catch (e) { /* メタが読めなければチャンクも対象外 */ }
  }

  // 年度管理そのものが無かった頃の、さらに古いフラットキー
  await tryCopy(LEGACY_STORAGE_KEYS.horses);
  await tryCopy(LEGACY_STORAGE_KEYS.marks);
  await tryCopy(LEGACY_STORAGE_KEYS.categories);
}

let _idbStorageInstalled = false;
let _platformStorageRef = null;

/* ------------------------------------------------------------
   保存の診断(データが消える原因の切り分け用)
   ------------------------------------------------------------
   既存のデータは一切変更しない。書き込むのは診断専用のキー(pog-probe-v1 と
   pog-diag-roundtrip)だけで、ほかのキーには触れない。
   ・recordLaunchProbe: 起動のたびに「起動回数・日時・実行環境・馬データ件数」を
     ブラウザ内(IndexedDB)と、ブラウザの外(Claude側ストレージ)の両方に記録する。
     次の起動で片方だけが消えていれば、原因を切り分けられる。
   ・runStorageDiagnostics: 現在の状態を調べて、文章にして返す(読み取り中心)。
   ------------------------------------------------------------ */
const PROBE_KEY = "pog-probe-v1";
const DIAG_ROUNDTRIP_KEY = "pog-diag-roundtrip";
let _probeRecorded = false;

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);
}

function describeLaunchEnv() {
  let inFrame = false;
  try { inFrame = window.top !== window.self; } catch (e) { inFrame = true; }
  let standalone = false;
  try {
    standalone = (typeof navigator !== "undefined" && navigator.standalone === true) ||
      !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  } catch (e) { /* 無視 */ }
  let ancestors = "";
  try { ancestors = Array.from((typeof location !== "undefined" && location.ancestorOrigins) || []).join(","); } catch (e) { /* 無視 */ }
  let refOrigin = "";
  try { refOrigin = document.referrer ? new URL(document.referrer).origin : ""; } catch (e) { /* 無視 */ }
  return {
    origin: (typeof location !== "undefined") ? location.origin : "",
    path: (typeof location !== "undefined") ? location.pathname : "",
    inFrame, standalone, ancestors, refOrigin,
    ua: (typeof navigator !== "undefined") ? navigator.userAgent : "",
  };
}

const isNotFoundMessage = (e) => /not found|404/i.test((e && e.message) || String(e));

// 起動記録を1件書く。読み込みが正常に終わったあとに、1ページ読み込みにつき1回だけ呼ぶ。
// 失敗しても本体には影響しない(例外は握りつぶす)。診断専用キー以外は書かない。
async function recordLaunchProbe(horsesCount) {
  if (_probeRecorded) return;
  _probeRecorded = true;
  const env = describeLaunchEnv();
  const entry = { t: Date.now(), standalone: env.standalone, inFrame: env.inFrame, horses: horsesCount };
  const bump = (rec) => {
    const r = (rec && typeof rec === "object" && Array.isArray(rec.history)) ? rec : { v: 1, firstAt: entry.t, launches: 0, history: [] };
    r.launches = (r.launches || 0) + 1;
    r.lastAt = entry.t;
    r.history = r.history.concat([entry]).slice(-12);
    return r;
  };
  // ブラウザ内(IndexedDB)。読めたときだけ書く(読めないのに新規記録で上書きしない)。
  try {
    const got = await idbStorageImpl.getStrict(PROBE_KEY, false);
    let rec = null;
    if (got.found) { try { rec = JSON.parse(got.value); } catch (e) { rec = null; } }
    await idbStorageImpl.set(PROBE_KEY, JSON.stringify(bump(rec)), false);
  } catch (e) { /* 診断用なので無視 */ }
  // ブラウザの外(Claude側ストレージ)。使えない環境では何もしない。
  const ps = _platformStorageRef;
  if (ps && typeof ps.get === "function" && typeof ps.set === "function") {
    try {
      let rec = null, readable = true;
      try {
        const g = await withTimeout(ps.get(PROBE_KEY, false), 6000);
        if (g && g.value !== undefined) rec = JSON.parse(g.value);
      } catch (e) { if (!isNotFoundMessage(e)) readable = false; }
      if (readable) await withTimeout(ps.set(PROBE_KEY, JSON.stringify(bump(rec)), false), 6000);
    } catch (e) { /* 診断用なので無視 */ }
  }
}

const fmtDiagTime = (ms) => {
  try { return new Date(ms).toLocaleString("ja-JP", { hour12: false }); } catch (e) { return String(ms); }
};
function describeProbe(rec) {
  if (!rec) return "記録なし";
  const hist = (rec.history || []).map((h) =>
    `    ${fmtDiagTime(h.t)} ${h.standalone ? "ホーム画面" : "ブラウザ"} ${h.inFrame ? "iframe内" : "単独"} 馬${h.horses}頭`).join("\n");
  return `起動${rec.launches}回目 / 初回 ${fmtDiagTime(rec.firstAt)} / 最終 ${fmtDiagTime(rec.lastAt)}\n  直近の起動:\n${hist}`;
}

// 現在の保存の状態を文章にして返す。馬データなど既存のキーは読むだけ。
async function runStorageDiagnostics(season) {
  const L = [];
  const env = describeLaunchEnv();
  L.push("【実行環境】");
  L.push(`  オリジン: ${env.origin}`);
  L.push(`  パス: ${env.path}`);
  L.push(`  iframe内: ${env.inFrame ? "はい" : "いいえ"}  / 埋め込み元: ${env.ancestors || (env.refOrigin ? env.refOrigin + "(referrer)" : "不明")}`);
  L.push(`  ホーム画面アプリ(standalone): ${env.standalone ? "はい" : "いいえ"}`);
  L.push(`  UA: ${env.ua}`);

  L.push("【ブラウザの保存領域】");
  try {
    if (navigator.storage && typeof navigator.storage.persisted === "function") {
      L.push(`  永続化(persisted): ${(await navigator.storage.persisted()) ? "許可" : "未許可"}`);
    } else L.push("  永続化(persisted): 確認不可");
  } catch (e) { L.push(`  永続化(persisted): エラー ${e && e.message}`); }
  try {
    if (navigator.storage && typeof navigator.storage.estimate === "function") {
      const est = await navigator.storage.estimate();
      const mb = (n) => (typeof n === "number" ? (n / 1048576).toFixed(1) + "MB" : "不明");
      L.push(`  使用量/上限(estimate): ${mb(est.usage)} / ${mb(est.quota)}`);
    } else L.push("  使用量/上限(estimate): 確認不可");
  } catch (e) { L.push(`  使用量/上限(estimate): エラー ${e && e.message}`); }
  try {
    if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      L.push(`  IndexedDB一覧: ${dbs.map((d) => d.name).join(", ") || "なし"}`);
    } else L.push("  IndexedDB一覧: 確認不可");
  } catch (e) { L.push(`  IndexedDB一覧: エラー ${e && e.message}`); }

  L.push("【IndexedDB(このアプリの保存先)】");
  try {
    const keys = await idbTx("readonly", (store, out) => {
      const req = store.getAllKeys();
      req.onsuccess = () => out(req.result);
    });
    const names = (keys || []).map((k) => String(k).replace(/^(priv|shared):/, ""));
    const count = (pre) => names.filter((n) => n.startsWith(pre)).length;
    L.push(`  キー総数: ${names.length}`);
    L.push(`  馬データのキー: ${count("horses-v1:")} / 印: ${count("marks-v1:")} / カテゴリ: ${count("categories-v1:")} / 血統: ${names.includes(PEDIGREE_STORAGE_KEY) ? "あり" : "なし"} / 自動退避: ${count(BAK_PREFIX)}`);
    L.push(`  選択中の年度(${season})の馬データ: ${names.includes(horsesMetaKey(season)) ? "メタあり" : "メタなし"}`);
  } catch (e) { L.push(`  読み込みエラー: ${e && e.message}`); }
  try {
    const g = await idbStorageImpl.getStrict(PROBE_KEY, false);
    L.push(`  起動記録: ${g.found ? describeProbe(JSON.parse(g.value)) : "記録なし"}`);
  } catch (e) { L.push(`  起動記録: 読み込みエラー ${e && e.message}`); }

  L.push("【Claude側ストレージ(ブラウザの外)】");
  const ps = _platformStorageRef;
  if (!ps || typeof ps.get !== "function") {
    L.push("  この環境では利用できません(window.storageなし)");
  } else {
    try {
      await withTimeout(ps.set(DIAG_ROUNDTRIP_KEY, JSON.stringify({ t: Date.now() }), false), 8000);
      const back = await withTimeout(ps.get(DIAG_ROUNDTRIP_KEY, false), 8000);
      try { await withTimeout(ps.delete(DIAG_ROUNDTRIP_KEY, false), 8000); } catch (e) { /* 無視 */ }
      L.push(`  書き込み→読み戻し: ${back && back.value ? "成功" : "失敗(値が戻らない)"}`);
    } catch (e) { L.push(`  書き込み→読み戻し: 失敗 ${e && e.message}`); }
    const peek = async (label, key) => {
      try {
        const g = await withTimeout(ps.get(key, false), 8000);
        L.push(`  ${label}: あり(${g && g.value ? g.value.length : 0}文字)`);
      } catch (e) { L.push(`  ${label}: ${isNotFoundMessage(e) ? "なし" : "読み込みエラー " + (e && e.message)}`); }
    };
    await peek("選択中の年度の記録", CURRENT_SEASON_KEY);
    await peek("馬データ(メタ)", horsesMetaKey(season));
    await peek("血統データ", PEDIGREE_STORAGE_KEY);
    try {
      const g = await withTimeout(ps.get(PROBE_KEY, false), 8000);
      L.push(`  起動記録: ${describeProbe(JSON.parse(g.value))}`);
    } catch (e) { L.push(`  起動記録: ${isNotFoundMessage(e) ? "記録なし" : "読み込みエラー " + (e && e.message)}`); }
  }
  return L.join("\n");
}

// アプリ起動時に一度だけ呼ぶ。旧ストレージから読めるデータを移行したうえで、
// window.storage をIndexedDBベースの実装に差し替える。
async function ensureIDBStorage() {
  if (_idbStorageInstalled) return;
  _idbStorageInstalled = true;
  const platformStorage = (typeof window !== "undefined") ? window.storage : null;
  _platformStorageRef = platformStorage; // 診断用に、差し替える前のClaude側ストレージを控えておく(読み書きの対象は変えない)
  try {
    await migratePlatformStorageToIDBIfNeeded(platformStorage);
  } catch (e) {
    console.error("[pog-debug] platform→IndexedDB移行に失敗(IndexedDBのみで続行)", e);
  }
  window.storage = idbStorageImpl;
  console.log("[pog-debug] ストレージ層をIndexedDBに切り替えました");
}

/* ============================================================
   永続化ヘルパー
   ============================================================ */
async function loadJSON(key, fallback) {
  try {
    const res = await window.storage.get(key, false);
    return res ? JSON.parse(res.value) : fallback;
  } catch (e) {
    return fallback;
  }
}

/* ------------------------------------------------------------
   厳密な読み込み(「データがない」と「読み込みに失敗した」を区別する)
   ------------------------------------------------------------
   loadJSON は、どんな失敗でも fallback(空データ)を返すため、起動時の読み込みや
   「読んだ内容をもとに上書き保存する」処理には使わない。こちらは次の3つを区別する。
     { status: "ok", value }      … 見つかって、読めた
     { status: "missing" }        … 本当にデータが存在しない
     { status: "error", error, kind } … 読めない(kind: "read"=読み込み失敗 / "integrity"=内容が壊れている)
   ------------------------------------------------------------ */
class StorageLoadError extends Error {
  constructor(message, kind, key) {
    super(message);
    this.name = "StorageLoadError";
    this.kind = kind || "read"; // "read" | "integrity"
    this.key = key || null;
  }
}

async function loadJSONStrict(key) {
  let res;
  try {
    if (window.storage && typeof window.storage.getStrict === "function") {
      res = await window.storage.getStrict(key, false);
    } else {
      // getStrictを持たない保存層(旧window.storage)向け: 「not found」だけを「ない」として扱う
      try {
        const r = await window.storage.get(key, false);
        res = r ? { found: true, value: r.value } : { found: false };
      } catch (e) {
        if (/not found|404/i.test((e && e.message) || "")) res = { found: false };
        else throw e;
      }
    }
  } catch (e) {
    return { status: "error", kind: "read", error: `読み込みに失敗しました(${key}): ${(e && e.message) || e}` };
  }
  if (!res.found) return { status: "missing" };
  try {
    return { status: "ok", value: JSON.parse(res.value) };
  } catch (e) {
    return { status: "error", kind: "integrity", error: `保存データの形式が壊れています(${key})` };
  }
}

// 「ない」ときだけ fallback を返し、エラーのときは例外(StorageLoadError)を投げる。
async function loadJSONOrThrow(key, fallback) {
  const r = await loadJSONStrict(key);
  if (r.status === "ok") return r.value;
  if (r.status === "missing") return fallback;
  throw new StorageLoadError(r.error, r.kind, key);
}

// キーが存在するか(読めない場合は例外。「ない」と取り違えない)
async function existsStrict(key) {
  try {
    const r = await window.storage.getStrict(key, false);
    return !!r.found;
  } catch (e) {
    throw new StorageLoadError(`読み込みに失敗しました(${key}): ${(e && e.message) || e}`, "read", key);
  }
}

/* ------------------------------------------------------------
   書き込みの可否(ゲート)と保存結果の通知
   ------------------------------------------------------------
   起動時の読み込みに失敗している間は、保存層の入口(storageSet/saveJSON)で
   すべての書き込みを止める(画面側の防御に加えた二重の安全策)。
   ------------------------------------------------------------ */
let _storageWritesEnabled = true;
function setStorageWritesEnabled(v) { _storageWritesEnabled = !!v; }

const _failedSaveKeys = new Set();
let _saveResultListener = null;
function setSaveResultListener(fn) { _saveResultListener = fn; }
function reportSaveResult(key, ok) {
  if (ok) _failedSaveKeys.delete(key); else _failedSaveKeys.add(key);
  if (_saveResultListener) {
    try { _saveResultListener(Array.from(_failedSaveKeys)); } catch (e) { /* 通知側の失敗は無視 */ }
  }
}

// window.storage.set を小さなリトライ付きで呼ぶ共通ヘルパー。馬データ・血統データ
// どちらの保存経路からも使う。一時的な失敗(瞬断等)をある程度吸収するためのもので、
// ストレージ基盤そのものが機能していない場合まではカバーできない。
// リトライは「同じ値を同じキーへ書き直す」だけなので、既存データを壊さない。
async function storageSet(key, jsonString, shared, retries = 2) {
  if (!_storageWritesEnabled) {
    return { ok: false, error: "データの読み込みが完了していないため、保存を停止しています" };
  }
  let lastError = "";
  for (let i = 0; i < retries; i++) {
    try {
      await window.storage.set(key, jsonString, shared);
      return { ok: true };
    } catch (e) {
      lastError = (e && e.message) ? e.message : String(e);
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { ok: false, error: lastError };
}

/* ------------------------------------------------------------
   直前の版の自動退避(1世代)
   ------------------------------------------------------------
   印・メモ・順位(marks)、カテゴリ、血統データは、本体を上書きする直前に、
   「いま保存されている版」を別キー(bak-v1:<元のキー>)へ1世代だけ残す。
   馬データ(複数キー)は、CSVの取り込み・バックアップの復元で置き換える直前に退避する。
   - 順序: ①現在の保存内容を厳密に読む → ②正常な内容なら退避を書く → ③本体を書く。
     ③が失敗しても、本体は上書きされておらず(1キーの書き込みは原子的)、退避も残る。
   - 次の場合は退避を更新しない: 読み込めない/形式が不正/保存失敗中/空の内容で中身のある退避を置き換える場合。
   - 通常の保存では約5分に1回だけ更新する(連続操作のたびに退避が最新版に置き換わるのを避けるため)。
   - ブラウザ自体によるデータ削除(Safariの自動削除など)には備えられない(同じIndexedDB内のため)。
   ------------------------------------------------------------ */
const BAK_PREFIX = "bak-v1:";
const BAK_MIN_INTERVAL_MS = 5 * 60 * 1000;
const _bakLastAt = new Map();

function bakKeyFor(key) { return BAK_PREFIX + key; }

function autoBackupRuleFor(key) {
  if (/^marks-v1:/.test(key)) {
    return { id: "marks", label: "印・メモ・順位", validate: (v) => !!v && typeof v === "object" && !Array.isArray(v), count: (v) => Object.keys(v).length };
  }
  if (/^categories-v1:/.test(key)) {
    return { id: "categories", label: "カテゴリ", validate: (v) => Array.isArray(v), count: (v) => v.length };
  }
  if (key === PEDIGREE_STORAGE_KEY) {
    return {
      id: "pedigree", label: "血統データ",
      validate: (v) => !!v && typeof v === "object" && !!v.horses && typeof v.horses === "object" && !Array.isArray(v.horses),
      count: (v) => Object.keys(v.horses).length,
    };
  }
  return null;
}

// 戻り値: { ok, skipped? }。例外は投げない。ok=falseは「退避したかったが書けなかった/読めなかった」。
async function backupBeforeWrite(key, force) {
  const rule = autoBackupRuleFor(key);
  if (!rule) return { ok: true, skipped: true };
  if (!_storageWritesEnabled) return { ok: false, error: "locked" };
  if (!force && _failedSaveKeys.size > 0) return { ok: true, skipped: true }; // 保存失敗中は退避を更新しない
  const now = Date.now();
  if (!force && now - (_bakLastAt.get(key) || 0) < BAK_MIN_INTERVAL_MS) return { ok: true, skipped: true };
  try {
    const cur = await window.storage.getStrict(key, false);
    if (!cur.found) return { ok: true, skipped: true }; // 退避すべき前の版が無い
    let parsed;
    try { parsed = JSON.parse(cur.value); } catch (e) { return { ok: false, error: "corrupt" }; }
    if (!rule.validate(parsed)) return { ok: false, error: "invalid" };
    if (rule.count(parsed) === 0) {
      // 空の内容で、中身のある退避を置き換えない
      const ex = await window.storage.getStrict(bakKeyFor(key), false);
      if (ex.found) {
        try {
          const rec = JSON.parse(ex.value);
          if (rule.count(JSON.parse(rec.raw)) > 0) return { ok: true, skipped: true };
        } catch (e) { /* 既存の退避が読めないなら置き換えてよい */ }
      }
    }
    await window.storage.set(bakKeyFor(key), JSON.stringify({ v: 1, savedAt: now, sourceKey: key, raw: cur.value }), false);
    _bakLastAt.set(key, now);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// 馬データ(分割保存)を置き換える直前に、現在の全頭を1つのキーへ退避する(1回の書き込みで原子的)。
async function snapshotHorsesBeforeReplace(season) {
  if (!_storageWritesEnabled) return { ok: false, error: "locked" };
  try {
    const { horses } = await loadHorsesStrict(season);
    if (horses.length === 0) return { ok: true, skipped: true };
    const hk = seasonStorageKeys(season).horses;
    await window.storage.set(bakKeyFor(hk), JSON.stringify({ v: 1, savedAt: Date.now(), sourceKey: hk, horses }), false);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/* ------------------------------------------------------------
   保存(同じキーへの保存は呼び出し順に1つずつ実行する)
   ------------------------------------------------------------
   連続した操作(印を続けて付ける等)で、リトライや退避の待ち時間のせいで古い内容が
   新しい内容より後に書き込まれることがないよう、キーごとに順番待ちにする。
   ------------------------------------------------------------ */
const _saveChains = new Map();
function saveJSON(key, value, opts) {
  const prev = _saveChains.get(key) || Promise.resolve();
  const run = prev.then(() => saveJSONNow(key, value, opts || {}));
  _saveChains.set(key, run.catch(() => {}));
  return run;
}

async function saveJSONNow(key, value, opts) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    console.error("storage save failed (stringify)", key, e);
    reportSaveResult(key, false);
    return false;
  }
  // ①②: 退避(強制の場合、退避できなければ本体を置き換えない)
  const bak = await backupBeforeWrite(key, !!opts.forceBackup);
  if (opts.forceBackup && !bak.ok) {
    console.error("auto backup failed; save aborted", key, bak.error);
    reportSaveResult(key, false);
    return false;
  }
  // ③: 本体
  const result = await storageSet(key, json, false);
  if (!result.ok) console.error("storage save failed", key, result.error);
  reportSaveResult(key, result.ok);
  return result.ok; // 呼び出し側でエラーをユーザーに提示できるよう、成否を返す
}

/* ------------------------------------------------------------
   自動退避の一覧と、退避からの復元
   ------------------------------------------------------------
   復元は利用者が確認画面で明示的に実行したときだけ行う。
   1キーの本体は「退避の内容で置き換え」→成功したら「置き換え前の本体を退避へ入れ替え」の順
   (途中で失敗しても、退避と本体のどちらかは必ず元の内容が残る)。
   馬データ(複数キー)は退避の全頭を書き直す(失敗しても退避は変更しないので、やり直せる)。
   ------------------------------------------------------------ */
async function listAutoBackups(season) {
  const ks = seasonStorageKeys(season);
  const out = [];
  for (const key of [ks.marks, ks.categories, PEDIGREE_STORAGE_KEY]) {
    const rule = autoBackupRuleFor(key);
    try {
      const r = await window.storage.getStrict(bakKeyFor(key), false);
      if (!r.found) continue;
      const rec = JSON.parse(r.value);
      const data = JSON.parse(rec.raw);
      if (!rule.validate(data)) continue;
      out.push({ id: rule.id, label: rule.label, key, savedAt: rec.savedAt, count: rule.count(data), kind: "single" });
    } catch (e) { /* 読めない退避は表示しない */ }
  }
  try {
    const r = await window.storage.getStrict(bakKeyFor(ks.horses), false);
    if (r.found) {
      const rec = JSON.parse(r.value);
      if (Array.isArray(rec.horses) && rec.horses.length > 0) {
        out.push({ id: "horses", label: "馬データ", key: ks.horses, savedAt: rec.savedAt, count: rec.horses.length, kind: "horses" });
      }
    }
  } catch (e) { /* 読めない退避は表示しない */ }
  return out;
}

async function restoreAutoBackup(item, season) {
  const prevGate = _storageWritesEnabled;
  _storageWritesEnabled = true; // 利用者が確認のうえ実行する復元だけは、読み込みエラー画面からでも書き込める
  try {
    const r = await window.storage.getStrict(bakKeyFor(item.key), false);
    if (!r.found) return { ok: false, error: "退避データが見つかりません" };
    const rec = JSON.parse(r.value);
    if (item.kind === "horses") {
      if (!Array.isArray(rec.horses) || rec.horses.length === 0) return { ok: false, error: "退避データが正しくありません" };
      const res = await saveHorsesChunked(season, rec.horses, { skipOldMetaCheck: true });
      return res.ok ? { ok: true } : { ok: false, error: res.error || "保存に失敗しました" };
    }
    const rule = autoBackupRuleFor(item.key);
    const data = JSON.parse(rec.raw);
    if (!rule || !rule.validate(data)) return { ok: false, error: "退避データが正しくありません" };
    let cur = null;
    try { cur = await window.storage.getStrict(item.key, false); } catch (e) { /* 取り消し用の入れ替えを省くだけ */ }
    await window.storage.set(item.key, rec.raw, false); // 本体を退避の内容に置き換える(原子的)
    if (cur && cur.found) {
      try {
        if (rule.validate(JSON.parse(cur.value))) {
          await window.storage.set(bakKeyFor(item.key), JSON.stringify({ v: 1, savedAt: Date.now(), sourceKey: item.key, raw: cur.value }), false);
        }
      } catch (e) { /* 入れ替えに失敗しても、本体は退避の内容で復元済み */ }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    _storageWritesEnabled = prevGate;
  }
}

// ストレージ自己診断(STEP9-補修)。CSVインポートの成否に関わらず単独で実行でき、
// 「極小データの書き込み」「読み込み」「shared領域への書き込み」の3段階を確認する。
// これにより、データの中身やサイズではなく、ストレージ基盤自体の問題かどうかを
// 切り分けられる。
async function runStorageSelfTest() {
  let tier1Ok = false, tier1Error = "";
  try {
    await window.storage.set("pog-debug-tiny-test", JSON.stringify({ t: Date.now() }), false);
    tier1Ok = true;
    try { await window.storage.delete("pog-debug-tiny-test", false); } catch (e2) { /* 無視 */ }
  } catch (e) {
    tier1Error = (e && e.message) ? e.message : String(e);
  }

  let tier3GetOk = false, tier3GetError = "";
  try {
    await window.storage.get("pog-debug-nonexistent-key-xyz", false);
    tier3GetOk = true;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    tier3GetError = msg;
    tier3GetOk = /not found|404/i.test(msg); // 「無いから失敗」は正常な挙動
  }

  let tier3SharedOk = false, tier3SharedError = "";
  try {
    await window.storage.set("pog-debug-tiny-test-shared", JSON.stringify({ t: Date.now() }), true);
    tier3SharedOk = true;
    try { await window.storage.delete("pog-debug-tiny-test-shared", true); } catch (e2) { /* 無視 */ }
  } catch (e) {
    tier3SharedError = (e && e.message) ? e.message : String(e);
  }

  return { tier1Ok, tier1Error, tier3GetOk, tier3GetError, tier3SharedOk, tier3SharedError };
}

/* ------------------------------------------------------------
   馬データの分割保存(シャーディング)
   ------------------------------------------------------------
   実機検証の結果、5MB制限そのものではなく、1回の書き込みサイズが
   数MB規模になると "Unexpected response type" というエラーで保存
   そのものが不安定になることが分かった。対策として、馬データを
   1つの大きなキーにまとめて保存するのではなく、HORSES_CHUNK_SIZE
   頭ごとの小さなキーに分割して保存する。

   キー構成:
   - `horses-v1:<season>:meta`   … { count, chunkCount }
   - `horses-v1:<season>:chunk0` … 先頭からHORSES_CHUNK_SIZE頭分
   - `horses-v1:<season>:chunk1` … 続きのHORSES_CHUNK_SIZE頭分 …

   marks/categoriesはサイズが小さいため、従来通り単一キーのまま
   (loadJSON/saveJSONを直接使う)で変更していない。
   ------------------------------------------------------------ */
const HORSES_CHUNK_SIZE = 500; // 1チャンクあたりの頭数(1件あたり約400バイト×500 ≈ 200KB程度で十分小さい)

function horsesMetaKey(season) { return `${seasonStorageKeys(season).horses}:meta`; }
function horsesChunkKey(season, i) { return `${seasonStorageKeys(season).horses}:chunk${i}`; }

// 馬データを分割して保存する。以前より少ないチャンク数で上書きする場合に
// 古いチャンクが残らないよう、まず既存のメタ情報を見て余分なチャンクを
// 削除してから書き込む。戻り値: { ok, savedChunks, failedChunk, error }
async function saveHorsesChunked(season, horses, opts) {
  // 既存のメタ情報を「厳密に」読む。読めない場合は何も書かずに中止する
  // (読めないまま上書きして、古いチャンクを取り残したり壊したりしないため)。
  let oldMeta = null;
  if (!(opts && opts.skipOldMetaCheck)) {
    const r = await loadJSONStrict(horsesMetaKey(season));
    if (r.status === "error") {
      return { ok: false, savedChunks: 0, totalChunks: 0, failedChunkKey: horsesMetaKey(season), error: r.error };
    }
    oldMeta = r.status === "ok" ? r.value : null;
  }
  const chunks = [];
  for (let i = 0; i < horses.length; i += HORSES_CHUNK_SIZE) {
    chunks.push(horses.slice(i, i + HORSES_CHUNK_SIZE));
  }
  // 0頭(空配列)でもmetaだけは作る(chunkCount=0)。
  for (let i = 0; i < chunks.length; i++) {
    const key = horsesChunkKey(season, i);
    const result = await storageSet(key, JSON.stringify(chunks[i]), false);
    if (!result.ok) {
      console.error("[pog-debug] チャンク保存失敗:", key, result.error);
      return { ok: false, savedChunks: i, totalChunks: chunks.length, failedChunkKey: key, error: result.error };
    }
  }
  // 新しいチャンク数より古いチャンク数が多い場合、余分な古いチャンクを削除する
  if (oldMeta && oldMeta.chunkCount > chunks.length) {
    for (let i = chunks.length; i < oldMeta.chunkCount; i++) {
      try { await window.storage.delete(horsesChunkKey(season, i), false); } catch (e) { /* もともと無ければ無視 */ }
    }
  }
  const metaOk = await saveJSON(horsesMetaKey(season), { count: horses.length, chunkCount: chunks.length });
  return { ok: metaOk, savedChunks: chunks.length, totalChunks: chunks.length, error: metaOk ? null : "メタ情報の保存に失敗しました" };
}

// 分割保存された馬データを「厳密に」読み込む(起動・年度切替・置き換え前の退避用)。
// - metaが無い → 本当にまだ無い(空配列)
// - metaがあるのにチャンクが無い/読めない/形式が不正 → 例外(空として扱わない)
// - 頭数がmetaの値と違うだけの場合は、読めたデータをそのまま返し countMismatch を立てる
async function loadHorsesStrict(season) {
  const meta = await loadJSONOrThrow(horsesMetaKey(season), null);
  if (!meta || !meta.chunkCount) return { horses: [], countMismatch: false };
  const results = await Promise.all(
    Array.from({ length: meta.chunkCount }, (_, i) => loadJSONStrict(horsesChunkKey(season, i)))
  );
  const arrays = results.map((r, i) => {
    const key = horsesChunkKey(season, i);
    if (r.status === "error") throw new StorageLoadError(r.error, r.kind, key);
    if (r.status === "missing") throw new StorageLoadError(`馬データの一部(${i + 1}/${meta.chunkCount})が見つかりません`, "integrity", key);
    if (!Array.isArray(r.value)) throw new StorageLoadError(`馬データの形式が正しくありません(${key})`, "integrity", key);
    return r.value;
  });
  const horses = arrays.flat();
  return { horses, countMismatch: typeof meta.count === "number" && meta.count !== horses.length };
}

// 分割保存された馬データを読み込んで1つの配列に結合する。
// metaが無い場合は「その年度はまだ馬データが無い」として空配列を返す。
// (失敗も空として扱うため、起動時や上書きの判断には使わない。保存後の確認用。)
async function loadHorsesChunked(season) {
  const meta = await loadJSON(horsesMetaKey(season), null);
  if (!meta || !meta.chunkCount) return [];
  const chunkPromises = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    chunkPromises.push(loadJSON(horsesChunkKey(season, i), []));
  }
  const chunkArrays = await Promise.all(chunkPromises);
  return chunkArrays.flat();
}

// 指定した年度の馬データ(すべてのチャンク+メタ)を削除する。
async function deleteHorsesChunked(season) {
  // メタを読めないまま削除すると、チャンクだけが取り残されるため、読めなければ何も消さずに中止する
  const meta = await loadJSONOrThrow(horsesMetaKey(season), null);
  const chunkCount = meta ? meta.chunkCount : 0;
  // 先にメタを消す(消せなければ例外で中止=何も消えていない)。途中でチャンクの削除に失敗しても、
  // 「メタがあるのにチャンクが欠けている」状態ではなく「空の年度+使われないチャンク」になるため整合性が保たれる。
  if (meta) await window.storage.delete(horsesMetaKey(season), false);
  for (let i = 0; i < chunkCount; i++) {
    try { await window.storage.delete(horsesChunkKey(season, i), false); } catch (e) { /* 無ければ無視 */ }
  }
  // 旧形式(分割前)の単一キーが残っている場合も念のため削除する
  try {
    const legacyKey = seasonStorageKeys(season).horses;
    const existing = await window.storage.get(legacyKey, false);
    if (existing) await window.storage.delete(legacyKey, false);
  } catch (e) { /* 無ければ無視 */ }
}

/* ------------------------------------------------------------
   初回起動時の移行処理(年度管理が無かった頃のデータの救済)
   ------------------------------------------------------------
   `horses-v1`等のフラットな旧キーが残っている場合だけ、それを
   2026年度のデータとして新形式(`horses-v1:2026`等)に移行し、
   旧キーは削除する。新形式のキーが既に存在する場合は何もしない
   (誤って上書きしないようにするための安全確認を必ず入れる)。
   ------------------------------------------------------------ */
async function migrateLegacyDataIfNeeded() {
  const keys = seasonStorageKeys(DEFAULT_SEASON);
  // 新形式のキーが既に存在するなら、移行は不要(むしろ上書きしてはいけない)。
  const alreadyMigrated = await Promise.all([
    existsStrict(horsesMetaKey(DEFAULT_SEASON)),
    existsStrict(keys.horses), // 分割保存導入前の単一キー形式
    existsStrict(keys.marks),
    existsStrict(keys.categories),
  ]);
  if (alreadyMigrated.some(Boolean)) return;

  const legacyHorses = await loadJSONOrThrow(LEGACY_STORAGE_KEYS.horses, null);
  const legacyMarks = await loadJSONOrThrow(LEGACY_STORAGE_KEYS.marks, null);
  const legacyCategories = await loadJSONOrThrow(LEGACY_STORAGE_KEYS.categories, null);
  if (!legacyHorses && !legacyMarks && !legacyCategories) return;

  if (legacyHorses) await saveHorsesChunked(DEFAULT_SEASON, legacyHorses);
  if (legacyMarks) await saveJSON(keys.marks, legacyMarks);
  if (legacyCategories) await saveJSON(keys.categories, legacyCategories);
  try {
    const [vh, vm, vc] = await Promise.all([
      window.storage.get(LEGACY_STORAGE_KEYS.horses, false).catch(() => null),
      window.storage.get(LEGACY_STORAGE_KEYS.marks, false).catch(() => null),
      window.storage.get(LEGACY_STORAGE_KEYS.categories, false).catch(() => null),
    ]);
    if (vh) await window.storage.delete(LEGACY_STORAGE_KEYS.horses, false);
    if (vm) await window.storage.delete(LEGACY_STORAGE_KEYS.marks, false);
    if (vc) await window.storage.delete(LEGACY_STORAGE_KEYS.categories, false);
  } catch (e) {
    console.error("legacy key cleanup failed", e);
  }
}

// 指定した年度の馬データ・印・カテゴリを読み込む(無ければ空で返す)。
// 年度切り替え・年度追加どちらからも使う共通処理。馬データは分割保存
// されているため loadHorsesChunked で結合して読み込む。
// 分割保存導入前の単一キー(horses-v1:<season>)がまだ残っている場合は
// それも読み込む(過去にインポートしたデータを失わないための後方互換)。
async function loadSeasonData(season) {
  const keys = seasonStorageKeys(season);
  // 厳密な読み込み: 「ない」は空として扱うが、読めない/壊れている場合は例外(空として続行しない)。
  const [chunked, legacySingleHorses, marks, categories] = await Promise.all([
    loadHorsesStrict(season),
    loadJSONOrThrow(keys.horses, []),
    loadJSONOrThrow(keys.marks, {}),
    loadJSONOrThrow(keys.categories, DEFAULT_CATEGORIES),
  ]);
  if (!Array.isArray(legacySingleHorses)) throw new StorageLoadError(`馬データの形式が正しくありません(${keys.horses})`, "integrity", keys.horses);
  if (!marks || typeof marks !== "object" || Array.isArray(marks)) throw new StorageLoadError(`印・メモのデータの形式が正しくありません(${keys.marks})`, "integrity", keys.marks);
  if (!Array.isArray(categories)) throw new StorageLoadError(`カテゴリのデータの形式が正しくありません(${keys.categories})`, "integrity", keys.categories);
  const horses = chunked.horses.length > 0 ? chunked.horses : legacySingleHorses;
  return {
    horses, marks, categories,
    warning: chunked.countMismatch ? "馬データの頭数が保存時の記録と一致しません(読めた分だけ表示しています)" : null,
  };
}

/* ============================================================
   データのエクスポート・バックアップ — STEP7
   ------------------------------------------------------------
   window.storageの障害有無に関わらず動作するよう、すべて画面上の
   React State(引数で渡されたデータ)から直接ファイルを生成する。
   pedigree-v1 / pedigree-conflicts-v1は対象外(年度データとは別の
   共有データのため)。
   ============================================================ */

// 文字列をブラウザのダウンロード機能でファイルとして保存する。
function downloadTextFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// CSVの1セルを安全にエスケープする(カンマ・改行・ダブルクォートを含む場合は引用符で囲む)。
function csvCell(value) {
  const s = (value === null || value === undefined) ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// 候補馬(チェック済み・現在の絞り込み結果)をCSVとして書き出す。
function exportCandidatesToCsv(candidateHorses, marks, catById) {
  const header = ["馬名", "性別", "父", "母", "母父", "調教師", "所属", "生産者", "印", "メモ"];
  const rows = candidateHorses.map((h) => {
    const mark = marks[h.id];
    const category = catById(mark?.categoryId);
    const markLabel = category ? `${category.mark} ${category.label}` : "";
    return [
      h.name, h.sex, h.sire, h.dam, h.damSire,
      trainerDisplayName(h.trainer), regionLabel(h.region), h.breeder,
      markLabel, mark?.note || "",
    ];
  });
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(","));
  // ExcelでUTF-8を正しく開けるようBOMを付与する。
  const csv = "\uFEFF" + lines.join("\r\n");
  const today = new Date().toISOString().slice(0, 10);
  downloadTextFile(`候補馬_${today}.csv`, csv, "text/csv;charset=utf-8");
}

// 血統DB({version, horses:{...}})として使える内容か(1頭以上のデータがあるか)を判定する。
function hasPedigreeData(db) {
  return !!db && typeof db === "object" && !!db.horses && typeof db.horses === "object"
    && !Array.isArray(db.horses) && Object.keys(db.horses).length > 0;
}

// 現在の年度データ(馬・印・カテゴリ)と血統データをJSONバックアップとして書き出す。
// horsesはCSVインポート時点で不要列(URL・母戦績・兄弟情報など)を
// 既に含んでいないため、追加の除外処理は不要。
function exportSeasonBackup(season, horses, marks, categories, pedigree) {
  const backup = {
    formatVersion: 1,
    season,
    label: seasonLabel(season),
    exportedAt: new Date().toISOString(),
    horses,
    marks,
    categories,
  };
  // 血統データ(pedigree-v1。全年度共通)は現在の保存内容をそのまま同梱する。
  // 空(0頭)の場合は含めない(復元時に既存の血統データを空で上書きしないため)。
  if (hasPedigreeData(pedigree)) backup.pedigree = pedigree;
  const json = JSON.stringify(backup);
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const filename = `pog-backup-${ymd}.json`;
  saveBackupJsonFile(filename, json);
  // 「最後に書き出した日」の表示用(失敗しても保存失敗の警告は出さない。storageSetを直接使う)
  storageSet(LAST_BACKUP_KEY, JSON.stringify(Date.now()), false).catch(() => {});
  // 画面側の「保存できない場合」の代替手段(再保存・コピー)で使うため、生成した内容を返す
  return { filename, json };
}

// JSON文字列をクリップボードへコピーする(ファイル保存が使えない環境向けの代替手段)。
async function copyTextToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 下の方法を試す */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

// バックアップJSONを「ファイルとして」保存する(画面にテキスト表示しない)。
// iPhone/iPad: 共有シート(「"ファイル"に保存」)で保存する。使えない・失敗した場合や
// PCでは Blob + <a download> でダウンロードする。Blobの種類をoctet-streamにすることで、
// ブラウザがJSONを画面に表示してしまわず、ダウンロード扱いになりやすくする。
function saveBackupJsonFile(filename, json) {
  const anchorDownload = () => {
    const blob = new Blob([json], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  try {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isIOS && typeof File === "function" && navigator.share && navigator.canShare) {
      const file = new File([json], filename, { type: "application/json" });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: filename }).catch((e) => {
          if (e && e.name === "AbortError") return; // ユーザーが共有シートを閉じただけ
          anchorDownload();
        });
        return;
      }
    }
  } catch (e) { /* 共有が使えなければ下のダウンロードへ */ }
  anchorDownload();
}

// 血統不足チェック用のCSV(UTF-8 BOM付き・CRLF)。既存の候補馬CSVとは独立した新規出力。
function buildGapCsvText(header, rows) {
  return "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

// 不足馬CSV: 登録番号,馬名,状態,理由(一覧と同じ範囲・同じ絞り込みの行を渡す)
function buildGapHorsesCsv(rows) {
  return buildGapCsvText(
    ["登録番号", "馬名", "状態", "理由"],
    rows.map(({ horse, result }) => [horse.id, horse.name, `${result.state} ${GAP_STATE_LABEL[result.state]}`, result.reason])
  );
}

// 祖先の雛形CSV: 既存の血統CSVインポート形式(馬名,父,母)。父・母は空欄のまま。
function buildAncestorTemplateCsv(items) {
  return buildGapCsvText(["馬名", "父", "母"], items.map((it) => [it.name, "", ""]));
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// CSVファイルを保存する(新規のCSV出力専用。saveBackupJsonFileと同じ方式)。
// iPhone/iPad: 共有シート(「"ファイル"に保存」)。使えない・失敗した場合やPCは Blob + <a download>。
function saveCsvTextFile(filename, csvText) {
  const anchorDownload = () => {
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  try {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (isIOS && typeof File === "function" && navigator.share && navigator.canShare) {
      const file = new File([csvText], filename, { type: "text/csv" });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: filename }).catch((e) => {
          if (e && e.name === "AbortError") return;
          anchorDownload();
        });
        return;
      }
    }
  } catch (e) { /* 共有が使えなければ下のダウンロードへ */ }
  anchorDownload();
}

// バックアップJSONファイルを読み込み、内容を検証したうえでパースして返す。
// 実際に画面へ反映するかどうかは呼び出し側(確認モーダル)に委ねる。
async function readSeasonBackupFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("JSONとして読み取れませんでした(ファイルが壊れている可能性があります)");
  }
  if (!data || !Array.isArray(data.horses) || typeof data.marks !== "object" || !Array.isArray(data.categories)) {
    throw new Error("バックアップファイルの形式が正しくありません");
  }
  // pedigreeは新しいバックアップにだけ含まれる任意項目。無い・形式が正しくない場合は
  // 「血統データなし」として扱い、馬データ等はこれまでどおり復元できるようにする。
  if (!hasPedigreeData(data.pedigree)) data.pedigree = null;
  return data;
}

/* ============================================================
   メインアプリ
   ============================================================ */
export default function App() {
  const [horses, setHorses] = useState([]);
  const [marks, setMarks] = useState({});
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [currentSeason, setCurrentSeason] = useState(DEFAULT_SEASON);
  const [ready, setReady] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState(null);
  const [screen, setScreen] = useState("list"); // "list" | "candidates"
  const [candidateMarkFilter, setCandidateMarkFilter] = useState(""); // ""=すべて, CANDIDATE_NO_MARK=印なし, それ以外はcategory.id

  const [q, setQ] = useState({ name: "", sire: "", dam: "" });
  const [sex, setSex] = useState("");
  const [regionFilter, setRegionFilter] = useState("");
  const [selectedTrainers, setSelectedTrainers] = useState([]);
  const [trainerModalOpen, setTrainerModalOpen] = useState(false);
  const [selectedBreeders, setSelectedBreeders] = useState([]);
  const [breederModalOpen, setBreederModalOpen] = useState(false);
  const [selectedMonths, setSelectedMonths] = useState([]);
  const [selectedDamSires, setSelectedDamSires] = useState([]);
  const [damSireModalOpen, setDamSireModalOpen] = useState(false);
  const [monthModalOpen, setMonthModalOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [onlyMarked, setOnlyMarked] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [sortBy, setSortBy] = useState("name");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const fileInputRef = useRef(null);

  // 候補馬画面専用の検索条件(通常の馬一覧の条件とは完全に独立して保持する)
  const [candidateQuery, setCandidateQuery] = useState({ name: "", sire: "", dam: "" });
  const [candidateSex, setCandidateSex] = useState("");
  const [candidateRegionFilter, setCandidateRegionFilter] = useState("");
  const [candidateSelectedTrainers, setCandidateSelectedTrainers] = useState([]);
  const [candidateTrainerModalOpen, setCandidateTrainerModalOpen] = useState(false);
  const [candidateSelectedBreeders, setCandidateSelectedBreeders] = useState([]);
  const [candidateBreederModalOpen, setCandidateBreederModalOpen] = useState(false);
  const [candidateSelectedMonths, setCandidateSelectedMonths] = useState([]);
  const [candidateSelectedDamSires, setCandidateSelectedDamSires] = useState([]);
  const [candidateDamSireModalOpen, setCandidateDamSireModalOpen] = useState(false);
  const [candidateMonthModalOpen, setCandidateMonthModalOpen] = useState(false);
  const [candidateSortBy, setCandidateSortBy] = useState("name");
  const [candidateFiltersExpanded, setCandidateFiltersExpanded] = useState(false);

  // 血統データ管理(STEP4)。POG馬データとは完全に独立した状態。
  const [pedigreeImportOpen, setPedigreeImportOpen] = useState(false);
  const [pedigreeImporting, setPedigreeImporting] = useState(false);
  const [pedigreeImportResult, setPedigreeImportResult] = useState(null);
  const pedigreeFileInputRef = useRef(null);

  // 血統解析画面(STEP9)。pedigreeDBは年度非依存の共有データなので、
  // horses/marks/categoriesとは別に読み込む。どの馬の血統を見ているかは
  // pedigreeViewHorseで管理する(null=非表示)。
  const [pedigreeDB, setPedigreeDB] = useState(null);
  const [pedigreeViewHorse, setPedigreeViewHorse] = useState(null);

  // 年度管理UI(STEP5)
  const [seasonModalOpen, setSeasonModalOpen] = useState(false);
  const [seasonDeleteTarget, setSeasonDeleteTarget] = useState(null); // 削除確認対象の年度({id,label})
  const [seasonSwitching, setSeasonSwitching] = useState(false);

  // カテゴリ(印)管理UI(STEP6)
  const [categoryManageOpen, setCategoryManageOpen] = useState(false);

  // 指名順位の管理UI(STEP1)
  const [rankingModalOpen, setRankingModalOpen] = useState(false);
  const [noteListOpen, setNoteListOpen] = useState(false);
  const [pedigreeGapOpen, setPedigreeGapOpen] = useState(false); // 血統不足チェック

  // データのエクスポート・バックアップ(STEP7)
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [pendingRestore, setPendingRestore] = useState(null); // 読み込んだバックアップ(確認待ち)
  const [restoring, setRestoring] = useState(false);
  const backupFileInputRef = useRef(null);

  // 読み込みの状態。loadError があるあいだは、画面を編集できる状態にせず、保存もすべて止める。
  const [loadError, setLoadError] = useState(null); // { message, kind: "read"|"integrity", season }
  const [failedSaveKeys, setFailedSaveKeys] = useState([]); // 保存に失敗して、まだ成功していないキー
  const [dataWarning, setDataWarning] = useState(null);
  const [lastBackupAt, setLastBackupAt] = useState(null);

  // GitHub同期。エンジンは1つだけ作る。取り込み(復元)が済んだら、画面を読み込み直す。
  const loadAllRef = useRef(null);
  const syncEngine = useMemo(() => {
    const eng = createSyncEngine({
      store: syncStoreAdapter,
      onApplied: async () => { if (loadAllRef.current) await loadAllRef.current(); },
      log: (...a) => console.warn("[pog-sync]", ...a),
    });
    _syncEngine = eng;
    return eng;
  }, []);
  const [syncStatus, setSyncStatus] = useState(() => syncEngine.getStatus());
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  useEffect(() => {
    const off = syncEngine.subscribe(setSyncStatus);
    setSyncStatus(syncEngine.getStatus());
    return off;
  }, [syncEngine]);

  // すべての保存データを「厳密に」読み込む。「データがない」は空として扱うが、
  // 読めない・壊れている場合は例外にして、空データで続行しない(上書きを防ぐ)。
  const loadAll = useCallback(async () => {
    setLoadError(null);
    let season = DEFAULT_SEASON;
    try {
      // 保存層をIndexedDBに切り替える(旧ストレージに読めるデータがあれば
      // 一度だけ移行する)。これより後のすべての読み書きはIndexedDB経由になる。
      await ensureIDBStorage();
      await migrateLegacyDataIfNeeded();
      const savedSeason = await loadJSONOrThrow(CURRENT_SEASON_KEY, null);
      season = savedSeason || DEFAULT_SEASON;
      const { horses: h, marks: m, categories: c, warning } = await loadSeasonData(season);
      // 血統データ(pedigree-v1)は年度非依存の共有データなので、一度だけ読み込んでおく。
      const db = await loadPedigreeDBStrict();
      const lastBackup = await loadJSON(LAST_BACKUP_KEY, null); // 表示用のみ。読めなくても支障なし
      setCurrentSeason(season);
      setHorses(h);
      setMarks(m);
      setCategories(c);
      setPedigreeDB(db);
      setDataWarning(warning);
      setLastBackupAt(typeof lastBackup === "number" ? lastBackup : null);
      setStorageWritesEnabled(true);
      setReady(true);
      recordLaunchProbe(h.length).catch(() => {}); // 診断用の起動記録(本体のデータには触れない)
      // 読み込みが正常に終わってから、GitHub同期を開始する(読み込みに失敗している間は同期しない)
      syncEngine.start().catch(() => {});
      // ブラウザに永続化を依頼する(許可されるかは環境次第。許可されても消えないことの保証ではない)
      try { if (navigator.storage && typeof navigator.storage.persist === "function") navigator.storage.persist().catch(() => {}); } catch (e2) { /* 無視 */ }
    } catch (e) {
      console.error("[pog-debug] 起動時の読み込みに失敗", e);
      setStorageWritesEnabled(false); // 読み込みに失敗している間は、保存層の入口ですべての書き込みを止める
      syncEngine.stop(); // 同期も止める(読み込めていない状態で送受信しない)
      setReady(false);
      setLoadError({
        message: (e && e.message) ? e.message : String(e),
        kind: (e && e.kind) || "read",
        season,
      });
    }
  }, []);

  loadAllRef.current = loadAll;
  useEffect(() => { loadAll(); }, [loadAll]);

  // 画面を閉じる/隠すときに未送信の変更を送る。戻ったとき・通信が復帰したときに追いつく。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") syncEngine.flush();
      else syncEngine.kick();
    };
    const onPageHide = () => syncEngine.flush();
    const onOnline = () => syncEngine.kick();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
    };
  }, [syncEngine]);

  // 保存の失敗/成功を保存層から受け取る(印・メモ・順位・カテゴリ・年度などすべての保存が対象)
  useEffect(() => {
    setSaveResultListener((keys) => setFailedSaveKeys(keys));
    return () => setSaveResultListener(null);
  }, []);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  // 保存に失敗している印・メモ・順位・カテゴリを、画面の現在の内容でもう一度保存する
  // (画面の内容は、正常に読み込んだデータに利用者の操作を重ねたもの)
  const retryFailedSaves = async () => {
    const ks = seasonStorageKeys(currentSeason);
    const results = await Promise.all([saveJSON(ks.marks, marks), saveJSON(ks.categories, categories)]);
    showToast(results.every(Boolean) ? "保存しました" : "まだ保存できません");
  };

  // 年度を切り替える。切り替え先の年度データを読み込み直し、フィルター条件や
  // 開いている画面もリセットする(別年度の調教師選択などを引きずらないため)。
  // 「最後に選択していた年度」を1つの文字列として保存するだけなので、
  // 年度一覧(別データ)との不整合が起きようがない設計にしている。
  const switchSeason = async (season) => {
    if (season === currentSeason) { setSeasonModalOpen(false); return; }
    setSeasonSwitching(true);
    try {
      const { horses: h, marks: m, categories: c } = await loadSeasonData(season);
      setCurrentSeason(season);
      setHorses(h);
      setMarks(m);
      setCategories(c);
      await saveJSON(CURRENT_SEASON_KEY, season);
      // 検索・絞り込み条件を初期化(別年度のデータに対する条件を引き継がない)
      setQ({ name: "", sire: "", dam: "" });
      setSex("");
      setRegionFilter("");
      setSelectedTrainers([]);
      setSelectedBreeders([]);
      setSelectedMonths([]);
      setSelectedDamSires([]);
      setCategoryFilter("");
      setOnlyMarked(false);
      setPage(1);
      setCandidateQuery({ name: "", sire: "", dam: "" });
      setCandidateSex("");
      setCandidateRegionFilter("");
      setCandidateSelectedTrainers([]);
      setCandidateSelectedBreeders([]);
      setCandidateSelectedMonths([]);
      setCandidateSelectedDamSires([]);
      setCandidateMarkFilter("");
      setSelected(null);
      setScreen("list");
      setSeasonModalOpen(false);
      showToast(`${seasonLabel(season)}に切り替えました`);
    } catch (e) {
      showToast("年度の切り替えに失敗しました");
      console.error(e);
    } finally {
      setSeasonSwitching(false);
    }
  };

  // 年度データを削除(初期化)する。POG開催年度は固定の選択肢なので、
  // 削除してもその年度自体が一覧から消えるわけではなく、「空の年度」に
  // 戻るだけ。現在選択中の年度は削除できない(呼び出し元でもガードするが
  // ここでも二重に防止する)。pedigree-v1/pedigree-conflicts-v1には一切触れない。
  const deleteSeason = async (seasonId) => {
    if (seasonId === currentSeason) { showToast("選択中の年度は削除できません"); setSeasonDeleteTarget(null); return; }
    const keys = seasonStorageKeys(seasonId);
    try {
      await deleteHorsesChunked(seasonId); // 分割保存された馬データ(chunk0,1,2…+meta)をすべて削除
      await Promise.all(
        [keys.marks, keys.categories].map(async (k) => {
          try {
            const existing = await window.storage.get(k, false);
            if (existing) await window.storage.delete(k, false);
          } catch (e) { /* もともと存在しない場合は何もしない */ }
        })
      );
      showToast(`${seasonLabel(seasonId)}のデータを削除しました`);
    } catch (e) {
      showToast("年度の削除に失敗しました");
      console.error(e);
    } finally {
      setSeasonDeleteTarget(null);
    }
  };

  // 馬名(表示名)の手動変更。馬ID(id/compositeId)・marks・血統には触れず、nameだけを書き換える。
  // CSV上の元の名前は originalName として最初の1回だけ保持する。
  // 保存は、その馬を含む1チャンクだけを既存のstorageSetで書き直し、読み直して検証する。
  const renameHorse = async (horseId, rawName) => {
    const newName = (rawName || "").trim();
    const idx = horses.findIndex((h) => h.id === horseId);
    if (idx < 0 || !newName) return false;
    const old = horses[idx];
    if (old.name === newName) return true;
    const updated = { ...old, name: newName, nameIsPlaceholder: false, originalName: old.originalName || old.name };
    const nextHorses = horses.slice();
    nextHorses[idx] = updated;
    try {
      const chunkIndex = Math.floor(idx / HORSES_CHUNK_SIZE);
      const chunk = nextHorses.slice(chunkIndex * HORSES_CHUNK_SIZE, (chunkIndex + 1) * HORSES_CHUNK_SIZE);
      const key = horsesChunkKey(currentSeason, chunkIndex);
      const result = await storageSet(key, JSON.stringify(chunk), false);
      if (!result.ok) throw new Error(result.error || "save failed");
      const verify = await loadJSON(key, null);
      if (!Array.isArray(verify) || !verify.some((h) => h.id === horseId && h.name === newName)) throw new Error("verify failed");
    } catch (e) {
      console.error("[pog-debug] 馬名変更の保存に失敗", e);
      showToast("馬名の保存に失敗しました(変更は反映されていません)");
      return false;
    }
    setHorses(nextHorses);
    setSelected((cur) => (cur && cur.id === horseId ? updated : cur));
    setPedigreeViewHorse((cur) => (cur && cur.id === horseId ? updated : cur));
    showToast("馬名を変更しました");
    return true;
  };

  const handleImport = async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      const text = await decodeFile(file);
      // 不要な列(URL・母戦績・兄弟情報など)はparseHorses内で最初から
      // Horseオブジェクトに含めていないため、ここで保存前に加工する必要はない。
      const parsed = parseHorses(text, currentSeason);

      // 置き換える前に、現在の馬データを退避する。退避できなければ(=現在のデータを守れないので)中止する。
      const snap = await snapshotHorsesBeforeReplace(currentSeason);
      if (!snap.ok) {
        showToast("現在のデータを退避できなかったため、取り込みを中止しました(既存データは変更していません)");
        return;
      }
      const prevHorses = horses;
      setHorses(parsed);

      console.log("[pog-debug] CSVファイルサイズ(bytes):", file.size);
      console.log("[pog-debug] パース後の頭数:", parsed.length);

      // 馬データは1つの大きなキーではなく、複数の小さなキーに分割して保存する
      // (単一の大きな書き込みが実機で不安定になることが確認できたため)。
      const result = await saveHorsesChunked(currentSeason, parsed);
      console.log("[pog-debug] チャンク保存結果:", result);

      // 保存を試みただけで成功とはみなさない。実際に読み直して、保存した
      // つもりの頭数と一致するかを検証する。
      let verifiedOk = false;
      if (result.ok) {
        const verifyHorses = await loadHorsesChunked(currentSeason);
        verifiedOk = verifyHorses.length === parsed.length;
      }

      setPage(1);
      if (verifiedOk) {
        showToast(`${parsed.length.toLocaleString()}頭を読み込みました(${result.totalChunks}分割・保存確認済み)`);
      } else {
        // 保存失敗(または検証不一致)の場合だけ、詳しい自己診断を実行する。
        const diag = await runStorageSelfTest();
        console.error("[pog-debug] 馬データの保存に失敗しました", { result, diag });
        // 新旧のデータが混ざった状態を残さないよう、取り込み前の内容へ書き戻す(退避も残してある)
        let rolledBack = prevHorses.length === 0;
        if (prevHorses.length > 0) {
          const rb = await saveHorsesChunked(currentSeason, prevHorses, { skipOldMetaCheck: true });
          rolledBack = rb.ok;
        }
        if (rolledBack) setHorses(prevHorses); else await loadAll(); // 書き戻せない場合は、実際の保存状態を読み直す
        showToast(
          `保存失敗(${rolledBack ? "取り込み前の状態に戻しました" : "保存状態を確認してください"}) ｜ 段階1:${diag.tier1Ok ? "OK" : "NG"} 段階get:${diag.tier3GetOk ? "OK" : "NG"} 段階shared:${diag.tier3SharedOk ? "OK" : "NG"}`
        );
      }
    } catch (e) {
      showToast("CSVの読み込みに失敗しました");
      console.error(e);
    } finally {
      setImporting(false);
    }
  };

  // 血統CSV(馬名,父,母)の一括インポート。POG馬データ(horses/marks/categories)
  // には一切触れず、pedigree-v1(全年度共通)だけを更新する。
  const handlePedigreeImport = async (file) => {
    if (!file) return;
    setPedigreeImporting(true);
    try {
      const text = await decodeFile(file);
      const parsedCsv = Papa.parse(text, { header: true, skipEmptyLines: true });
      const rows = parsedCsv.data;

      // 既存の血統データ・矛盾一覧を「厳密に」読む。読めない場合は何も保存せずに中止する
      // (空のDBに取り込み分だけを足して保存し、既存データを上書きしてしまうのを防ぐ)。
      let currentDb, prevConflictsStrict;
      try {
        currentDb = await loadPedigreeDBStrict();
        prevConflictsStrict = await loadPedigreeConflictsStrict();
      } catch (e) {
        console.error("[pog-debug] 血統データの読み込みに失敗(取り込みを中止)", e);
        showToast("既存の血統データを読み込めないため、取り込みを中止しました(データは変更していません)");
        return;
      }
      const result = importPedigreeCsvRows(rows, currentDb);
      const expectedHorseCount = Object.keys(result.db.horses).length;

      // CSV全体を処理し終えてから1回だけ保存する。戻り値(成否)を必ず確認する。
      const dbSaveOk = await savePedigreeDB(result.db, { forceBackup: true }); // 取り込み前の血統データを退避してから保存

      // 矛盾は既存の未解決分とマージして保存(完全一致の重複は除く)。
      const prevConflicts = prevConflictsStrict;
      const seen = new Set(prevConflicts.map((c) => `${c.name}|${c.field}|${c.existingName}|${c.incomingName}`));
      const mergedConflicts = [...prevConflicts];
      result.conflicts.forEach((c) => {
        const sig = `${c.name}|${c.field}|${c.existingName}|${c.incomingName}`;
        if (!seen.has(sig)) { seen.add(sig); mergedConflicts.push(c); }
      });
      const conflictsSaveOk = await savePedigreeConflicts(mergedConflicts);

      // 保存を試みただけで成功とはみなさない。実際に読み直して、保存した
      // つもりのデータが本当に反映されているかを検証する。
      let verifiedOk = false;
      if (dbSaveOk && conflictsSaveOk) {
        const verifyDb = await loadPedigreeDB();
        verifiedOk = Object.keys(verifyDb.horses).length === expectedHorseCount;
      }

      let diag = null;
      if (!verifiedOk) {
        // 保存失敗時だけ、ストレージ自己診断で詳しい状況を調べる。
        diag = await runStorageSelfTest();
        console.error("[pog-debug] 血統データの保存に失敗しました", { dbSaveOk, conflictsSaveOk, diag });
      } else {
        // 保存が確認できた場合だけ、血統解析画面が使うReact Stateを更新する。
        setPedigreeDB(result.db);
      }

      setPedigreeImportResult({
        totalRows: rows.length,
        newCount: result.newCount,
        updatedCount: result.updatedCount,
        unchangedCount: result.unchangedCount,
        incompleteCount: result.incompleteCount,
        conflicts: result.conflicts, // 今回のインポートで新たに見つかった矛盾
        saved: verifiedOk,
        diag,
      });
      if (!verifiedOk) {
        showToast("血統データの保存に失敗しました(インポート結果は反映されていません)");
      }
    } catch (e) {
      showToast("血統CSVの読み込みに失敗しました");
      console.error(e);
    } finally {
      setPedigreeImporting(false);
    }
  };

  // バックアップJSONを選んだ時点ではまだ画面に反映しない。内容を検証し、
  // 現在の年度と一致するかどうかを確認モーダルで提示してから適用する。
  const handleBackupFileSelected = async (file) => {
    if (!file) return;
    try {
      const data = await readSeasonBackupFile(file);
      setPendingRestore(data);
    } catch (e) {
      showToast(e.message || "バックアップファイルの読み込みに失敗しました");
      console.error(e);
    }
  };

  // 確認モーダルで「復元する」が押されたときに、実際に画面(React State)へ
  // 反映する。あわせて永続化も試みるが、現在ストレージ障害が続いている場合は
  // 失敗する可能性があるため、その旨をトーストで明示する。
  const confirmRestore = async () => {
    if (!pendingRestore) return;
    setRestoring(true);
    try {
      // 置き換える前に、現在のデータを退避する。退避できなければ(現在のデータを守れないので)中止する。
      const ks = seasonStorageKeys(currentSeason);
      const snaps = await Promise.all([
        snapshotHorsesBeforeReplace(currentSeason),
        backupBeforeWrite(ks.marks, true),
        backupBeforeWrite(ks.categories, true),
        hasPedigreeData(pendingRestore.pedigree) ? backupBeforeWrite(PEDIGREE_STORAGE_KEY, true) : Promise.resolve({ ok: true }),
      ]);
      if (snaps.some((x) => !x.ok)) {
        showToast("現在のデータを退避できなかったため、復元を中止しました(データは変更していません)");
        return;
      }
      setHorses(pendingRestore.horses);
      setMarks(pendingRestore.marks);
      setCategories(pendingRestore.categories);
      setPendingRestore(null);
      setBackupModalOpen(false);
      setScreen("list");

      const [savedHorses, savedMarks, savedCategories] = await Promise.all([
        saveHorsesChunked(currentSeason, pendingRestore.horses),
        saveJSON(seasonStorageKeys(currentSeason).marks, pendingRestore.marks),
        saveJSON(seasonStorageKeys(currentSeason).categories, pendingRestore.categories),
      ]);
      // 血統データ(pedigree-v1。全年度共通)は、バックアップに含まれている場合だけ復元する。
      // 古いバックアップ(pedigreeなし)では現在の血統データには触れない。
      // 保存→読み直しで確認できた場合だけ、画面用のStateを更新する。
      const backupPedigree = pendingRestore.pedigree;
      let pedigreeRestored = false, pedigreeFailed = false;
      if (hasPedigreeData(backupPedigree)) {
        const pOk = await savePedigreeDB(backupPedigree);
        const verify = pOk ? await loadPedigreeDB() : null;
        if (verify && Object.keys(verify.horses).length === Object.keys(backupPedigree.horses).length) {
          setPedigreeDB(backupPedigree);
          pedigreeRestored = true;
        } else {
          pedigreeFailed = true;
        }
      }
      if (savedHorses.ok && savedMarks && savedCategories && pedigreeFailed) {
        showToast("馬データ等は復元しましたが、血統データの保存に失敗しました");
      } else if (savedHorses.ok && savedMarks && savedCategories) {
        showToast(`${pendingRestore.horses.length.toLocaleString()}頭${pedigreeRestored ? "と血統データ" : ""}のバックアップを復元しました`);
      } else {
        showToast("画面には復元しましたが、保存には失敗しました(ストレージ障害の可能性)");
      }
      // 一部だけ保存できた状態を画面に残さないよう、保存に失敗した場合は実際の保存内容を読み直す
      if (!(savedHorses.ok && savedMarks && savedCategories) || pedigreeFailed) await loadAll();
    } catch (e) {
      showToast("復元中にエラーが発生しました");
      console.error(e);
    } finally {
      setRestoring(false);
    }
  };

  // marks[horseId] のレコードは { categoryId, note, checked, rank, updatedAt } の形で
  // 印(categoryId)・メモ(note)・候補馬チェック(checked)・指名順位(rank) を同じ
  // レコード内に持つが、それぞれ独立した値として扱う(印が無くてもchecked=true
  // になり得るし、rankが付いていても印・チェック・メモとは無関係)。
  // すべて「無い」状態になったときだけレコード自体を削除する。
  const isEmptyMarkRecord = (m) => !m || (!m.categoryId && !m.checked && !m.note && !m.rank);

  const setMark = useCallback((horseId, categoryId) => {
    setMarks((prev) => {
      const merged = { ...(prev[horseId] || {}), categoryId: categoryId || null, updatedAt: Date.now() };
      const next = { ...prev };
      if (isEmptyMarkRecord(merged)) delete next[horseId];
      else next[horseId] = merged;
      saveJSON(seasonStorageKeys(currentSeason).marks, next);
      return next;
    });
  }, [currentSeason]);

  const setNote = useCallback((horseId, note) => {
    setMarks((prev) => {
      const cur = prev[horseId];
      if (!cur && !note) return prev;
      const merged = { ...(cur || {}), note, updatedAt: Date.now() };
      const next = { ...prev };
      if (isEmptyMarkRecord(merged)) delete next[horseId];
      else next[horseId] = merged;
      saveJSON(seasonStorageKeys(currentSeason).marks, next);
      return next;
    });
  }, [currentSeason]);

  /* ------------------------------------------------------------
     指名順位(STEP1)。印(categoryId)・候補馬チェック(checked)・
     メモ(note)とは完全に独立したmarksのフィールドとして管理する。
     1位〜N位が歯抜けにならないよう、複数頭のrankを同時に書き換える
     必要がある操作(入れ替え・解除)は、1回のsetMarksでまとめて
     保存する(呼び出しごとに保存が走って順位が一時的に矛盾した
     状態になるのを避けるため)。
     ------------------------------------------------------------ */
  const applyRankChanges = useCallback((changes) => {
    // changes: [{ horseId, rank: number|null }, ...]
    setMarks((prev) => {
      const next = { ...prev };
      changes.forEach(({ horseId, rank }) => {
        const base = next[horseId] || prev[horseId] || {};
        const merged = { ...base, rank: rank || null, updatedAt: Date.now() };
        if (isEmptyMarkRecord(merged)) delete next[horseId];
        else next[horseId] = merged;
      });
      saveJSON(seasonStorageKeys(currentSeason).marks, next);
      return next;
    });
  }, [currentSeason]);

  // 指名順位の最下位に追加する(既にある順位の最大値+1。無ければ1位)。
  const assignNextRank = useCallback((horseId) => {
    const ranked = Object.values(marks).map((m) => m.rank).filter(Boolean);
    const nextRank = ranked.length ? Math.max(...ranked) + 1 : 1;
    applyRankChanges([{ horseId, rank: nextRank }]);
  }, [marks, applyRankChanges]);

  // 指定した馬の順位を外す場合に必要な変更一覧(本人の順位解除＋下位の繰り上げ)を
  // 計算するだけの純粋な関数。実際の適用はしない。removeRankと、候補馬チェックを
  // OFFにしたときの自動解除処理の両方から共通で使い、繰り上げロジックを重複させない。
  const computeRankRemovalChanges = useCallback((horseId) => {
    const currentRank = marks[horseId]?.rank;
    if (!currentRank) return [];
    const changes = [{ horseId, rank: null }];
    Object.entries(marks).forEach(([hid, m]) => {
      if (hid !== horseId && m.rank && m.rank > currentRank) {
        changes.push({ horseId: hid, rank: m.rank - 1 });
      }
    });
    return changes;
  }, [marks]);

  // 指名順位を解除する(「順位なし」に戻す)。それより下位だった馬は
  // 繰り上げて、1位からの連番が崩れないようにする。
  const removeRank = useCallback((horseId) => {
    applyRankChanges(computeRankRemovalChanges(horseId));
  }, [computeRankRemovalChanges, applyRankChanges]);

  // 候補馬チェック(気になる馬・候補として残しておきたい馬)。印(categoryId)とは
  // 完全に独立したデータとして保存する。「印が付いている＝チェック済み」にはしない。
  // チェックをOFFにする場合は、その馬の指名順位も同時に解除し、下位を繰り上げる
  // (POGでは候補から外した馬の指名順位は不要になるため)。チェックをONに戻した
  // 場合は、以前の順位を復元せず「順位なし」のまま扱う(rankには一切触れない)。
  // チェックの更新と順位の解除・繰り上げは、矛盾した中間状態ができないよう
  // 1回のsetMarksでまとめて適用する。
  const setChecked = useCallback((horseId, checked) => {
    const rankChanges = !checked ? computeRankRemovalChanges(horseId) : [];
    const rankChangeMap = new Map(rankChanges.map((c) => [c.horseId, c.rank]));

    setMarks((prev) => {
      const next = { ...prev };
      const touchedIds = new Set([horseId, ...rankChangeMap.keys()]);
      touchedIds.forEach((hid) => {
        const base = prev[hid] || {};
        const patch = { ...base, updatedAt: Date.now() };
        if (hid === horseId) patch.checked = !!checked;
        if (rankChangeMap.has(hid)) patch.rank = rankChangeMap.get(hid) || null;
        if (isEmptyMarkRecord(patch)) delete next[hid];
        else next[hid] = patch;
      });
      saveJSON(seasonStorageKeys(currentSeason).marks, next);
      return next;
    });
  }, [currentSeason, computeRankRemovalChanges]);

  const toggleChecked = useCallback((horseId) => {
    setChecked(horseId, !marks[horseId]?.checked);
  }, [marks, setChecked]);

  // ひとつ上/下の順位の馬と入れ替える(direction: -1で上位へ、+1で下位へ)。
  // 既に最上位/最下位の場合は何もしない。
  const moveRank = useCallback((horseId, direction) => {
    const currentRank = marks[horseId]?.rank;
    if (!currentRank) return;
    const targetRank = currentRank + direction;
    if (targetRank < 1) return;
    const swapEntry = Object.entries(marks).find(([hid, m]) => hid !== horseId && m.rank === targetRank);
    if (!swapEntry) return; // 入れ替え相手がいない(すでに端)
    applyRankChanges([
      { horseId, rank: targetRank },
      { horseId: swapEntry[0], rank: currentRank },
    ]);
  }, [marks, applyRankChanges]);

  const cycleMark = (horseId) => {
    const cur = marks[horseId]?.categoryId || null;
    const ids = categories.map((c) => c.id);
    const idx = cur ? ids.indexOf(cur) : -1;
    const nextId = idx + 1 < ids.length ? ids[idx + 1] : null;
    setMark(horseId, nextId);
  };

  const trainers = useMemo(() => computeTrainerOptions(horses, regionFilter), [horses, regionFilter]);

  // 所属を変更して調教師の候補が絞り込まれた際、選択中の調教師の中に
  // 新しい候補一覧に存在しないものがあれば自動的に選択解除する
  // (例: 「所属:美浦」で選んだ調教師を残したまま「所属:栗東」に切り替えても、
  //  存在しない「栗東＋美浦の調教師」という組み合わせが内部に残らないようにする)。
  useEffect(() => {
    setSelectedTrainers((prev) => {
      const next = prev.filter((t) => trainers.includes(t));
      return next.length === prev.length ? prev : next;
    });
  }, [trainers]);

  const breeders = useMemo(() => computeBreederOptions(horses), [horses]);
  const damSireOptions = useMemo(() => computeDamSireOptions(horses), [horses]);

  const filtered = useMemo(() => {
    let list = horses;
    if (q.name) list = list.filter((h) => h.name.includes(q.name));
    if (q.sire) list = list.filter((h) => h.sire.includes(q.sire));
    if (q.dam) list = list.filter((h) => h.dam.includes(q.dam));
    if (sex) list = list.filter((h) => h.sex === sex);
    // 所属は単一選択。「未定」が選ばれていれば所属欄が空の馬だけを対象にする。
    if (regionFilter) {
      list = list.filter((h) => (h.region ? h.region === regionFilter : regionFilter === UNASSIGNED_REGION));
    }
    // 調教師は複数選択されたうちのいずれかに一致すればOK(OR検索)。
    // 「未定」が選ばれていれば、調教師欄が空の馬も対象に含める。
    if (selectedTrainers.length > 0) {
      const set = new Set(selectedTrainers);
      list = list.filter((h) => (h.trainer ? set.has(h.trainer) : set.has(UNASSIGNED_TRAINER)));
    }
    // 生産者も同様に複数選択のいずれかに一致すればOK(OR検索)
    if (selectedBreeders.length > 0) {
      const set = new Set(selectedBreeders);
      list = list.filter((h) => set.has(h.breeder));
    }
    // 母父は複数選択のいずれかに完全一致すればOK(OR)。既存の母父テキスト検索とは別に、両方AND
    if (selectedDamSires.length > 0) {
      const set = new Set(selectedDamSires);
      list = list.filter((h) => set.has(h.damSire));
    }
    // 生年月日(月)は複数選択のいずれかの月に一致すればOK(OR)。他の条件とはAND
    if (selectedMonths.length > 0) {
      const set = new Set(selectedMonths);
      list = list.filter((h) => set.has(birthMonthOf(h.birthDate)));
    }
    // 「印ありのみ」は"印(categoryId)が付いている馬"を指す。チェック(checked)の有無とは無関係。
    if (onlyMarked) list = list.filter((h) => !!marks[h.id]?.categoryId);
    if (categoryFilter) list = list.filter((h) => marks[h.id]?.categoryId === categoryFilter);

    const arr = [...list];
    if (sortBy === "name") arr.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    if (sortBy === "birth") arr.sort((a, b) => (a.birthDate || "").localeCompare(b.birthDate || ""));
    if (sortBy === "marked") arr.sort((a, b) => (marks[b.id]?.updatedAt || 0) - (marks[a.id]?.updatedAt || 0));
    return arr;
  }, [horses, q, sex, regionFilter, selectedTrainers, selectedBreeders, selectedMonths, selectedDamSires, onlyMarked, categoryFilter, marks, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [q, sex, regionFilter, selectedTrainers, selectedBreeders, selectedMonths, selectedDamSires, onlyMarked, categoryFilter, sortBy]);

  // markedCount = 印(categoryId)が付いている頭数。checkedCount = 候補馬チェックが付いている頭数。
  // 完全に別カウントとして扱う。
  const markedCount = useMemo(() => Object.values(marks).filter((m) => m.categoryId).length, [marks]);
  const checkedCount = useMemo(() => Object.values(marks).filter((m) => m.checked).length, [marks]);
  const catById = (id) => categories.find((c) => c.id === id);

  /* ------------------------------------------------------------
     候補馬画面の検索
     ------------------------------------------------------------
     「チェック済みの馬」を固定の母集団とし、そこから通常の馬一覧と
     全く同じ処理方法(同じ関数・同じ比較ロジック)で絞り込む。
     印フィルター(すべて/◎/○/…/印なし)はこの母集団に対して
     AND条件でさらに重ねてかける。
     ------------------------------------------------------------ */
  const candidateBaseHorses = useMemo(() => horses.filter((h) => marks[h.id]?.checked), [horses, marks]);

  // 候補馬画面のサマリー(候補馬のみ対象。表示用の算出のみで保存はしない)
  const candidateSummary = useMemo(() => {
    const rankedCount = candidateBaseHorses.filter((h) => !!marks[h.id]?.rank).length;
    const noMarkCount = candidateBaseHorses.filter((h) => !marks[h.id]?.categoryId).length;
    const noteCount = candidateBaseHorses.filter((h) => hasNote(marks[h.id])).length;
    const perCategory = categories.map((c) => ({
      id: c.id, mark: c.mark, color: c.color,
      count: candidateBaseHorses.filter((h) => marks[h.id]?.categoryId === c.id).length,
    }));
    return { total: candidateBaseHorses.length, rankedCount, noMarkCount, noteCount, perCategory };
  }, [candidateBaseHorses, marks, categories]);

  const candidateTrainers = useMemo(
    () => computeTrainerOptions(candidateBaseHorses, candidateRegionFilter),
    [candidateBaseHorses, candidateRegionFilter]
  );
  useEffect(() => {
    setCandidateSelectedTrainers((prev) => {
      const next = prev.filter((t) => candidateTrainers.includes(t));
      return next.length === prev.length ? prev : next;
    });
  }, [candidateTrainers]);

  const candidateBreeders = useMemo(() => computeBreederOptions(candidateBaseHorses), [candidateBaseHorses]);
  const candidateDamSireOptions = useMemo(() => computeDamSireOptions(candidateBaseHorses), [candidateBaseHorses]);

  const candidateHorses = useMemo(() => {
    let list = candidateBaseHorses;
    // 印フィルター(チェック済みという条件に対してAND)
    if (candidateMarkFilter === CANDIDATE_NO_MARK) {
      list = list.filter((h) => !marks[h.id]?.categoryId);
    } else if (candidateMarkFilter === CANDIDATE_HAS_NOTE) {
      list = list.filter((h) => hasNote(marks[h.id]));
    } else if (candidateMarkFilter) {
      list = list.filter((h) => marks[h.id]?.categoryId === candidateMarkFilter);
    }
    // ここから先は通常の馬一覧の`filtered`と全く同じ絞り込みロジック
    if (candidateQuery.name) list = list.filter((h) => h.name.includes(candidateQuery.name));
    if (candidateQuery.sire) list = list.filter((h) => h.sire.includes(candidateQuery.sire));
    if (candidateQuery.dam) list = list.filter((h) => h.dam.includes(candidateQuery.dam));
    if (candidateSex) list = list.filter((h) => h.sex === candidateSex);
    if (candidateRegionFilter) {
      list = list.filter((h) => (h.region ? h.region === candidateRegionFilter : candidateRegionFilter === UNASSIGNED_REGION));
    }
    if (candidateSelectedTrainers.length > 0) {
      const set = new Set(candidateSelectedTrainers);
      list = list.filter((h) => (h.trainer ? set.has(h.trainer) : set.has(UNASSIGNED_TRAINER)));
    }
    if (candidateSelectedBreeders.length > 0) {
      const set = new Set(candidateSelectedBreeders);
      list = list.filter((h) => set.has(h.breeder));
    }
    if (candidateSelectedDamSires.length > 0) {
      const set = new Set(candidateSelectedDamSires);
      list = list.filter((h) => set.has(h.damSire));
    }
    if (candidateSelectedMonths.length > 0) {
      const set = new Set(candidateSelectedMonths);
      list = list.filter((h) => set.has(birthMonthOf(h.birthDate)));
    }

    const arr = [...list];
    if (candidateSortBy === "name") arr.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    if (candidateSortBy === "birth") arr.sort((a, b) => (a.birthDate || "").localeCompare(b.birthDate || ""));
    if (candidateSortBy === "marked") arr.sort((a, b) => (marks[b.id]?.updatedAt || 0) - (marks[a.id]?.updatedAt || 0));
    if (candidateSortBy === "rank") {
      // 指名順位が付いている馬を順位昇順で先頭に、順位なしの馬はその後に名前順で続ける。
      arr.sort((a, b) => {
        const ra = marks[a.id]?.rank || Infinity;
        const rb = marks[b.id]?.rank || Infinity;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name, "ja");
      });
    }
    if (candidateSortBy === "markOrder") {
      // 印順: categories配列の並び(◎→○→▲→△→☆→×)、印なし(または未知の印)は最後。
      // 同じ印の中は 指名順位あり(昇順) → 順位なし(馬名順)。
      const markIndex = new Map(categories.map((c, i) => [c.id, i]));
      const idx = (h) => {
        const cid = marks[h.id]?.categoryId;
        return cid && markIndex.has(cid) ? markIndex.get(cid) : Infinity;
      };
      arr.sort((a, b) => {
        const ia = idx(a), ib = idx(b);
        if (ia !== ib) return ia === Infinity ? 1 : ib === Infinity ? -1 : ia - ib;
        const ra = marks[a.id]?.rank || Infinity;
        const rb = marks[b.id]?.rank || Infinity;
        if (ra !== rb) return ra === Infinity ? 1 : rb === Infinity ? -1 : ra - rb;
        return a.name.localeCompare(b.name, "ja");
      });
    }
    return arr;
  }, [
    candidateBaseHorses, marks, categories, candidateMarkFilter, candidateQuery, candidateSex, candidateRegionFilter,
    candidateSelectedTrainers, candidateSelectedBreeders, candidateSelectedMonths, candidateSelectedDamSires, candidateSortBy,
  ]);

  // 折りたたみ時に表示する、候補馬画面の検索条件の要約
  const candidateFilterSummaryParts = useMemo(() => {
    const parts = [];
    if (candidateQuery.name) parts.push(`馬名:${candidateQuery.name}`);
    if (candidateQuery.sire) parts.push(`父:${candidateQuery.sire}`);
    if (candidateQuery.dam) parts.push(`母:${candidateQuery.dam}`);
    if (candidateSex) parts.push(candidateSex);
    if (candidateRegionFilter) parts.push(candidateRegionFilter === UNASSIGNED_REGION ? UNASSIGNED_REGION_LABEL : regionLabel(candidateRegionFilter));
    if (candidateSelectedTrainers.length) parts.push(`調教師${candidateSelectedTrainers.length}名`);
    if (candidateSelectedBreeders.length) parts.push(`生産者${candidateSelectedBreeders.length}件`);
    if (candidateSelectedDamSires.length) parts.push(`母父${candidateSelectedDamSires.length}件`);
    if (candidateSelectedMonths.length) parts.push(`生まれ月${candidateSelectedMonths.length}件`);
    return parts;
  }, [candidateQuery, candidateSex, candidateRegionFilter, candidateSelectedTrainers, candidateSelectedBreeders, candidateSelectedMonths, candidateSelectedDamSires]);

  // 折りたたみ時に表示する、現在の絞り込み条件の要約(例: 「牡　調教師2名　生産者2件　◎」)
  const filterSummaryParts = useMemo(() => {
    const parts = [];
    if (q.sire) parts.push(`父:${q.sire}`);
    if (q.dam) parts.push(`母:${q.dam}`);
    if (sex) parts.push(sex);
    if (regionFilter) parts.push(regionFilter === UNASSIGNED_REGION ? UNASSIGNED_REGION_LABEL : regionLabel(regionFilter));
    if (selectedTrainers.length) parts.push(`調教師${selectedTrainers.length}名`);
    if (selectedBreeders.length) parts.push(`生産者${selectedBreeders.length}件`);
    if (selectedDamSires.length) parts.push(`母父${selectedDamSires.length}件`);
    if (selectedMonths.length) parts.push(`生まれ月${selectedMonths.length}件`);
    if (onlyMarked) parts.push("印あり");
    if (categoryFilter) {
      const c = catById(categoryFilter);
      if (c) parts.push(c.mark);
    }
    return parts;
  }, [q.sire, q.dam, sex, regionFilter, selectedTrainers, selectedBreeders, selectedMonths, selectedDamSires, onlyMarked, categoryFilter, categories]);

  // カテゴリ(印)の追加・編集・削除。すべて現在の年度の categories-v1:<年度> に
  // 保存する(marks/horsesなど他のデータには触れない)。
  const addCategory = ({ label, mark, color }) => {
    const id = `custom_${Date.now()}`;
    const next = [...categories, { id, label: label || "新しい印", mark: mark || "★", color: color || CATEGORY_COLOR_PALETTE[categories.length % CATEGORY_COLOR_PALETTE.length] }];
    setCategories(next);
    saveJSON(seasonStorageKeys(currentSeason).categories, next);
  };

  const editCategory = (categoryId, patch) => {
    const next = categories.map((c) => (c.id === categoryId ? { ...c, ...patch } : c));
    setCategories(next);
    saveJSON(seasonStorageKeys(currentSeason).categories, next);
  };

  // カテゴリを削除する。そのカテゴリが付いていた馬の印(categoryId)だけを
  // 解除する(チェック・メモは保持する)。検索・候補馬の絞り込みで削除した
  // カテゴリを選択中だった場合は「すべて」に戻す。
  const deleteCategory = (categoryId) => {
    const next = categories.filter((c) => c.id !== categoryId);
    setCategories(next);
    saveJSON(seasonStorageKeys(currentSeason).categories, next);

    setMarks((prev) => {
      let changed = false;
      const nextMarks = { ...prev };
      Object.keys(nextMarks).forEach((hid) => {
        if (nextMarks[hid].categoryId === categoryId) {
          changed = true;
          const merged = { ...nextMarks[hid], categoryId: null };
          if (isEmptyMarkRecord(merged)) delete nextMarks[hid];
          else nextMarks[hid] = merged;
        }
      });
      if (changed) saveJSON(seasonStorageKeys(currentSeason).marks, nextMarks);
      return changed ? nextMarks : prev;
    });

    if (categoryFilter === categoryId) setCategoryFilter("");
    if (candidateMarkFilter === categoryId) setCandidateMarkFilter("");
  };

  if (loadError) {
    return <StorageErrorScreen error={loadError} onRetry={loadAll} />;
  }

  if (!ready) {
    return (
      <div className="w-full h-screen flex items-center justify-center" style={{ background: C.bg, color: C.textDim }}>
        読み込み中…
      </div>
    );
  }

  return (
    <div
      className="w-full flex flex-col"
      style={{
        background: C.bg,
        color: C.text,
        fontFamily: "'Hiragino Sans', 'Noto Sans JP', sans-serif",
        position: "relative",           // モーダルのabsolute配置の基準点をこの要素に固定する
        height: "100dvh",               // 中身の量に関わらずルートの高さを常にビューポート丈で固定する
        overflow: "hidden",             // ルート自体はスクロールさせない(スクロールは内部の一覧だけ)
        isolation: "isolate",           // 祖先のスタッキングコンテキストの影響を受けないようにする
      }}
    >
      {/* iOS Safariは16px未満のinput/select/textareaにフォーカスすると自動ズームする仕様があり、
          このアプリのように text-xs/text-sm を多用する密なUIでは、入力するたびに画面が
          拡大されてしまう。見た目のサイズ(padding等)は変えず、フォーカス時も含めて
          実際のフォントサイズだけ16px以上に統一してズームそのものを起きなくする。
          ただし性別/所属セレクトは「性別すべて」「所属すべて」という長めの文字列を
          表示する必要があり、16pxだと現在のボックス幅からはみ出すため、
          この2つだけは.compact-selectで明示的にフォントサイズを下げる
          (ボックスの横幅・高さ・余白は変更していない)。 */}
      <style>{`
        input, select, textarea { font-size: 16px !important; }
        select.compact-select { font-size: 12px !important; }
      `}</style>
      {/* 保存に失敗しているとき/データ警告(消えない帯。保存できていない状態を見逃さないため) */}
      {failedSaveKeys.length > 0 && (
        <div className="shrink-0 px-4 py-2 text-xs flex items-center gap-2" style={{ background: "#3A1F1C", color: "#F0C9C4", borderBottom: `1px solid ${C.danger}`, paddingTop: "max(8px, env(safe-area-inset-top))" }}>
          <AlertTriangle size={14} color={C.danger} className="shrink-0" />
          <span className="flex-1 leading-snug">保存できていない変更があります。このまま閉じると失われる可能性があります。JSONバックアップの書き出しをおすすめします。</span>
          {failedSaveKeys.some((k) => /^(marks|categories)-v1:/.test(k)) && (
            <button onClick={retryFailedSaves} className="shrink-0 px-2.5 py-1.5 rounded-lg font-semibold" style={{ border: `1px solid ${C.danger}`, color: "#F0C9C4" }}>再試行</button>
          )}
        </div>
      )}
      {dataWarning && (
        <div className="shrink-0 px-4 py-1.5 text-[11px] leading-snug" style={{ background: C.surfaceRaised, color: C.textDim, borderBottom: `1px solid ${C.border}` }}>
          {dataWarning}
        </div>
      )}
      {/* GitHub同期が止まっているとき(要対応のときだけ表示。通信待ちは自動で再試行するので控えめに) */}
      {["error", "auth", "conflict", "offline", "halted"].includes(syncStatus.phase) && (
        <button
          onClick={() => setSyncModalOpen(true)}
          className="shrink-0 w-full px-4 py-1.5 text-[11px] leading-snug text-left flex items-center gap-2"
          style={syncStatus.phase === "offline"
            ? { background: C.surfaceRaised, color: C.textDim, borderBottom: `1px solid ${C.border}` }
            : { background: "#3A1F1C", color: "#F0C9C4", borderBottom: `1px solid ${C.danger}` }}
        >
          <Cloud size={12} className="shrink-0" />
          <span className="flex-1">
            {syncStatus.phase === "offline"
              ? "GitHub同期: 通信待ちです(この端末のデータは保存されています。自動で再試行します)"
              : syncStatus.phase === "halted"
                ? "GitHub同期を停止しました。取り込みの失敗を元に戻せませんでした。タップして、データを確認してください"
                : "GitHub同期が止まっています。タップして確認してください(この端末のデータは変更されていません)"}
          </span>
        </button>
      )}
      {/* ヘッダー(スクロールしない固定領域) */}
      <header className="shrink-0 px-4 pt-4 pb-3" style={{ background: C.bg, borderBottom: `1px solid ${C.border}`, paddingTop: "max(16px, env(safe-area-inset-top))" }}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span style={{ color: C.gold, fontSize: 11, letterSpacing: 2 }}>POG</span>
              <h1 className="text-lg font-bold" style={{ letterSpacing: 1 }}>候補馬管理</h1>
            </div>
            <button
              onClick={() => setSeasonModalOpen(true)}
              className="flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full"
              style={{ background: C.surfaceRaised, border: `1px solid ${C.goldSoft}` }}
            >
              <span className="text-xs font-semibold" style={{ color: C.gold }}>{seasonLabel(currentSeason)}</span>
              <ChevronDown size={11} color={C.gold} />
            </button>
            <div className="text-xs mt-1 truncate" style={{ color: C.textDim }}>
              全{horses.length.toLocaleString()}頭 ・ 印あり{markedCount}頭
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => { setPedigreeImportResult(null); setPedigreeImportOpen(true); }}
              className="flex items-center justify-center px-2.5 py-2 rounded-lg shrink-0"
              style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.textDim }}
              aria-label="血統データ管理"
            >
              <Dna size={14} />
            </button>
            <button
              onClick={() => setSyncModalOpen(true)}
              className="flex items-center justify-center px-2.5 py-2 rounded-lg shrink-0"
              style={{ background: C.surfaceRaised, border: `1px solid ${["error", "auth", "conflict", "halted"].includes(syncStatus.phase) ? C.danger : C.border}`, color: syncStatus.repo ? C.gold : C.textDim }}
              aria-label="GitHub同期"
            >
              <Cloud size={14} />
            </button>
            <button
              onClick={() => setBackupModalOpen(true)}
              className="flex items-center justify-center px-2.5 py-2 rounded-lg shrink-0"
              style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.textDim }}
              aria-label="データのエクスポート・バックアップ"
            >
              <Download size={14} />
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold shrink-0"
              style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.gold }}
            >
              {importing ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
              {horses.length ? "更新" : "CSV読込"}
            </button>
          </div>
          <input
            ref={fileInputRef} type="file" accept=".csv" className="hidden"
            onChange={(e) => handleImport(e.target.files?.[0])}
          />
        </div>

        {horses.length > 0 && (
          <div className="flex gap-2 mt-3">
            <button
              onClick={() => setScreen("list")}
              className="flex-1 py-2 rounded-lg text-xs font-semibold"
              style={{
                background: screen === "list" ? C.gold : C.surfaceRaised,
                color: screen === "list" ? C.bg : C.textDim,
                border: `1px solid ${screen === "list" ? C.gold : C.border}`,
              }}
            >馬一覧</button>
            <button
              onClick={() => setScreen("candidates")}
              className="flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
              style={{
                background: screen === "candidates" ? C.gold : C.surfaceRaised,
                color: screen === "candidates" ? C.bg : C.textDim,
                border: `1px solid ${screen === "candidates" ? C.gold : C.border}`,
              }}
            ><Bookmark size={12} />候補馬 {checkedCount}</button>
          </div>
        )}

        {horses.length > 0 && screen === "list" && (
          <>
            {/* 検索バー */}
            <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
              <Search size={15} color={C.textDim} />
              <input
                value={q.name}
                onChange={(e) => setQ((p) => ({ ...p, name: e.target.value }))}
                placeholder="馬名で検索"
                className="flex-1 bg-transparent outline-none text-sm"
                style={{ color: C.text }}
              />
              {q.name && <X size={14} color={C.textDim} onClick={() => setQ((p) => ({ ...p, name: "" }))} />}
              <button onClick={() => setShowFilters((v) => !v)} className="flex items-center gap-1">
                <Filter size={15} color={showFilters ? C.gold : C.textDim} />
              </button>
            </div>

            {showFilters ? (
              <div className="mt-2 p-3 rounded-lg space-y-2" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                <div className="grid grid-cols-3 gap-2">
                  <input placeholder="父" value={q.sire} onChange={(e) => setQ((p) => ({ ...p, sire: e.target.value }))}
                    className="px-2 py-1.5 rounded text-xs bg-transparent outline-none" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }} />
                  <input placeholder="母" value={q.dam} onChange={(e) => setQ((p) => ({ ...p, dam: e.target.value }))}
                    className="px-2 py-1.5 rounded text-xs bg-transparent outline-none" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }} />
                  <button
                    onClick={() => setDamSireModalOpen(true)}
                    className="px-2 py-1.5 rounded text-xs text-left truncate"
                    style={{
                      background: C.surfaceRaised,
                      border: `1px solid ${selectedDamSires.length ? C.gold : C.border}`,
                      color: selectedDamSires.length ? C.gold : C.text,
                    }}
                  >
                    {selectedDamSires.length === 0 ? "母父すべて" : `母父 ${selectedDamSires.length}件選択`}
                  </button>
                </div>
                <div className="flex gap-2">
                  <select value={sex} onChange={(e) => setSex(e.target.value)}
                    className="flex-1 px-2 py-1.5 rounded text-xs compact-select" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}>
                    <option value="">性別すべて</option>
                    <option value="牡">牡</option>
                    <option value="牝">牝</option>
                    <option value="せん">せん</option>
                  </select>
                  <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}
                    className="flex-1 px-2 py-1.5 rounded text-xs compact-select" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}>
                    <option value="">所属すべて</option>
                    <option value="栗">栗東</option>
                    <option value="美">美浦</option>
                    <option value={UNASSIGNED_REGION}>{UNASSIGNED_REGION_LABEL}</option>
                  </select>
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
                    className="px-2 py-1.5 rounded text-xs" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}>
                    <option value="name">名前順</option>
                    <option value="birth">生年月日順</option>
                    <option value="marked">印の更新順</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setTrainerModalOpen(true)}
                    className="flex-1 px-2 py-1.5 rounded text-xs text-left truncate"
                    style={{
                      background: C.surfaceRaised,
                      border: `1px solid ${selectedTrainers.length ? C.gold : C.border}`,
                      color: selectedTrainers.length ? C.gold : C.text,
                    }}
                  >
                    {selectedTrainers.length === 0
                      ? "調教師すべて"
                      : `調教師 ${selectedTrainers.length}名`}
                  </button>
                  <button
                    onClick={() => setBreederModalOpen(true)}
                    className="flex-1 px-2 py-1.5 rounded text-xs text-left truncate"
                    style={{
                      background: C.surfaceRaised,
                      border: `1px solid ${selectedBreeders.length ? C.gold : C.border}`,
                      color: selectedBreeders.length ? C.gold : C.text,
                    }}
                  >
                    {selectedBreeders.length === 0
                      ? "生産者すべて"
                      : `生産者 ${selectedBreeders.length}件`}
                  </button>
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setMonthModalOpen(true)}
                    className="flex-1 px-2 py-1.5 rounded text-xs text-left truncate"
                    style={{
                      background: C.surfaceRaised,
                      border: `1px solid ${selectedMonths.length ? C.gold : C.border}`,
                      color: selectedMonths.length ? C.gold : C.text,
                    }}
                  >
                    {selectedMonths.length === 0 ? "生年月日（月）すべて" : `生年月日（月） ${selectedMonths.length}件選択`}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <button
                    onClick={() => setOnlyMarked((v) => !v)}
                    className="px-2 py-1 rounded-full text-xs font-semibold"
                    style={{ background: onlyMarked ? C.gold : "transparent", color: onlyMarked ? C.bg : C.textDim, border: `1px solid ${onlyMarked ? C.gold : C.border}` }}
                  >印ありのみ</button>
                  {categories.map((c) => (
                    <button key={c.id}
                      onClick={() => setCategoryFilter((v) => v === c.id ? "" : c.id)}
                      className="px-2 py-1 rounded-full text-xs font-semibold"
                      style={{ background: categoryFilter === c.id ? c.color : "transparent", color: categoryFilter === c.id ? C.bg : c.color, border: `1px solid ${c.color}` }}
                    >{c.mark} {c.label}</button>
                  ))}
                  <button onClick={() => setCategoryManageOpen(true)} className="px-2 py-1 rounded-full text-xs flex items-center gap-0.5" style={{ color: C.textDim, border: `1px dashed ${C.border}` }}>
                    <Settings size={11} />カテゴリ管理
                  </button>
                </div>
                {/* 展開/折りたたみボタン(右下・十分なタップ領域) */}
                <div className="flex justify-end pt-1">
                  <button
                    onClick={() => setShowFilters(false)}
                    className="flex items-center gap-1 px-3 rounded-lg text-xs font-semibold"
                    style={{ color: C.textDim, minHeight: 40, minWidth: 44 }}
                  >
                    折りたたむ <span style={{ fontSize: 13 }}>▲</span>
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowFilters(true)}
                className="mt-2 w-full flex items-center justify-between gap-2 px-3 rounded-lg"
                style={{ background: C.surface, border: `1px solid ${C.border}`, minHeight: 40 }}
              >
                <span className="text-xs truncate text-left" style={{ color: filterSummaryParts.length ? C.gold : C.textDim }}>
                  {filterSummaryParts.length ? filterSummaryParts.join("　") : "絞り込み条件なし"}
                </span>
                <span className="flex items-center justify-center shrink-0" style={{ color: C.textDim, fontSize: 13, minWidth: 32, minHeight: 40 }}>▼</span>
              </button>
            )}
          </>
        )}
      </header>

      {/* メインコンテンツ */}
      {horses.length === 0 ? (
        <EmptyState onPick={() => fileInputRef.current?.click()} onRestore={() => backupFileInputRef.current?.click()} onSync={() => setSyncModalOpen(true)} importing={importing} />
      ) : screen === "candidates" ? (
        <CandidateScreen
          candidateHorses={candidateHorses}
          candidateBaseCount={candidateBaseHorses.length}
          checkedCount={checkedCount}
          categories={categories}
          candidateMarkFilter={candidateMarkFilter}
          setCandidateMarkFilter={setCandidateMarkFilter}
          marks={marks}
          catById={catById}
          onOpen={(h) => setSelected(h)}
          onToggleChecked={toggleChecked}
          onCycleMark={cycleMark}
          query={candidateQuery}
          setQuery={setCandidateQuery}
          sex={candidateSex}
          setSex={setCandidateSex}
          regionFilter={candidateRegionFilter}
          setRegionFilter={setCandidateRegionFilter}
          selectedTrainers={candidateSelectedTrainers}
          onOpenTrainerModal={() => setCandidateTrainerModalOpen(true)}
          selectedBreeders={candidateSelectedBreeders}
          onOpenBreederModal={() => setCandidateBreederModalOpen(true)}
          selectedMonths={candidateSelectedMonths}
          onOpenMonthModal={() => setCandidateMonthModalOpen(true)}
          selectedDamSires={candidateSelectedDamSires}
          onOpenDamSireModal={() => setCandidateDamSireModalOpen(true)}
          sortBy={candidateSortBy}
          setSortBy={setCandidateSortBy}
          filtersExpanded={candidateFiltersExpanded}
          setFiltersExpanded={setCandidateFiltersExpanded}
          filterSummaryParts={candidateFilterSummaryParts}
          onExport={() => exportCandidatesToCsv(candidateHorses, marks, catById)}
          onOpenRanking={() => setRankingModalOpen(true)}
          summary={candidateSummary}
          onOpenNoteList={() => setNoteListOpen(true)}
          onOpenPedigreeGap={() => setPedigreeGapOpen(true)}
        />
      ) : (
        <>
          <main className="flex-1 min-h-0 overflow-y-auto px-3 py-2" style={{ WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}>
            {filtered.length === 0 ? (
              <div className="text-center py-16 text-sm" style={{ color: C.textDim }}>該当する馬がいません</div>
            ) : (
              <div className="space-y-2">
                {pageItems.map((h) => (
                  <HorseRow key={h.id} horse={h} mark={marks[h.id]} category={catById(marks[h.id]?.categoryId)}
                    checked={!!marks[h.id]?.checked} rank={marks[h.id]?.rank}
                    onOpen={() => setSelected(h)} onCycleMark={() => cycleMark(h.id)}
                    onToggleChecked={() => toggleChecked(h.id)} />
                ))}
              </div>
            )}
          </main>

          {totalPages > 1 && (
            <div className="shrink-0 flex items-center justify-center gap-3 py-3" style={{ background: C.bg, borderTop: `1px solid ${C.border}`, paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ opacity: page <= 1 ? 0.3 : 1 }}><ChevronLeft size={18} color={C.text} /></button>
              <span className="text-xs" style={{ color: C.textDim }}>{page} / {totalPages}（{filtered.length.toLocaleString()}頭）</span>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} style={{ opacity: page >= totalPages ? 0.3 : 1 }}><ChevronRight size={18} color={C.text} /></button>
            </div>
          )}
        </>
      )}

      {trainerModalOpen && (
        <NameFilterModal
          title="調教師を選択"
          hideSelectAll
          searchPlaceholder="調教師名を検索"
          notFoundText="該当する調教師がいません"
          items={trainers}
          selected={selectedTrainers}
          onChange={setSelectedTrainers}
          onClose={() => setTrainerModalOpen(false)}
          displayName={trainerDisplayName}
          specialItems={[UNASSIGNED_TRAINER]}
        />
      )}

      {breederModalOpen && (
        <NameFilterModal
          title="生産者を選択"
          hideSelectAll
          searchPlaceholder="生産者名を検索"
          notFoundText="該当する生産者がいません"
          items={breeders}
          selected={selectedBreeders}
          onChange={setSelectedBreeders}
          onClose={() => setBreederModalOpen(false)}
        />
      )}

      {damSireModalOpen && (
        <NameFilterModal
          title="母父を選択"
          searchPlaceholder="母父名を検索"
          notFoundText="該当する母父がいません"
          items={damSireOptions}
          selected={selectedDamSires}
          onChange={setSelectedDamSires}
          onClose={() => setDamSireModalOpen(false)}
          selectAllVisible
        />
      )}

      {candidateDamSireModalOpen && (
        <NameFilterModal
          title="母父を選択"
          searchPlaceholder="母父名を検索"
          notFoundText="該当する母父がいません"
          items={candidateDamSireOptions}
          selected={candidateSelectedDamSires}
          onChange={setCandidateSelectedDamSires}
          onClose={() => setCandidateDamSireModalOpen(false)}
          selectAllVisible
        />
      )}

      {monthModalOpen && (
        <NameFilterModal
          title="生年月日（月）を選択"
          items={BIRTH_MONTH_OPTIONS}
          selected={selectedMonths}
          onChange={setSelectedMonths}
          onClose={() => setMonthModalOpen(false)}
          displayName={birthMonthLabel}
          hideSearch
        />
      )}

      {candidateMonthModalOpen && (
        <NameFilterModal
          title="生年月日（月）を選択"
          items={BIRTH_MONTH_OPTIONS}
          selected={candidateSelectedMonths}
          onChange={setCandidateSelectedMonths}
          onClose={() => setCandidateMonthModalOpen(false)}
          displayName={birthMonthLabel}
          hideSearch
        />
      )}

      {candidateTrainerModalOpen && (
        <NameFilterModal
          title="調教師を選択"
          hideSelectAll
          searchPlaceholder="調教師名を検索"
          notFoundText="該当する調教師がいません"
          items={candidateTrainers}
          selected={candidateSelectedTrainers}
          onChange={setCandidateSelectedTrainers}
          onClose={() => setCandidateTrainerModalOpen(false)}
          displayName={trainerDisplayName}
          specialItems={[UNASSIGNED_TRAINER]}
        />
      )}

      {candidateBreederModalOpen && (
        <NameFilterModal
          title="生産者を選択"
          hideSelectAll
          searchPlaceholder="生産者名を検索"
          notFoundText="該当する生産者がいません"
          items={candidateBreeders}
          selected={candidateSelectedBreeders}
          onChange={setCandidateSelectedBreeders}
          onClose={() => setCandidateBreederModalOpen(false)}
        />
      )}

      {pedigreeImportOpen && (
        <PedigreeImportModal
          importing={pedigreeImporting}
          result={pedigreeImportResult}
          onPickFile={() => pedigreeFileInputRef.current?.click()}
          onClose={() => setPedigreeImportOpen(false)}
        />
      )}
      <input
        ref={pedigreeFileInputRef} type="file" accept=".csv" className="hidden"
        onChange={(e) => { handlePedigreeImport(e.target.files?.[0]); e.target.value = ""; }}
      />

      {seasonModalOpen && (
        <SeasonModal
          currentSeason={currentSeason}
          switching={seasonSwitching}
          onSwitch={switchSeason}
          onRequestDelete={(s) => setSeasonDeleteTarget(s)}
          onClose={() => setSeasonModalOpen(false)}
        />
      )}

      {seasonDeleteTarget && (
        <SeasonDeleteConfirmModal
          season={seasonDeleteTarget}
          onCancel={() => setSeasonDeleteTarget(null)}
          onConfirm={() => deleteSeason(seasonDeleteTarget.id)}
        />
      )}

      {categoryManageOpen && (
        <CategoryManageModal
          categories={categories}
          onAdd={addCategory}
          onEdit={editCategory}
          onDelete={deleteCategory}
          onClose={() => setCategoryManageOpen(false)}
        />
      )}

      {noteListOpen && (
        <NoteListModal
          candidateHorses={candidateBaseHorses}
          marks={marks}
          catById={catById}
          onOpen={(h) => setSelected(h)}
          onClose={() => setNoteListOpen(false)}
        />
      )}

      {pedigreeGapOpen && (
        <PedigreeGapModal
          candidateHorses={candidateBaseHorses}
          allHorses={horses}
          pedigreeDB={pedigreeDB}
          onOpen={(h) => setSelected(h)}
          onClose={() => setPedigreeGapOpen(false)}
        />
      )}

      {rankingModalOpen && (
        <RankingModal
          candidateHorses={candidateBaseHorses}
          marks={marks}
          catById={catById}
          onMoveUp={(id) => moveRank(id, -1)}
          onMoveDown={(id) => moveRank(id, 1)}
          onRemoveRank={removeRank}
          onAssignRank={assignNextRank}
          onOpen={(h) => setSelected(h)}
          onClose={() => setRankingModalOpen(false)}
        />
      )}

      {syncModalOpen && (
        <SyncModal engine={syncEngine} status={syncStatus} C={C} onClose={() => setSyncModalOpen(false)} />
      )}

      {backupModalOpen && (
        <BackupModal
          currentSeason={currentSeason}
          horsesCount={horses.length}
          onExportSeason={() => {
            const r = exportSeasonBackup(currentSeason, horses, marks, categories, pedigreeDB);
            setLastBackupAt(Date.now());
            return r;
          }}
          lastBackupAt={lastBackupAt}
          season={currentSeason}
          onRestored={async () => { setBackupModalOpen(false); await loadAll(); }}
          onPickRestoreFile={() => backupFileInputRef.current?.click()}
          onClose={() => setBackupModalOpen(false)}
        />
      )}
      <input
        ref={backupFileInputRef} type="file" accept=".json" className="hidden"
        onChange={(e) => { handleBackupFileSelected(e.target.files?.[0]); e.target.value = ""; }}
      />

      {pendingRestore && (
        <RestoreConfirmModal
          backup={pendingRestore}
          currentSeason={currentSeason}
          restoring={restoring}
          onCancel={() => setPendingRestore(null)}
          onConfirm={confirmRestore}
        />
      )}

      {selected && (
        <HorseDetail
          horse={selected}
          mark={marks[selected.id]}
          checked={!!marks[selected.id]?.checked}
          categories={categories}
          onClose={() => setSelected(null)}
          onSetMark={(cid) => setMark(selected.id, cid)}
          onSetNote={(note) => setNote(selected.id, note)}
          onToggleChecked={() => toggleChecked(selected.id)}
          onViewPedigree={() => setPedigreeViewHorse(selected)}
          onRename={(name) => renameHorse(selected.id, name)}
          onAssignRank={() => assignNextRank(selected.id)}
          onRemoveRank={() => removeRank(selected.id)}
        />
      )}

      {pedigreeViewHorse && (
        <PedigreeAnalysisModal
          horse={pedigreeViewHorse}
          pedigreeDB={pedigreeDB}
          onClose={() => setPedigreeViewHorse(null)}
        />
      )}

      {toast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-xs font-semibold z-50"
          style={{ background: C.surfaceRaised, color: C.gold, border: `1px solid ${C.goldSoft}` }}>
          {toast}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   一覧行
   ============================================================ */
function HorseRow({ horse, mark, category, checked, rank, onOpen, onCycleMark, onToggleChecked, showNote }) {
  return (
    <div className="flex items-stretch rounded-lg overflow-hidden" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
      <div style={{ width: 4, background: sexColor(horse.sex) }} />
      <button
        onClick={onToggleChecked}
        className="flex items-center justify-center px-2.5"
        style={{ minWidth: 40, borderRight: `1px solid ${C.border}` }}
        aria-label="候補馬チェック"
      >
        <span
          className="flex items-center justify-center shrink-0 rounded"
          style={{ width: 18, height: 18, background: checked ? C.gold : "transparent", border: `1px solid ${checked ? C.gold : C.border}` }}
        >
          {checked && <span style={{ fontSize: 12, color: C.bg, fontWeight: 700, lineHeight: 1 }}>✓</span>}
        </span>
      </button>
      <button onClick={onCycleMark} className="flex items-center justify-center px-3" style={{ minWidth: 52, borderRight: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 20, color: category ? category.color : C.border, fontWeight: 700 }}>
          {category ? category.mark : "・"}
        </span>
      </button>
      <button onClick={onOpen} className="flex-1 text-left px-3 py-2.5 min-w-0">
        <div className="flex items-center gap-1.5">
          {rank ? (
            <span
              className="flex items-center justify-center shrink-0 rounded-full text-[10px] font-bold"
              style={{ width: 18, height: 18, background: C.gold, color: C.bg }}
            >
              {rank}
            </span>
          ) : null}
          <span className="font-bold text-sm truncate">{horse.name}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: C.surfaceRaised, color: C.textDim }}>{horse.sex}</span>
          {showNote && hasNote(mark) && <StickyNote size={14} color={C.gold} className="shrink-0" aria-label="メモあり" />}
        </div>
        <div className="text-xs mt-0.5 truncate" style={{ color: C.textDim }}>
          父 {horse.sire || "―"} ／ 母 {horse.dam || "―"}{horse.damSire && `(${horse.damSire})`}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] truncate" style={{ color: C.textDim, fontFamily: "monospace" }}>
          {horse.birthDate && <span>{horse.birthDate}</span>}
          {horse.trainer && (
            <span className="truncate">
              {trainerDisplayName(horse.trainer)}{horse.region && `(${regionLabel(horse.region)})`}
            </span>
          )}
          {horse.breeder && <span className="truncate">｜{horse.breeder}</span>}
        </div>
      </button>
    </div>
  );
}

/* ============================================================
   候補馬(チェック済みの馬)画面
   ============================================================ */
function CandidateScreen({
  candidateHorses, candidateBaseCount, checkedCount, categories, candidateMarkFilter, setCandidateMarkFilter,
  marks, catById, onOpen, onToggleChecked, onCycleMark,
  query, setQuery, sex, setSex, regionFilter, setRegionFilter,
  selectedTrainers, onOpenTrainerModal, selectedBreeders, onOpenBreederModal,
  selectedMonths, onOpenMonthModal, selectedDamSires, onOpenDamSireModal,
  sortBy, setSortBy, filtersExpanded, setFiltersExpanded, filterSummaryParts,
  onExport, onOpenRanking, summary, onOpenNoteList, onOpenPedigreeGap,
}) {
  // 件数はsummary(候補馬全体)から。フィルターの値は従来どおり ""(すべて) / category.id / CANDIDATE_NO_MARK / CANDIDATE_HAS_NOTE
  const sm = summary || { total: 0, noMarkCount: 0, noteCount: 0, perCategory: [] };
  const chips = [
    { id: "", mark: null, label: "すべて", count: sm.total },
    ...sm.perCategory.map((c) => ({ id: c.id, mark: c.mark, color: c.color, label: c.mark, count: c.count })),
    { id: CANDIDATE_NO_MARK, mark: null, label: "印なし", count: sm.noMarkCount },
    { id: CANDIDATE_HAS_NOTE, mark: null, label: "メモあり", count: sm.noteCount },
  ];
  return (
    <>
      <div className="shrink-0 px-4 pt-3 pb-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-bold whitespace-nowrap">候補馬 {checkedCount}頭</h2>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={onOpenRanking}
              disabled={checkedCount === 0}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold"
              style={{
                color: checkedCount === 0 ? C.border : C.gold,
                border: `1px solid ${checkedCount === 0 ? C.border : C.goldSoft}`,
              }}
              aria-label="指名順位"
            >
              <ListOrdered size={13} />指名順位 {summary ? summary.rankedCount : 0}
            </button>
            <button
              onClick={onOpenNoteList}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold"
              style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}
              aria-label="メモ一覧"
            >
              <StickyNote size={13} />メモ {summary ? summary.noteCount : 0}
            </button>
            <button
              onClick={onExport}
              disabled={candidateHorses.length === 0}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold"
              style={{
                color: candidateHorses.length === 0 ? C.border : C.gold,
                border: `1px solid ${candidateHorses.length === 0 ? C.border : C.goldSoft}`,
              }}
              aria-label="CSV書き出し"
            >
              <FileDown size={13} />CSV
            </button>
          </div>
        </div>

        {/* 印の件数兼フィルター(件数は候補馬全体。タップで従来の印フィルターと同じ絞り込み) */}
        <div className="flex gap-1.5 overflow-x-auto mt-2 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
          {chips.map((chip) => {
            const active = candidateMarkFilter === chip.id;
            return (
              <button
                key={chip.id || "all"}
                onClick={() => setCandidateMarkFilter(chip.id)}
                className="shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap"
                style={{
                  background: active ? C.gold : "transparent",
                  color: active ? C.bg : C.textDim,
                  border: `1px solid ${active ? C.gold : C.border}`,
                }}
              >
                {chip.mark ? (
                  <span style={{ color: active ? C.bg : chip.color, fontWeight: 700 }}>{chip.mark}</span>
                ) : chip.label}
                {" "}{chip.count}
              </button>
            );
          })}
        </div>

        {/* 検索条件: 折りたたみ可能。候補馬(チェック済み)の中からさらに絞り込む */}
        {filtersExpanded ? (
          <div className="mt-2 p-3 rounded-lg space-y-2" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
            <input
              placeholder="馬名で検索"
              value={query.name}
              onChange={(e) => setQuery((p) => ({ ...p, name: e.target.value }))}
              className="w-full px-2 py-1.5 rounded text-xs bg-transparent outline-none"
              style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}
            />
            <div className="grid grid-cols-3 gap-2">
              <input placeholder="父" value={query.sire} onChange={(e) => setQuery((p) => ({ ...p, sire: e.target.value }))}
                className="px-2 py-1.5 rounded text-xs bg-transparent outline-none" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }} />
              <input placeholder="母" value={query.dam} onChange={(e) => setQuery((p) => ({ ...p, dam: e.target.value }))}
                className="px-2 py-1.5 rounded text-xs bg-transparent outline-none" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }} />
              <button
                onClick={onOpenDamSireModal}
                className="px-2 py-1.5 rounded text-xs text-left truncate"
                style={{
                  background: C.surfaceRaised,
                  border: `1px solid ${selectedDamSires.length ? C.gold : C.border}`,
                  color: selectedDamSires.length ? C.gold : C.text,
                }}
              >
                {selectedDamSires.length === 0 ? "母父すべて" : `母父 ${selectedDamSires.length}件選択`}
              </button>
            </div>
            <div className="flex gap-2">
              <select value={sex} onChange={(e) => setSex(e.target.value)}
                className="flex-1 px-2 py-1.5 rounded text-xs compact-select" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}>
                <option value="">性別すべて</option>
                <option value="牡">牡</option>
                <option value="牝">牝</option>
                <option value="せん">せん</option>
              </select>
              <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}
                className="flex-1 px-2 py-1.5 rounded text-xs compact-select" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}>
                <option value="">所属すべて</option>
                <option value="栗">栗東</option>
                <option value="美">美浦</option>
                <option value={UNASSIGNED_REGION}>{UNASSIGNED_REGION_LABEL}</option>
              </select>
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
                className="px-2 py-1.5 rounded text-xs" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}>
                <option value="name">名前順</option>
                <option value="birth">生年月日順</option>
                <option value="marked">印の更新順</option>
                <option value="rank">指名順位順</option>
                <option value="markOrder">印順</option>
              </select>
            </div>
            <div className="flex gap-2">
              <button
                onClick={onOpenTrainerModal}
                className="flex-1 px-2 py-1.5 rounded text-xs text-left truncate"
                style={{
                  background: C.surfaceRaised,
                  border: `1px solid ${selectedTrainers.length ? C.gold : C.border}`,
                  color: selectedTrainers.length ? C.gold : C.text,
                }}
              >
                {selectedTrainers.length === 0 ? "調教師すべて" : `調教師 ${selectedTrainers.length}名`}
              </button>
              <button
                onClick={onOpenBreederModal}
                className="flex-1 px-2 py-1.5 rounded text-xs text-left truncate"
                style={{
                  background: C.surfaceRaised,
                  border: `1px solid ${selectedBreeders.length ? C.gold : C.border}`,
                  color: selectedBreeders.length ? C.gold : C.text,
                }}
              >
                {selectedBreeders.length === 0 ? "生産者すべて" : `生産者 ${selectedBreeders.length}件`}
              </button>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={onOpenMonthModal}
                className="flex-1 px-2 py-1.5 rounded text-xs text-left truncate"
                style={{
                  background: C.surfaceRaised,
                  border: `1px solid ${selectedMonths.length ? C.gold : C.border}`,
                  color: selectedMonths.length ? C.gold : C.text,
                }}
              >
                {selectedMonths.length === 0 ? "生年月日（月）すべて" : `生年月日（月） ${selectedMonths.length}件選択`}
              </button>
            </div>
            <div className="flex justify-between items-center pt-1">
              <button
                onClick={onOpenPedigreeGap}
                className="flex items-center gap-1 px-3 rounded-lg text-xs font-semibold"
                style={{ color: C.gold, border: `1px solid ${C.goldSoft}`, minHeight: 40 }}
              >
                <Dna size={13} />血統不足
              </button>
              <button
                onClick={() => setFiltersExpanded(false)}
                className="flex items-center gap-1 px-3 rounded-lg text-xs font-semibold"
                style={{ color: C.textDim, minHeight: 40, minWidth: 44 }}
              >
                折りたたむ <span style={{ fontSize: 13 }}>▲</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => setFiltersExpanded(true)}
              className="flex-1 min-w-0 flex items-center justify-between gap-2 px-3 rounded-lg"
              style={{ background: C.surface, border: `1px solid ${C.border}`, minHeight: 40 }}
            >
              <span className="text-xs truncate text-left" style={{ color: filterSummaryParts.length ? C.gold : C.textDim }}>
                {filterSummaryParts.length ? filterSummaryParts.join("　") : "検索条件"}
              </span>
              <span className="flex items-center justify-center shrink-0" style={{ color: C.textDim, fontSize: 13, minWidth: 32, minHeight: 40 }}>▼</span>
            </button>
            <button
              onClick={onOpenPedigreeGap}
              className="shrink-0 flex items-center gap-1 px-3 rounded-lg text-xs font-semibold"
              style={{ color: C.gold, border: `1px solid ${C.goldSoft}`, minHeight: 40 }}
              aria-label="血統不足チェック"
            >
              <Dna size={13} />血統不足
            </button>
          </div>
        )}

      </div>
      <main className="flex-1 min-h-0 overflow-y-auto px-3 py-2" style={{ WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}>
        {candidateBaseCount === 0 ? (
          <div className="text-center py-16 text-sm" style={{ color: C.textDim }}>
            候補馬にチェックした馬がいません
          </div>
        ) : candidateHorses.length === 0 ? (
          <div className="text-center py-16 text-sm" style={{ color: C.textDim }}>
            条件に一致する候補馬がいません
          </div>
        ) : (
          <div className="space-y-2 pb-4">
            {candidateHorses.map((h) => (
              <HorseRow
                key={h.id}
                showNote
                horse={h}
                mark={marks[h.id]}
                category={catById(marks[h.id]?.categoryId)}
                checked={!!marks[h.id]?.checked}
                rank={marks[h.id]?.rank}
                onOpen={() => onOpen(h)}
                onCycleMark={() => onCycleMark(h.id)}
                onToggleChecked={() => onToggleChecked(h.id)}
              />
            ))}
          </div>
        )}
      </main>
    </>
  );
}

/* ============================================================
   詳細モーダル
   ============================================================ */
function HorseDetail({ horse, mark, checked, categories, onClose, onSetMark, onSetNote, onToggleChecked, onViewPedigree, onRename, onAssignRank, onRemoveRank }) {
  const rank = mark?.rank || null;
  // 馬名の編集: 鉛筆→入力→「変更する」→確認ポップアップ→確定した場合のみ保存
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmingName, setConfirmingName] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const trimmedDraft = nameDraft.trim();
  const canSubmitName = trimmedDraft.length > 0 && trimmedDraft !== horse.name;
  const startEditName = () => { setNameDraft(horse.name); setEditingName(true); };
  const cancelEditName = () => { setEditingName(false); setConfirmingName(false); };
  const doRename = async () => {
    setRenaming(true);
    const ok = await onRename(trimmedDraft);
    setRenaming(false);
    setConfirmingName(false);
    if (ok) setEditingName(false);
  };
  const [note, setNoteLocal] = useState(mark?.note || "");
  // メモ欄は内容の全文が見える高さまで自動で伸ばす(欄内スクロールなし。長い場合は詳細画面全体をスクロール)
  const noteRef = useRef(null);
  useEffect(() => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [note]);
  const rows = [
    ["父", horse.sire], ["母", horse.dam], ["母父", horse.damSire],
    ["生年月日", horse.birthDate], ["性別", horse.sex], ["毛色", horse.color],
    ["所属", regionLabel(horse.region)], ["調教師", trainerDisplayName(horse.trainer)], ["生産者", horse.breeder], ["馬主", horse.owner],
  ];
  const extra = Object.entries(horse.raw || {}).filter(([, v]) => v);

  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "92%", height: "92%" }} onClick={(e) => e.stopPropagation()}>
        {/* 固定ヘッダー: スクロール領域の外にあるので、長い内容をスクロールしても×が常に押せる */}
        <div
          className="shrink-0 flex items-start justify-between pl-5 pr-2"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 8 }}
        >
          <div className="min-w-0 flex-1 pt-1">
            <div className="text-[11px]" style={{ color: sexColor(horse.sex) }}>{horse.sex}</div>
            {editingName ? (
              <div className="pr-1">
                <input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="馬名"
                  autoFocus
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                  style={{ background: C.surface, border: `1px solid ${C.gold}`, color: C.text }}
                />
                <div className="flex gap-2 mt-2">
                  <button
                    onClick={cancelEditName}
                    className="flex-1 py-2 rounded-lg text-sm font-semibold"
                    style={{ color: C.textDim, border: `1px solid ${C.border}`, minHeight: 40 }}
                  >キャンセル</button>
                  <button
                    onClick={() => setConfirmingName(true)}
                    disabled={!canSubmitName}
                    className="flex-1 py-2 rounded-lg text-sm font-bold"
                    style={{ background: canSubmitName ? C.gold : C.border, color: C.bg, minHeight: 40 }}
                  >変更する</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <h2 className="text-xl font-bold break-words min-w-0">{horse.name}</h2>
                <button
                  onClick={startEditName}
                  className="shrink-0 flex items-center justify-center"
                  style={{ minWidth: 40, minHeight: 40 }}
                  aria-label="馬名を編集"
                >
                  <Pencil size={16} color={C.textDim} />
                </button>
              </div>
            )}
            {horse.originalName && !editingName && (
              <div className="text-[11px] pb-1" style={{ color: C.textDim }}>登録時の名前: {horse.originalName}</div>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 flex items-center justify-center"
            style={{ minHeight: 44, minWidth: 44 }}
            aria-label="閉じる"
          >
            <X size={22} color={C.textDim} />
          </button>
        </div>

        <div
          className="flex-1 min-h-0 overflow-y-auto p-5"
          style={{ WebkitOverflowScrolling: "touch", overscrollBehavior: "contain", paddingBottom: "max(24px, env(safe-area-inset-bottom))" }}
        >

        <button
          onClick={onToggleChecked}
          className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg mb-3"
          style={{ background: checked ? C.surfaceRaised : "transparent", border: `1px solid ${checked ? C.gold : C.border}` }}
        >
          <span
            className="flex items-center justify-center shrink-0 rounded"
            style={{ width: 18, height: 18, background: checked ? C.gold : "transparent", border: `1px solid ${checked ? C.gold : C.border}` }}
          >
            {checked && <span style={{ fontSize: 12, color: C.bg, fontWeight: 700, lineHeight: 1 }}>✓</span>}
          </span>
          <span className="text-sm font-semibold" style={{ color: checked ? C.gold : C.text }}>
            {checked ? "候補馬に登録中" : "候補馬にする"}
          </span>
        </button>

        {checked && (
          <div
            className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg mb-3"
            style={{ background: rank ? C.surfaceRaised : "transparent", border: `1px solid ${rank ? C.gold : C.border}` }}
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: rank ? C.gold : C.text }}>
              <ListOrdered size={14} />
              {rank ? `指名順位 ${rank}位` : "指名順位なし"}
            </span>
            {rank ? (
              <button
                onClick={onRemoveRank}
                className="text-xs font-semibold px-2.5 py-1.5 rounded-lg"
                style={{ color: C.danger, border: `1px solid ${C.border}` }}
              >
                解除
              </button>
            ) : (
              <button
                onClick={onAssignRank}
                className="text-xs font-semibold px-2.5 py-1.5 rounded-lg flex items-center gap-1"
                style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}
              >
                <Plus size={12} />最下位に追加
              </button>
            )}
          </div>
        )}

        <button
          onClick={onViewPedigree}
          className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg mb-3"
          style={{ background: "transparent", border: `1px solid ${C.goldSoft}` }}
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: C.gold }}>
            <Dna size={14} />血統を見る(7代)
          </span>
          <ChevronRight size={16} color={C.gold} />
        </button>

        <div className="flex flex-wrap gap-1.5 mb-4">
          {categories.map((c) => (
            <button key={c.id} onClick={() => onSetMark(mark?.categoryId === c.id ? null : c.id)}
              className="px-2.5 py-1.5 rounded-full text-xs font-semibold"
              style={{ background: mark?.categoryId === c.id ? c.color : "transparent", color: mark?.categoryId === c.id ? C.bg : c.color, border: `1px solid ${c.color}` }}>
              {c.mark} {c.label}
            </button>
          ))}
        </div>

        <div className="rounded-lg divide-y" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
          {rows.map(([label, val]) => (
            <div key={label} className="flex px-3 py-2 text-sm" style={{ borderColor: C.border }}>
              <span className="w-16 shrink-0" style={{ color: C.textDim }}>{label}</span>
              <span>{val || "―"}</span>
            </div>
          ))}
        </div>

        {extra.length > 0 && (
          <details className="mt-3">
            <summary className="text-xs cursor-pointer flex items-center gap-1" style={{ color: C.textDim }}>
              <ChevronDown size={12} />その他の情報（{extra.length}項目）
            </summary>
            <div className="mt-1 rounded-lg divide-y" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
              {extra.map(([k, v]) => (
                <div key={k} className="flex px-3 py-1.5 text-xs">
                  <span className="w-20 shrink-0 truncate" style={{ color: C.textDim }}>{k}</span>
                  <span className="truncate">{String(v)}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="mt-3">
          <label className="text-xs" style={{ color: C.textDim }}>メモ</label>
          <textarea
            ref={noteRef}
            value={note}
            onChange={(e) => setNoteLocal(e.target.value)}
            onBlur={() => onSetNote(note)}
            rows={2}
            placeholder="血統・気になる点など"
            className="w-full mt-1 px-3 py-2 rounded-lg text-sm outline-none resize-none"
            style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text, overflow: "hidden" }}
          />
        </div>
        </div>
      </div>

      {confirmingName && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={(e) => { e.stopPropagation(); if (!renaming) setConfirmingName(false); }}
        >
          <div
            className="w-full max-w-sm rounded-2xl p-5"
            style={{ background: C.surface, border: `1px solid ${C.border}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold mb-3">馬名を変更しますか？</h3>
            <div className="rounded-lg px-3 py-2 mb-3 text-sm" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
              <div className="break-words" style={{ color: C.textDim }}>{horse.name}</div>
              <div className="my-0.5" style={{ color: C.gold }}>↓</div>
              <div className="break-words font-bold">{trimmedDraft}</div>
            </div>
            <p className="text-xs mb-4" style={{ color: C.textDim }}>変更後は正式馬名として保存されます。</p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmingName(false)}
                disabled={renaming}
                className="flex-1 py-2.5 rounded-lg text-sm font-semibold"
                style={{ color: C.textDim, border: `1px solid ${C.border}`, minHeight: 44 }}
              >キャンセル</button>
              <button
                onClick={doRename}
                disabled={renaming}
                className="flex-1 py-2.5 rounded-lg text-sm font-bold"
                style={{ background: C.gold, color: C.bg, minHeight: 44, opacity: renaming ? 0.6 : 1 }}
              >{renaming ? "保存中…" : "変更する"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   汎用: 複数選択モーダル(調教師・生産者などで共用)
   ============================================================ */
function NameFilterModal({ title, searchPlaceholder, items, selected, onChange, onClose, displayName, notFoundText, specialItems, hideSearch, selectAllVisible, hideSelectAll }) {
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(selected);
  const toLabel = displayName || ((x) => x);
  const isSpecial = (t) => !!specialItems && specialItems.includes(t);

  const visible = useMemo(
    () => (query ? items.filter((t) => toLabel(t).includes(query)) : items),
    [items, query]
  );

  const toggle = (t) => {
    setDraft((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  };
  // selectAllVisible指定時は、検索で絞り込み中なら「表示中の項目」だけを既存の選択に追加する
  const selectAll = () => {
    if (selectAllVisible && query) setDraft((prev) => Array.from(new Set([...prev, ...visible])));
    else setDraft(items);
  };
  const clearAll = () => setDraft([]);

  const cancel = () => onClose();            // 選択内容を破棄して戻る
  const done = () => { onChange(draft); onClose(); }; // 選択内容を確定して戻る

  return (
    <div
      className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={cancel}
    >
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "92%", height: "92%" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 固定ヘッダー: スクロール領域の外にあり、常に表示される。Safe Areaも考慮する */}
        <div
          className="shrink-0 flex items-center justify-between px-2"
          style={{
            background: C.surfaceRaised,
            borderBottom: `1px solid ${C.border}`,
            paddingTop: "max(12px, env(safe-area-inset-top))",
            paddingBottom: 12,
          }}
        >
          <button
            onClick={cancel}
            className="flex items-center gap-0.5 text-sm font-semibold"
            style={{ color: C.textDim, padding: "10px 12px", minHeight: 44, minWidth: 44 }}
          >
            <ChevronLeft size={18} />キャンセル
          </button>
          <span className="text-sm font-bold">{title}</span>
          <button
            onClick={done}
            className="text-sm font-bold rounded-lg"
            style={{ color: C.bg, background: C.gold, padding: "10px 16px", minHeight: 44 }}
          >完了</button>
        </div>

        <div className="shrink-0 px-4 pt-3">
          {!hideSearch && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
            <Search size={14} color={C.textDim} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: C.text }}
              autoFocus
            />
            {query && <X size={13} color={C.textDim} onClick={() => setQuery("")} />}
          </div>
          )}
          <div className="flex items-center justify-between mt-2 mb-1">
            <span className="text-xs font-semibold" style={{ color: C.gold }}>{draft.length}件選択中</span>
            <div className="flex gap-3">
              {!hideSelectAll && (
                <button onClick={selectAll} className="text-xs font-semibold" style={{ color: C.text }}>すべて選択</button>
              )}
              <button onClick={clearAll} className="text-xs font-semibold" style={{ color: C.textDim }}>すべて解除</button>
            </div>
          </div>
        </div>

        <div
          className="flex-1 min-h-0 overflow-y-auto px-4 py-1"
          style={{ WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}
        >
          {visible.length === 0 ? (
            <div className="text-center py-10 text-sm" style={{ color: C.textDim }}>{notFoundText}</div>
          ) : (
            <div className="space-y-1 pb-4">
              {visible.map((t, idx) => {
                const checked = draft.includes(t);
                const special = isSpecial(t);
                // 「未定」など特別な項目の直後に区切り線を入れて、通常の名前と視覚的に分ける
                const showDivider = idx > 0 && isSpecial(visible[idx - 1]) && !special;
                return (
                  <React.Fragment key={t}>
                    {showDivider && <div style={{ borderTop: `1px solid ${C.border}`, margin: "6px 2px 8px" }} />}
                    <button
                      onClick={() => toggle(t)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left"
                      style={{
                        background: checked ? C.surfaceRaised : "transparent",
                        border: `1px solid ${checked ? C.gold : "transparent"}`,
                      }}
                    >
                      <span
                        className="flex items-center justify-center shrink-0 rounded"
                        style={{ width: 18, height: 18, background: checked ? C.gold : "transparent", border: `1px solid ${checked ? C.gold : C.border}` }}
                      >
                        {checked && <span style={{ fontSize: 12, color: C.bg, fontWeight: 700, lineHeight: 1 }}>✓</span>}
                      </span>
                      <span className="text-sm" style={{ color: special ? C.textDim : C.text, fontStyle: special ? "italic" : "normal" }}>
                        {toLabel(t)}
                      </span>
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 px-4" style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
          <button onClick={done} className="w-full py-3 rounded-lg text-sm font-bold" style={{ background: C.gold, color: C.bg, minHeight: 48 }}>
            完了（{draft.length}件選択中）
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   血統データ管理(一括インポート) — STEP4
   ------------------------------------------------------------
   POG馬データのインポートとは完全に独立した画面。ここで扱うのは
   pedigree-v1(全年度共通)のみで、horses-v1:<年度>等には触れない。
   ============================================================ */
function PedigreeImportModal({ importing, result, onPickFile, onClose }) {
  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "90%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="shrink-0 flex items-center justify-between px-4"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 12 }}
        >
          <div className="flex items-center gap-1.5">
            <Dna size={15} color={C.gold} />
            <span className="text-sm font-bold">血統データ管理</span>
          </div>
          <button onClick={onClose} style={{ minHeight: 44, minWidth: 44 }} className="flex items-center justify-center">
            <X size={20} color={C.textDim} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4" style={{ WebkitOverflowScrolling: "touch" }}>
          <p className="text-xs leading-relaxed mb-3" style={{ color: C.textDim }}>
            「馬名,父,母」の列を持つCSVを読み込み、血統データベース(pedigree-v1)へ一括登録します。全年度で共通のデータとして保存され、POGの馬データ・印・候補馬・検索には影響しません。同じ祖先馬は自動的に共有され、重複登録はされません。
          </p>

          <button
            onClick={onPickFile}
            disabled={importing}
            className="w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 mb-4"
            style={{ background: C.gold, color: C.bg }}
          >
            {importing ? <RefreshCw size={16} className="animate-spin" /> : <Upload size={16} />}
            血統CSVを選択
          </button>

          {result && (
            <div className="space-y-3">
              {result.saved === false && (
                <div className="p-3 rounded-lg" style={{ background: `${C.danger}22`, border: `1px solid ${C.danger}` }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <AlertTriangle size={14} color={C.danger} />
                    <span className="text-xs font-bold" style={{ color: C.danger }}>保存に失敗しました</span>
                  </div>
                  <p className="text-[11px] leading-relaxed" style={{ color: C.text }}>
                    下記の件数はCSVの処理結果であり、血統データベースへの保存は確認できませんでした。実際のデータには反映されていません。もう一度お試しください。
                  </p>
                  {result.diag && (
                    <p className="text-[11px] mt-1.5" style={{ color: C.textDim }}>
                      診断:極小データ{result.diag.tier1Ok ? "OK" : "NG"} / 読み込み{result.diag.tier3GetOk ? "OK" : "NG"} / 共有領域{result.diag.tier3SharedOk ? "OK" : "NG"}
                    </p>
                  )}
                </div>
              )}
              {result.saved === true && (
                <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg" style={{ background: `${C.gold}18`, border: `1px solid ${C.goldSoft}` }}>
                  <Check size={14} color={C.gold} />
                  <span className="text-xs font-semibold" style={{ color: C.gold }}>保存を確認しました</span>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <ResultStat label="読み込んだ行数" value={result.totalRows} />
                <ResultStat label="新規登録" value={result.newCount} color={C.gold} />
                <ResultStat label="情報を追加" value={result.updatedCount} />
                <ResultStat label="変更なし" value={result.unchangedCount} />
                <ResultStat label="父/母が空欄" value={result.incompleteCount} color={result.incompleteCount ? C.textDim : undefined} />
                <ResultStat label="矛盾を検出" value={result.conflicts.length} color={result.conflicts.length ? C.danger : undefined} />
              </div>

              {result.conflicts.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mt-2 mb-1.5">
                    <AlertTriangle size={13} color={C.danger} />
                    <span className="text-xs font-semibold" style={{ color: C.danger }}>
                      血統データの矛盾({result.conflicts.length}件) — 上書きせず既存データを保持しています
                    </span>
                  </div>
                  <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
                    {result.conflicts.map((c, i) => (
                      <div
                        key={i}
                        className="px-3 py-2 text-xs"
                        style={{ background: i % 2 === 0 ? C.surfaceRaised : C.surface, borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}
                      >
                        <div className="font-semibold mb-1">{c.name} の{c.field === "sire" ? "父" : "母"}</div>
                        <div style={{ color: C.textDim }}>
                          既存: {c.existingName} ／ 新規CSV: {c.incomingName}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultStat({ label, value, color }) {
  return (
    <div className="px-3 py-2 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
      <div className="text-[10px]" style={{ color: C.textDim }}>{label}</div>
      <div className="text-base font-bold" style={{ color: color || C.text }}>{value.toLocaleString()}</div>
    </div>
  );
}

/* ============================================================
   年度管理モーダル — STEP5
   ============================================================ */
function SeasonModal({ currentSeason, switching, onSwitch, onRequestDelete, onClose }) {
  const seasonOptions = useMemo(() => generateSeasonOptions(), []);
  const listRef = useRef(null);
  const currentRef = useRef(null);

  // 開いたときに、現在選択中の年度が見える位置まで自動でスクロールする。
  // マウント直後は要素のレイアウトが確定していないことがあるため、
  // 次の描画フレームまで待ってから実行することで確実に中央へ寄せる。
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (currentRef.current) {
        currentRef.current.scrollIntoView({ block: "center" });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "85%", height: "70%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="shrink-0 flex items-center justify-between px-4"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 12 }}
        >
          <span className="text-sm font-bold">年度を切り替え</span>
          <button onClick={onClose} style={{ minHeight: 44, minWidth: 44 }} className="flex items-center justify-center">
            <X size={20} color={C.textDim} />
          </button>
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="space-y-2">
            {seasonOptions.map((s) => {
              const isCurrent = s.id === currentSeason;
              return (
                <div
                  key={s.id}
                  ref={isCurrent ? currentRef : null}
                  className="flex items-center gap-2 px-3 py-3 rounded-lg"
                  style={{ background: C.surfaceRaised, border: `1px solid ${isCurrent ? C.gold : C.border}` }}
                >
                  <button
                    onClick={() => !isCurrent && !switching && onSwitch(s.id)}
                    className="flex-1 flex items-center gap-2 text-left"
                    disabled={switching}
                  >
                    <span className="text-sm font-semibold" style={{ color: isCurrent ? C.gold : C.text }}>{s.label}</span>
                    {isCurrent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: C.gold, color: C.bg }}>選択中</span>
                    )}
                  </button>
                  {!isCurrent && (
                    <button
                      onClick={() => onRequestDelete(s)}
                      className="flex items-center justify-center"
                      style={{ minHeight: 40, minWidth: 40, color: C.textDim }}
                      aria-label={`${s.label}のデータを削除`}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   年度削除の確認モーダル — STEP5
   ============================================================ */
function SeasonDeleteConfirmModal({ season, onCancel, onConfirm }) {
  const [deleting, setDeleting] = useState(false);
  const handleConfirm = async () => {
    setDeleting(true);
    await onConfirm();
    setDeleting(false);
  };
  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.7)" }} onClick={onCancel}>
      <div
        className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5"
        style={{ background: C.surface, border: `1px solid ${C.danger}`, paddingBottom: "max(20px, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={18} color={C.danger} />
          <h2 className="text-base font-bold">{season.label}を削除しますか？</h2>
        </div>
        <div className="text-xs leading-relaxed mb-4" style={{ color: C.textDim }}>
          <p className="mb-2">
            {season.label}に紐づく以下のデータがすべて削除されます。
          </p>
          <ul className="list-disc pl-4 space-y-0.5 mb-2">
            <li>馬データ</li>
            <li>印(◎○▲△☆×)</li>
            <li>候補馬チェック</li>
            <li>メモ</li>
            <li>カテゴリ設定</li>
          </ul>
          <p style={{ color: C.danger, fontWeight: 600 }}>この操作は元に戻せません。</p>
          <p className="mt-2">
            なお、血統データベース(全年度共通)は削除の対象外です。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-lg text-sm font-semibold"
            style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}
          >
            キャンセル
          </button>
          <button
            onClick={handleConfirm}
            disabled={deleting}
            className="flex-1 py-3 rounded-lg text-sm font-bold flex items-center justify-center gap-1.5"
            style={{ background: C.danger, color: "#fff", opacity: deleting ? 0.6 : 1 }}
          >
            {deleting ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
            削除する
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   カテゴリ(印)管理モーダル — STEP6
   ------------------------------------------------------------
   追加済みカテゴリの編集(名前・記号・色)・削除・新規追加を1画面で
   行う。印の基本6種(◎○▲△☆×)もここでは「ただのカテゴリの1つ」
   として扱われ、他のカテゴリと同じように編集・削除ができる
   (誤って全部消してしまわないよう、削除は個別に確認ステップを挟む)。
   ============================================================ */
function CategoryManageModal({ categories, onAdd, onEdit, onDelete, onClose }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [addingOpen, setAddingOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newMark, setNewMark] = useState("★");
  const [newColor, setNewColor] = useState(CATEGORY_COLOR_PALETTE[0]);

  const handleAdd = () => {
    if (!newLabel.trim()) return;
    onAdd({ label: newLabel.trim(), mark: newMark.trim() || "★", color: newColor });
    setNewLabel(""); setNewMark("★"); setNewColor(CATEGORY_COLOR_PALETTE[0]);
    setAddingOpen(false);
  };

  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "88%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="shrink-0 flex items-center justify-between px-4"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 12 }}
        >
          <span className="text-sm font-bold">カテゴリ(印)管理</span>
          <button onClick={onClose} style={{ minHeight: 44, minWidth: 44 }} className="flex items-center justify-center">
            <X size={20} color={C.textDim} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="space-y-2">
            {categories.map((c) => (
              <CategoryEditRow
                key={c.id}
                category={c}
                confirmingDelete={confirmDeleteId === c.id}
                onEdit={(patch) => onEdit(c.id, patch)}
                onRequestDelete={() => setConfirmDeleteId(c.id)}
                onCancelDelete={() => setConfirmDeleteId(null)}
                onConfirmDelete={() => { onDelete(c.id); setConfirmDeleteId(null); }}
              />
            ))}
          </div>

          <div className="mt-4 pt-3" style={{ borderTop: `1px solid ${C.border}` }}>
            {!addingOpen ? (
              <button
                onClick={() => setAddingOpen(true)}
                className="w-full py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5"
                style={{ color: C.textDim, border: `1px dashed ${C.border}` }}
              >
                <Plus size={14} />新しいカテゴリを追加
              </button>
            ) : (
              <div className="p-3 rounded-lg space-y-2" style={{ background: C.surfaceRaised, border: `1px solid ${C.gold}` }}>
                <div className="flex gap-2">
                  <input
                    value={newMark}
                    onChange={(e) => setNewMark(e.target.value.slice(0, 2))}
                    placeholder="印"
                    className="w-14 px-2 py-2 rounded text-center text-lg outline-none"
                    style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text }}
                  />
                  <input
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="カテゴリ名(例: 抽選対象)"
                    className="flex-1 px-3 py-2 rounded text-sm outline-none"
                    style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text }}
                    autoFocus
                  />
                </div>
                <ColorSwatchPicker value={newColor} onChange={setNewColor} />
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => { setAddingOpen(false); setNewLabel(""); }}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold"
                    style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.textDim }}
                  >キャンセル</button>
                  <button
                    onClick={handleAdd}
                    disabled={!newLabel.trim()}
                    className="flex-1 py-2 rounded-lg text-xs font-bold"
                    style={{ background: C.gold, color: C.bg, opacity: newLabel.trim() ? 1 : 0.5 }}
                  >追加する</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ColorSwatchPicker({ value, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {CATEGORY_COLOR_PALETTE.map((color) => (
        <button
          key={color}
          onClick={() => onChange(color)}
          className="flex items-center justify-center rounded-full shrink-0"
          style={{
            width: 28, height: 28, background: color,
            border: value === color ? `2px solid ${C.text}` : "2px solid transparent",
            boxShadow: value === color ? `0 0 0 2px ${C.surfaceRaised}` : "none",
          }}
          aria-label={color}
        >
          {value === color && <Check size={14} color={C.bg} strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

function CategoryEditRow({ category, confirmingDelete, onEdit, onRequestDelete, onCancelDelete, onConfirmDelete }) {
  const [label, setLabel] = useState(category.label);
  const [mark, setMark] = useState(category.mark);

  if (confirmingDelete) {
    return (
      <div className="p-3 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.danger}` }}>
        <p className="text-xs mb-2" style={{ color: C.text }}>
          「{category.mark} {category.label}」を削除しますか？この印が付いていた馬は印なしに戻ります(チェック・メモは残ります)。
        </p>
        <div className="flex gap-2">
          <button onClick={onCancelDelete} className="flex-1 py-2 rounded-lg text-xs font-semibold" style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text }}>
            キャンセル
          </button>
          <button onClick={onConfirmDelete} className="flex-1 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1" style={{ background: C.danger, color: "#fff" }}>
            <Trash2 size={12} />削除する
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
      <div className="flex items-center gap-2 mb-2">
        <input
          value={mark}
          onChange={(e) => setMark(e.target.value.slice(0, 2))}
          onBlur={() => mark !== category.mark && onEdit({ mark: mark || category.mark })}
          className="w-12 px-1 py-2 rounded text-center text-lg font-bold outline-none"
          style={{ background: C.surface, border: `1px solid ${C.border}`, color: category.color }}
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== category.label && onEdit({ label: label || category.label })}
          className="flex-1 px-3 py-2 rounded text-sm outline-none"
          style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text }}
        />
        <button
          onClick={onRequestDelete}
          className="flex items-center justify-center shrink-0"
          style={{ minWidth: 40, minHeight: 40, color: C.textDim }}
          aria-label={`${category.label}を削除`}
        >
          <Trash2 size={15} />
        </button>
      </div>
      <ColorSwatchPicker value={category.color} onChange={(color) => onEdit({ color })} />
    </div>
  );
}

/* ============================================================
   指名順位モーダル — STEP1(馬を選ぶ使いやすさの改善)
   ------------------------------------------------------------
   候補馬(チェック済み)のうち、順位が付いている馬を上から順に表示し、
   上下ボタンで簡単に入れ替えられるようにする。印(categoryId)・
   候補馬チェック(checked)・メモ(note)とは独立したrankフィールドを
   扱うだけで、他のデータには一切触れない。
   ============================================================ */
function NoteListModal({ candidateHorses, marks, catById, onOpen, onClose }) {
  const items = useMemo(() => {
    return candidateHorses
      .filter((h) => hasNote(marks[h.id]))
      .sort((a, b) => {
        const ra = marks[a.id]?.rank || Infinity;
        const rb = marks[b.id]?.rank || Infinity;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name, "ja");
      });
  }, [candidateHorses, marks]);

  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "88%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="shrink-0 flex items-center justify-between px-4"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 12 }}
        >
          <div className="flex items-center gap-1.5">
            <StickyNote size={15} color={C.gold} />
            <span className="text-sm font-bold">メモ一覧 {items.length}頭</span>
          </div>
          <button onClick={onClose} style={{ minHeight: 44, minWidth: 44 }} className="flex items-center justify-center">
            <X size={20} color={C.textDim} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3" style={{ WebkitOverflowScrolling: "touch" }}>
          {items.length === 0 ? (
            <p className="text-xs text-center py-6" style={{ color: C.textDim }}>メモが入力された候補馬はいません。</p>
          ) : (
            <div className="space-y-2">
              {items.map((h) => {
                const m = marks[h.id];
                const category = catById(m?.categoryId);
                return (
                  <button
                    key={h.id}
                    onClick={() => onOpen(h)}
                    className="w-full text-left p-2.5 rounded-lg"
                    style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}
                  >
                    <div className="flex items-center gap-1.5">
                      {m?.rank ? (
                        <span className="flex items-center justify-center shrink-0 rounded-full text-[10px] font-bold" style={{ width: 18, height: 18, background: C.gold, color: C.bg }}>
                          {m.rank}
                        </span>
                      ) : null}
                      {category && <span style={{ color: category.color, fontWeight: 700, fontSize: 14 }}>{category.mark}</span>}
                      <span className="text-sm font-bold truncate">{h.name}</span>
                    </div>
                    <div className="text-xs mt-1.5 truncate" style={{ color: C.text }}>
                      {noteFirstLine(m.note)}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   血統不足チェック(不足馬一覧・不足祖先)
   ------------------------------------------------------------
   状態は開くたびに既存データから計算するだけで、何も保存しない。
   対象: 候補馬のみ(チェック済みの馬すべて。検索条件の絞り込みとは独立)／全馬。
   馬名タップで馬詳細を開き、閉じるとこの一覧に戻る。
   ============================================================ */
const GAP_STATE_COLOR = { A: C.gold, B: C.textDim, C: C.danger, D: "#D9A441" };
const GAP_STATE_ORDER = { C: 0, D: 1, B: 2, A: 3 };
const GAP_VIEW_LIMIT = 200;

function PedigreeGapModal({ candidateHorses, allHorses, pedigreeDB, onOpen, onClose }) {
  const [scope, setScope] = useState("candidates"); // "candidates" | "all"
  const [tab, setTab] = useState("horses"); // "horses" | "ancestors"
  const [stateFilter, setStateFilter] = useState("all"); // "all" | "B" | "C" | "D"
  const [ancSection, setAncSection] = useState("unreg"); // "unreg" | "check"
  const [limit, setLimit] = useState(GAP_VIEW_LIMIT);
  const [computed, setComputed] = useState(null);

  const targetHorses = scope === "all" ? allHorses : candidateHorses;
  const scopeLabel = scope === "all" ? "全馬" : "候補馬";

  useEffect(() => {
    setComputed(null);
    setLimit(GAP_VIEW_LIMIT);
    if (!pedigreeDB) return undefined;
    // 全馬は件数が多いので、先に「集計中」を表示してから計算する
    const t = setTimeout(() => {
      const all = targetHorses.map((h) => ({ horse: h, result: classifyPedigreeGap(h, pedigreeDB) }));
      all.sort((a, b) =>
        (GAP_STATE_ORDER[a.result.state] - GAP_STATE_ORDER[b.result.state])
        || a.horse.name.localeCompare(b.horse.name, "ja"));
      setComputed({ all, agg: aggregateAncestorGaps(all) });
    }, 30);
    return () => clearTimeout(t);
  }, [targetHorses, pedigreeDB]);

  const counts = useMemo(() => {
    const c = { A: 0, B: 0, C: 0, D: 0 };
    if (computed) computed.all.forEach((r) => { c[r.result.state] += 1; });
    return c;
  }, [computed]);

  const listRows = useMemo(() => {
    if (!computed) return [];
    return computed.all.filter((r) => r.result.state !== "A" && (stateFilter === "all" || r.result.state === stateFilter));
  }, [computed, stateFilter]);

  const agg = computed?.agg;
  const ancList = agg ? (ancSection === "unreg" ? agg.unregistered : agg.needCheck) : [];

  const saveHorsesCsv = () => {
    saveCsvTextFile(`血統不足馬_${scopeLabel}_${todayYmd()}.csv`, buildGapHorsesCsv(listRows));
  };
  const saveAncestorCsv = () => {
    const name = ancSection === "unreg" ? "未登録" : "要確認";
    saveCsvTextFile(`不足祖先_${name}_${scopeLabel}_${todayYmd()}.csv`, buildAncestorTemplateCsv(ancList));
  };

  const pill = (active) => ({
    background: active ? C.gold : "transparent",
    color: active ? C.bg : C.textDim,
    border: `1px solid ${active ? C.gold : C.border}`,
  });

  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, height: "92%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="shrink-0 flex items-center justify-between px-4"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 12 }}
        >
          <div className="flex items-center gap-1.5">
            <Dna size={15} color={C.gold} />
            <span className="text-sm font-bold">血統不足チェック</span>
          </div>
          <button onClick={onClose} style={{ minHeight: 44, minWidth: 44 }} className="flex items-center justify-center" aria-label="閉じる">
            <X size={20} color={C.textDim} />
          </button>
        </div>

        <div className="shrink-0 px-4 pt-3 pb-2 space-y-2" style={{ borderBottom: `1px solid ${C.border}` }}>
          <div className="flex gap-1.5">
            <button onClick={() => setScope("candidates")} className="flex-1 py-1.5 rounded-full text-xs font-semibold" style={pill(scope === "candidates")}>
              候補馬のみ {candidateHorses.length}頭
            </button>
            <button onClick={() => setScope("all")} className="flex-1 py-1.5 rounded-full text-xs font-semibold" style={pill(scope === "all")}>
              全馬 {allHorses.length}頭
            </button>
          </div>
          <div className="flex gap-1.5">
            <button onClick={() => setTab("horses")} className="flex-1 py-1.5 rounded-lg text-xs font-semibold" style={pill(tab === "horses")}>不足馬</button>
            <button onClick={() => setTab("ancestors")} className="flex-1 py-1.5 rounded-lg text-xs font-semibold" style={pill(tab === "ancestors")}>不足祖先</button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3" style={{ WebkitOverflowScrolling: "touch" }}>
          {!pedigreeDB ? (
            <p className="text-xs text-center py-8" style={{ color: C.textDim }}>血統データを読み込み中です。少し待ってからもう一度開いてください。</p>
          ) : !computed ? (
            <p className="text-xs text-center py-8" style={{ color: C.textDim }}>集計中…</p>
          ) : tab === "horses" ? (
            <>
              <div className="flex gap-1.5 overflow-x-auto pb-2" style={{ WebkitOverflowScrolling: "touch" }}>
                {[
                  { id: "all", label: "すべて", n: counts.B + counts.C + counts.D },
                  { id: "C", label: "C 親情報なし", n: counts.C },
                  { id: "D", label: "D 要確認", n: counts.D },
                  { id: "B", label: "B 途切れ", n: counts.B },
                ].map((f) => (
                  <button key={f.id} onClick={() => { setStateFilter(f.id); setLimit(GAP_VIEW_LIMIT); }}
                    className="shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap" style={pill(stateFilter === f.id)}>
                    {f.label} {f.n}
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-[11px]" style={{ color: C.textDim }}>254枠到達(A) {counts.A}頭は表示しません</span>
                <button onClick={saveHorsesCsv} disabled={listRows.length === 0}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold shrink-0"
                  style={{ color: listRows.length === 0 ? C.border : C.gold, border: `1px solid ${listRows.length === 0 ? C.border : C.goldSoft}` }}>
                  <FileDown size={13} />CSV {listRows.length}件
                </button>
              </div>
              {listRows.length === 0 ? (
                <p className="text-xs text-center py-8" style={{ color: C.textDim }}>該当する馬はいません。</p>
              ) : (
                <div className="space-y-2">
                  {listRows.slice(0, limit).map(({ horse, result }) => (
                    <button key={horse.id} onClick={() => onOpen(horse)} className="w-full text-left p-2.5 rounded-lg"
                      style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
                      <div className="flex items-center gap-1.5">
                        <span className="shrink-0 px-1.5 rounded text-[10px] font-bold"
                          style={{ color: GAP_STATE_COLOR[result.state], border: `1px solid ${GAP_STATE_COLOR[result.state]}` }}>
                          {result.state}
                        </span>
                        <span className="text-sm font-bold truncate">{horse.name}</span>
                        <span className="ml-auto shrink-0 text-[10px]" style={{ color: C.textDim }}>{horse.id}</span>
                      </div>
                      <div className="text-[11px] mt-1" style={{ color: C.textDim, wordBreak: "break-all" }}>{result.reason}</div>
                    </button>
                  ))}
                  {listRows.length > limit && (
                    <button onClick={() => setLimit((l) => l + GAP_VIEW_LIMIT)} className="w-full py-2 rounded-lg text-xs font-semibold"
                      style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}>
                      さらに表示({listRows.length - limit}件)
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="text-[11px] mb-2" style={{ color: C.textDim }}>
                集計対象 {agg.includedHorses}頭
                {agg.excludedHorses > 0 && `(血統情報の食い違いで要確認の${agg.excludedHorses}頭は除外)`}
                。同じ祖先が1頭の血統表に複数回出ても1頭として数えます。
              </p>
              <div className="flex gap-1.5 mb-2">
                <button onClick={() => { setAncSection("unreg"); setLimit(GAP_VIEW_LIMIT); }} className="flex-1 py-1.5 rounded-full text-xs font-semibold" style={pill(ancSection === "unreg")}>
                  確実な未登録 {agg.unregistered.length}
                </button>
                <button onClick={() => { setAncSection("check"); setLimit(GAP_VIEW_LIMIT); }} className="flex-1 py-1.5 rounded-full text-xs font-semibold" style={pill(ancSection === "check")}>
                  要確認の祖先 {agg.needCheck.length}
                </button>
              </div>
              <div className="flex items-start justify-between gap-2 mb-2">
                <p className="text-[11px]" style={{ color: C.textDim }}>
                  {ancSection === "unreg"
                    ? "血統DBにレコードが全くない名前です(影響馬数の多い順)。"
                    : "レコードはあるが親情報が未登録(または片方のみ)の名前です。本当に親が不明な馬も含まれます。"}
                </p>
                <button onClick={saveAncestorCsv} disabled={ancList.length === 0}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold shrink-0"
                  style={{ color: ancList.length === 0 ? C.border : C.gold, border: `1px solid ${ancList.length === 0 ? C.border : C.goldSoft}` }}>
                  <FileDown size={13} />雛形CSV
                </button>
              </div>
              {ancList.length === 0 ? (
                <p className="text-xs text-center py-8" style={{ color: C.textDim }}>該当する祖先はありません。</p>
              ) : (
                <div className="space-y-1.5">
                  {ancList.slice(0, limit).map((it) => (
                    <div key={it.key} className="flex items-center gap-2 p-2 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
                      <span className="text-sm truncate flex-1">{it.name}</span>
                      {ancSection === "check" && (
                        <span className="shrink-0 text-[10px]" style={{ color: C.textDim }}>{it.kind === "half" ? "片親のみ" : "親情報なし"}</span>
                      )}
                      <span className="shrink-0 text-xs font-bold" style={{ color: C.gold }}>{it.count}頭</span>
                    </div>
                  ))}
                  {ancList.length > limit && (
                    <button onClick={() => setLimit((l) => l + GAP_VIEW_LIMIT)} className="w-full py-2 rounded-lg text-xs font-semibold"
                      style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}>
                      さらに表示({ancList.length - limit}件)
                    </button>
                  )}
                </div>
              )}
              {ancSection === "check" && agg.nameless.length > 0 && (
                <div className="mt-4 p-2.5 rounded-lg" style={{ border: `1px dashed ${C.border}` }}>
                  <div className="flex items-center gap-1.5 text-xs font-bold" style={{ color: C.textDim }}>
                    <AlertTriangle size={13} />名前不明（キーのみ） {agg.nameless.length}件
                  </div>
                  <p className="text-[11px] mt-1" style={{ color: C.textDim }}>
                    血統DBの親リンク先レコードが実在せず、馬名が分からない祖先です。馬名として扱えないため、CSVには含めません。
                  </p>
                  <div className="mt-1.5 space-y-0.5">
                    {agg.nameless.slice(0, 30).map((it) => (
                      <div key={it.key} className="flex justify-between text-[11px]" style={{ color: C.textDim }}>
                        <span className="truncate">キー: {it.key}</span><span className="shrink-0 ml-2">{it.count}頭</span>
                      </div>
                    ))}
                    {agg.nameless.length > 30 && <div className="text-[11px]" style={{ color: C.textDim }}>ほか{agg.nameless.length - 30}件</div>}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RankingModal({ candidateHorses, marks, catById, onMoveUp, onMoveDown, onRemoveRank, onAssignRank, onOpen, onClose }) {
  const ranked = useMemo(() => {
    return candidateHorses
      .filter((h) => marks[h.id]?.rank)
      .sort((a, b) => marks[a.id].rank - marks[b.id].rank);
  }, [candidateHorses, marks]);

  const unranked = useMemo(() => {
    return candidateHorses.filter((h) => !marks[h.id]?.rank);
  }, [candidateHorses, marks]);

  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "88%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="shrink-0 flex items-center justify-between px-4"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 12 }}
        >
          <div className="flex items-center gap-1.5">
            <ListOrdered size={15} color={C.gold} />
            <span className="text-sm font-bold">指名順位</span>
            <span className="text-xs" style={{ color: C.textDim }}>
              <span style={{ color: C.gold, fontWeight: 700 }}>{ranked.length}頭</span> / 候補{candidateHorses.length}頭
            </span>
          </div>
          <button onClick={onClose} style={{ minHeight: 44, minWidth: 44 }} className="flex items-center justify-center">
            <X size={20} color={C.textDim} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="text-xs font-semibold mb-1.5" style={{ color: C.gold }}>
            順位あり({ranked.length}頭)
          </div>
          {ranked.length === 0 ? (
            <p className="text-xs text-center py-6" style={{ color: C.textDim }}>
              まだ順位が付いた候補馬はいません。下の一覧から「順位を追加」で登録できます。
            </p>
          ) : (
            <div className="space-y-2">
              {ranked.map((h, idx) => {
                const category = catById(marks[h.id]?.categoryId);
                return (
                  <div key={h.id} className="flex items-center gap-2 p-2.5 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
                    <span
                      className="flex items-center justify-center shrink-0 rounded-full text-xs font-bold"
                      style={{ width: 24, height: 24, background: C.gold, color: C.bg }}
                    >
                      {marks[h.id].rank}
                    </span>
                    <button onClick={() => onOpen(h)} className="flex-1 min-w-0 text-left" style={{ minHeight: 32 }}>
                      <div className="flex items-center gap-1">
                        {category && <span style={{ color: category.color, fontWeight: 700, fontSize: 13 }}>{category.mark}</span>}
                        <span className="text-sm font-semibold truncate">{h.name}</span>
                      </div>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => onMoveUp(h.id)}
                        disabled={idx === 0}
                        className="flex items-center justify-center rounded"
                        style={{ width: 32, height: 32, color: idx === 0 ? C.border : C.text, border: `1px solid ${C.border}` }}
                        aria-label="ひとつ上へ"
                      >
                        <ChevronUp size={16} />
                      </button>
                      <button
                        onClick={() => onMoveDown(h.id)}
                        disabled={idx === ranked.length - 1}
                        className="flex items-center justify-center rounded"
                        style={{ width: 32, height: 32, color: idx === ranked.length - 1 ? C.border : C.text, border: `1px solid ${C.border}` }}
                        aria-label="ひとつ下へ"
                      >
                        <ChevronDown size={16} />
                      </button>
                      <button
                        onClick={() => onRemoveRank(h.id)}
                        className="flex items-center justify-center rounded"
                        style={{ width: 32, height: 32, color: C.danger, border: `1px solid ${C.border}` }}
                        aria-label="順位を解除"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {unranked.length > 0 && (
            <div className="mt-4 pt-3" style={{ borderTop: `1px solid ${C.border}` }}>
              <div className="text-xs font-semibold mb-1.5" style={{ color: C.textDim }}>
                順位なし({unranked.length}頭)
              </div>
              <div className="space-y-1.5">
                {unranked.map((h) => {
                  const category = catById(marks[h.id]?.categoryId);
                  return (
                    <div key={h.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                      <button onClick={() => onOpen(h)} className="flex-1 min-w-0 flex items-center gap-1 text-left" style={{ minHeight: 32 }}>
                        {category && <span style={{ color: category.color, fontWeight: 700, fontSize: 13 }}>{category.mark}</span>}
                        <span className="text-sm truncate">{h.name}</span>
                      </button>
                      <button
                        onClick={() => onAssignRank(h.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold shrink-0"
                        style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}
                      >
                        <Plus size={12} />順位を追加
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   データのエクスポート・バックアップ モーダル — STEP7
   ============================================================ */
function formatDateTime(ms) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 直前の版の自動退避の一覧と、「この版に戻す」(確認つき)。バックアップ画面と読み込みエラー画面で共用する。
function AutoBackupList({ season, onRestored }) {
  const [items, setItems] = useState(null);
  const [confirmItem, setConfirmItem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let alive = true;
    listAutoBackups(season).then((l) => { if (alive) setItems(l); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [season]);
  const doRestore = async () => {
    if (!confirmItem) return;
    setBusy(true);
    const r = await restoreAutoBackup(confirmItem, season);
    setBusy(false);
    if (r.ok) { setConfirmItem(null); setMsg("戻しました"); await onRestored(); }
    else setMsg(`戻せませんでした: ${r.error || ""}`);
  };
  if (items === null) return <p className="text-[11px]" style={{ color: C.textDim }}>確認中…</p>;
  if (items.length === 0) return <p className="text-[11px]" style={{ color: C.textDim }}>自動退避はまだありません(データを更新すると、直前の版が自動で残ります)。</p>;
  return (
    <div className="space-y-1.5">
      {items.map((it) => (
        <div key={it.id} className="flex items-center gap-2 p-2 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold">{it.label} {it.count.toLocaleString()}件</div>
            <div className="text-[10px]" style={{ color: C.textDim }}>{formatDateTime(it.savedAt)} の版</div>
          </div>
          <button onClick={() => { setConfirmItem(it); setMsg(""); }} className="shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-semibold" style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}>
            この版に戻す
          </button>
        </div>
      ))}
      {confirmItem && (
        <div className="p-3 rounded-lg" style={{ border: `1px solid ${C.danger}` }}>
          <p className="text-xs leading-relaxed mb-2">
            現在の「{confirmItem.label}」を、{formatDateTime(confirmItem.savedAt)} の版({confirmItem.count.toLocaleString()}件)で置き換えます。よろしいですか?
          </p>
          <div className="flex gap-2">
            <button onClick={() => setConfirmItem(null)} disabled={busy} className="flex-1 py-2 rounded-lg text-xs font-semibold" style={{ border: `1px solid ${C.border}`, color: C.textDim }}>キャンセル</button>
            <button onClick={doRestore} disabled={busy} className="flex-1 py-2 rounded-lg text-xs font-semibold" style={{ background: C.gold, color: C.bg }}>{busy ? "復元中…" : "戻す"}</button>
          </div>
        </div>
      )}
      {msg && <p className="text-[11px]" style={{ color: C.textDim }}>{msg}</p>}
    </div>
  );
}

// 保存データを読み込めなかったときの画面。新規データとして初期化はせず、編集・保存・取り込みも止める。
function StorageErrorScreen({ error, onRetry }) {
  const integrity = error.kind === "integrity";
  return (
    <div className="w-full flex flex-col items-center overflow-y-auto" style={{ background: C.bg, color: C.text, height: "100dvh", padding: "max(24px, env(safe-area-inset-top)) 20px 32px" }}>
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={20} color={C.danger} />
          <h2 className="text-base font-bold">保存データを読み込めませんでした</h2>
        </div>
        <p className="text-xs leading-relaxed mb-3" style={{ color: C.textDim }}>
          {integrity
            ? "保存されているデータの一部が見つからないか、内容が壊れています。"
            : "ブラウザの保存領域(IndexedDB)から読み込めませんでした。一時的な不具合の可能性があります。"}
          保存データには何も書き込んでおらず、新規データとしての初期化もしていません。安全のため、編集・保存・取り込みは停止しています。
        </p>
        <div className="text-[11px] p-2.5 rounded-lg mb-4 break-all" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.textDim }}>
          {error.message}
        </div>
        <button onClick={onRetry} className="w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 mb-2" style={{ background: C.gold, color: C.bg }}>
          <RefreshCw size={16} />もう一度読み込む
        </button>
        <p className="text-[11px] leading-relaxed mb-5" style={{ color: C.textDim }}>
          改善しない場合は、アプリを開き直す・他のタブでこのページを開いていないか確認する・端末を再起動する、をお試しください。
        </p>
        {integrity && (
          <div className="pt-4" style={{ borderTop: `1px solid ${C.border}` }}>
            <h3 className="text-sm font-bold mb-1">直前の自動退避から戻す</h3>
            <p className="text-[11px] leading-relaxed mb-2" style={{ color: C.textDim }}>
              データの置き換えに失敗した場合などに備えて、直前の版を自動で残しています。戻すと、現在の内容は退避の内容に置き換わります。
            </p>
            <AutoBackupList season={error.season} onRestored={onRetry} />
          </div>
        )}
      </div>
    </div>
  );
}

function BackupModal({ currentSeason, horsesCount, onExportSeason, onPickRestoreFile, onClose, lastBackupAt, season, onRestored }) {
  // ストレージの永続化の状態(navigator.storage.persisted/persist)。利用できない環境では「確認できません」と表示する。
  const [persist, setPersist] = useState({ supported: null, persisted: null, requested: false, busy: false });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (navigator.storage && typeof navigator.storage.persisted === "function") {
          const p = await navigator.storage.persisted();
          if (alive) setPersist((x) => ({ ...x, supported: true, persisted: !!p }));
        } else if (alive) {
          setPersist((x) => ({ ...x, supported: false }));
        }
      } catch (e) {
        if (alive) setPersist((x) => ({ ...x, supported: false }));
      }
    })();
    return () => { alive = false; };
  }, []);
  const requestPersist = async () => {
    if (!(navigator.storage && typeof navigator.storage.persist === "function")) return;
    setPersist((x) => ({ ...x, busy: true }));
    try {
      await navigator.storage.persist();
      const p = typeof navigator.storage.persisted === "function" ? await navigator.storage.persisted() : false;
      setPersist((x) => ({ ...x, persisted: !!p, requested: true, busy: false }));
    } catch (e) {
      setPersist((x) => ({ ...x, requested: true, busy: false }));
    }
  };
  const daysSinceBackup = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86400000) : null;
  const backupStale = daysSinceBackup === null || daysSinceBackup >= 14;
  // 直近に書き出した内容(「保存できない場合」の再保存・コピー用。保存はしない)
  const [lastExport, setLastExport] = useState(null);
  const [copyState, setCopyState] = useState(""); // "" | "ok" | "ng"
  // 保存の診断(データが消える原因の切り分け用。既存データは変更しない)
  const [diag, setDiag] = useState({ busy: false, text: "", copied: "" });
  const runDiag = async () => {
    setDiag({ busy: true, text: "", copied: "" });
    let text;
    try { text = await runStorageDiagnostics(season); } catch (e) { text = `診断に失敗しました: ${(e && e.message) || e}`; }
    setDiag({ busy: false, text, copied: "" });
  };
  const copyDiag = async () => {
    const ok = await copyTextToClipboard(diag.text);
    setDiag((d) => ({ ...d, copied: ok ? "ok" : "ng" }));
  };
  const doExport = () => {
    const r = onExportSeason();
    if (r) { setLastExport(r); setCopyState(""); }
  };
  const doCopy = async () => {
    if (!lastExport) return;
    setCopyState((await copyTextToClipboard(lastExport.json)) ? "ok" : "ng");
  };
  return (
    <div className="absolute inset-0 z-40 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "85%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="shrink-0 flex items-center justify-between px-4"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 12 }}
        >
          <span className="text-sm font-bold">データのエクスポート・バックアップ</span>
          <button onClick={onClose} style={{ minHeight: 44, minWidth: 44 }} className="flex items-center justify-center">
            <X size={20} color={C.textDim} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5" style={{ WebkitOverflowScrolling: "touch" }}>
          <div>
            <h3 className="text-sm font-bold mb-1">{seasonLabel(currentSeason)}をバックアップ</h3>
            <p className="text-xs leading-relaxed mb-3" style={{ color: C.textDim }}>
              現在の年度の馬データ・印・チェック・メモ・カテゴリをまとめてJSONファイルとして書き出します(候補馬だけでなく全頭が対象です)。
            </p>
            <button
              onClick={doExport}
              disabled={horsesCount === 0}
              className="w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2"
              style={{ background: C.gold, color: C.bg, opacity: horsesCount === 0 ? 0.5 : 1 }}
            >
              <Download size={16} />JSONで書き出す({horsesCount.toLocaleString()}頭)
            </button>
            {lastExport && (
              <div className="mt-3 p-3 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
                <div className="text-xs font-semibold mb-1" style={{ color: C.gold }}>{lastExport.filename}</div>
                <p className="text-[11px] leading-relaxed mb-2" style={{ color: C.textDim }}>
                  共有シートが開いたら「"ファイル"に保存」を選んでください。ファイルが保存されない場合は、下のボタンをお試しください。
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => saveBackupJsonFile(lastExport.filename, lastExport.json)}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold"
                    style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}
                  >
                    もう一度保存する
                  </button>
                  <button
                    onClick={doCopy}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold"
                    style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}
                  >
                    JSONをコピー
                  </button>
                </div>
                {copyState === "ok" && (
                  <p className="text-[11px] mt-2" style={{ color: C.textDim }}>コピーしました。「メモ」アプリなどに貼り付けて、.json ファイルとして保存してください。</p>
                )}
                {copyState === "ng" && (
                  <p className="text-[11px] mt-2" style={{ color: C.danger }}>コピーできませんでした。</p>
                )}
              </div>
            )}
          </div>

          <div className="pt-4" style={{ borderTop: `1px solid ${C.border}` }}>
            <h3 className="text-sm font-bold mb-1">バックアップから復元</h3>
            <p className="text-xs leading-relaxed mb-3" style={{ color: C.textDim }}>
              上記で書き出したJSONファイルを選ぶと、内容を確認したうえで現在の年度({seasonLabel(currentSeason)})に反映します。
            </p>
            <button
              onClick={onPickRestoreFile}
              className="w-full py-3 rounded-lg text-sm font-semibold flex items-center justify-center gap-2"
              style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}
            >
              <Upload size={16} />バックアップファイルを選択
            </button>
          </div>

          <div className="pt-4" style={{ borderTop: `1px solid ${C.border}` }}>
            <h3 className="text-sm font-bold mb-1">保存の状態</h3>
            <p className="text-xs mb-1" style={{ color: backupStale ? C.danger : C.textDim }}>
              {lastBackupAt
                ? `最後にJSONを書き出す操作をした日: ${formatDateTime(lastBackupAt)}(${daysSinceBackup}日前)`
                : "JSONバックアップを書き出した記録がありません"}
            </p>
            <p className="text-[11px] leading-relaxed mb-3" style={{ color: C.textDim }}>
              データはこの端末のブラウザ内に保存されています。ブラウザの設定やiOSの自動整理で消えることがあるため、定期的にJSONを書き出して「ファイル」アプリなどに残してください。Safariとホーム画面から開いたアプリは、保存領域が別です。
            </p>
            <div className="p-3 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
              <div className="text-xs font-semibold mb-1">ストレージの永続化</div>
              <p className="text-[11px] leading-relaxed mb-2" style={{ color: C.textDim }}>
                {persist.supported === null && "確認中…"}
                {persist.supported === false && "この環境では、永続化の状態を確認できません(利用できない可能性があります)。"}
                {persist.supported === true && persist.persisted === true && "永続化が許可されています。ブラウザが自動で消去しにくくなりますが、データが消えないことの保証ではありません(利用者の操作や端末側の事情で消える場合があります)。"}
                {persist.supported === true && persist.persisted === false && (persist.requested
                  ? "永続化は許可されませんでした。この環境では、ブラウザの自動整理でデータが消える可能性があります。"
                  : "永続化は許可されていません。ブラウザの自動整理でデータが消える可能性があります。")}
              </p>
              {persist.supported === true && persist.persisted === false && typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.persist === "function" && (
                <button onClick={requestPersist} disabled={persist.busy} className="w-full py-2 rounded-lg text-xs font-semibold" style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}>
                  {persist.busy ? "申請中…" : "永続化を申請する"}
                </button>
              )}
              <p className="text-[10px] leading-relaxed mt-2" style={{ color: C.textDim }}>
                許可されても、データ消失を完全に防ぐものではありません。
              </p>
            </div>
          </div>

          <div className="pt-4" style={{ borderTop: `1px solid ${C.border}` }}>
            <h3 className="text-sm font-bold mb-1">直前の自動退避</h3>
            <p className="text-[11px] leading-relaxed mb-2" style={{ color: C.textDim }}>
              印・カテゴリ・血統データを更新する直前の版を、1つだけ自動で残しています(約5分に1回更新)。馬データは、CSVの取り込み・バックアップの復元の直前に残します。操作の失敗や取り違えに備えるもので、ブラウザによるデータ削除には備えられません。
            </p>
            <AutoBackupList season={season} onRestored={onRestored} />
          </div>

          <div className="pt-4" style={{ borderTop: `1px solid ${C.border}` }}>
            <h3 className="text-sm font-bold mb-1">保存の診断</h3>
            <p className="text-[11px] leading-relaxed mb-2" style={{ color: C.textDim }}>
              データが消える原因を調べるための表示です。馬データなどの保存内容は変更しません(診断専用の小さな記録だけを書きます)。Safariとホーム画面アプリの両方で実行して、結果を見比べてください。
            </p>
            <button
              onClick={runDiag}
              disabled={diag.busy}
              className="w-full py-2.5 rounded-lg text-xs font-semibold"
              style={{ color: C.gold, border: `1px solid ${C.goldSoft}`, opacity: diag.busy ? 0.6 : 1 }}
            >
              {diag.busy ? "診断中…" : "診断を実行"}
            </button>
            {diag.text && (
              <div className="mt-2">
                <pre className="p-2 rounded-lg text-[10px] leading-relaxed whitespace-pre-wrap break-all" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}>{diag.text}</pre>
                <button onClick={copyDiag} className="w-full mt-2 py-2 rounded-lg text-xs font-semibold" style={{ color: C.gold, border: `1px solid ${C.goldSoft}` }}>
                  診断結果をコピー
                </button>
                {diag.copied === "ok" && <p className="text-[11px] mt-1" style={{ color: C.textDim }}>コピーしました。</p>}
                {diag.copied === "ng" && <p className="text-[11px] mt-1" style={{ color: C.danger }}>コピーできませんでした。画面を撮影してください。</p>}
              </div>
            )}
          </div>

          <p className="text-[11px] leading-relaxed" style={{ color: C.textDim }}>
            ※ 血統データ(pedigree。全年度共通)もバックアップに含まれます。復元すると、血統データもバックアップの内容に置き換わります(血統データがまだ無い場合は含まれません)。
          </p>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   バックアップ復元の確認モーダル — STEP7
   ============================================================ */
function RestoreConfirmModal({ backup, currentSeason, restoring, onCancel, onConfirm }) {
  const seasonMismatch = backup.season && backup.season !== currentSeason;
  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.7)" }} onClick={onCancel}>
      <div
        className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-5"
        style={{ background: C.surface, border: `1px solid ${seasonMismatch ? C.danger : C.gold}`, paddingBottom: "max(20px, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={18} color={seasonMismatch ? C.danger : C.gold} />
          <h2 className="text-base font-bold">バックアップを復元しますか？</h2>
        </div>

        {seasonMismatch && (
          <div className="mb-3 p-2.5 rounded-lg text-xs" style={{ background: `${C.danger}22`, border: `1px solid ${C.danger}`, color: C.danger }}>
            このバックアップは「{backup.label || backup.season}」のデータですが、現在選択中の年度は「{seasonLabel(currentSeason)}」です。年度が一致していません。
          </div>
        )}

        <div className="text-xs leading-relaxed mb-4" style={{ color: C.textDim }}>
          <p className="mb-1">書き出し日時: {backup.exportedAt ? new Date(backup.exportedAt).toLocaleString("ja-JP") : "不明"}</p>
          <p className="mb-1">馬データ: {backup.horses.length.toLocaleString()}頭</p>
          <p className="mb-2">血統データ: {backup.pedigree ? `${Object.keys(backup.pedigree.horses).length.toLocaleString()}頭分を含む` : "含まれていません"}</p>
          <p style={{ color: C.danger, fontWeight: 600 }}>
            現在「{seasonLabel(currentSeason)}」に表示されている馬データ・印・チェック・メモは、このバックアップの内容で置き換えられます。{backup.pedigree ? "全年度共通の血統データも、このバックアップの内容で置き換えられます。" : "血統データは変更されません。"}この操作は元に戻せません。
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-lg text-sm font-semibold"
            style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}
          >
            キャンセル
          </button>
          <button
            onClick={onConfirm}
            disabled={restoring}
            className="flex-1 py-3 rounded-lg text-sm font-bold flex items-center justify-center gap-1.5"
            style={{ background: C.danger, color: "#fff", opacity: restoring ? 0.6 : 1 }}
          >
            {restoring ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
            復元する
          </button>
        </div>
      </div>
    </div>
  );
}


/* ============================================================
   血統解析画面 — STEP9
   ------------------------------------------------------------
   STEP4で作った血統データベース(pedigreeDB)と解析関数
   (buildAncestorTree・countAncestorOccurrences・findAncestorNodes・
   isInSireLine・isInMaleLineOf・hasAncestorInDamMaleLine・
   hasAncestorOnSide)をそのまま再利用し、実際にUIから使えるようにする。
   世代数は既存のPEDIGREE_MAX_GENERATION(=7)をそのまま使う
   (10代化はSTEP9の対象外)。血統データが少ない・無い馬でも
   エラーにならず、「祖先データが登録されていません」と表示する。
   ============================================================ */
function pathToJapanese(path) {
  return path.map((p) => (p === PEDIGREE_SIDE.SIRE ? "父" : "母")).join("→");
}

/* ------------------------------------------------------------
   5代血統表(表示専用・読み取りのみ)
   ------------------------------------------------------------
   buildAncestorTreeが返すノード(path = ["sire"|"dam", ...])をそのまま使い、
   父を上・母を下にして、第g世代のi番目(上から0始まり)を
   32行のグリッドの (i * 32/2^g) 行目から 32/2^g 行ぶん占有させる。
   pathの並びから位置を決めるだけで、配列順の推測や並べ替えはしない。
   ------------------------------------------------------------ */
const PEDIGREE_TABLE_GENERATIONS = 5;
const PEDIGREE_TABLE_ROWS = 2 ** PEDIGREE_TABLE_GENERATIONS; // 32

function buildPedigreeTableCells(tree, generations = PEDIGREE_TABLE_GENERATIONS) {
  const rows = 2 ** generations;
  const byPath = {};
  tree.forEach((n) => {
    if (n.generation > generations) return;
    byPath[n.path.map((p) => (p === PEDIGREE_SIDE.SIRE ? "s" : "d")).join("")] = n;
  });
  const cells = [];
  for (let g = 1; g <= generations; g++) {
    const span = rows / 2 ** g;
    for (let i = 0; i < 2 ** g; i++) {
      const bits = i.toString(2).padStart(g, "0").replace(/0/g, "s").replace(/1/g, "d");
      const node = byPath[bits] || null;
      cells.push({
        gen: g, index: i, span, row: i * span + 1,
        side: bits[0] === "s" ? "sire" : "dam",
        name: node ? node.name : null,
        key: node ? node.key : null,
      });
    }
  }
  return cells;
}

function PedigreeTable5({ tree, dupKeys }) {
  const cells = useMemo(() => buildPedigreeTableCells(tree), [tree]);
  const [atEnd, setAtEnd] = useState(false);
  const onScroll = (e) => {
    const el = e.currentTarget;
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 4);
  };
  const COL_W = 112;
  const ROW_H = 26;
  const sideTint = { sire: "#4A6FA51A", dam: "#B5647A1A" };
  return (
    <div className="mb-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <div className="text-xs font-semibold" style={{ color: C.textDim }}>5代血統表</div>
        <div className="text-[10px]" style={{ color: C.textDim }}>横にスクロールで4代・5代 ▸</div>
      </div>
      <div className="relative" style={{ maxWidth: "100%" }}>
        <div
          onScroll={onScroll}
          style={{
            overflowX: "auto", overflowY: "hidden", maxWidth: "100%",
            WebkitOverflowScrolling: "touch", overscrollBehaviorX: "contain", touchAction: "pan-x pan-y",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${PEDIGREE_TABLE_GENERATIONS}, ${COL_W}px)`,
              gridTemplateRows: `18px repeat(${PEDIGREE_TABLE_ROWS}, ${ROW_H}px)`,
              gap: 2,
              width: "max-content",
            }}
          >
            {Array.from({ length: PEDIGREE_TABLE_GENERATIONS }, (_, i) => (
              <div key={`h${i}`} className="text-[10px] font-semibold text-center" style={{ gridColumn: i + 1, gridRow: 1, color: C.textDim, lineHeight: "18px" }}>
                {i + 1}代
              </div>
            ))}
            {cells.map((c) => {
              const known = !!c.name;
              const isDup = known && dupKeys.has(c.key);
              const lines = c.span >= 2 ? 3 : 2;
              return (
                <div
                  key={`${c.gen}-${c.index}`}
                  className="flex items-center px-1.5 rounded"
                  style={{
                    gridColumn: c.gen,
                    gridRow: `${c.row + 1} / span ${c.span}`,
                    background: `linear-gradient(${sideTint[c.side]}, ${sideTint[c.side]}), ${C.surfaceRaised}`,
                    border: `1px solid ${isDup ? C.goldSoft : C.border}`,
                    minWidth: 0,
                    overflow: "hidden",
                  }}
                >
                  <span
                    style={{
                      display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines,
                      overflow: "hidden", wordBreak: "break-all", lineHeight: 1.15,
                      fontSize: c.gen <= 2 ? 12 : 10.5, fontWeight: c.gen <= 2 ? 700 : 500,
                      color: known ? (isDup ? C.gold : C.text) : C.textDim,
                      opacity: known ? 1 : 0.5,
                    }}
                    title={known ? c.name : undefined}
                  >
                    {known ? c.name : "不明"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {/* 右端にまだ続きがあることを示す控えめなぼかし(スクロール端に着いたら消える) */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute", top: 0, right: 0, bottom: 0, width: 22, pointerEvents: "none",
            background: `linear-gradient(to right, transparent, ${C.surface})`,
            opacity: atEnd ? 0 : 1, transition: "opacity 0.15s",
          }}
        />
      </div>
    </div>
  );
}

function PedigreeAnalysisModal({ horse, pedigreeDB, onClose }) {
  const [query, setQuery] = useState("");

  // rootはHorseオブジェクトそのものではなく、血統解析関数が要求する
  // {sire, dam, damSire}相当の形にしておく(既存関数の入力形式と合わせる)。
  const root = useMemo(() => ({ sire: horse.sire, dam: horse.dam, damSire: horse.damSire }), [horse]);

  const tree = useMemo(() => buildAncestorTree(root, pedigreeDB, PEDIGREE_MAX_GENERATION), [root, pedigreeDB]);

  const maxGenReached = tree.length ? Math.max(...tree.map((n) => n.generation)) : 0;

  // 世代ごとにグループ化(表示用)
  const byGeneration = useMemo(() => {
    const map = {};
    tree.forEach((n) => { (map[n.generation] = map[n.generation] || []).push(n); });
    return map;
  }, [tree]);

  // 同じ祖先が複数箇所に登場しているケース(「複数箇所に登場する祖先」セクション用)。
  // これは7代ツリー全体が対象で、表示範囲の変更後も内容は変えない。
  const duplicates = useMemo(() => {
    const byKey = {};
    tree.forEach((n) => { (byKey[n.key] = byKey[n.key] || []).push(n); });
    return Object.values(byKey).filter((nodes) => nodes.length >= 2)
      .sort((a, b) => b.length - a.length);
  }, [tree]);

  // インブリード表示(「3×4」形式)だけは5代以内に限定する。7代ツリー自体・
  // 「複数箇所に登場する祖先」・祖先名検索(7代以内)には影響しない、独立した
  // 集計をここで別途行う。
  const inbreedingDuplicates = useMemo(() => {
    const byKey = {};
    tree
      .filter((n) => n.generation <= INBREEDING_MAX_GENERATION)
      .forEach((n) => { (byKey[n.key] = byKey[n.key] || []).push(n); });
    return Object.values(byKey).filter((nodes) => nodes.length >= 2);
  }, [tree]);

  // inbreedingDuplicates(5代以内限定)をもとに、「3×4」のようなクロス表記を組み立てる。
  // 実際に5代以内のツリー上で見つかった出現世代だけを使い、推測は行わない。
  const inbreedingCrosses = useMemo(() => {
    return inbreedingDuplicates
      .map((nodes) => {
        const generations = nodes.map((n) => n.generation).sort((a, b) => a - b);
        return { name: nodes[0].name, generations, label: generations.join("×") };
      })
      .sort((a, b) => a.generations[0] - b.generations[0] || a.generations.length - b.generations.length);
  }, [inbreedingDuplicates]);

  // 5代血統表で、5代以内に複数回登場する祖先(インブリード)を金色で示すためのキー集合
  const inbreedingDupKeys = useMemo(() => new Set(inbreedingDuplicates.map((nodes) => nodes[0].key)), [inbreedingDuplicates]);

  const searchResults = useMemo(() => {
    if (!query.trim()) return null;
    return findAncestorNodes(root, query.trim(), pedigreeDB, PEDIGREE_MAX_GENERATION);
  }, [query, root, pedigreeDB]);

  return (
    <div className="absolute inset-0 z-50 flex items-end sm:items-center sm:justify-center" style={{ background: "rgba(0,0,0,0.7)" }} onClick={onClose}>
      <div
        className="w-full sm:max-w-md flex flex-col rounded-t-2xl sm:rounded-2xl overflow-hidden"
        style={{ background: C.surface, border: `1px solid ${C.border}`, maxHeight: "90%" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="shrink-0 flex items-center justify-between px-4"
          style={{ background: C.surfaceRaised, borderBottom: `1px solid ${C.border}`, paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: 12 }}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Dna size={14} color={C.gold} />
              <span className="text-sm font-bold truncate">{horse.name} の血統</span>
            </div>
          </div>
          <button onClick={onClose} style={{ minHeight: 44, minWidth: 44 }} className="flex items-center justify-center shrink-0">
            <X size={20} color={C.textDim} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4" style={{ WebkitOverflowScrolling: "touch" }}>
          {/* 到達状況のサマリー */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            <ResultStat label="到達世代" value={maxGenReached} color={maxGenReached >= PEDIGREE_MAX_GENERATION ? C.gold : undefined} />
            <ResultStat label="取得できた祖先" value={tree.length} />
          </div>
          {maxGenReached < PEDIGREE_MAX_GENERATION && (
            <p className="text-[11px] leading-relaxed mb-4" style={{ color: C.textDim }}>
              {tree.length === 0
                ? "この馬の血統データはまだ登録されていません。🧬「血統データ管理」からCSVを取り込むと表示されます。"
                : `${PEDIGREE_MAX_GENERATION}代のうち${maxGenReached}代目までのデータが登録されています。それより先の祖先は未登録です。`}
            </p>
          )}

          {/* インブリード(○×○形式のクロス表記) */}
          <div className="mb-4">
            <div className="text-xs font-semibold mb-1.5" style={{ color: C.textDim }}>インブリード</div>
            {inbreedingCrosses.length === 0 ? (
              <p className="text-xs" style={{ color: C.textDim }}>
                {PEDIGREE_MAX_GENERATION}代以内にインブリードはありません
              </p>
            ) : (
              <div className="space-y-1.5">
                {inbreedingCrosses.map((cross, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between px-3 py-2 rounded-lg text-xs"
                    style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}
                  >
                    <span className="font-semibold">{cross.name}</span>
                    <span style={{ color: C.gold, fontFamily: "monospace", fontWeight: 600 }}>{cross.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 5代血統表(表示のみ。7代データのうち5代目までを描画) */}
          {tree.length > 0 && <PedigreeTable5 tree={tree} dupKeys={inbreedingDupKeys} />}

          {/* 祖先検索 */}
          <div className="mb-4">
            <div className="text-xs font-semibold mb-1.5" style={{ color: C.textDim }}>祖先名で検索</div>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
              <Search size={14} color={C.textDim} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="例: ノーザンダンサー"
                className="flex-1 bg-transparent outline-none text-sm"
                style={{ color: C.text }}
              />
              {query && <X size={13} color={C.textDim} onClick={() => setQuery("")} />}
            </div>

            {searchResults && (
              searchResults.length === 0 ? (
                <div className="text-xs mt-2 px-1" style={{ color: C.textDim }}>
                  {PEDIGREE_MAX_GENERATION}代以内には見つかりませんでした(未登録の可能性もあります)。
                </div>
              ) : (
                <div className="mt-2 space-y-1.5">
                  <div className="text-xs font-semibold" style={{ color: C.gold }}>{searchResults.length}箇所で見つかりました</div>
                  {searchResults.map((n, i) => (
                    <div key={i} className="px-3 py-2 rounded-lg text-xs" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold">{n.name}</span>
                        <span style={{ color: C.textDim }}>第{n.generation}代</span>
                      </div>
                      <div style={{ color: C.textDim, fontFamily: "monospace" }}>{pathToJapanese(n.path)}</div>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        <span className="px-1.5 py-0.5 rounded-full" style={{ background: n.path[0] === "sire" ? "#4A6FA522" : "#B5647A22", color: n.path[0] === "sire" ? "#8FB8DE" : "#E0A8BC", fontSize: 10 }}>
                          {n.path[0] === "sire" ? "父側" : "母側"}
                        </span>
                        {isInSireLine(n) && (
                          <span className="px-1.5 py-0.5 rounded-full" style={{ background: `${C.gold}22`, color: C.gold, fontSize: 10 }}>父系(直系)</span>
                        )}
                        {isInMaleLineOf(n, PEDIGREE_SIDE.DAM) && (
                          <span className="px-1.5 py-0.5 rounded-full" style={{ background: `${C.gold}22`, color: C.gold, fontSize: 10 }}>母の牡系</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>

          {/* 複数箇所に登場する祖先(7代以内・アコーディオンで折りたたみ、初期状態は閉じる) */}
          {duplicates.length > 0 && (
            <details className="mb-4 rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
              <summary className="px-3 py-2.5 text-xs cursor-pointer flex items-center gap-1.5">
                <AlertTriangle size={12} color={C.gold} />
                <span className="font-semibold" style={{ color: C.gold }}>複数箇所に登場する祖先({duplicates.length}頭)</span>
              </summary>
              <div className="px-3 pb-3 space-y-1.5">
                {duplicates.map((nodes, i) => (
                  <div key={i} className="px-3 py-2 rounded-lg text-xs" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                    <div className="font-semibold mb-1">{nodes[0].name}({nodes.length}箇所)</div>
                    <div style={{ color: C.textDim }}>
                      {nodes.map((n, j) => (
                        <div key={j} style={{ fontFamily: "monospace" }}>第{n.generation}代: {pathToJapanese(n.path)}</div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* 世代ごとの一覧 */}
          {tree.length > 0 && (
            <div>
              <div className="text-xs font-semibold mb-1.5" style={{ color: C.textDim }}>世代ごとの一覧</div>
              <div className="space-y-2">
                {Array.from({ length: PEDIGREE_MAX_GENERATION }, (_, i) => i + 1).map((gen) => {
                  const nodes = byGeneration[gen] || [];
                  if (nodes.length === 0) return null;
                  return (
                    <details key={gen} className="rounded-lg" style={{ background: C.surfaceRaised, border: `1px solid ${C.border}` }}>
                      <summary className="px-3 py-2 text-xs cursor-pointer flex items-center justify-between">
                        <span className="font-semibold">第{gen}代({nodes.length}頭)</span>
                        <ChevronDown size={12} color={C.textDim} />
                      </summary>
                      <div className="px-3 pb-2 space-y-1">
                        {nodes.map((n, i) => (
                          <div key={i} className="text-xs flex items-center justify-between" style={{ color: C.textDim }}>
                            <span style={{ color: C.text }}>{n.name}</span>
                            <span style={{ fontFamily: "monospace" }}>{pathToJapanese(n.path)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   空状態(インポート導線)
   ============================================================ */
function EmptyState({ onPick, onRestore, onSync, importing }) {
  // ここに来るのは「保存データの読み込みに成功したうえで、馬データが存在しない」場合だけ
  // (読み込みに失敗した場合は、別のエラー画面になり、ここには来ない)。
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
      <div className="text-5xl mb-3" style={{ color: C.gold }}>◎</div>
      <h2 className="text-base font-bold mb-1">まだ馬データがありません</h2>
      <p className="text-xs mb-6 leading-relaxed" style={{ color: C.textDim }}>
        今年の2歳馬CSVを読み込むと、検索・印付けができるようになります。
        以前のバックアップ(JSON)がある場合は、そこから復元もできます。
      </p>
      <button onClick={onPick} disabled={importing}
        className="px-5 py-3 rounded-lg text-sm font-semibold flex items-center gap-2"
        style={{ background: C.gold, color: C.bg }}>
        {importing ? <RefreshCw size={16} className="animate-spin" /> : <Upload size={16} />}
        CSVを選択
      </button>
      <button onClick={onRestore} disabled={importing}
        className="mt-3 px-5 py-3 rounded-lg text-sm font-semibold flex items-center gap-2"
        style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.text }}>
        <Upload size={16} />バックアップから復元
      </button>
      <button onClick={onSync} disabled={importing}
        className="mt-3 px-5 py-3 rounded-lg text-sm font-semibold flex items-center gap-2"
        style={{ background: C.surfaceRaised, border: `1px solid ${C.border}`, color: C.gold }}>
        <Cloud size={16} />GitHubから復元
      </button>
      <p className="mt-2 text-[11px] leading-relaxed" style={{ color: C.textDim }}>
        GitHub同期を設定していた場合は、トークンを入力し直すと、控えから自動で復元されます。
      </p>
    </div>
  );
}
