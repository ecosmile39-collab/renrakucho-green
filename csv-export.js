import Papa from "papaparse";

const recordLabels = {
    careStaff: "担当職員", careJournal: "介護日誌", temp1: "来所時体温", temp2: "途中体温",
    pulse: "脈拍", spo2: "酸素飽和度", bpHigh: "血圧（上）", bpLow: "血圧（下）",
    mealMain: "食事（主食）", mealSub: "食事（副食）", water: "水分", medication: "服薬・処置",
    oralCare: "口腔ケア", bowel: "排便", bowel1: "便性状1", bowel2: "便性状2", bowel3: "便性状3",
    bath: "入浴", bathReason: "入浴の補足", training: "機能訓練", activity: "活動",
    message: "施設からの連絡", familyMessage: "家庭からの連絡", facilityPR: "施設からのお知らせ",
    handoverRequired: "要申し送り", medicalVisit: "受診対応あり", conditionChange: "体調変化",
    handoverNote: "職員間申し送り", imageCount: "写真枚数", videoCount: "動画数",
    hasImage: "写真あり", hasVideo: "動画あり", familyPublished: "家族向け公開済み",
    familyPublishedAt: "家族向け公開日時",
    afterSchoolStaff: "児童支援・担当指導員", afterSchoolAttendance: "児童支援・利用状況",
    afterSchoolProvideStart: "児童支援・提供開始", afterSchoolProvideEnd: "児童支援・提供終了",
    afterSchoolArrivalTime: "児童支援・到着時刻", afterSchoolDepartureTime: "児童支援・退所時刻",
    afterSchoolPickupType: "児童支援・来所時送迎", afterSchoolPickup: "児童支援・来所時送迎補足",
    afterSchoolDropoffType: "児童支援・退所時送迎", afterSchoolDropoff: "児童支援・退所時送迎補足",
    afterSchoolTemperature: "児童支援・体温", afterSchoolTempTime: "児童支援・検温時刻",
    afterSchoolHealth: "児童支援・健康状態", afterSchoolHealthNote: "児童支援・健康状態補足",
    afterSchoolToiletTime: "児童支援・排泄時刻", afterSchoolToilet: "児童支援・排泄状況",
    afterSchoolSupport: "児童支援・活動内容", afterSchoolActivityTags: "児童支援・活動種別",
    afterSchoolEpisode: "児童支援・施設での様子", afterSchoolSnack: "児童支援・おやつ",
    afterSchoolSnackIntake: "児童支援・おやつ摂取量", afterSchoolNextUseDate: "児童支援・次回利用予定日",
    afterSchoolBelongings: "児童支援・持ち物", afterSchoolHomeSleepHours: "児童支援・睡眠時間",
    afterSchoolHomeSleepQuality: "児童支援・睡眠の様子", afterSchoolMorningState: "児童支援・朝の様子",
    afterSchoolParentSign: "児童支援・保護者確認", afterSchoolHandover: "児童支援・家族への連絡",
    lifeCareAttendance: "生活介護・利用状況", lifeCareStaff: "生活介護・担当職員",
    lifeCareStartTime: "生活介護・提供開始", lifeCareEndTime: "生活介護・提供終了",
    lifeCareArrivalTime: "生活介護・来所時刻", lifeCareDepartureTime: "生活介護・退所時刻",
    lifeCarePickupType: "生活介護・来所時送迎", lifeCarePickupNote: "生活介護・来所時送迎補足",
    lifeCareDropoffType: "生活介護・退所時送迎", lifeCareDropoffNote: "生活介護・退所時送迎補足",
    lifeCareTemperature: "生活介護・体温", lifeCarePulse: "生活介護・脈拍",
    lifeCareBpHigh: "生活介護・血圧（上）", lifeCareBpLow: "生活介護・血圧（下）",
    lifeCareSpo2: "生活介護・酸素飽和度", lifeCareHealthNote: "生活介護・健康状態",
    lifeCareMeal: "生活介護・食事", lifeCareWater: "生活介護・水分",
    lifeCareMedication: "生活介護・服薬・医療的ケア", lifeCareToileting: "生活介護・排泄",
    lifeCareBathing: "生活介護・入浴", lifeCareActivityTags: "生活介護・活動種別",
    lifeCareGoalProgress: "生活介護・個別支援状況", lifeCareActivityDetails: "生活介護・活動内容",
    lifeCareEpisode: "生活介護・本人の様子", lifeCareHandover: "生活介護・家族への連絡",
    stTempIn: "短期入所・入所時体温", stTempOut: "短期入所・退所時体温",
    stPulseIn: "短期入所・入所時脈拍", stPulseOut: "短期入所・退所時脈拍",
    stSpo2In: "短期入所・入所時酸素飽和度", stSpo2Out: "短期入所・退所時酸素飽和度",
    stBpHighIn: "短期入所・入所時血圧（上）", stBpLowIn: "短期入所・入所時血圧（下）",
    stBpHighOut: "短期入所・退所時血圧（上）", stBpLowOut: "短期入所・退所時血圧（下）",
    stMealBreakfast: "短期入所・朝食", stMealLunch: "短期入所・昼食", stMealDinner: "短期入所・夕食",
    stWater: "短期入所・水分", stOralCare: "短期入所・口腔ケア", stMedication: "短期入所・服薬",
    stBath: "短期入所・入浴", stBathReason: "短期入所・入浴補足", stBowel: "短期入所・排便",
    stBowel1: "短期入所・便性状1", stBowel2: "短期入所・便性状2", stBowel3: "短期入所・便性状3",
    stNightState: "短期入所・夜間の様子", stDayActivity: "短期入所・日中の活動",
    stBelongingMemo: "短期入所・持ち物メモ", lastBathDate: "最終入浴日", lastBowelDate: "最終排便日",
    medRemain: "内服薬残り", nsSign: "看護確認", checkStaffIn: "入所時確認者", checkStaffOut: "退所時確認者"
};

