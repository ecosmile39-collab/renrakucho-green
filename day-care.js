// デイケア（通所リハビリテーション）のリハビリ記録
// 入力画面の「リハビリ記録（デイケア）」欄の読み書きと、表示用の文章づくり

export const DAY_CARE_SERVICE = "デイケア";
export const DAY_CARE_REHAB_ROWS = 4;

// 表示・CSV に使う項目（キーとラベル）
export const DAY_CARE_REHAB_FIELDS = [
    ["rhStaffRole", "担当リハビリ職"],
    ["rhStaffName", "リハビリ担当者"],
    ["rhItems", "実施したリハビリ"],
    ["rhGoal", "リハビリの目標"],
    ["rhChange", "前回からの変化・できたこと"]
];

const text = value => (value === undefined || value === null ? "" : String(value).trim());

// 「歩行訓練」「10m×3回」の組を「歩行訓練 10m×3回」の1行にする
export function formatDayCareRehabItems(rows) {
    if (!Array.isArray(rows)) return "";
    return rows
        .map(row => [text(row?.name), text(row?.amount)].filter(Boolean).join(" "))
        .filter(Boolean)
        .join("、");
}

export function normalizeDayCareRehabRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows
        .map(row => ({ name: text(row?.name), amount: text(row?.amount) }))
        .filter(row => row.name || row.amount)
        .slice(0, DAY_CARE_REHAB_ROWS);
}

export function readDayCareRehabFields(doc) {
    const value = id => text(doc.getElementById(id)?.value);
    const rows = [];
    for (let i = 1; i <= DAY_CARE_REHAB_ROWS; i++) {
        rows.push({ name: value(`rhItemName${i}`), amount: value(`rhItemAmount${i}`) });
    }
    const rhItemRows = normalizeDayCareRehabRows(rows);
    return {
        rhStaffRole: value("rhStaffRole"),
        rhStaffName: value("rhStaffName"),
        rhItemRows,
        rhItems: formatDayCareRehabItems(rhItemRows),
        rhGoal: value("rhGoal"),
        rhChange: value("rhChange")
    };
}

export function fillDayCareRehabFields(doc, data = {}) {
    const set = (id, value) => {
        const field = doc.getElementById(id);
        if (field) field.value = text(value);
    };
    set("rhStaffRole", data.rhStaffRole);
    set("rhStaffName", data.rhStaffName);
    set("rhGoal", data.rhGoal);
    set("rhChange", data.rhChange);
    const rows = normalizeDayCareRehabRows(data.rhItemRows);
    for (let i = 1; i <= DAY_CARE_REHAB_ROWS; i++) {
        set(`rhItemName${i}`, rows[i - 1]?.name);
        set(`rhItemAmount${i}`, rows[i - 1]?.amount);
    }
}

// 印刷・履歴で使う「担当：理学療法士（PT） 山田」
export function dayCareRehabStaffText(data = {}) {
    return [text(data.rhStaffRole), text(data.rhStaffName)].filter(Boolean).join(" ");
}

export function hasDayCareRehab(data = {}) {
    return ["rhStaffRole", "rhStaffName", "rhItems", "rhGoal", "rhChange"].some(key => text(data[key]));
}
