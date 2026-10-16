const test = require("node:test");
const assert = require("node:assert/strict");
const {
    calculateInvoicePricing,
    normalizeOneTimeInvoiceAdjustment
} = require("./one-time-invoice-adjustment");

test("one-time adjustment is added before calculating tax", () => {
    assert.deepEqual(
        calculateInvoicePricing(5000, ["デイサービス", "生活介護"], {
            id: "field-change-1",
            description: "入力項目変更手数料",
            amount: 3000
        }),
        {
            additionalServiceCount: 1,
            additionalServiceSubtotal: 1000,
            subtotal: 9000,
            tax: 900,
            total: 9900,
            oneTimeAdjustment: {
                id: "field-change-1",
                description: "入力項目変更手数料",
                amount: 3000
            }
        }
    );
});

test("missing adjustment preserves existing invoice pricing", () => {
    assert.deepEqual(calculateInvoicePricing(5000, ["デイサービス"], null), {
        additionalServiceCount: 0,
        additionalServiceSubtotal: 0,
        subtotal: 5000,
        tax: 500,
        total: 5500,
        oneTimeAdjustment: null
    });
});

test("invalid adjustment values are rejected", () => {
    for (const value of [
        { id: "valid", description: "  ", amount: 100 },
        { id: "valid", description: "変更手数料", amount: 0 },
        { id: "valid", description: "変更手数料", amount: 1000001 },
        { id: "bad id", description: "変更手数料", amount: 100 }
    ]) {
        assert.throws(() => normalizeOneTimeInvoiceAdjustment(value), TypeError);
    }
});

test("LINE agency fee is a separate one-time item added with other adjustments before tax", () => {
    const fee = { id: "agency-1", description: "LINE連携設定代行手数料", amount: 3000 };
    const pricing = calculateInvoicePricing(5000, ["デイサービス", "生活介護"],
        { id: "manual-1", description: "帳票変更手数料", amount: 2000 }, fee);
    assert.equal(pricing.subtotal, 11000);
    assert.equal(pricing.tax, 1100);
    assert.equal(pricing.total, 12100);
    assert.deepEqual(pricing.lineAgencyFee, fee);
    assert.equal(pricing.oneTimeAdjustment.amount, 2000);
});
