import assert from "node:assert/strict";
import { test } from "node:test";
import { removeUndefinedFields } from "./firestore-data.js";

test("removeUndefinedFields omits undefined object properties recursively", () => {
    assert.deepEqual(removeUndefinedFields({
        kept: "value",
        omitted: undefined,
        nested: { alsoOmitted: undefined, kept: true }
    }), {
        kept: "value",
        nested: { kept: true }
    });
});

test("removeUndefinedFields preserves array positions by replacing undefined items with null", () => {
    assert.deepEqual(removeUndefinedFields({
        items: [undefined, { omitted: undefined, kept: "value" }]
    }), {
        items: [null, { kept: "value" }]
    });
});
