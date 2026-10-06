const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("crypto");
const { readFileSync } = require("fs");
const path = require("path");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const nodemailer = require("nodemailer");
const { GoogleAuth } = require("google-auth-library");
const { decryptCredentials, encryptCredentials } = require("./line-credential-crypto");

initializeApp();

const VIDEO_RETENTION_MS = 72 * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 50;
const INVOICE_TEST_RECIPIENT = "ecosmile39@gmail.com";
const FIRESTORE_BACKUP_PROJECT_ID = "renrakucho-app-6b157";
const FIRESTORE_BACKUP_BUCKET = "renrakucho-firestore-backups-astral-bazaar-510707-c6";
const FIRESTORE_BACKUP_SERVICE_ACCOUNT = "firestore-daily-exporter@renrakucho-app-6b157.iam.gserviceaccount.com";
const INVOICE_GMAIL_USER = defineSecret("INVOICE_GMAIL_USER");
const INVOICE_GMAIL_APP_PASSWORD = defineSecret("INVOICE_GMAIL_APP_PASSWORD");
const ADMIN_CONTROL_KEY = defineSecret("ADMIN_CONTROL_KEY");
const FACILITY_REGISTRATION_KEY = defineSecret("FACILITY_REGISTRATION_KEY");
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const LINE_CHANNEL_SECRET = defineSecret("LINE_CHANNEL_SECRET");
const FACILITY_LINE_ENCRYPTION_KEY = defineSecret("FACILITY_LINE_ENCRYPTION_KEY");
const CURRENT_TERMS_VERSION = "2026-10-06-v1";
const LINE_RECORD_BASE_URL = "https://renrakucho-green.vercel.app/line-record.html";
const LINE_WEBHOOK_BASE_URL = "https://us-central1-renrakucho-app-6b157.cloudfunctions.net/facilityLineMessagingWebhook";
const companyStampPng = readFileSync(path.join(__dirname, "company_stamp.png"));
const companyStampDataUrl = `data:image/png;base64,${companyStampPng.toString("base64")}`;

