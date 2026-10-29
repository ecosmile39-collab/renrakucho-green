// 誕生日カードのデザイン（入力画面で選び、印刷画面でそのデザインのカードを出す）
export const BIRTHDAY_CARD_DESIGNS = [
    { value: "vertical1", label: "縦型1（鶴亀と松竹梅）", image: "bg_birthday.jpg" },
    { value: "vertical2", label: "縦型2（ピンクの花柄）", image: "bg_birthday_v2.jpg" },
    { value: "vertical3", label: "縦型3（どうぶつフレーム）", image: "functions/b1.png" },
    { value: "horizontal1", label: "横型1（鶴亀と松竹梅）", image: "bg_birthday_h_2.jpg" },
    { value: "horizontal2", label: "横型2（ピンクの花柄）", image: "bg_birthday_h_1.jpg" },
    { value: "horizontal3", label: "横型3（折り紙の花・緑）", image: "functions/B2.png" },
    { value: "horizontal4", label: "横型4（折り紙の花・赤）", image: "functions/B3.png" },
    { value: "vertical4", label: "縦型4（パステルの花・写真3枚）", image: "https://renrakucyou.ecosmile.xyz/lp/wp-content/uploads/2026/10/ecs-card-base-pastel-2k-scaled.jpg", photoCount: 3 },
    { value: "vertical5", label: "縦型5（和風の桜と梅・写真3枚）", image: "https://renrakucyou.ecosmile.xyz/lp/wp-content/uploads/2026/10/ecs-card-base-wafu-2k-scaled.jpg", photoCount: 3 }
];

export function isValidCardDesign(value) {
    return BIRTHDAY_CARD_DESIGNS.some(design => design.value === value);
}

export function cardDesignFor(value) {
    return BIRTHDAY_CARD_DESIGNS.find(design => design.value === value) || BIRTHDAY_CARD_DESIGNS[0];
}

const isLeapYear = year => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

// 誕生日（YYYY-MM-DD）が、その日（YYYY-MM-DD）かどうか。2月29日生まれは、うるう年でない年は2月28日をお誕生日とする
export function isBirthdayOn(birthday, dateStr) {
    const birth = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthday || ""));
    const target = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!birth || !target) return false;
    let [month, day] = [birth[2], birth[3]];
    if (month === "02" && day === "29" && !isLeapYear(Number(target[1]))) day = "28";
    return month === target[2] && day === target[3];
}

// お誕生日の前後の何日以内に、カードのデザインを選べるようにするか
export const BIRTHDAY_WINDOW_DAYS = 3;

// 記録の日付が、いちばん近いお誕生日から何日ずれているか（前はマイナス、後はプラス）。
// 前後 windowDays 日以内なら { offset, birthdayDate: "YYYY-MM-DD", age } を返し、範囲外なら null
export function birthdayWindow(birthday, dateStr, windowDays = BIRTHDAY_WINDOW_DAYS) {
    const birth = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthday || ""));
    const target = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!birth || !target) return null;
    const targetTime = Date.UTC(Number(target[1]), Number(target[2]) - 1, Number(target[3]));
    const targetYear = Number(target[1]);
    for (const year of [targetYear, targetYear - 1, targetYear + 1]) {
        let day = Number(birth[3]);
        if (birth[2] === "02" && day === 29 && !isLeapYear(year)) day = 28;
        const birthdayTime = Date.UTC(year, Number(birth[2]) - 1, day);
        const offset = Math.round((targetTime - birthdayTime) / 86400000);
        if (Math.abs(offset) <= windowDays) {
            const birthdayDate = `${year}-${birth[2]}-${String(day).padStart(2, "0")}`;
            return { offset, birthdayDate, age: year - Number(birth[1]) };
        }
    }
    return null;
}

export function ageOn(birthday, dateStr) {
    const birth = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthday || ""));
    const target = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
    if (!birth || !target) return null;
    let age = Number(target[1]) - Number(birth[1]);
    if (!isBirthdayOn(birthday, dateStr) && `${target[2]}${target[3]}` < `${birth[2]}${birth[3]}`) age--;
    return age;
}

// 期間内の記録のうち、いちばん新しい日に入力画面で選ばれたデザイン（なければ空）
export function chosenCardDesign(records) {
    const chosen = (records || [])
        .filter(record => isValidCardDesign(record?.birthdayCardDesign))
        .sort((first, second) => String(second.date || "").localeCompare(String(first.date || "")));
    return chosen.length ? chosen[0].birthdayCardDesign : "";
}
