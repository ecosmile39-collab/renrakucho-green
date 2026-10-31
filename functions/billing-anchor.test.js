const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// index.js から請求期間の計算に使う関数だけを取り出して試す
const source = readFileSync(path.join(__dirname, "index.js"), "utf8");
function extract(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} が見つかりません`);
    let depth = 0;
    for (let i = source.indexOf("{", start); i < source.length; i++) {
        if (source[i] === "{") depth++;
        if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`${name} の終わりが見つかりません`);
}
const sandbox = {};
vm.runInNewContext(
    ["getTokyoDateParts", "dateKey", "addMonthsToAnchor", "getLatestMaturedBillingPeriod", "getNextBillingAnchorAt"]
        .map(extract).join("\n") + "\nthis.f = { getLatestMaturedBillingPeriod, getNextBillingAnchorAt };",
    sandbox
);
const { getLatestMaturedBillingPeriod, getNextBillingAnchorAt } = sandbox.f;
const at = text => new Date(`${text}+09:00`);

test("switching to paid use on 10/16 starts monthly billing from the second month", () => {
    const anchor = getNextBillingAnchorAt(at("2026-10-16T14:00:00"));
    assert.equal(anchor, new Date("2026-11-16T00:00:00+09:00").toISOString());
    // 切り替えの翌朝や10/31には、途中の期間（10/16〜）の請求書を出さない
    assert.equal(getLatestMaturedBillingPeriod(anchor, at("2026-10-17T09:00:00")), null);
    assert.equal(getLatestMaturedBillingPeriod(anchor, at("2026-10-31T09:00:00")), null);
    // 2か月目（11/16〜12/15）の請求書は、始まる10日前の 11/6 に出す
    assert.equal(getLatestMaturedBillingPeriod(anchor, at("2026-11-05T09:00:00")), null);
    assert.deepEqual({ ...getLatestMaturedBillingPeriod(anchor, at("2026-11-06T09:00:00")) }, { startDate: "2026-11-16", endDate: "2026-12-15" });
    // 3か月目は 12/6 から
    assert.deepEqual({ ...getLatestMaturedBillingPeriod(anchor, at("2026-12-06T09:00:00")) }, { startDate: "2026-12-16", endDate: "2027-01-15" });
});

test("without the fix, an anchor on the switch day would bill the period already in use", () => {
    assert.deepEqual({ ...getLatestMaturedBillingPeriod(at("2026-10-16T14:00:00").toISOString(), at("2026-10-31T09:00:00")) },
        { startDate: "2026-10-16", endDate: "2026-11-15" });
});

test("activation and the admin first invoice both set the anchor to the second month", () => {
    const activate = source.slice(source.indexOf("exports.activateFacilitySubscription"), source.indexOf("exports.setFacilityUsageLock"));
    assert.match(activate, /facility\.billingAnchorAt \? \{\} : \{ billingAnchorAt: getNextBillingAnchorAt\(activatedAt\) \}/);
    const issue = source.slice(source.indexOf("exports.issueFacilityInvoiceForAdmin"), source.indexOf("exports.sendTestInvoiceEmail"));
    assert.match(issue, /billingAnchorAt: currentFacility\.billingAnchorAt \|\| nextBillingAnchorAt/);
    assert.ok(!issue.includes("`${billingPeriodStart}T00:00:00+09:00`"));
});
