const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validateFacilityServiceTypes } = require("./service-types");

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