const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseLpInquiry } = require("./lp-inquiry");

test("an LP form submission is reduced to facility name, contact name and kind", () => {
    assert.deepEqual(parseLpInquiry(JSON.stringify({ facility: " あまみやホーム ", name: "山田", kind: "無料トライアル", email: "x@example.com" })),
        { facilityName: "あまみやホーム", contactName: "山田", kind: "無料トライアル" });
    assert.deepEqual(parseLpInquiry({ facility: "みどり苑", kind: "よく分からない" }),
        { facilityName: "みどり苑", contactName: "", kind: "お問い合わせ" });
});

test("broken, empty or robot submissions are ignored", () => {
    assert.equal(parseLpInquiry("{not json"), null);
    assert.equal(parseLpInquiry({ facility: "   " }), null);
    assert.equal(parseLpInquiry({ facility: "施設", website: "spam" }), null);
    assert.equal(parseLpInquiry(null), null);
    assert.equal(parseLpInquiry({ facility: "a".repeat(300) }).facilityName.length, 100);
    assert.equal(parseLpInquiry({ facility: "改行\nあり" }).facilityName, "改行 あり");
});