function escapeHtml(value) {
    return String(value || "").replace(/[&<>\"']/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[character]));
}

exports.createFacilitySession = onCall(async request => {
    const facilityName = typeof request.data?.facilityName === "string" ? request.data.facilityName.trim() : "";
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    if (!facilityName || !password || facilityName.length > 200 || password.length > 200) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }

    const facilities = getFirestore().collection("facilities");
    const matches = await facilities.where("facilityName", "==", facilityName).limit(2).get();
    let facility = matches.docs.length === 1 ? matches.docs[0] : null;
    if (matches.empty) {
        const legacyFacility = await facilities.doc(facilityName).get();
        if (legacyFacility.exists && (!legacyFacility.data().facilityName || legacyFacility.data().facilityName === facilityName)) {
            facility = legacyFacility;
        }
    }

    if (!facility || matches.size > 1) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    const data = facility.data();
    if (data.password !== password) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    if (data.status === "locked") {
        throw new HttpsError("permission-denied", "システムが利用停止中です。管理者にお問い合わせください。");
    }
    if (data.subscriptionStatus === "trial") {
        const trialEndsAt = Date.parse(data.trialEndsAt || "");
        if (!Number.isFinite(trialEndsAt) || Date.now() >= trialEndsAt) {
            throw new HttpsError("permission-denied", "無料お試し期間が終了しました。利用を続ける場合は販売元へお問い合わせください。");
        }
    }

    return {
        facilityId: facility.id,
        facilityName: data.facilityName || facility.id,
        customToken: await getAuth().createCustomToken(facility.id, { role: "facility" })
    };
});

exports.createFacilityDeletionSession = onCall(async request => {
    const facilityName = typeof request.data?.facilityName === "string" ? request.data.facilityName.trim() : "";
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    if (!facilityName || !password || facilityName.length > 200 || password.length > 200) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    const facilities = getFirestore().collection("facilities");
    const matches = await facilities.where("facilityName", "==", facilityName).limit(2).get();
    let facility = matches.docs.length === 1 ? matches.docs[0] : null;
    if (matches.empty) {
        const legacyFacility = await facilities.doc(facilityName).get();
        if (legacyFacility.exists && (!legacyFacility.data().facilityName || legacyFacility.data().facilityName === facilityName)) {
            facility = legacyFacility;
        }
    }
    if (!facility || matches.size > 1 || facility.data().password !== password) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    if (facility.data().status === "locked") {
        throw new HttpsError("permission-denied", "利用停止中の施設はこの画面から退会できません。管理者へお問い合わせください。");
    }
    return {
        facilityId: facility.id,
        facilityName: facility.data().facilityName || facility.id,
        customToken: await getAuth().createCustomToken(facility.id, { role: "facility-delete" })
    };
});

function secretsMatch(supplied, expected) {
    if (typeof supplied !== "string" || !supplied || typeof expected !== "string" || !expected) return false;
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    return suppliedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function encryptFacilityLineCredentials(facilityId, credentials) {
    return encryptCredentials(credentials, FACILITY_LINE_ENCRYPTION_KEY.value(), facilityId);
}

function decryptFacilityLineCredentials(facilityId, encrypted) {
    return decryptCredentials(encrypted, FACILITY_LINE_ENCRYPTION_KEY.value(), facilityId);
}

async function getFacilityLineCredentials(facilityId) {
    const snapshot = await getFirestore().collection("facilityLineSettings").doc(facilityId).get();
    return snapshot.exists ? decryptFacilityLineCredentials(facilityId, snapshot.data().encryptedCredentials) : null;
}

exports.createAdminSession = onCall({ secrets: [ADMIN_CONTROL_KEY] }, async request => {
    if (!secretsMatch(request.data?.adminKey, ADMIN_CONTROL_KEY.value())) {
        throw new HttpsError("unauthenticated", "管理者キーが正しくありません。");
    }
    return {
        customToken: await getAuth().createCustomToken("admin-control-panel", { role: "admin" })
    };
});

exports.prepareLegacyStorageOwnership = onCall(async request => {
    if (request.auth?.token.role !== "admin") {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const db = getFirestore();
    const facilities = await db.collection("facilities").get();
    const usersByName = new Map();
    const userSnapshots = await Promise.all(facilities.docs.map(facility => facility.ref.collection("users").get()));
    userSnapshots.forEach((snapshot, index) => {
        snapshot.docs.forEach(user => {
            const owners = usersByName.get(user.id) || [];
            owners.push({ facilityId: facilities.docs[index].id, ref: user.ref, data: user.data() });
            usersByName.set(user.id, owners);
        });
    });

    let batch = db.batch();
    let batchWrites = 0;
    let uniqueOwners = 0;
    let ambiguousNames = 0;
    for (const owners of usersByName.values()) {
        if (owners.length === 1) {
            const owner = owners[0];
            if (owner.data.legacyStorageOwnerFacilityId !== owner.facilityId) {
                batch.set(owner.ref, { legacyStorageOwnerFacilityId: owner.facilityId }, { merge: true });
                batchWrites++;
            }
            uniqueOwners++;
        } else {
            ambiguousNames++;
            owners.forEach(owner => {
                if (owner.data.legacyStorageOwnerFacilityId) {
                    batch.update(owner.ref, { legacyStorageOwnerFacilityId: FieldValue.delete() });
                    batchWrites++;
                }
            });
        }
        if (batchWrites >= 400) {
            await batch.commit();
            batch = db.batch();
            batchWrites = 0;
        }
    }
    if (batchWrites) await batch.commit();
    return { facilities: facilities.size, uniqueOwners, ambiguousNames };
});

exports.registerTrialFacility = onCall({ secrets: [FACILITY_REGISTRATION_KEY] }, async request => {
    const registrationKey = request.data?.registrationKey;
    const acceptedTermsVersion = request.data?.acceptedTermsVersion;
    const facilityName = typeof request.data?.facilityName === "string" ? request.data.facilityName.trim() : "";
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    const email = typeof request.data?.email === "string" ? request.data.email.trim() : "";
    const phone = typeof request.data?.phone === "string" ? request.data.phone.trim() : "";
    if (!secretsMatch(registrationKey, FACILITY_REGISTRATION_KEY.value())) {
        throw new HttpsError("permission-denied", "秘密の合言葉が違います。");
    }
    if (acceptedTermsVersion !== CURRENT_TERMS_VERSION) {
        throw new HttpsError("failed-precondition", "最新の利用規約を確認し、同意してから登録してください。");
    }
    if (!facilityName || facilityName.length > 200 || password.length < 6 || password.length > 200 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpsError("invalid-argument", "施設名、6文字以上のパスワード、連絡先メールを確認してください。");
    }

    const db = getFirestore();
    const matches = await db.collection("facilities").where("facilityName", "==", facilityName).limit(2).get();
    const legacyFacility = await db.collection("facilities").doc(facilityName).get();
    if (!matches.empty || legacyFacility.exists) {
        throw new HttpsError("already-exists", "その施設名は既に使用されています。");
    }
    const trialStartedAt = new Date();
    const trialEndsAt = new Date(trialStartedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    const facilityRef = await db.collection("facilities").add({
        facilityName,
        password,
        email,
        phone: phone || "未登録",
        status: "active",
        createdAt: trialStartedAt.toISOString(),
        subscriptionStatus: "trial",
        trialStartedAt: trialStartedAt.toISOString(),
        trialEndsAt: trialEndsAt.toISOString(),
        acceptedTermsVersion: CURRENT_TERMS_VERSION,
        termsAcceptedAt: new Date().toISOString()
    });
    return {
        facilityId: facilityRef.id,
        facilityName,
        trialEndsAt: trialEndsAt.toISOString(),
        customToken: await getAuth().createCustomToken(facilityRef.id, { role: "facility" })
    };
});

exports.changeFacilityPassword = onCall(async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    const currentPassword = typeof request.data?.currentPassword === "string" ? request.data.currentPassword : "";
    const newPassword = typeof request.data?.newPassword === "string" ? request.data.newPassword : "";
    const facilityRef = getFirestore().collection("facilities").doc(facilityId);
    const facilitySnapshot = await facilityRef.get();
    if (!currentPassword || facilitySnapshot.data().password !== currentPassword) {
        throw new HttpsError("unauthenticated", "現在のパスワードが違います。");
    }
    if (newPassword.length < 6 || newPassword.length > 200) {
        throw new HttpsError("invalid-argument", "新しいパスワードは6文字以上で入力してください。");
    }
    await facilityRef.update({ password: newPassword });
    return { success: true };
});

exports.renameFacility = onCall(async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    const currentPassword = typeof request.data?.currentPassword === "string" ? request.data.currentPassword : "";
    const newFacilityName = typeof request.data?.newFacilityName === "string" ? request.data.newFacilityName.trim() : "";
    if (!newFacilityName || newFacilityName.length > 200) {
        throw new HttpsError("invalid-argument", "新しい施設名を確認してください。");
    }

    const db = getFirestore();
    const facilityRef = db.collection("facilities").doc(facilityId);
    const facilitySnapshot = await facilityRef.get();
    if (!facilitySnapshot.exists || facilitySnapshot.data().password !== currentPassword) {
        throw new HttpsError("unauthenticated", "現在のパスワードが違います。");
    }
    const nameMatches = await db.collection("facilities").where("facilityName", "==", newFacilityName).limit(2).get();
    if (nameMatches.docs.some(match => match.id !== facilityId)) {
        throw new HttpsError("already-exists", "その施設名は既に使用されています。");
    }
    const legacyFacility = await db.collection("facilities").doc(newFacilityName).get();
    if (legacyFacility.exists && legacyFacility.id !== facilityId && !legacyFacility.data().facilityName) {
        throw new HttpsError("already-exists", "その施設名は既に使用されています。");
    }
    await facilityRef.update({ facilityName: newFacilityName });
    return { facilityName: newFacilityName };
});

async function buildFacilityDeletionPlan(facilityId) {
    const db = getFirestore();
    const facilityRef = db.collection("facilities").doc(facilityId);
    const [facilitySnapshot, usersSnapshot, recordsSnapshot, allFacilitiesSnapshot, invoiceHistorySnapshot] = await Promise.all([
        facilityRef.get(),
        facilityRef.collection("users").get(),
        facilityRef.collection("daily_records").get(),
        db.collection("facilities").get(),
        facilityRef.collection("invoiceHistory").get()
    ]);
    if (!facilitySnapshot.exists) throw new HttpsError("not-found", "施設情報が見つかりません。");

    const otherFacilityUserNames = new Set();
    for (const otherFacility of allFacilitiesSnapshot.docs) {
        if (otherFacility.id === facilityId) continue;
        const otherUsers = await otherFacility.ref.collection("users").get();
        otherUsers.forEach(user => otherFacilityUserNames.add(user.id));
    }

    const ambiguousLegacyNames = usersSnapshot.docs
        .map(user => user.id)
        .filter(userName => otherFacilityUserNames.has(userName));
    const bucket = getStorage().bucket();
    const listFiles = async prefix => {
        const [files] = await bucket.getFiles({ prefix });
        return files;
    };
    const scopedFiles = (await Promise.all([
        listFiles(`images/${facilityId}/`),
        listFiles(`videos/${facilityId}/`),
        listFiles(`faces/${facilityId}/`)
    ])).flat();
    const legacyFiles = [];
    for (const user of usersSnapshot.docs) {
        if (otherFacilityUserNames.has(user.id)) continue;
        const userFiles = await Promise.all([
            listFiles(`images/${user.id}/`),
            listFiles(`videos/${user.id}/`),
            listFiles(`faces/${user.id}/`)
        ]);
        legacyFiles.push(...userFiles.flat());
    }

    return {
        facility: facilitySnapshot.data(),
        usersSnapshot,
        recordsSnapshot,
        invoiceHistorySnapshot,
        scopedFiles,
        legacyFiles,
        ambiguousLegacyNames,
        counts: {
            users: usersSnapshot.size,
            records: recordsSnapshot.size,
            invoiceHistory: invoiceHistorySnapshot.size,
            scopedStorageFiles: scopedFiles.length,
            legacyStorageFiles: legacyFiles.length,
            ambiguousLegacyUsers: ambiguousLegacyNames.length
        }
    };
}

function requireFacilityDeletionId(request) {
    const facilityId = request.auth?.uid;
    if (!facilityId || request.auth.token.role !== "facility-delete") {
        throw new HttpsError("unauthenticated", "退会処理の施設認証を確認できません。");
    }
    return facilityId;
}

exports.previewFacilityDeletion = onCall(async request => {
    const facilityId = requireFacilityDeletionId(request);
    const facilitySnapshot = await getFirestore().collection("facilities").doc(facilityId).get();
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    if (!facilitySnapshot.exists || facilitySnapshot.data().status === "locked" || !password || facilitySnapshot.data().password !== password) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    const plan = await buildFacilityDeletionPlan(facilityId);
    return {
        facilityId,
        facilityName: plan.facility.facilityName || facilityId,
        ...plan.counts
    };
});

async function deleteFirestoreDocuments(documents) {
    const db = getFirestore();
    for (let offset = 0; offset < documents.length; offset += 400) {
        const batch = db.batch();
        documents.slice(offset, offset + 400).forEach(document => batch.delete(document.ref));
        await batch.commit();
    }
}

exports.deleteFacilityAccount = onCall(async request => {
    const facilityId = requireFacilityDeletionId(request);
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    const confirmedFacilityName = typeof request.data?.confirmedFacilityName === "string" ? request.data.confirmedFacilityName.trim() : "";
    const facilityRef = getFirestore().collection("facilities").doc(facilityId);
    const facilitySnapshot = await facilityRef.get();
    if (!facilitySnapshot.exists || facilitySnapshot.data().status === "locked" || !password || facilitySnapshot.data().password !== password) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    const facilityName = facilitySnapshot.data().facilityName || facilityId;
    if (confirmedFacilityName !== facilityName) {
        throw new HttpsError("failed-precondition", "最終確認の施設名が一致しません。");
    }

    const plan = await buildFacilityDeletionPlan(facilityId);
    if (plan.ambiguousLegacyNames.length) {
        throw new HttpsError("failed-precondition", `他施設と共有の可能性がある旧ファイルがあるため中止しました（該当利用者${plan.ambiguousLegacyNames.length}名）。管理者へお問い合わせください。`);
    }

    const db = getFirestore();
    const cancellationRef = db.collection("facilityCancellations").doc(facilityId);
    const counts = plan.counts;
    await cancellationRef.set({
        facilityId,
        facilityName,
        status: "processing",
        requestedAt: new Date().toISOString(),
        usersCount: counts.users,
        recordsCount: counts.records,
        storageFilesCount: counts.scopedStorageFiles + counts.legacyStorageFiles
    });

    const storageResults = await Promise.allSettled([...plan.scopedFiles, ...plan.legacyFiles]
        .map(file => file.delete({ ignoreNotFound: true })));
    const storageFailures = storageResults.filter(result => result.status === "rejected");
    if (storageFailures.length) {
        await cancellationRef.set({
            status: "failed",
            errorMessage: `${storageFailures.length}個のStorageファイルを削除できませんでした。`,
            updatedAt: new Date().toISOString()
        }, { merge: true });
        throw new HttpsError("unavailable", `${storageFailures.length}個のStorageファイルを削除できませんでした。Firestoreデータは残しています。`);
    }

    try {
        const [pairingCodes, recordLinks] = await Promise.all([
            db.collection("linePairingCodes").where("facilityId", "==", facilityId).get(),
            db.collection("lineRecordLinks").where("facilityId", "==", facilityId).get()
        ]);
        await Promise.all([
            deleteFirestoreDocuments(plan.recordsSnapshot.docs),
            deleteFirestoreDocuments(plan.usersSnapshot.docs),
            deleteFirestoreDocuments(plan.invoiceHistorySnapshot.docs),
            deleteFirestoreDocuments(pairingCodes.docs),
            deleteFirestoreDocuments(recordLinks.docs),
            db.collection("facilityLineSettings").doc(facilityId).delete()
        ]);
        await facilityRef.delete();
        await cancellationRef.set({ status: "completed", completedAt: new Date().toISOString() }, { merge: true });
    } catch (error) {
        await cancellationRef.set({
            status: "failed",
            errorMessage: String(error.message || error).slice(0, 500),
            updatedAt: new Date().toISOString()
        }, { merge: true });
        throw new HttpsError("internal", "データ削除を完了できませんでした。管理者へお問い合わせください。");
    }

    return { facilityName, ...counts, deletedStorageFiles: storageResults.length };
});

function requireFacilityId(request) {
    const facilityId = request.auth?.uid;
    if (!facilityId || request.auth.token.role !== "facility") {
        throw new HttpsError("unauthenticated", "施設ログインを確認できません。ログインし直してください。");
    }
    return facilityId;
}

async function verifyFacilityIsActive(facilityId) {
    const facilitySnapshot = await getFirestore().collection("facilities").doc(facilityId).get();
    if (!facilitySnapshot.exists || facilitySnapshot.data().status === "locked") {
        throw new HttpsError("permission-denied", "この施設は現在利用できません。");
    }
    const facility = facilitySnapshot.data();
    if (facility.subscriptionStatus === "trial") {
        const trialEndsAt = Date.parse(facility.trialEndsAt || "");
        if (!Number.isFinite(trialEndsAt) || Date.now() >= trialEndsAt) {
            throw new HttpsError("permission-denied", "無料お試し期間が終了しています。");
        }
    }
}

function hashLineCode(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

exports.createLinePairingCode = onCall(async request => {
    const facilityId = requireFacilityId(request);
    const userName = typeof request.data?.userName === "string" ? request.data.userName.trim() : "";
    if (!userName || userName.length > 200) {
        throw new HttpsError("invalid-argument", "利用者を確認できません。");
    }
    await verifyFacilityIsActive(facilityId);

    const userRef = getFirestore().collection("facilities").doc(facilityId).collection("users").doc(userName);
    const userSnapshot = await userRef.get();
    if (!userSnapshot.exists) {
        throw new HttpsError("not-found", "利用者名簿に登録されていません。");
    }

    const code = crypto.randomBytes(6).toString("hex").toUpperCase();
    await getFirestore().collection("linePairingCodes").doc(hashLineCode(code)).set({
        facilityId,
        userName,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000)
    });
    const lineSettingsSnapshot = await getFirestore().collection("facilityLineSettings").doc(facilityId).get();
    const lineSettings = lineSettingsSnapshot.exists ? lineSettingsSnapshot.data() : {};
    return {
        code,
        expiresInMinutes: 15,
        officialAccountName: lineSettings.displayName || "ecosmile39",
        officialAccountId: lineSettings.basicId || "@108nturw"
    };
});

async function connectLineUser(code, lineUserId, expectedFacilityId = "") {
    const db = getFirestore();
    const codeRef = db.collection("linePairingCodes").doc(hashLineCode(code));
    return db.runTransaction(async transaction => {
        const codeSnapshot = await transaction.get(codeRef);
        if (!codeSnapshot.exists) return { status: "invalid" };
        const pairing = codeSnapshot.data();
        if (expectedFacilityId && pairing.facilityId !== expectedFacilityId) return { status: "invalid" };
        const expiration = pairing.expiresAt?.toDate ? pairing.expiresAt.toDate() : new Date(pairing.expiresAt);
        if (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()) {
            transaction.delete(codeRef);
            return { status: "expired" };
        }

        const userRef = db.collection("facilities").doc(pairing.facilityId).collection("users").doc(pairing.userName);
        const userSnapshot = await transaction.get(userRef);
        if (!userSnapshot.exists) {
            transaction.delete(codeRef);
            return { status: "invalid" };
        }

        const lineUserIds = Array.isArray(userSnapshot.data().lineUserIds) ? userSnapshot.data().lineUserIds : [];
        if (!lineUserIds.includes(lineUserId)) {
            transaction.set(userRef, {
                lineUserIds: [...lineUserIds, lineUserId],
                lineLinkedAt: FieldValue.serverTimestamp()
            }, { merge: true });
        }
        transaction.delete(codeRef);
        return { status: "linked", userName: pairing.userName };
    });
}

async function replyToLine(replyToken, text, channelAccessToken) {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${channelAccessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] })
    });
    if (!response.ok) {
        logger.warn("LINE webhook reply failed", { status: response.status });
    }
}

