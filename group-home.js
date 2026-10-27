export const vitalFields = (period, label, prefix = "gh") => [
    { id: `${prefix}${period}Time`, label: `${label}・測定時刻`, type: "time" },
    { id: `${prefix}${period}Temp`, label: `${label}・体温（℃）`, type: "number", step: "0.1", list: "temp1List" },
    { id: `${prefix}${period}Pulse`, label: `${label}・脈拍（回/分）`, type: "number", list: "pulseList" },
    { id: `${prefix}${period}Spo2`, label: `${label}・酸素飽和度（%）`, type: "number", max: "100", list: "spo2List" },
    { id: `${prefix}${period}BpHigh`, label: `${label}・血圧 上（mmHg）`, type: "number", list: "bpHighList" },
    { id: `${prefix}${period}BpLow`, label: `${label}・血圧 下（mmHg）`, type: "number", list: "bpLowList" }
];

export const GROUP_HOME_SECTIONS = [
    { title: "定時バイタル（朝）", fields: vitalFields("Morning", "朝") },
    { title: "定時バイタル（夕）", fields: vitalFields("Evening", "夕") },
    { title: "食事・水分・口腔ケア・服薬", fields: [
        { id: "ghMealBreakfast", label: "朝食", list: "mealList", placeholder: "例：主食10割・副食8割" },
        { id: "ghMealLunch", label: "昼食", list: "mealList", placeholder: "例：主食10割・副食10割" },
        { id: "ghMealDinner", label: "夕食", list: "mealList", placeholder: "例：主食8割・副食8割" },
        { id: "ghWater", label: "水分（1日合計・ml）", type: "number", list: "waterMlList" },
        { id: "ghOralCare", label: "口腔ケア", list: "oralCareList", placeholder: "例：毎食後に実施、一部介助" },
        { id: "ghMedicationMorning", label: "朝の服薬・処置", list: "medicationList", placeholder: "例：朝食後の内服確認済み" },
        { id: "ghMedicationNoon", label: "昼の服薬・処置", list: "medicationList" },
        { id: "ghMedicationEvening", label: "夕・就寝前の服薬・処置", list: "medicationList" }
    ] },
    { title: "毎日の排泄・入浴・睡眠", fields: [
        { id: "ghBowel", label: "本日の排便", type: "select", options: ["あり", "なし"] },
        { id: "ghBowelCount", label: "排便回数（回）", type: "number", list: "bowelCountList" },
        { id: "ghBowelCondition", label: "排便の時刻・状態", list: "bowelConditionList", placeholder: "例：10:00 普通便、中等量" },
        { id: "ghLastBowelDate", label: "最終排便日", type: "date" },
        { id: "ghUrination", label: "排尿の回数・状態", list: "urinationList", placeholder: "例：日中5回・夜間1回、特変なし" },
        { id: "ghBath", label: "本日の入浴・清潔保持", type: "select", options: ["一般浴", "機械浴", "シャワー浴", "清拭", "実施なし"] },
        { id: "ghBathNote", label: "入浴の様子・未実施理由", type: "textarea" },
        { id: "ghSleep", label: "睡眠・夜間の様子", type: "textarea", placeholder: "例：21時就寝、6時起床。夜間トイレ1回、その後再入眠" }
    ] },
    { title: "家事・役割と日々の暮らし", fields: [
        { id: "ghRoles", label: "一緒に行った家事・ご本人の役割", type: "textarea", placeholder: "例：洗濯物たたみ、配膳、簡単な調理、植物の水やり" },
        { id: "ghRoleResponse", label: "得意なこと・参加時の様子・支援内容", type: "textarea", placeholder: "例：タオルを丁寧に畳まれ、笑顔で取り組まれた。声かけで開始できた" },
        { id: "ghDailyLife", label: "日中の活動・暮らしの様子", type: "textarea", placeholder: "交流、散歩、趣味、ご本人の気持ちや体調の変化など" }
    ] },
    { title: "日用品・持ち込み品の確認", fields: [
        { id: "ghSupplies", label: "日用品の残量・補充依頼", type: "textarea", placeholder: "例：ティッシュ残り1箱、おむつ残り10枚。補充をお願いします" },
        { id: "ghBelongings", label: "新しく持ち込んだ衣類・物品の確認", type: "textarea", placeholder: "例：長袖シャツ2枚受け取り、記名確認済み。持ち込みがなければ空欄" }
    ] }
];

