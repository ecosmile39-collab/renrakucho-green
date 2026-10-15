import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ALL_SERVICE_TYPE_VALUES,
    calculateServicePricing,
    isShortStayService,
    normalizeBillingServiceTypes,
    normalizeServiceTypes,
    populateServiceTypeSelect
} from "./service-types.js";

test("unconfigured facilities retain all service types", () => {
    assert.deepEqual(normalizeServiceTypes(undefined), ALL_SERVICE_TYPE_VALUES);
});

test("facility service settings keep only supported values without duplicates", () => {
    assert.deepEqual(
        normalizeServiceTypes(["生活介護", "無効なサービス", "デイサービス", "生活介護"]),
        ["デイサービス", "生活介護"]
    );
});

test("empty or invalid settings fall back to all services", () => {
    assert.deepEqual(normalizeServiceTypes([]), ALL_SERVICE_TYPE_VALUES);
    assert.deepEqual(normalizeServiceTypes(["未対応"]), ALL_SERVICE_TYPE_VALUES);
});

test("short-stay, residential and unit-residential services share short-stay handling", () => {
    assert.equal(isShortStayService("ショートステイ"), true);
    assert.equal(isShortStayService("入所"), true);
    assert.equal(isShortStayService("ユニット入所"), true);
    assert.equal(isShortStayService("デイサービス"), false);
});

test("billing services default to one enabled service to preserve current invoice amounts", () => {
    assert.deepEqual(normalizeBillingServiceTypes(undefined), ["デイサービス"]);
    assert.deepEqual(normalizeBillingServiceTypes(undefined, ["生活介護", "ショートステイ"]), ["ショートステイ"]);
});

test("billing service selections are canonical and unique", () => {
    assert.deepEqual(
        normalizeBillingServiceTypes(["生活介護", "ショートステイ", "無効"], ["ショートステイ", "デイサービス"]),
        ["ショートステイ", "生活介護"]
    );
    assert.deepEqual(normalizeBillingServiceTypes([], ["生活介護"]), ["生活介護"]);
});

test("each selected service after the first adds 1,000 yen before the existing tax calculation", () => {
    assert.deepEqual(calculateServicePricing(5000, ["デイサービス"]), {
        additionalServiceCount: 0, additionalServiceSubtotal: 0, subtotal: 5000, tax: 500, total: 5500
    });
    assert.deepEqual(calculateServicePricing(5000, ["デイサービス", "生活介護"]), {
        additionalServiceCount: 1, additionalServiceSubtotal: 1000, subtotal: 6000, tax: 600, total: 6600
    });
    assert.deepEqual(calculateServicePricing(4000, ["デイサービス", "生活介護", "児童発達支援"]), {
        additionalServiceCount: 2, additionalServiceSubtotal: 2000, subtotal: 6000, tax: 600, total: 6600
    });
});

test("service dropdowns contain only enabled types and replace a disabled selection", () => {
    const originalDocument = globalThis.document;
    globalThis.document = { createElement: () => ({}) };
    const select = {
        value: "生活介護",
        options: [],
        replaceChildren(...options) { this.options = options; }
    };
    try {
        const selected = populateServiceTypeSelect(select, ["デイサービス", "児童発達支援"], "生活介護");
        assert.equal(selected, "デイサービス");
        assert.deepEqual(select.options.map(option => option.value), ["デイサービス", "児童発達支援"]);
    } finally {
        if (originalDocument === undefined) delete globalThis.document;
        else globalThis.document = originalDocument;
    }
});