function getFamilyVisibleFields(record) {
    const fields = [];
    const add = (label, key) => {
        const value = record[key];
        if (Array.isArray(value)) {
            if (value.length) fields.push({ label, value: value.join("、") });
        } else if (value !== undefined && value !== null && String(value).trim() !== "") {
            fields.push({ label, value: String(value) });
        }
    };

    if (record.serviceType === "放課後等デイサービス" || record.serviceType === "児童発達支援") {
        [
            ["利用状況", "afterSchoolAttendance"], ["担当指導員", "afterSchoolStaff"],
            ["提供時間", "afterSchoolProvideStart"], ["提供終了", "afterSchoolProvideEnd"],
            ["到着時刻", "afterSchoolArrivalTime"], ["退所時刻", "afterSchoolDepartureTime"],
            ["来所時の送迎", "afterSchoolPickupType"], ["送迎の補足", "afterSchoolPickup"],
            ["退所時の送迎", "afterSchoolDropoffType"], ["送迎の補足", "afterSchoolDropoff"],
            ["来所時体温", "afterSchoolTemperature"], ["検温時刻", "afterSchoolTempTime"],
            ["健康状態", "afterSchoolHealth"], ["健康状態の補足", "afterSchoolHealthNote"],
            ["排泄時刻", "afterSchoolToiletTime"], ["排泄状況", "afterSchoolToilet"],
            ["おやつ", "afterSchoolSnack"], ["おやつ摂取量", "afterSchoolSnackIntake"],
            ["本日の活動", "afterSchoolActivityTags"], ["活動内容", "afterSchoolSupport"],
            ["施設での様子", "afterSchoolEpisode"], ["次回利用予定日", "afterSchoolNextUseDate"],
            ["持ち物・お知らせ", "afterSchoolBelongings"], ["昨晩の睡眠時間", "afterSchoolHomeSleepHours"],
            ["昨晩の睡眠の様子", "afterSchoolHomeSleepQuality"], ["朝の様子", "afterSchoolMorningState"],
            ["保護者確認", "afterSchoolParentSign"], ["ご家族への連絡", "afterSchoolHandover"]
        ].forEach(([label, key]) => add(label, key));
    } else if (record.serviceType === "生活介護") {
        [
            ["利用状況", "lifeCareAttendance"], ["担当職員", "lifeCareStaff"],
            ["提供開始", "lifeCareStartTime"], ["提供終了", "lifeCareEndTime"],
            ["来所時刻", "lifeCareArrivalTime"], ["退所時刻", "lifeCareDepartureTime"],
            ["来所時の送迎", "lifeCarePickupType"], ["送迎の補足", "lifeCarePickupNote"],
            ["退所時の送迎", "lifeCareDropoffType"], ["送迎の補足", "lifeCareDropoffNote"],
            ["体温", "lifeCareTemperature"], ["脈拍", "lifeCarePulse"],
            ["血圧（上）", "lifeCareBpHigh"], ["血圧（下）", "lifeCareBpLow"],
            ["酸素飽和度", "lifeCareSpo2"], ["健康状態", "lifeCareHealthNote"],
            ["食事", "lifeCareMeal"], ["水分", "lifeCareWater"],
            ["服薬・医療的ケア", "lifeCareMedication"], ["排泄", "lifeCareToileting"],
            ["入浴・清潔保持", "lifeCareBathing"], ["日中活動", "lifeCareActivityTags"],
            ["個別支援の状況", "lifeCareGoalProgress"], ["活動内容", "lifeCareActivityDetails"],
            ["ご本人の様子", "lifeCareEpisode"], ["ご家族への連絡", "lifeCareHandover"]
        ].forEach(([label, key]) => add(label, key));
    } else if (record.serviceType === "ショートステイ") {
        [
            ["入所時体温", "stTempIn"], ["入所時脈拍", "stPulseIn"], ["入所時酸素飽和度", "stSpo2In"],
            ["退所時体温", "stTempOut"], ["退所時脈拍", "stPulseOut"], ["退所時酸素飽和度", "stSpo2Out"],
            ["朝食", "stMealBreakfast"], ["昼食", "stMealLunch"], ["夕食", "stMealDinner"],
            ["水分", "stWater"], ["服薬・処置", "stMedication"], ["入浴", "stBath"],
            ["夜間の様子", "stNightState"], ["日中の活動", "stDayActivity"],
            ["持ち物メモ", "stBelongingMemo"]
        ].forEach(([label, key]) => add(label, key));
    } else {
        [
            ["担当スタッフ", "careStaff"], ["体温", "temp1"], ["体温（途中）", "temp2"],
            ["脈拍", "pulse"], ["酸素飽和度", "spo2"], ["血圧（上）", "bpHigh"],
            ["血圧（下）", "bpLow"], ["食事（主食）", "mealMain"], ["食事（副食）", "mealSub"],
            ["水分", "water"], ["服薬・処置", "medication"], ["口腔ケア", "oralCare"],
            ["入浴", "bath"], ["入浴の補足", "bathReason"], ["機能訓練", "training"],
            ["活動", "activity"], ["介護日誌", "careJournal"]
        ].forEach(([label, key]) => add(label, key));
    }
    add("施設からの連絡", "message");
    add("ご家族からの連絡", "familyMessage");
    add("施設からのお知らせ", "facilityPR");
    return fields;
}

