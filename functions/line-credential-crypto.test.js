"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { decryptCredentials, encryptCredentials } = require("./line-credential-crypto");

test("facility LINE credentials round-trip without storing plaintext", () => {
    const key = crypto.randomBytes(32).toString("base64");
    const credentials = {
        channelAccessToken: "test-access-token",
        channelSecret: "0123456789abcdef0123456789abcdef"
    };
    const facilityId = "facility-1";

    const encrypted = encryptCredentials(credentials, key, facilityId);

    assert.deepEqual(decryptCredentials(encrypted, key, facilityId), credentials);
    assert.equal(JSON.stringify(encrypted).includes(credentials.channelAccessToken), false);
    assert.equal(JSON.stringify(encrypted).includes(credentials.channelSecret), false);
    assert.throws(() => decryptCredentials(encrypted, key, "facility-2"));
});

test("tampered facility LINE credentials are rejected", () => {
    const key = crypto.randomBytes(32).toString("base64");
    const encrypted = encryptCredentials({ channelSecret: "0123456789abcdef0123456789abcdef" }, key, "facility-1");
    encrypted.ciphertext = Buffer.from(encrypted.ciphertext, "base64").map(byte => byte ^ 1).toString("base64");

    assert.throws(() => decryptCredentials(encrypted, key, "facility-1"));
});