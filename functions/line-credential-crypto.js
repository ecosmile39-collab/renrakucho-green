"use strict";

const crypto = require("crypto");

function getKey(keyBase64) {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) throw new Error("Encryption key must decode to 32 bytes.");
    return key;
}

function encryptCredentials(credentials, keyBase64, facilityId) {
    if (typeof facilityId !== "string" || !facilityId) throw new Error("Facility ID is required.");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getKey(keyBase64), iv);
    cipher.setAAD(Buffer.from(facilityId, "utf8"));
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(credentials), "utf8"),
        cipher.final()
    ]);
    return {
        version: 1,
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
    };
}

function decryptCredentials(encrypted, keyBase64, facilityId) {
    if (encrypted?.version !== 1) throw new Error("Unsupported encrypted credential format.");
    if (typeof facilityId !== "string" || !facilityId) throw new Error("Facility ID is required.");
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        getKey(keyBase64),
        Buffer.from(encrypted.iv, "base64")
    );
    decipher.setAAD(Buffer.from(facilityId, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final()
    ]).toString("utf8");
    return JSON.parse(plaintext);
}

module.exports = { encryptCredentials, decryptCredentials };