async function getLineAttachment(filePath, linkDate, expiresAt, checkUploadDate = false) {
    try {
        const file = getStorage().bucket().file(filePath);
        const [metadata] = await file.getMetadata();
        if (checkUploadDate && metadata.metadata?.uploadedForDate !== linkDate) return null;
        const [url] = await file.getSignedUrl({
            action: "read",
            expires: expiresAt,
            version: "v4"
        });
        return { url, contentType: metadata.contentType || "" };
    } catch (error) {
        logger.warn("LINE record attachment unavailable", { reason: error.code || "unknown" });
        return null;
    }
}

exports.getLineSharedRecord = onCall(async request => {
    const token = typeof request.data?.token === "string" ? request.data.token : "";
    if (!/^[a-f0-9]{64}$/i.test(token)) {
        throw new HttpsError("unauthenticated", "閲覧リンクが正しくありません。");
    }

    const linkSnapshot = await getFirestore().collection("lineRecordLinks").doc(hashLineCode(token)).get();
    if (!linkSnapshot.exists) throw new HttpsError("unauthenticated", "閲覧リンクが無効か、有効期限が切れています。");
    const link = linkSnapshot.data();
    const expiration = link.expiresAt?.toDate ? link.expiresAt.toDate() : new Date(link.expiresAt);
    if (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()) {
        throw new HttpsError("unauthenticated", "閲覧リンクが無効か、有効期限が切れています。");
    }

    const recordRef = getFirestore().collection("facilities").doc(link.facilityId)
        .collection("daily_records").doc(`${link.date}_${link.serviceType}_${link.userName}`);
    const recordSnapshot = await recordRef.get();
    if (!recordSnapshot.exists) throw new HttpsError("not-found", "連絡帳が見つかりません。");
    const record = recordSnapshot.data();
    if (record.facilityId !== link.facilityId || record.userName !== link.userName || record.date !== link.date || record.serviceType !== link.serviceType) {
        throw new HttpsError("permission-denied", "連絡帳を確認できません。");
    }

    const userSnapshot = await getFirestore().collection("facilities").doc(link.facilityId)
        .collection("users").doc(link.userName).get();
    const facilitySnapshot = await getFirestore().collection("facilities").doc(link.facilityId).get();
    const attachments = { images: [], videos: [] };
    if (userSnapshot.exists && userSnapshot.data().photoNg !== true) {
        const imageCount = Number.isInteger(record.imageCount) ? Math.min(record.imageCount, 20) : 0;
        const videoCount = Number.isInteger(record.videoCount) ? Math.min(record.videoCount, 10) : 0;
        const imageAttachments = await Promise.all(Array.from({ length: imageCount }, (_, index) =>
            getLineAttachment(
                `images/${link.facilityId}/${link.userName}/image_${index + 1}.jpg`,
                link.date,
                expiration,
                true
            )
        ));
        const videoAttachments = await Promise.all(Array.from({ length: videoCount }, (_, index) =>
            getLineAttachment(
                `videos/${link.facilityId}/${link.userName}/${link.date}_video_${index + 1}.mp4`,
                link.date,
                expiration
            )
        ));
        attachments.images = imageAttachments.filter(Boolean);
        attachments.videos = videoAttachments.filter(Boolean);
    }

    return {
        facilityName: facilitySnapshot.exists ? (facilitySnapshot.data().facilityName || "") : "",
        userName: link.userName,
        date: link.date,
        serviceType: link.serviceType,
        fields: getFamilyVisibleFields(record),
        attachments
    };
});