function cellValue(value) {
    if (value === undefined || value === null) return "";
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "boolean") return value ? "はい" : "いいえ";
    if (Array.isArray(value)) return value.map(cellValue).join("、");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

export function createCsv(table) {
    const data = table.map(row => row.map(cellValue));
    return "\uFEFF" + Papa.unparse(data, {
        newline: "\r\n", quotes: true, escapeFormulae: /^[\s\uFEFF]*[=+\-@\t\r]/
    });
}

export function rosterTable(users, facility) {
    const rows = [...users].sort((first, second) => first.name.localeCompare(second.name, "ja"));
    return [
        ["施設ID", "施設名", "氏名", "生年月日", "利用サービス", "利用中", "写真・動画NG", "排泄記録表示", "LINE連携件数", "登録日時"],
        ...rows.map(user => [facility.id, facility.name, user.name, user.birthday,
            Array.isArray(user.services) ? user.services : [user.serviceType || "デイサービス"],
            user.active !== false, user.photoNg === true, user.needExcretion === true,
            Array.isArray(user.lineUserIds) ? user.lineUserIds.length : 0, user.registeredAt])
    ];
}

export function selectRecords(records, filters) {
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!filters.facilityId || !validDate(filters.startDate) || !validDate(filters.endDate) || filters.startDate > filters.endDate) {
        throw new Error("開始日と終了日を正しく指定してください。");
    }
    return records.filter(record => (!record.facilityId || record.facilityId === filters.facilityId) &&
        validDate(record.date) && record.date >= filters.startDate && record.date <= filters.endDate &&
        (!filters.userName || record.userName === filters.userName) &&
        (!filters.serviceType || (record.serviceType || "デイサービス") === filters.serviceType))
        .sort((first, second) => first.date.localeCompare(second.date) ||
            String(first.userName).localeCompare(String(second.userName), "ja") ||
            String(first.serviceType || "デイサービス").localeCompare(String(second.serviceType || "デイサービス"), "ja"));
}

export function recordsTable(records, facility) {
    const excluded = new Set(["facilityId", "userName", "date", "serviceType", "imageFiles", "videoFiles", "lineUserIds", "password", "token"]);
    const present = new Set(records.flatMap(record => Object.keys(record)).filter(key => !excluded.has(key)));
    const known = Object.keys(recordLabels).filter(key => present.has(key));
    const extra = [...present].filter(key => !Object.hasOwn(recordLabels, key)).sort();
    const keys = [...known, ...extra];
    const label = key => {
        if (Object.hasOwn(recordLabels, key)) return recordLabels[key];
        if (/^num_(in|out)_\d+$/.test(key)) return `持参品${key.split("_")[2]}・${key.includes("_in_") ? "入所時" : "退所時"}`;
        if (/^free_item_\d+$/.test(key)) return `追加持参品${key.split("_")[2]}・品名`;
        if (/^num_(in|out)_free\d+$/.test(key)) return `追加持参品${key.match(/\d+$/)[0]}・${key.includes("_in_") ? "入所時" : "退所時"}`;
        return `追加項目（${key}）`;
    };
    return [
        ["施設ID", "施設名", "日付", "氏名", "利用サービス", ...keys.map(label)],
        ...records.map(record => [facility.id, facility.name, record.date, record.userName,
            record.serviceType || "デイサービス", ...keys.map(key => record[key])])
    ];
}