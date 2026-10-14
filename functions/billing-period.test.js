const test = require("node:test");
const assert = require("node:assert/strict");

function getTokyoDateParts(date) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    });
    const parts = formatter.formatToParts(date);
    return {
        year: parts.find(part => part.type === "year")?.value || "",
        month: parts.find(part => part.type === "month")?.value || "",
        day: parts.find(part => part.type === "day")?.value || ""
    };
}

function dateKey(parts) {
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function addMonthsToAnchor(anchor, monthOffset) {
    const targetMonth = new Date(Date.UTC(Number(anchor.year), Number(anchor.month) - 1 + monthOffset, 1));
    const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
    return {
        year: String(targetMonth.getUTCFullYear()),
        month: String(targetMonth.getUTCMonth() + 1).padStart(2, "0"),
        day: String(Math.min(Number(anchor.day), lastDay)).padStart(2, "0")
    };
}

function getLatestMaturedBillingPeriod(createdAt, now, advanceDays = 10) {
    const registrationDate = createdAt && typeof createdAt.toDate === "function"
        ? createdAt.toDate()
        : new Date(createdAt);
    if (!Number.isFinite(registrationDate.getTime())) return null;

    const anchor = getTokyoDateParts(registrationDate);
    const todayKey = dateKey(getTokyoDateParts(now));
    let latestPeriod = null;
    for (let monthOffset = 1; monthOffset <= 1200; monthOffset++) {
        const startParts = addMonthsToAnchor(anchor, monthOffset - 1);
        const nextStartParts = addMonthsToAnchor(anchor, monthOffset);

        const startDateKey = dateKey(startParts);
        const sendTriggerDate = new Date(`${startDateKey}T00:00:00+09:00`);
        sendTriggerDate.setDate(sendTriggerDate.getDate() - advanceDays);
        const sendTriggerDateKey = dateKey(getTokyoDateParts(sendTriggerDate));

        if (sendTriggerDateKey > todayKey) break;

        const endDate = new Date(Date.UTC(Number(nextStartParts.year), Number(nextStartParts.month) - 1, Number(nextStartParts.day) - 1));
        const endParts = {
            year: String(endDate.getUTCFullYear()),
            month: String(endDate.getUTCMonth() + 1).padStart(2, "0"),
            day: String(endDate.getUTCDate()).padStart(2, "0")
        };
        latestPeriod = {
            startDate: startDateKey,
            endDate: dateKey(endParts)
        };
    }
    return latestPeriod;
}

test("monthly invoice triggers 10 days before next period start", () => {
    // 施設が10月13日に初回登録し、初回の1か月分が満了する日（次回利用開始日）が11月13日とする
    const billingAnchor = new Date("2026-11-13T00:00:00+09:00");

    // 11月2日（11日前）: まだ送信されない
    const nov2 = new Date("2026-11-02T09:00:00+09:00");
    const periodNov2 = getLatestMaturedBillingPeriod(billingAnchor, nov2, 10);
    assert.equal(periodNov2, null);

    // 11月3日（10日前）: 2回目の請求書がトリガーされる
    const nov3 = new Date("2026-11-03T09:00:00+09:00");
    const periodNov3 = getLatestMaturedBillingPeriod(billingAnchor, nov3, 10);
    assert.notEqual(periodNov3, null);
    assert.equal(periodNov3.startDate, "2026-11-13");
    assert.equal(periodNov3.endDate, "2026-12-12");

    // 11月13日当日: 同様に該当期間が取得される
    const nov13 = new Date("2026-11-13T09:00:00+09:00");
    const periodNov13 = getLatestMaturedBillingPeriod(billingAnchor, nov13, 10);
    assert.notEqual(periodNov13, null);
    assert.equal(periodNov13.startDate, "2026-11-13");
    assert.equal(periodNov13.endDate, "2026-12-12");

    // 12月2日（次々回12月13日の11日前）: まだ3回目はトリガーされず、2回目の期間が維持
    const dec2 = new Date("2026-12-02T09:00:00+09:00");
    const periodDec2 = getLatestMaturedBillingPeriod(billingAnchor, dec2, 10);
    assert.equal(periodDec2.startDate, "2026-11-13");

    // 12月3日（次々回12月13日の10日前）: 3回目の請求書がトリガーされる
    const dec3 = new Date("2026-12-03T09:00:00+09:00");
    const periodDec3 = getLatestMaturedBillingPeriod(billingAnchor, dec3, 10);
    assert.equal(periodDec3.startDate, "2026-12-13");
    assert.equal(periodDec3.endDate, "2027-01-12");
});