exports.getLineRecipientStatus = onCall(async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    const userName = typeof request.data?.userName === "string" ? request.data.userName.trim() : "";
    if (!userName || userName.length > 200) {
        throw new HttpsError("invalid-argument", "利用者を確認できません。");
    }
    const userRef = getFirestore().collection("facilities").doc(facilityId).collection("users").doc(userName);
    const userSnapshot = await userRef.get();
    if (!userSnapshot.exists) throw new HttpsError("not-found", "利用者名簿に登録されていません。");
    const lineUserIds = Array.isArray(userSnapshot.data().lineUserIds) ? userSnapshot.data().lineUserIds : [];
    return { recipientCount: lineUserIds.length };
});

exports.getFacilityLineSettingsStatus = onCall(async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    const snapshot = await getFirestore().collection("facilityLineSettings").doc(facilityId).get();
    const settings = snapshot.exists ? snapshot.data() : {};
    return {
        configured: snapshot.exists,
        displayName: settings.displayName || "",
        basicId: settings.basicId || "",
        webhookUrl: `${LINE_WEBHOOK_BASE_URL}/${encodeURIComponent(facilityId)}`
    };
});

exports.saveFacilityLineSettings = onCall({ secrets: [FACILITY_LINE_ENCRYPTION_KEY] }, async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    const channelAccessToken = typeof request.data?.channelAccessToken === "string"
        ? request.data.channelAccessToken.trim()
        : "";
    const channelSecret = typeof request.data?.channelSecret === "string"
        ? request.data.channelSecret.trim()
        : "";
    if (!channelAccessToken || channelAccessToken.length > 4096 || channelSecret.length !== 32) {
        throw new HttpsError("invalid-argument", "アクセストークンと32文字のChannel secretを確認してください。");
    }

    let botInfoResponse;
    try {
        botInfoResponse = await fetch("https://api.line.me/v2/bot/info", {
            headers: { Authorization: `Bearer ${channelAccessToken}` }
        });
    } catch {
        throw new HttpsError("unavailable", "LINEに接続できませんでした。時間をおいて再試行してください。");
    }
    if (!botInfoResponse.ok) {
        throw new HttpsError("invalid-argument", "アクセストークンが正しいか確認してください。");
    }
    const botInfo = await botInfoResponse.json();
    if (typeof botInfo.basicId !== "string" || typeof botInfo.displayName !== "string") {
        throw new HttpsError("invalid-argument", "LINE公式アカウント情報を確認できませんでした。");
    }

    const settingsRef = getFirestore().collection("facilityLineSettings").doc(facilityId);
    const currentSnapshot = await settingsRef.get();
    const previousBasicId = currentSnapshot.exists ? currentSnapshot.data().basicId : "@108nturw";
    const accountChanged = previousBasicId !== botInfo.basicId;
    await settingsRef.set({
        encryptedCredentials: encryptFacilityLineCredentials(facilityId, { channelAccessToken, channelSecret }),
        basicId: botInfo.basicId,
        displayName: botInfo.displayName,
        updatedAt: FieldValue.serverTimestamp()
    });

    if (accountChanged) {
        const users = await getFirestore().collection("facilities").doc(facilityId).collection("users").get();
        for (let offset = 0; offset < users.docs.length; offset += 400) {
            const batch = getFirestore().batch();
            users.docs.slice(offset, offset + 400).forEach(user => batch.update(user.ref, {
                lineUserIds: [],
                lineLinkedAt: FieldValue.delete()
            }));
            await batch.commit();
        }
    }

    return {
        configured: true,
        displayName: botInfo.displayName,
        basicId: botInfo.basicId,
        accountChanged,
        webhookUrl: `${LINE_WEBHOOK_BASE_URL}/${encodeURIComponent(facilityId)}`
    };
});

exports.removeFacilityLineSettings = onCall(async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    await getFirestore().collection("facilityLineSettings").doc(facilityId).delete();
    const users = await getFirestore().collection("facilities").doc(facilityId).collection("users").get();
    for (let offset = 0; offset < users.docs.length; offset += 400) {
        const batch = getFirestore().batch();
        users.docs.slice(offset, offset + 400).forEach(user => batch.update(user.ref, {
            lineUserIds: [],
            lineLinkedAt: FieldValue.delete()
        }));
        await batch.commit();
    }
    return { removed: true };
});

exports.sendLineRecordNotification = onCall({
    secrets: [FACILITY_LINE_ENCRYPTION_KEY, LINE_CHANNEL_ACCESS_TOKEN]
}, async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    const { userName, date, serviceType } = request.data || {};
    if (typeof userName !== "string" || !userName || userName.length > 200 ||
        typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        typeof serviceType !== "string" || !serviceType || serviceType.length > 100) {
        throw new HttpsError("invalid-argument", "利用者・日付・サービスを確認できません。");
    }

    const db = getFirestore();
    const userRef = db.collection("facilities").doc(facilityId).collection("users").doc(userName);
    const [userSnapshot, recordSnapshot] = await Promise.all([
        userRef.get(),
        db.collection("facilities").doc(facilityId).collection("daily_records").doc(`${date}_${serviceType}_${userName}`).get()
    ]);
    if (!userSnapshot.exists || !recordSnapshot.exists) {
        throw new HttpsError("not-found", "利用者または連絡帳が見つかりません。");
    }
    const lineUserIds = Array.isArray(userSnapshot.data().lineUserIds) ? userSnapshot.data().lineUserIds : [];
    if (!lineUserIds.length) {
        throw new HttpsError("failed-precondition", "保護者のLINE連携がまだ完了していません。");
    }

    const facilityLineCredentials = await getFacilityLineCredentials(facilityId);
    const channelAccessToken = facilityLineCredentials?.channelAccessToken || LINE_CHANNEL_ACCESS_TOKEN.value();

    const token = crypto.randomBytes(32).toString("hex");
    await db.collection("lineRecordLinks").doc(hashLineCode(token)).set({
        facilityId,
        userName,
        date,
        serviceType,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });
    const recordUrl = `${LINE_RECORD_BASE_URL}?token=${token}`;
    const message = `${userName} 様の ${date} の連絡帳をお届けします。\n次のリンクからご確認ください（7日間有効）：\n${recordUrl}`;
    const results = await Promise.allSettled(lineUserIds.map(lineUserId => fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${channelAccessToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ to: lineUserId, messages: [{ type: "text", text: message }] })
    })));
    const failures = results.filter(result => result.status === "rejected" || !result.value.ok);
    if (failures.length) {
        logger.error("LINE record notification failed", { facilityId, failedCount: failures.length, recipientCount: lineUserIds.length });
        throw new HttpsError("unavailable", `LINE通知に失敗しました（${lineUserIds.length - failures.length}/${lineUserIds.length}件送信）。記録自体は保存されています。`);
    }
    return { recipientCount: lineUserIds.length, expiresInDays: 7 };
});

