import { createStructuredRecord, vitalFields } from "./group-home.js";

// 入所・ユニット入所（長期入所）の毎日の記録。ショートステイの入所時・退所時や持ち物チェックは使わない。
export const LONG_TERM_RESIDENTIAL_SERVICES = ["入所", "ユニット入所"];
export const RESIDENTIAL_RECORD_LAYOUT = "residential";

export function isLongTermResidentialService(serviceType) {
    return LONG_TERM_RESIDENTIAL_SERVICES.includes(serviceType);
}

// 以前ショートステイと同じ欄で保存した入所の記録は、従来の表示を使う
export function isResidentialLayoutRecord(record) {
    return Boolean(record) && isLongTermResidentialService(record.serviceType) && record.recordLayout === RESIDENTIAL_RECORD_LAYOUT;
}

export const RESIDENTIAL_SECTIONS = [
    { title: "定時バイタル（朝）", fields: vitalFields("Morning", "朝", "rs") },
    { title: "定時バイタル（夕）", fields: vitalFields("Evening", "夕", "rs") },
    { title: "食事・水分・口腔ケア・服薬", fields: [
        { id: "rsMealBreakfast", label: "朝食", list: "mealList", placeholder: "例：主食10割・副食8割" },
        { id: "rsMealLunch", label: "昼食", list: "mealList", placeholder: "例：主食10割・副食10割" },
        { id: "rsMealDinner", label: "夕食", list: "mealList", placeholder: "例：主食8割・副食8割" },
        { id: "rsWater", label: "水分（1日合計・ml）", type: "number", list: "waterMlList" },
        { id: "rsOralCare", label: "口腔ケア", list: "oralCareList", placeholder: "例：毎食後に実施、一部介助" },
        { id: "rsMedicationMorning", label: "朝の服薬・処置", list: "medicationList", placeholder: "例：朝食後の内服確認済み" },
        { id: "rsMedicationNoon", label: "昼の服薬・処置", list: "medicationList" },
        { id: "rsMedicationEvening", label: "夕・就寝前の服薬・処置", list: "medicationList" }
    ] },
    { title: "毎日の排泄・入浴・睡眠", fields: [
        { id: "rsBowel", label: "本日の排便", type: "select", options: ["あり", "なし"] },
        { id: "rsBowelCount", label: "排便回数（回）", type: "number", list: "bowelCountList" },
        { id: "rsBowelCondition", label: "排便の時刻・状態", list: "bowelConditionList", placeholder: "例：10:00 普通便、中等量" },
        { id: "rsLastBowelDate", label: "最終排便日", type: "date" },
        { id: "rsUrination", label: "排尿の回数・状態", list: "urinationList", placeholder: "例：日中5回・夜間1回、パッド交換4回" },
        { id: "rsBath", label: "本日の入浴・清潔保持", type: "select", options: ["一般浴", "機械浴", "シャワー浴", "清拭", "実施なし"] },
        { id: "rsBathNote", label: "入浴の様子・未実施理由", type: "textarea" },
        { id: "rsSleep", label: "睡眠・夜間の様子", type: "textarea", placeholder: "例：21時就寝、6時起床。夜間の巡視時は良眠" }
    ] },
    { title: "日中の暮らし", fields: [
        { id: "rsDailyActivity", label: "日中の活動・レクリエーション", type: "textarea", placeholder: "例：体操、塗り絵、ユニットでの洗濯物たたみ、散歩" },
        { id: "rsDailyState", label: "ご本人の様子・表情・会話", type: "textarea", placeholder: "例：他のご入所者様と談笑され、笑顔が多く見られた" }
    ] },
    { title: "日用品の補充・面会", fields: [
        { id: "rsSupplies", label: "日用品の残量・補充のお願い", type: "textarea", placeholder: "例：ティッシュ残り1箱、歯磨き粉の補充をお願いします" },
        { id: "rsBelongings", label: "お預かりした衣類・物品", type: "textarea", placeholder: "例：長袖シャツ2枚受け取り、記名確認済み。なければ空欄" },
        { id: "rsVisit", label: "面会・外出の記録", type: "textarea", placeholder: "例：14時 長女様面会（20分）。次回の面会予定など" }
    ] }
];

const residentialRecord = createStructuredRecord(RESIDENTIAL_SECTIONS, "residentialSection");

export const RESIDENTIAL_FIELDS = residentialRecord.fields;
export const buildResidentialForm = residentialRecord.build;
export const readResidentialFields = residentialRecord.read;
export const restoreResidentialFields = residentialRecord.restore;
export const validateResidentialFields = residentialRecord.validate;
export const renderResidentialRecord = residentialRecord.render;
