// 「AIに相談する」：行事やレクの案を考えるための質問文を作り、無料で使えるAI（ChatGPT・Claude・Gemini）を開く。
// 利用者さんのお名前などの個人情報は質問文に入れない。

export const AI_TOPICS = {
    recreation: "レクリエーション",
    seasonal: "季節の行事",
    birthday: "誕生日会",
    conversation: "声かけの例"
};

export const AI_CONDITIONS = [
    "車いすの方が多い",
    "座ってできるもの",
    "認知症の方も楽しめる",
    "準備が少なくてすむもの",
    "体を動かすもの",
    "頭の体操になるもの"
];

export const AI_SERVICES = {
    chatgpt: { label: "ChatGPT", url: prompt => `https://chatgpt.com/?q=${encodeURIComponent(prompt)}` },
    claude: { label: "Claude", url: prompt => `https://claude.ai/new?q=${encodeURIComponent(prompt)}` },
    gemini: { label: "Gemini", url: () => "https://gemini.google.com/app", pasteOnly: true }
};

const seasonOf = month => (
    [12, 1, 2].includes(month) ? "冬" : [3, 4, 5].includes(month) ? "春" : [6, 7, 8].includes(month) ? "夏" : "秋"
);

// 自由記入の中に利用者さんのお名前があれば「（お名前）」に置きかえる
export function removePersonalNames(text, names = []) {
    let result = String(text || "");
    const sorted = [...new Set(names.filter(Boolean).map(String))].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
        const variants = [name, name.replace(/\s+/g, ""), ...name.split(/\s+/).filter(part => part.length >= 2)];
        for (const variant of variants) {
            if (variant) result = result.split(variant).join("（お名前）");
        }
    }
    return result;
}

export function buildAiPrompt({ topic = "recreation", service = "デイサービス", month = 1, people = "", minutes = "", conditions = [], note = "", userNames = [] } = {}) {
    const place = service || "介護施設";
    const monthText = month ? `${month}月（${seasonOf(Number(month))}）` : "";
    const timeText = minutes ? `${minutes}` : "";
    let first;
    if (topic === "seasonal") {
        first = `${place}で${monthText}に行う季節の行事（イベント）の案を5つ提案してください。飾りつけや当日の流れも教えてください。`;
    } else if (topic === "birthday") {
        first = `${place}で${monthText}に行う誕生日会の進め方と、出し物の案を5つ提案してください。`;
    } else if (topic === "conversation") {
        first = `${place}の利用者さんへの、${monthText}らしい話題を使った声かけの例を10個教えてください。`;
    } else {
        first = `${place}で${monthText}に行う${timeText ? `${timeText}の` : ""}レクリエーションを5つ提案してください。`;
    }
    const lines = [first];
    if (topic !== "recreation" && timeText && topic !== "conversation") lines.push(`時間は${timeText}くらいです。`);
    const who = [];
    if (people) who.push(`参加者は${people}`);
    if (conditions.length) who.push(`${conditions.join("、")}`);
    if (who.length) lines.push(`${who.join("で、")}という条件に合う内容にしてください。`);
    if (topic !== "conversation") lines.push("準備物と進め方も教えてください。");
    lines.push("高齢の方が安全に楽しめるよう、注意点も添えてください。");
    const cleanNote = removePersonalNames(note, userNames).trim();
    if (cleanNote) lines.push(`そのほかの条件：${cleanNote}`);
    return lines.join("");
}