exports.deleteExpiredLineLinks = onSchedule({
    schedule: "every day 04:30",
    timeZone: "Asia/Tokyo",
    maxInstances: 1
}, async () => {
    const db = getFirestore();
    for (const collectionName of ["lineRecordLinks", "linePairingCodes"]) {
        let deletedCount = 0;
        while (true) {
            const expired = await db.collection(collectionName).where("expiresAt", "<=", new Date()).limit(400).get();
            if (expired.empty) break;
            const batch = db.batch();
            expired.docs.forEach(document => batch.delete(document.ref));
            await batch.commit();
            deletedCount += expired.size;
        }
        logger.info("Expired LINE documents removed", { collectionName, deletedCount });
    }
});

async function handleLineMessagingWebhook(request, response, credentials, expectedFacilityId = "") {
    if (request.method === "GET") return response.status(200).send("OK");
    if (request.method !== "POST") return response.status(405).send("Method not allowed");

    const signature = request.get("x-line-signature") || "";
    const expectedSignature = crypto.createHmac("sha256", credentials.channelSecret)
        .update(request.rawBody)
        .digest();
    const receivedSignature = Buffer.from(signature, "base64");
    if (receivedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(receivedSignature, expectedSignature)) {
        return response.status(401).send("Invalid signature");
    }

    const events = Array.isArray(request.body?.events) ? request.body.events : [];
    for (const event of events) {
        if (event.type !== "message" || event.message?.type !== "text" || !event.replyToken || !event.source?.userId) continue;
        const code = event.message.text.trim().toUpperCase();
        if (!/^[A-F0-9]{12}$/.test(code)) continue;
        try {
            const result = await connectLineUser(code, event.source.userId, expectedFacilityId);
            const reply = result.status === "linked"
                ? `${result.userName} 様の連絡帳を受け取るLINE連携が完了しました。`
                : "連携コードが無効か、有効期限が切れています。施設へ新しいコードをお申し付けください。";
            await replyToLine(event.replyToken, reply, credentials.channelAccessToken);
        } catch (error) {
            logger.error("LINE account pairing failed", { error });
            await replyToLine(event.replyToken, "連携できませんでした。時間をおいて再度お試しください。", credentials.channelAccessToken).catch(() => {});
        }
    }
    return response.status(200).send("OK");
}

exports.lineMessagingWebhook = onRequest({
    secrets: [LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET]
}, async (request, response) => handleLineMessagingWebhook(request, response, {
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN.value(),
    channelSecret: LINE_CHANNEL_SECRET.value()
}));

exports.facilityLineMessagingWebhook = onRequest({
    secrets: [FACILITY_LINE_ENCRYPTION_KEY]
}, async (request, response) => {
    let facilityId = "";
    try {
        const pathParts = request.path.split("/").filter(Boolean);
        if (pathParts.length !== 1) return response.status(404).send("Not found");
        facilityId = decodeURIComponent(pathParts[0]);
    } catch {
        return response.status(404).send("Not found");
    }
    if (!facilityId || facilityId.includes("/") || facilityId.length > 200) {
        return response.status(404).send("Not found");
    }
    if (request.method === "GET") return response.status(200).send("OK");

    const facilitySnapshot = await getFirestore().collection("facilities").doc(facilityId).get();
    if (!facilitySnapshot.exists || facilitySnapshot.data().status === "locked") {
        return response.status(404).send("Not found");
    }
    const credentials = await getFacilityLineCredentials(facilityId);
    if (!credentials) return response.status(404).send("Not found");
    return handleLineMessagingWebhook(request, response, credentials, facilityId);
});

function getTokyoDateParts(date) {
    return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date).map(part => [part.type, part.value]));
}

