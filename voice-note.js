// 「🎤 話して記録」：スタッフが話した内容を、無料のAI（ChatGPT・Claude・Gemini）にまとめてもらう。
// AIへは話した内容だけを送り、利用者さんのお名前は「ご本人」に置きかえる。
// AIの答えを貼り付けると、介護日誌・ご家族への連絡事項・申し送りに分けて入れる。

import { removePersonalNames } from "./ai-consult.js";

export const VOICE_SECTIONS = {
    careJournal: "介護日誌",
    message: "ご家族への連絡事項",
    handoverNote: "申し送り",
    flags: "チェック"
};

export const VOICE_FLAGS = {
    handoverRequired: "要申し送り",
    medicalVisit: "受診対応あり",
    conditionChange: "体調変化"
};

const NONE_WORDS = /^(なし|特になし|とくになし|該当なし|ありません|無し|ー|-|―|なし。)$/;

export function buildVoiceSummaryPrompt({ transcript = "", service = "", userNames = [] } = {}) {
    const spoken = removePersonalNames(transcript, userNames).replace(/（お名前）(さん|様|さま|ちゃん|くん)?/g, "ご本人").trim();
    const place = service || "介護施設";
    return [
        `${place}のスタッフが、利用者さん（ご本人）の今日の様子を話した内容です。次の4つに分けてまとめてください。`,
        "",
        "【介護日誌】職員が読む記録。事実だけを、時間の順に短く。",
        "【ご家族への連絡事項】ご家族が読む文章。やさしく丁寧な言葉で、3〜4文。専門用語や略語は使わない。",
        "【申し送り】次の職員に伝えること。なければ「なし」。",
        "【チェック】「要申し送り」「受診対応あり」「体調変化」のうち当てはまるものを「、」で区切って。なければ「なし」。",
        "",
        "守ってほしいこと：",
        "・話した内容にないことは書かない。推測や病名は書かない。",
        "・数字（体温・量・回数・時間）は話したとおりに書く。",
        "・利用者さんは「ご本人」と書く。お名前は書かない。",
        "・見出しは【 】のまま、上の4つだけを順に書く。ケアマネジャーへの報告や注意点など、ほかの項目は書かない。",
        "",
        "＜話した内容＞",
        spoken
    ].join("\n");
}

// AIの答えから【見出し】ごとの本文を取り出す
export function parseVoiceSummary(answer) {
    const text = String(answer || "").replace(/\r\n?/g, "\n");
    const labelToKey = Object.fromEntries(Object.entries(VOICE_SECTIONS).map(([key, label]) => [label, key]));
    const result = { careJournal: "", message: "", handoverNote: "", flags: { handoverRequired: false, medicalVisit: false, conditionChange: false } };
    // 見出しを探す。「【介護日誌】」のほか、AIが「## 介護日誌」「**介護日誌：**」と書いた形も見つける。
    // 「【ケアマネジャーへの報告】」のように頼んでいない見出しは、区切りとしてだけ使い、中身は入れない。
    const found = [];
    for (const m of text.matchAll(/[*#\s]*【\s*([^】\n]{1,30}?)\s*】[*：:\s]*|[*#\s]*\[\s*(介護日誌|ご家族への連絡事項|申し送り|チェック)\s*\][*：:\s]*/g)) {
        found.push({ index: m.index, length: m[0].length, label: (m[1] || m[2]).trim() });
    }
    for (const m of text.matchAll(/(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*(介護日誌|ご家族への連絡事項|申し送り|チェック)[ \t]*(?:\*\*)?[ \t]*[：:]?[ \t]*(?:\*\*)?[ \t]*(?=\n|$)/g)) {
        found.push({ index: m.index, length: m[0].length, label: m[1] });
    }
    found.sort((a, b) => a.index - b.index);
    const marks = found.filter((mark, i) => i === 0 || mark.index >= found[i - 1].index + found[i - 1].length);
    // 見出しがない答えは、全部を介護日誌に入れる
    if (!marks.length) {
        const body = text.split("\n").map(line => line.replace(/^\s*[*\-]\s+/, "").trimEnd()).join("\n").replace(/\*\*/g, "").trim();
        if (body) { result.careJournal = body; result.noHeadings = true; }
        return result;
    }
    marks.forEach((mark, index) => {
        const key = labelToKey[mark.label];
        if (!key) return;
        const start = mark.index + mark.length;
        const end = index + 1 < marks.length ? marks[index + 1].index : text.length;
        const body = text.slice(start, end)
            .split("\n").map(line => line.replace(/^\s*[*\-・]\s*(?=\S)/, line.trim().startsWith("・") ? "・" : "").trimEnd())
            .join("\n").replace(/\*\*/g, "").trim();
        if (key === "flags") {
            if (!NONE_WORDS.test(body)) {
                for (const [flag, label] of Object.entries(VOICE_FLAGS)) if (body.includes(label)) result.flags[flag] = true;
            }
        } else if (!NONE_WORDS.test(body)) {
            result[key] = body;
        }
    });
    if (result.handoverNote) result.flags.handoverRequired = true;
    return result;
}

export function hasVoiceSummary(summary) {
    return Boolean(summary && (summary.careJournal || summary.message || summary.handoverNote || Object.values(summary.flags || {}).some(Boolean)));
}

// すでに書いてある欄には、改行して後ろに足す（消さない）
export function appendText(current, addition) {
    const before = String(current || "").trim();
    const add = String(addition || "").trim();
    if (!add) return before;
    if (!before) return add;
    if (before.includes(add)) return before;
    return `${before}\n${add}`;
}