export function createStructuredRecord(sections, sectionId) {
    const fields = sections.flatMap(section => section.fields);

    function build(container) {
        const document = container.ownerDocument;
        container.replaceChildren();
        for (const section of sections) {
            const heading = document.createElement("h3");
            heading.textContent = section.title;
            const fieldBox = document.createElement("div");
            fieldBox.className = "group-home-fields";
            for (const field of section.fields) {
                const wrapper = document.createElement("div");
                if (field.type === "textarea") wrapper.className = "group-home-wide";
                const label = document.createElement("label");
                label.htmlFor = field.id;
                label.textContent = field.label;
                const input = document.createElement(field.type === "textarea" ? "textarea" : field.type === "select" ? "select" : "input");
                input.id = field.id;
                if (field.type === "select") {
                    for (const value of ["", ...field.options]) {
                        const option = document.createElement("option");
                        option.value = value;
                        option.textContent = value || "選択してください";
                        input.appendChild(option);
                    }
                } else if (field.type === "textarea") {
                    input.rows = 2;
                } else {
                    input.type = field.type || "text";
                    if (field.type === "number") {
                        input.min = "0";
                        input.step = field.step || "1";
                        if (field.max) input.max = field.max;
                    }
                }
                if (field.placeholder) input.placeholder = field.placeholder;
                if (field.list) input.setAttribute("list", field.list);
                wrapper.append(label, input);
                fieldBox.appendChild(wrapper);
            }
            container.append(heading, fieldBox);
        }
    }

    function read(document) {
        return Object.fromEntries(fields.map(field => [field.id, document.getElementById(field.id).value]));
    }

    function restore(document, data = {}) {
        for (const field of fields) {
            document.getElementById(field.id).value = data[field.id] ?? "";
        }
    }

    function validate(document) {
        for (const field of fields) {
            const input = document.getElementById(field.id);
            if (!input.reportValidity()) {
                input.focus();
                return false;
            }
        }
        return true;
    }

    function render(data, compact = false) {
        const escape = value => String(value).replace(/[&<>"']/g, char => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[char]));
        const hidden = new Set(data.hiddenFormSections || []);
        const journal = hidden.has("careJournalArea") ? "" : `
        <div class="section-title">担当スタッフ・介護日誌</div>
        <div class="text-box" style="white-space:pre-wrap;">${escape(data.careStaff || "未入力")}\n${escape(data.careJournal || "未入力")}</div>`;
        const renderCell = field => `<th>${escape(field.label)}</th><td style="text-align:left;white-space:pre-wrap;">${escape(data[field.id] ?? "") || "未入力"}</td>`;
        return journal + (hidden.has(sectionId) ? "" : sections.map(section => `
        <div class="section-title">${escape(section.title)}</div>
        <table class="compact-table history-table">${section.fields.flatMap((field, index) => {
            if (compact && index % 2) return [];
            const next = compact ? section.fields[index + 1] : null;
            return `<tr>${renderCell(field)}${next ? renderCell(next) : compact ? '<td colspan="2"></td>' : ""}</tr>`;
        }).join("")}</table>
    `).join(""));
    }

    return { fields, build, read, restore, validate, render };
}

const groupHomeRecord = createStructuredRecord(GROUP_HOME_SECTIONS, "groupHomeSection");

export const GROUP_HOME_FIELDS = groupHomeRecord.fields;
export const buildGroupHomeForm = groupHomeRecord.build;
export const readGroupHomeFields = groupHomeRecord.read;
export const restoreGroupHomeFields = groupHomeRecord.restore;
export const validateGroupHomeFields = groupHomeRecord.validate;
export const renderGroupHomeRecord = groupHomeRecord.render;