function dateKey(parts) {
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function addMonthsToAnchor(anchor, monthOffset) {
    const targetMonth = new Date(Date.UTC(Number(anchor.year), Number(anchor.month) - 1 + monthOffset, 1));
    const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
    return {
        year: String(targetMonth.getUTCFullYear()),
        month: String(targetMonth.getUTCMonth() + 1).padStart(2, "0"),
        day: String(Math.min(Number(anchor.day), lastDay)).padStart(2, "0")
    };
}

function getLatestMaturedBillingPeriod(createdAt, now) {
    const registrationDate = createdAt && typeof createdAt.toDate === "function"
        ? createdAt.toDate()
        : new Date(createdAt);
    if (!Number.isFinite(registrationDate.getTime())) return null;

    const anchor = getTokyoDateParts(registrationDate);
    const todayKey = dateKey(getTokyoDateParts(now));
    let latestPeriod = null;
    for (let monthOffset = 1; monthOffset <= 1200; monthOffset++) {
        const dueParts = addMonthsToAnchor(anchor, monthOffset);
        if (dateKey(dueParts) > todayKey) break;

        const startParts = addMonthsToAnchor(anchor, monthOffset - 1);
        const endDate = new Date(Date.UTC(Number(dueParts.year), Number(dueParts.month) - 1, Number(dueParts.day) - 1));
        const endParts = {
            year: String(endDate.getUTCFullYear()),
            month: String(endDate.getUTCMonth() + 1).padStart(2, "0"),
            day: String(endDate.getUTCDate()).padStart(2, "0")
        };
        latestPeriod = {
            startDate: dateKey(startParts),
            endDate: dateKey(endParts),
            dueDate: dateKey(dueParts)
        };
    }
    return latestPeriod;
}

function formatJapaneseDateKey(value) {
    const [year, month, day] = value.split("-").map(Number);
    return `${year}年${month}月${day}日`;
}

exports.sendTestInvoiceEmail = onCall({
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    const { facilityId } = request.data || {};
    if (request.auth?.token.role !== "admin") {
        throw new HttpsError("unauthenticated", "請求書送信キーが正しくありません。");
    }
    if (typeof facilityId !== "string" || !facilityId || facilityId.length > 128) {
        throw new HttpsError("invalid-argument", "施設を特定できません。");
    }

    const facilitySnapshot = await getFirestore().collection("facilities").doc(facilityId).get();
    if (!facilitySnapshot.exists) {
        throw new HttpsError("not-found", "施設情報が見つかりません。");
    }

    const facility = facilitySnapshot.data();
    const facilityName = facility.facilityName || facilityId;
    const now = new Date();
    const dateParts = getTokyoDateParts(now);
    const issueDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const dueDateValue = new Date(Date.UTC(
        Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day) + 30
    ));
    const dueParts = {
        year: dueDateValue.getUTCFullYear(),
        month: String(dueDateValue.getUTCMonth() + 1).padStart(2, "0"),
        day: String(dueDateValue.getUTCDate()).padStart(2, "0")
    };
    const billingMonth = `${dateParts.year}年${Number(dateParts.month)}月`;
    const invoiceNumber = `TEST-${dateParts.year}${dateParts.month}${dateParts.day}-${facilityId.slice(-6).toUpperCase()}`;
    const formatJapaneseDate = parts => `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日`;
    const safeFacilityName = escapeHtml(facilityName);
    const safeInvoiceNumber = escapeHtml(invoiceNumber);
    const gmailUser = INVOICE_GMAIL_USER.value();
    const html = `<!doctype html><html lang="ja"><body style="font-family:sans-serif;color:#222;line-height:1.7;max-width:720px;margin:auto;padding:24px">
        <div style="border:2px solid #c92a2a;color:#c92a2a;padding:10px;text-align:center;font-weight:bold">テスト請求書（実請求ではありません）</div>
        <p>${safeFacilityName} 御中</p>
        <h1 style="text-align:center">請求書</h1>
        <p>請求書番号：${safeInvoiceNumber}<br>発行日：${formatJapaneseDate(dateParts)}<br>お支払期限：${formatJapaneseDate(dueParts)}</p>
        <p style="font-size:20px;font-weight:bold">ご請求金額（税込）　5,500円</p>
        <table style="width:100%;border-collapse:collapse"><thead><tr><th style="border:1px solid #adb5bd;padding:10px;text-align:left">内容</th><th style="border:1px solid #adb5bd;padding:10px;text-align:left">金額</th></tr></thead><tbody>
        <tr><td style="border:1px solid #adb5bd;padding:10px">システム利用料（${billingMonth}分）</td><td style="border:1px solid #adb5bd;padding:10px">5,000円</td></tr>
        <tr><td style="border:1px solid #adb5bd;padding:10px">消費税（10%）</td><td style="border:1px solid #adb5bd;padding:10px">500円</td></tr>
        <tr><th style="border:1px solid #adb5bd;padding:10px;text-align:left">合計</th><th style="border:1px solid #adb5bd;padding:10px;text-align:left">5,500円</th></tr></tbody></table>
        <div style="display:flex;justify-content:flex-start;align-items:flex-start;gap:16px;margin-top:28px"><div><h2>発行元</h2><p>株式会社えこすまいる<br>〒719-1164 岡山県総社市西郡430-2<br>連絡先：${escapeHtml(gmailUser)}<br>適格請求書発行事業者登録番号：なし</p></div><img src="cid:company-stamp" alt="株式会社えこすまいる会社印" width="92" height="92" style="width:92px;height:92px;object-fit:contain;margin-top:90px"></div>
        <h2>お振込先</h2><p>PayPay銀行<br>店番号：005 ／ 支店名：ビジネス営業部<br>普通 2088889<br>口座名義：カ）エコスマイル</p>
        <p style="background:#fff4e6;padding:12px">これは送信テストです。実際の請求・お支払いは発生しません。</p>
        <p>平素よりシステムをご利用いただき、誠にありがとうございます。今後ともどうぞよろしくお願い申し上げます。</p>
    </body></html>`;
    const text = `${facilityName} 御中\nテスト請求書（実請求ではありません）\n請求書番号：${invoiceNumber}\n発行日：${formatJapaneseDate(dateParts)}\n支払期限：${formatJapaneseDate(dueParts)}\nシステム利用料（${billingMonth}分）：5,000円\n消費税（10%）：500円\n税込合計：5,500円\n\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\nPayPay銀行 ビジネス営業部（005） 普通 2088889\n口座名義：カ）エコスマイル\n\nこれは送信テストです。実際の請求・お支払いは発生しません。\n\n平素よりシステムをご利用いただき、誠にありがとうございます。今後ともどうぞよろしくお願い申し上げます。`;

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: gmailUser,
                pass: INVOICE_GMAIL_APP_PASSWORD.value()
            }
        });
        const result = await transporter.sendMail({
            from: { name: "株式会社えこすまいる", address: gmailUser },
            to: INVOICE_TEST_RECIPIENT,
            subject: `【テスト請求書】${facilityName} 御中 / ${invoiceNumber}`,
            text,
            html,
            attachments: [{
                filename: "company_stamp.png",
                content: companyStampPng,
                contentType: "image/png",
                cid: "company-stamp"
            }]
        });

        const invoiceHistoryEntry = {
            test: true,
            facilityId,
            facilityName,
            recipient: INVOICE_TEST_RECIPIENT,
            invoiceNumber,
            issueDate,
            dueDate: `${dueParts.year}-${dueParts.month}-${dueParts.day}`,
            billingMonth,
            subtotal: 5000,
            tax: 500,
            total: 5500,
            sentAt: FieldValue.serverTimestamp(),
            messageId: result.messageId,
            invoiceHtml: html.replace('src="cid:company-stamp"', `src="${companyStampDataUrl}"`)
        };
        const { invoiceHtml, ...auditEntry } = invoiceHistoryEntry;
        await Promise.all([
            getFirestore().collection("facilities").doc(facilityId).collection("invoiceHistory").add(invoiceHistoryEntry),
            getFirestore().collection("invoiceEmailLogs").add(auditEntry)
        ]).catch(error => logger.warn("Test invoice email sent but history logging failed", error));

        return { success: true, recipient: INVOICE_TEST_RECIPIENT, invoiceNumber };
    } catch (error) {
        logger.error("Failed to send test invoice email", error);
        throw new HttpsError("internal", "テスト請求書メールを送信できませんでした。Gmail認証設定を確認してください。");
    }
});

