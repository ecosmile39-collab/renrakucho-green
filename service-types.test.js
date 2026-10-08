import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_SERVICE_TYPE_VALUES, normalizeServiceTypes, populateServiceTypeSelect } from "./service-types.js";

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