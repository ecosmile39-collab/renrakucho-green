const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    calculateServicePricing,
    getFacilityBillingServiceTypes,
    validateFacilityServiceTypes
} = require("./service-types");

test("facility service selection accepts supported services in canonical order", () => {
    assert.deepEqual(
        validateFacilityServiceTypes(["生活介護", "デイサービス"]),
        ["デイサービス", "生活介護"]
    );
});

test("facility service selection rejects empty, unsupported, and duplicate values", () => {
    assert.equal(validateFacilityServiceTypes([]), null);
    assert.equal(validateFacilityServiceTypes(["不明なサービス"]), null);
    assert.equal(validateFacilityServiceTypes(["デイサービス", "デイサービス"]), null);
});

test("billing service selection defaults to one enabled service to preserve existing pricing", () => {
    assert.deepEqual(getFacilityBillingServiceTypes({}), ["デイサービス"]);
    assert.deepEqual(
        getFacilityBillingServiceTypes({ enabledServiceTypes: ["生活介護", "ショートステイ"] }),
        ["ショートステイ"]
    );
});

test("billing service selection ignores invalid values but remains independent of input visibility", () => {
    assert.deepEqual(
        getFacilityBillingServiceTypes({
            enabledServiceTypes: ["ショートステイ", "デイサービス"],
            billingServiceTypes: ["生活介護", "ショートステイ", "無効"]
        }),
        ["ショートステイ", "生活介護"]
    );
    assert.deepEqual(
        getFacilityBillingServiceTypes({ enabledServiceTypes: ["生活介護"], billingServiceTypes: [] }),
        ["生活介護"]
    );
});

test("additional service fees follow the current invoice's tax calculation", () => {
    assert.deepEqual(calculateServicePricing(4000, ["デイサービス"]), {
        additionalServiceCount: 0, additionalServiceSubtotal: 0, subtotal: 4000, tax: 400, total: 4400
    });
    assert.deepEqual(calculateServicePricing(5000, ["デイサービス", "生活介護", "児童発達支援"]), {
        additionalServiceCount: 2, additionalServiceSubtotal: 2000, subtotal: 7000, tax: 700, total: 7700
    });
});