exports.sendMonthlyInvoices = onSchedule({
    schedule: "every day 09:00",
    timeZone: "Asia/Tokyo",
    maxInstances: 1,
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async () => {
    const db = getFirestore();
    const now = new Date();
    const issueDate = dateKey(getTokyoDateParts(now));
    const dueDateValue = new Date(`${issueDate}T00:00:00+09:00`);
    dueDateValue.setDate(dueDateValue.getDate() + 30);
    const dueDate = dateKey(getTokyoDateParts(dueDateValue));
    const gmailUser = INVOICE_GMAIL_USER.value();
    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
    });
    const facilitiesSnapshot = await db.collection("facilities").where("status", "==", "active").get();
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const facilityDocument of facilitiesSnapshot.docs) {
        const facility = facilityDocument.data();
        const facilityId = facilityDocument.id;
        const facilityName = facility.facilityName || facilityId;
        if (facility.subscriptionStatus === "trial") {
            skippedCount++;
            continue;
        }
        const recipient = typeof facility.email === "string" ? facility.email.trim() : "";
        if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
            skippedCount++;
            logger.warn("Skipping monthly invoice: facility email is missing or invalid", { facilityId });
            continue;
        }

        const period = getLatestMaturedBillingPeriod(facility.createdAt, now);
        if (!period) {
            skippedCount++;
            logger.warn("Skipping monthly invoice: facility registration date is missing or invalid", { facilityId });
            continue;
        }

        const historyRef = db.collection("facilities").doc(facilityId)
            .collection("invoiceHistory").doc(`AUTO-${period.startDate.replace(/-/g, "")}`);
        const reservedForSending = await db.runTransaction(async transaction => {
            const historySnapshot = await transaction.get(historyRef);
            if (historySnapshot.exists) {
                const history = historySnapshot.data();
                if (history.status === "sent") return false;
                const attemptStartedAt = history.attemptStartedAt && typeof history.attemptStartedAt.toDate === "function"
                    ? history.attemptStartedAt.toDate().getTime()
                    : 0;
                if (history.status === "sending" && Date.now() - attemptStartedAt < 60 * 60 * 1000) return false;
            }
            transaction.set(historyRef, {
                test: false,
                status: "sending",
                facilityId,
                facilityName,
                recipient,
                issueDate,
                dueDate,
                billingPeriodStart: period.startDate,
                billingPeriodEnd: period.endDate,
                subtotal: 5000,
                tax: 500,
                total: 5500,
                attemptStartedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            return true;
        });
        if (!reservedForSending) {
            skippedCount++;
            continue;
        }

        const invoiceNumber = `INV-${period.startDate.replace(/-/g, "")}-${facilityId.toUpperCase()}`;
        const formattedPeriod = `${formatJapaneseDateKey(period.startDate)}〜${formatJapaneseDateKey(period.endDate)}`;
        const html = `<!doctype html><html lang="ja"><body style="font-family:sans-serif;color:#222;line-height:1.7;max-width:720px;margin:auto;padding:24px">
            <p>${escapeHtml(facilityName)} 御中</p><h1 style="text-align:center">請求書</h1>
            <p>請求書番号：${escapeHtml(invoiceNumber)}<br>発行日：${formatJapaneseDateKey(issueDate)}<br>お支払期限：${formatJapaneseDateKey(dueDate)}</p>
            <p style="font-size:20px;font-weight:bold">ご請求金額（税込）　5,500円</p>
            <table style="width:100%;border-collapse:collapse"><thead><tr><th style="border:1px solid #adb5bd;padding:10px;text-align:left">内容</th><th style="border:1px solid #adb5bd;padding:10px;text-align:left">金額</th></tr></thead><tbody>
            <tr><td style="border:1px solid #adb5bd;padding:10px">システム利用料（${formattedPeriod}分）</td><td style="border:1px solid #adb5bd;padding:10px">5,000円</td></tr>
            <tr><td style="border:1px solid #adb5bd;padding:10px">消費税（10%）</td><td style="border:1px solid #adb5bd;padding:10px">500円</td></tr>
            <tr><th style="border:1px solid #adb5bd;padding:10px;text-align:left">合計</th><th style="border:1px solid #adb5bd;padding:10px;text-align:left">5,500円</th></tr></tbody></table>
            <div style="display:flex;justify-content:flex-start;align-items:flex-start;gap:16px;margin-top:28px"><div><h2>発行元</h2><p>株式会社えこすまいる<br>〒719-1164 岡山県総社市西郡430-2<br>連絡先：${escapeHtml(gmailUser)}<br>適格請求書発行事業者登録番号：なし</p></div><img src="cid:company-stamp" alt="株式会社えこすまいる会社印" width="92" height="92" style="width:92px;height:92px;object-fit:contain;margin-top:90px"></div>
            <h2>お振込先</h2><p>PayPay銀行<br>店番号：005 ／ 支店名：ビジネス営業部<br>普通 2088889<br>口座名義：カ）エコスマイル</p>
            <p style="margin-top:28px">平素よりシステムをご利用いただき、誠にありがとうございます。今後ともどうぞよろしくお願い申し上げます。</p>
        </body></html>`;
        const text = `${facilityName} 御中\n請求書番号：${invoiceNumber}\n請求対象期間：${formattedPeriod}\n発行日：${formatJapaneseDateKey(issueDate)}\nお支払期限：${formatJapaneseDateKey(dueDate)}\nシステム利用料：5,000円\n消費税（10%）：500円\n税込合計：5,500円\n\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\nPayPay銀行 ビジネス営業部（005） 普通 2088889\n口座名義：カ）エコスマイル\n\n平素よりシステムをご利用いただき、誠にありがとうございます。今後ともどうぞよろしくお願い申し上げます。`;

        try {
            const result = await transporter.sendMail({
                from: { name: "株式会社えこすまいる", address: gmailUser },
                to: recipient,
                subject: `【請求書】${facilityName} 御中 / ${invoiceNumber}`,
                text,
                html,
                attachments: [{ filename: "company_stamp.png", content: companyStampPng, contentType: "image/png", cid: "company-stamp" }]
            });
            const archivedHtml = html.replace('src="cid:company-stamp"', `src="${companyStampDataUrl}"`);
            await historyRef.set({
                status: "sent",
                test: false,
                invoiceNumber,
                billingMonth: formattedPeriod,
                invoiceHtml: archivedHtml,
                messageId: result.messageId,
                sentAt: FieldValue.serverTimestamp()
            }, { merge: true });
            await db.collection("invoiceEmailLogs").add({
                test: false,
                facilityId,
                facilityName,
                recipient,
                invoiceNumber,
                issueDate,
                dueDate,
                billingPeriodStart: period.startDate,
                billingPeriodEnd: period.endDate,
                subtotal: 5000,
                tax: 500,
                total: 5500,
                sentAt: FieldValue.serverTimestamp(),
                messageId: result.messageId
            }).catch(error => logger.warn("Invoice email sent but audit logging failed", { facilityId, error }));
            sentCount++;
        } catch (error) {
            failedCount++;
            await historyRef.set({
                status: "failed",
                failedAt: FieldValue.serverTimestamp(),
                failureMessage: String(error.message || error).slice(0, 500)
            }, { merge: true }).catch(logError => logger.error("Failed to record invoice send failure", logError));
            logger.error("Failed to send monthly invoice", { facilityId, recipient, error });
        }
    }

    logger.info("Monthly invoice run completed", {
        activeFacilities: facilitiesSnapshot.size,
        sent: sentCount,
        skipped: skippedCount,
        failed: failedCount
    });
});

exports.lockExpiredTrials = onSchedule("every 60 minutes", async () => {
    const facilitiesSnapshot = await getFirestore().collection("facilities").get();
    const now = Date.now();
    const expiredFacilities = facilitiesSnapshot.docs.filter(document => {
        const facility = document.data();
        if (facility.status === "locked" || facility.subscriptionStatus !== "trial") return false;
        const trialEndsAt = Date.parse(facility.trialEndsAt || "");
        return !Number.isFinite(trialEndsAt) || trialEndsAt <= now;
    });
    for (let offset = 0; offset < expiredFacilities.length; offset += 400) {
        const batch = getFirestore().batch();
        expiredFacilities.slice(offset, offset + 400).forEach(facility => batch.update(facility.ref, {
            status: "locked",
            trialExpiredAt: FieldValue.serverTimestamp()
        }));
        await batch.commit();
    }
    if (expiredFacilities.length) logger.info("Expired trial facilities locked", { count: expiredFacilities.length });
});

exports.deleteExpiredVideos = onSchedule("every 60 minutes", async () => {
    const bucket = getStorage().bucket();
    const [files] = await bucket.getFiles({ prefix: "videos/" });
    const cutoff = Date.now() - VIDEO_RETENTION_MS;
    const expiredFiles = [];

    for (const file of files) {
        let createdAt = Date.parse(file.metadata.timeCreated || "");
        if (!Number.isFinite(createdAt)) {
            const [metadata] = await file.getMetadata();
            createdAt = Date.parse(metadata.timeCreated || "");
        }
        if (Number.isFinite(createdAt) && createdAt <= cutoff) {
            expiredFiles.push(file);
        }
    }

    let deletedCount = 0;
    for (let offset = 0; offset < expiredFiles.length; offset += DELETE_BATCH_SIZE) {
        const batch = expiredFiles.slice(offset, offset + DELETE_BATCH_SIZE);
        const results = await Promise.allSettled(batch.map(file => file.delete({ ignoreNotFound: true })));
        const failures = results.filter(result => result.status === "rejected");
        deletedCount += results.length - failures.length;
        failures.forEach(result => logger.error("Failed to delete expired video", result.reason));
    }

    logger.info("Expired video cleanup completed", {
        scanned: files.length,
        expired: expiredFiles.length,
        deleted: deletedCount
    });
});

exports.exportDailyRecordsBackup = onSchedule({
    schedule: "every day 03:00",
    timeZone: "Asia/Tokyo",
    maxInstances: 1,
    serviceAccount: FIRESTORE_BACKUP_SERVICE_ACCOUNT
}, async () => {
    const now = new Date();
    const backupDate = dateKey(getTokyoDateParts(now));
    const outputUriPrefix = `gs://${FIRESTORE_BACKUP_BUCKET}/firestore/facility_data/${backupDate}_${now.getTime()}`;
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const authClient = await auth.getClient();

    const response = await authClient.request({
        url: `https://firestore.googleapis.com/v1/projects/${FIRESTORE_BACKUP_PROJECT_ID}/databases/(default):exportDocuments`,
        method: "POST",
        data: {
            collectionIds: ["daily_records", "users"],
            outputUriPrefix
        }
    });

    logger.info("Started facility data backup export", {
        backupDate,
        outputUriPrefix,
        operationName: response.data.name
    });
});
