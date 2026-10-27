const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const crypto = require("crypto");
const { readFileSync } = require("fs");
const path = require("path");
const { promisify } = require("util");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const nodemailer = require("nodemailer");
const { GoogleAuth } = require("google-auth-library");
const { decryptCredentials, encryptCredentials } = require("./line-credential-crypto");
const { isFamilyRecordRequest, latestPublishedRecords } = require("./line-family-records");
const {
    calculateServicePricing,
    getFacilityBillingServiceTypes,
    isShortStayService,
    validateFacilityServiceTypes
} = require("./service-types");
const {
    calculateInvoicePricing,
    normalizeOneTimeInvoiceAdjustment
} = require("./one-time-invoice-adjustment");
const { generateInvoicePdf } = require("./invoice-pdf");
const { findOverdueUnpaidInvoices } = require("./overdue-lock");
const { getTrialAccessEndsAt, isTrialAccessOpen, getPaymentGraceFields } = require("./trial-access");
const { LP_ANALYTICS_PROPERTY_ID, buildLpAnalyticsRequest, parseLpAnalyticsResponse } = require("./lp-analytics");
const { daysUntilTrialEnds, isTrialReminderDue } = require("./trial-reminder");
const { getFacilityRetentionDeadline, isFacilityRetentionExpired } = require("./facility-retention");

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
const COMMON_LINE_DISPLAY_NAME = "えこすまいる連絡帳";
const COMMON_LINE_BASIC_ID = "@805xgtzu";
const CURRENT_TERMS_VERSION = "2026-10-24-v1";
const LINE_RECORD_BASE_URL = "https://renrakucho-green.vercel.app/line-record.html";
const LINE_WEBHOOK_BASE_URL = "https://us-central1-renrakucho-app-6b157.cloudfunctions.net/facilityLineMessagingWebhook";
const COMMON_LINE_WEBHOOK_URL = "https://us-central1-renrakucho-app-6b157.cloudfunctions.net/lineMessagingWebhook";
const companyStampPng = readFileSync(path.join(__dirname, "company_stamp.png"));
const companyStampDataUrl = `data:image/png;base64,${companyStampPng.toString("base64")}`;
const scrypt = promisify(crypto.scrypt);
const ADMIN_LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const ADMIN_LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const FACILITY_PASSWORD_RESET_RATE_WINDOW_MS = 60 * 60 * 1000;
const FACILITY_PASSWORD_RESET_CODE_TTL_MS = 10 * 60 * 1000;

function escapeHtml(value) {
    return String(value || "").replace(/[&<>\"']/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[character]));
}

const PAYMENT_SUSPENSION_NOTICE = "お支払期限までにご入金を確認できない場合、期限の翌日からシステムのご利用が一時停止となります。あらかじめご了承ください。";
const FACILITY_RETENTION_NOTICE = "トライアル終了・一時停止から暦で2か月以内に本登録・再開が完了しない場合は退会扱いとなり、施設アカウント・利用者名簿・連絡帳・介護日誌・写真・動画を削除します。申込済み・承認待ち・入金待ちでも期限は延長されません。削除したデータは元に戻せません。";

function assertFacilityRetentionAvailable(facility) {
    if (facility.retentionDeletionStartedAt) {
        throw new HttpsError("failed-precondition", "保存期限を過ぎたため退会・削除処理中です。再開できません。");
    }
    let expired;
    try {
        expired = isFacilityRetentionExpired(facility, new Date());
    } catch (error) {
        logger.error("Invalid facility retention date", { error });
        throw new HttpsError("failed-precondition", "保存期限を確認できません。管理者へお問い合わせください。");
    }
    if (expired) {
        throw new HttpsError("failed-precondition", "終了・一時停止から2か月を過ぎています。退会・削除対象のため、本登録・再開はできません。");
    }
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
    if (!await verifyFacilityPassword(facility, password)) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    assertFacilityRetentionAvailable(data);
    if (data.usagePaused === true) {
        throw new HttpsError("permission-denied", "一時利用停止中です。再開をご希望の場合は管理者へお問い合わせください。");
    }
    let registrationOnly = false;
    if (data.subscriptionStatus === "trial") {
        const trialEndsAt = Date.parse(data.trialEndsAt || "");
        if (!Number.isFinite(trialEndsAt)) {
            throw new HttpsError("permission-denied", "無料お試し期間が終了しました。利用を続ける場合は販売元へお問い合わせください。");
        }
        registrationOnly = !isTrialAccessOpen(data);
    }
    if (data.status === "locked" && !registrationOnly) {
        if (data.lockReason === "payment_overdue") {
            throw new HttpsError("permission-denied", "お支払期限までにご入金を確認できなかったため、システムのご利用を一時停止しています。ご入金後、販売元へご連絡ください。");
        }
        throw new HttpsError("permission-denied", "現在、この施設のシステム利用を停止しています。詳しくは販売元へお問い合わせください。");
    }

    return {
        facilityId: facility.id,
        facilityName: data.facilityName || facility.id,
        registrationOnly,
        customToken: await getAuth().createCustomToken(facility.id, {
            role: "facility",
            ...(registrationOnly ? { registrationOnly: true } : {})
        })
    };
});

exports.createFacilitySessionForAdmin = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const facilityId = typeof request.data?.facilityId === "string" ? request.data.facilityId.trim() : "";
    if (!facilityId || facilityId.length > 200) {
        throw new HttpsError("invalid-argument", "施設IDが正しくありません。");
    }

    const facilitySnapshot = await getFirestore().collection("facilities").doc(facilityId).get();
    if (!facilitySnapshot.exists) {
        throw new HttpsError("not-found", "施設が見つかりません。");
    }
    const data = facilitySnapshot.data();
    assertFacilityRetentionAvailable(data);

    return {
        facilityId: facilitySnapshot.id,
        facilityName: data.facilityName || facilitySnapshot.id,
        customToken: await getAuth().createCustomToken(facilitySnapshot.id, { role: "facility" })
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
    if (!facility || matches.size > 1 || !await verifyFacilityPassword(facility, password)) {
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

async function hashFacilityPassword(password) {
    const salt = crypto.randomBytes(16);
    const derivedKey = await scrypt(password, salt, 64);
    return `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

function isSupportedFacilityPasswordHash(encodedHash) {
    if (typeof encodedHash !== "string") return false;
    const parts = encodedHash.split("$");
    return parts.length === 3 && parts[0] === "scrypt" &&
        /^[0-9a-f]{32}$/.test(parts[1]) && /^[0-9a-f]{128}$/.test(parts[2]);
}

async function verifyHashedFacilityPassword(password, encodedHash) {
    if (!isSupportedFacilityPasswordHash(encodedHash)) return false;
    const [, saltHex, keyHex] = encodedHash.split("$");
    const expected = Buffer.from(keyHex, "hex");
    const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

function plaintextPasswordsMatch(storedPassword, suppliedPassword) {
    if (typeof storedPassword !== "string" || typeof suppliedPassword !== "string") return false;
    const stored = Buffer.from(storedPassword);
    const supplied = Buffer.from(suppliedPassword);
    return stored.length === supplied.length && crypto.timingSafeEqual(stored, supplied);
}

async function verifyFacilityPassword(facilitySnapshot, suppliedPassword) {
    if (!facilitySnapshot?.exists || typeof suppliedPassword !== "string" || !suppliedPassword) return false;
    const db = getFirestore();
    const facilityRef = facilitySnapshot.ref;
    const credentialRef = db.collection("facilityCredentials").doc(facilitySnapshot.id);
    return db.runTransaction(async transaction => {
        const [latestFacility, credential] = await Promise.all([
            transaction.get(facilityRef),
            transaction.get(credentialRef)
        ]);
        if (!latestFacility.exists) return false;
        const passwordHash = credential.exists ? credential.data().passwordHash : null;
        if (passwordHash) return verifyHashedFacilityPassword(suppliedPassword, passwordHash);

        const legacyPassword = latestFacility.data().password;
        if (!plaintextPasswordsMatch(legacyPassword, suppliedPassword)) return false;
        if (latestFacility.data().retentionDeletionStartedAt) return true;
        transaction.set(credentialRef, {
            passwordHash: await hashFacilityPassword(suppliedPassword),
            updatedAt: FieldValue.serverTimestamp()
        });
        transaction.set(facilityRef, { password: FieldValue.delete() }, { merge: true });
        return true;
    });
}

async function enforceAdminLoginRateLimit(request, action, maxAttempts) {
    const ip = request.rawRequest?.ip;
    if (typeof ip !== "string" || !ip) {
        throw new HttpsError("failed-precondition", "認証元を確認できません。時間をおいて再度お試しください。");
    }
    const rateLimitId = crypto.createHash("sha256").update(`${action}:${ip}`).digest("hex");
    const limitRef = getFirestore().collection("adminLoginRateLimits").doc(rateLimitId);
    const now = Date.now();
    const allowed = await getFirestore().runTransaction(async transaction => {
        const snapshot = await transaction.get(limitRef);
        const data = snapshot.exists ? snapshot.data() : {};
        const windowStartedAt = Number(data.windowStartedAt) || now;
        const attempts = now - windowStartedAt >= ADMIN_LOGIN_RATE_WINDOW_MS ? 0 : Number(data.attempts) || 0;
        if (attempts >= maxAttempts) return false;
        const nextWindowStartedAt = attempts === 0 ? now : windowStartedAt;
        transaction.set(limitRef, {
            windowStartedAt: nextWindowStartedAt,
            attempts: attempts + 1,
            expiresAt: nextWindowStartedAt + ADMIN_LOGIN_RATE_WINDOW_MS
        });
        return true;
    });
    if (!allowed) {
        throw new HttpsError("resource-exhausted", "認証の試行回数が上限に達しました。15分後に再度お試しください。");
    }
}

function normalizeFacilityEmail(email) {
    return typeof email === "string" ? email.trim().toLowerCase() : "";
}

async function enforceFacilityPasswordResetRateLimit(request, key, maxAttempts) {
    const ip = request.rawRequest?.ip;
    if (typeof ip !== "string" || !ip) {
        throw new HttpsError("failed-precondition", "接続元を確認できません。時間をおいて再度お試しください。");
    }
    const rateLimitId = crypto.createHash("sha256").update(key).digest("hex");
    const limitRef = getFirestore().collection("facilityPasswordResetRateLimits").doc(rateLimitId);
    const now = Date.now();
    const allowed = await getFirestore().runTransaction(async transaction => {
        const snapshot = await transaction.get(limitRef);
        const data = snapshot.exists ? snapshot.data() : {};
        const windowStartedAt = Number(data.windowStartedAt) || now;
        const attempts = now - windowStartedAt >= FACILITY_PASSWORD_RESET_RATE_WINDOW_MS
            ? 0
            : Number(data.attempts) || 0;
        if (attempts >= maxAttempts) return false;
        const nextWindowStartedAt = attempts === 0 ? now : windowStartedAt;
        transaction.set(limitRef, {
            windowStartedAt: nextWindowStartedAt,
            attempts: attempts + 1,
            expiresAt: nextWindowStartedAt + FACILITY_PASSWORD_RESET_RATE_WINDOW_MS
        });
        return true;
    });
    if (!allowed) {
        throw new HttpsError("resource-exhausted", "確認コードの送信回数が上限に達しました。1時間後に再度お試しください。");
    }
}

exports.requestFacilityPasswordReset = onCall({
    secrets: [ADMIN_CONTROL_KEY, INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    const facilityName = typeof request.data?.facilityName === "string" ? request.data.facilityName.trim() : "";
    const email = normalizeFacilityEmail(request.data?.email);
    if (!facilityName || facilityName.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpsError("invalid-argument", "施設名と登録済みのメールアドレスを入力してください。");
    }

    const ip = request.rawRequest?.ip;
    await enforceFacilityPasswordResetRateLimit(request, `request:ip:${ip}`, 10);
    const emailHash = crypto.createHash("sha256").update(email).digest("hex");
    await enforceFacilityPasswordResetRateLimit(request, `request:email:${emailHash}`, 3);

    let challengeId = crypto.randomBytes(32).toString("hex");
    const facilities = getFirestore().collection("facilities");
    const matches = await facilities.where("facilityName", "==", facilityName).limit(2).get();
    let facility = matches.docs.length === 1 ? matches.docs[0] : null;
    if (matches.empty) {
        const legacyFacility = await facilities.doc(facilityName).get();
        if (legacyFacility.exists && (!legacyFacility.data().facilityName || legacyFacility.data().facilityName === facilityName)) {
            facility = legacyFacility;
        }
    }

    if (facility && matches.size <= 1 && normalizeFacilityEmail(facility.data().email) === email) {
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
        challengeId = crypto.randomBytes(32).toString("hex");
        const codeHash = crypto.createHmac("sha256", ADMIN_CONTROL_KEY.value())
            .update(`${challengeId}:${code}`).digest("hex");
        const challengeRef = getFirestore().collection("facilityPasswordResetChallenges").doc(challengeId);
        await challengeRef.set({
            facilityId: facility.id,
            email,
            codeHash,
            expiresAt: Date.now() + FACILITY_PASSWORD_RESET_CODE_TTL_MS,
            attempts: 0
        });

        const senderEmail = INVOICE_GMAIL_USER.value();
        try {
            const transporter = nodemailer.createTransport({
                service: "gmail",
                auth: { user: senderEmail, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
            });
            await transporter.sendMail({
                from: { name: "えこすまいる連絡帳", address: senderEmail },
                to: email,
                subject: "【えこすまいる連絡帳】パスワード再設定確認コード",
                text: `パスワード再設定確認コード：${code}\n\nこのコードは10分間有効です。心当たりがない場合は、このメールを破棄してください。`
            });
        } catch (error) {
            await challengeRef.delete();
            logger.error("Failed to send facility password reset code", { facilityId: facility.id, error });
        }
    }

    return { accepted: true, challengeId };
});

exports.completeFacilityPasswordReset = onCall({
    secrets: [ADMIN_CONTROL_KEY]
}, async request => {
    const challengeId = typeof request.data?.challengeId === "string" ? request.data.challengeId : "";
    const code = typeof request.data?.code === "string" ? request.data.code.trim() : "";
    const newPassword = typeof request.data?.newPassword === "string" ? request.data.newPassword : "";
    if (!/^[0-9a-f]{64}$/.test(challengeId) || !/^\d{6}$/.test(code)) {
        throw new HttpsError("invalid-argument", "確認コードが正しくありません。再度コードを送信してください。");
    }
    if (newPassword.length < 6 || newPassword.length > 200) {
        throw new HttpsError("invalid-argument", "新しいパスワードは6文字以上200文字以内で入力してください。");
    }

    await enforceAdminLoginRateLimit(request, "facility-password-reset-verification", 10);
    const db = getFirestore();
    const challengeRef = db.collection("facilityPasswordResetChallenges").doc(challengeId);
    const snapshot = await challengeRef.get();
    if (!snapshot.exists) {
        throw new HttpsError("unauthenticated", "確認コードが正しくないか、有効期限が切れています。最初からやり直してください。");
    }
    const challenge = snapshot.data();
    const providedHash = crypto.createHmac("sha256", ADMIN_CONTROL_KEY.value())
        .update(`${challengeId}:${code}`).digest("hex");
    const storedHash = typeof challenge.codeHash === "string" ? challenge.codeHash : "";
    const codeMatches = /^[0-9a-f]{64}$/.test(storedHash) &&
        crypto.timingSafeEqual(Buffer.from(providedHash, "hex"), Buffer.from(storedHash, "hex"));
    const passwordHash = codeMatches ? await hashFacilityPassword(newPassword) : null;
    const result = await db.runTransaction(async transaction => {
        const currentChallenge = await transaction.get(challengeRef);
        if (!currentChallenge.exists) return "invalid";
        const current = currentChallenge.data();
        if (Number(current.expiresAt) <= Date.now() || Number(current.attempts) >= 5) {
            transaction.delete(challengeRef);
            return "invalid";
        }
        if (!codeMatches || current.codeHash !== storedHash) {
            const attempts = Number(current.attempts) + 1;
            if (attempts >= 5) transaction.delete(challengeRef);
            else transaction.set(challengeRef, { attempts }, { merge: true });
            return "invalid";
        }

        const facilityRef = db.collection("facilities").doc(current.facilityId);
        const credentialRef = db.collection("facilityCredentials").doc(current.facilityId);
        const facility = await transaction.get(facilityRef);
        if (!facility.exists || normalizeFacilityEmail(facility.data().email) !== current.email) {
            transaction.delete(challengeRef);
            return "invalid";
        }
        assertFacilityRetentionAvailable(facility.data());
        transaction.set(credentialRef, {
            passwordHash,
            updatedAt: FieldValue.serverTimestamp()
        });
        transaction.set(facilityRef, { password: FieldValue.delete() }, { merge: true });
        transaction.delete(challengeRef);
        return "success";
    });
    if (result !== "success") {
        throw new HttpsError("unauthenticated", "確認コードが正しくないか、有効期限が切れています。最初からやり直してください。");
    }
    return { success: true };
});

exports.createAdminLoginChallenge = onCall({
    secrets: [ADMIN_CONTROL_KEY, INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    await enforceAdminLoginRateLimit(request, "challenge", 5);
    if (!secretsMatch(request.data?.adminKey, ADMIN_CONTROL_KEY.value())) {
        throw new HttpsError("unauthenticated", "管理者キーまたは確認コードが正しくありません。");
    }

    const adminEmail = INVOICE_GMAIL_USER.value();
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const challengeId = crypto.randomBytes(32).toString("hex");
    const codeHash = crypto.createHmac("sha256", ADMIN_CONTROL_KEY.value())
        .update(`${challengeId}:${code}`).digest("hex");
    const challengeRef = getFirestore().collection("adminLoginChallenges").doc(challengeId);
    await challengeRef.set({
        codeHash,
        expiresAt: Date.now() + ADMIN_LOGIN_CODE_TTL_MS,
        attempts: 0
    });

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: adminEmail, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
        });
        await transporter.sendMail({
            from: { name: "えこすまいる連絡帳 管理者認証", address: adminEmail },
            to: adminEmail,
            subject: "【えこすまいる連絡帳】管理者ログイン確認コード",
            text: `管理者ログイン確認コード：${code}\n\nこのコードは10分間有効です。心当たりがない場合は、このメールを破棄してください。`
        });
    } catch (error) {
        await challengeRef.delete();
        logger.error("Failed to send admin login verification code", { error });
        throw new HttpsError("internal", "確認コードをメール送信できませんでした。時間をおいて再度お試しください。");
    }
    return { challengeId };
});

exports.verifyAdminLoginCode = onCall({ secrets: [ADMIN_CONTROL_KEY] }, async request => {
    await enforceAdminLoginRateLimit(request, "verification", 10);
    const challengeId = typeof request.data?.challengeId === "string" ? request.data.challengeId : "";
    const code = typeof request.data?.code === "string" ? request.data.code : "";
    if (!/^[0-9a-f]{64}$/.test(challengeId) || !/^\d{6}$/.test(code)) {
        throw new HttpsError("unauthenticated", "管理者キーまたは確認コードが正しくありません。");
    }

    const challengeRef = getFirestore().collection("adminLoginChallenges").doc(challengeId);
    const isValid = await getFirestore().runTransaction(async transaction => {
        const snapshot = await transaction.get(challengeRef);
        if (!snapshot.exists) return false;
        const challenge = snapshot.data();
        if (Number(challenge.expiresAt) <= Date.now() || Number(challenge.attempts) >= 5) {
            transaction.delete(challengeRef);
            return false;
        }
        const providedHash = crypto.createHmac("sha256", ADMIN_CONTROL_KEY.value())
            .update(`${challengeId}:${code}`).digest("hex");
        if (!secretsMatch(providedHash, challenge.codeHash)) {
            transaction.set(challengeRef, { attempts: Number(challenge.attempts) + 1 }, { merge: true });
            return false;
        }
        transaction.delete(challengeRef);
        return true;
    });
    if (!isValid) {
        throw new HttpsError("unauthenticated", "管理者キーまたは確認コードが正しくありません。");
    }
    return {
        customToken: await getAuth().createCustomToken("admin-control-panel", {
            role: "admin",
            mfaVerified: true
        })
    };
});

exports.cleanExpiredAdminLoginData = onSchedule({
    schedule: "every day 03:00",
    // 起動直後の一時的な500などで実行自体が失敗したときは、数分後に自動で再実行する
    // （送信済み・送信中の記録で二重送信を防いでいるため、再実行しても重複しない）
    retryCount: 3,
    minBackoffSeconds: 120,
    maxBackoffSeconds: 600
}, async () => {
    const db = getFirestore();
    const now = Date.now();
    for (const collectionName of [
        "adminLoginChallenges",
        "adminLoginRateLimits",
        "facilityPasswordResetChallenges",
        "facilityPasswordResetRateLimits"
    ]) {
        while (true) {
            const expired = await db.collection(collectionName).where("expiresAt", "<=", now).limit(400).get();
            if (expired.empty) break;
            const batch = db.batch();
            expired.docs.forEach(document => batch.delete(document.ref));
            await batch.commit();
        }
    }
});

exports.migrateLegacyFacilityPasswords = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const facilities = await getFirestore().collection("facilities").get();
    let migrated = 0;
    let cleaned = 0;
    for (const facility of facilities.docs) {
        const facilityRef = facility.ref;
        const credentialRef = getFirestore().collection("facilityCredentials").doc(facility.id);
        const result = await getFirestore().runTransaction(async transaction => {
            const [latestFacility, credential] = await Promise.all([
                transaction.get(facilityRef),
                transaction.get(credentialRef)
            ]);
            if (!latestFacility.exists || latestFacility.data().retentionDeletionStartedAt ||
                typeof latestFacility.data().password !== "string") return "unchanged";
            const existingHash = credential.exists ? credential.data().passwordHash : null;
            const hasValidHash = isSupportedFacilityPasswordHash(existingHash);
            if (!hasValidHash) {
                transaction.set(credentialRef, {
                    passwordHash: await hashFacilityPassword(latestFacility.data().password),
                    updatedAt: FieldValue.serverTimestamp()
                });
            }
            transaction.set(facilityRef, { password: FieldValue.delete() }, { merge: true });
            return hasValidHash ? "cleaned" : "migrated";
        });
        if (result === "migrated") migrated++;
        if (result === "cleaned") cleaned++;
    }
    return { checked: facilities.size, migrated, cleaned };
});

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

exports.prepareLegacyStorageOwnership = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
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

exports.registerTrialFacility = onCall({
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    const acceptedTermsVersion = request.data?.acceptedTermsVersion;
    const facilityName = typeof request.data?.facilityName === "string" ? request.data.facilityName.trim() : "";
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    const email = typeof request.data?.email === "string" ? request.data.email.trim() : "";
    const phone = typeof request.data?.phone === "string" ? request.data.phone.trim() : "";
    const contactPerson = typeof request.data?.contactPerson === "string" ? request.data.contactPerson.trim() : "";
    if (acceptedTermsVersion !== CURRENT_TERMS_VERSION) {
        throw new HttpsError("failed-precondition", "最新の利用規約を確認し、同意してから登録してください。");
    }
    if (!facilityName || facilityName.length > 200 || password.length < 6 || password.length > 200 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone || phone.length > 50 ||
        !contactPerson || contactPerson.length > 100) {
        throw new HttpsError("invalid-argument", "施設名、6文字以上のパスワード、連絡先メール、電話番号、担当者名（100文字以内）を確認してください。");
    }

    const db = getFirestore();
    const matches = await db.collection("facilities").where("facilityName", "==", facilityName).limit(2).get();
    const legacyFacility = await db.collection("facilities").doc(facilityName).get();
    if (!matches.empty || legacyFacility.exists) {
        throw new HttpsError("already-exists", "その施設名は既に使用されています。");
    }
    const trialStartedAt = new Date();
    const trialEndsAt = new Date(trialStartedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    const trialEndDateFormatted = formatJapaneseDateKey(dateKey(getTokyoDateParts(trialEndsAt)));

    const facilityRef = await db.collection("facilities").add({
        facilityName,
        email,
        phone,
        contactPerson,
        status: "active",
        commonLineEnabled: false,
        basicInfoMenuEnabled: false,
        createdAt: trialStartedAt.toISOString(),
        subscriptionStatus: "trial",
        trialStartedAt: trialStartedAt.toISOString(),
        trialEndsAt: trialEndsAt.toISOString(),
        acceptedTermsVersion: CURRENT_TERMS_VERSION,
        termsAcceptedAt: new Date().toISOString()
    });
    try {
        await db.collection("facilityCredentials").doc(facilityRef.id).set({
            passwordHash: await hashFacilityPassword(password),
            updatedAt: FieldValue.serverTimestamp()
        });
    } catch (error) {
        await facilityRef.delete();
        throw error;
    }

    // トライアル申込施設への御礼とご利用案内のメールを即時送信
    let emailResult = null;
    try {
        const gmailUser = INVOICE_GMAIL_USER.value();
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: gmailUser, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
        });

        const subject = `【えこすまいる連絡帳】無料お試し登録ありがとうございます（${facilityName} 御中）`;
        const text = `${facilityName} 御中\n\nこのたびは「えこすまいる連絡帳」の無料お試し（トライアル）にお申し込みいただき、誠にありがとうございます。\n心より御礼申し上げます。\n\n本日から7日間の無料お試し期間がスタートいたしました。\n実際の業務に合わせて、連絡帳の作成やLINE連携の利便性をぜひご体験ください。\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n■ ご登録内容・お試し期間\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n施設名（ログインID）：${facilityName}\n無料お試し終了日　　：${trialEndDateFormatted}\nシステムログインURL ：https://renrakucho-green.vercel.app/login.html\n\n※ ログイン時はご登録いただいた「施設名」と「パスワード」を使用します。\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n■ 無料お試し終了後の進め方（本登録について）\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n無料お試し終了後も引き続きシステムをご利用いただく場合の手順は以下のとおりです。\n\n【ステップ1】画面から本登録をお申し込み\nお試し期間中、連絡帳画面上部に表示される「📝 本登録を申し込む」ボタンを押してください。\nボタンを押すと、本メールアドレス宛に初回利用分（1か月分）の請求書が自動発行されます。\n\n・初回ご請求金額：4,000円（税抜）／ 税込4,400円\n・2か月目以降　 ：月額5,000円（税抜）／ 税込5,500円\n・初回お支払期限：請求書発行から10日後\n※ A4印刷可能な請求書PDFがメールに添付されます。\n\n【ステップ2】ご利用料金のお振込み\n請求書に記載の振込先（PayPay銀行）へ利用料金をお振込みください。\n\n【ステップ3】本利用への自動継続\n弊社にて入金を確認次第、本利用へ切り替えいたします。\nお試し期間中に入力された利用者名簿や過去の連絡帳データはそのまま引き継がれ、中断することなく継続してご利用いただけます。\n\n※ 無料期間終了までにお申し込みがなかった場合、システムは自動的に停止し、費用が発生することはございません。\n\nご不明な点やお困りのことがございましたら、本メールへのご返信、または販売元までお気軽にお問い合わせください。\n今後とも「えこすまいる連絡帳」をどうぞよろしくお願い申し上げます。\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\n連絡先：${gmailUser}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        const serviceSelectionNotice = "本登録のお申し込み時に表示されるサービス一覧から、ご利用になるサービスにチェックを入れてください。\n1サービスの場合は従来の料金となり、2つ目以降は1サービスにつき税抜1,000円が加算されます。";
        const html = `<!doctype html><html lang="ja"><body style="font-family:sans-serif;color:#333;line-height:1.8;max-width:680px;margin:auto;padding:20px">
            <h2 style="color:#2b8a3e;border-bottom:2px solid #2b8a3e;padding-bottom:8px">無料お試し登録ありがとうございます</h2>
            <p><strong>${escapeHtml(facilityName)} 御中</strong></p>
            <p>このたびは「えこすまいる連絡帳」の無料お試し（トライアル）にお申し込みいただき、誠にありがとうございます。<br>心より御礼申し上げます。</p>
            <p>本日から7日間の無料お試し期間がスタートいたしました。<br>日々の連絡帳作成やご家族との連携など、実際の業務に合わせてぜひ使い心地をご体験ください。</p>

            <div style="background:#f1f8f2;border:1px solid #a5d6a7;border-radius:6px;padding:16px;margin:20px 0">
                <h3 style="margin-top:0;color:#2b8a3e;font-size:16px">■ ご登録内容・お試し期間</h3>
                <ul style="margin:0;padding-left:20px">
                    <li><strong>施設名（ログインID）：</strong>${escapeHtml(facilityName)}</li>
                    <li><strong>無料お試し終了日：</strong>${trialEndDateFormatted}</li>
                    <li><strong>ログイン画面：</strong><a href="https://renrakucho-green.vercel.app/login.html" target="_blank" rel="noopener noreferrer">https://renrakucho-green.vercel.app/login.html</a></li>
                </ul>
                <p style="margin:8px 0 0;font-size:13px;color:#555">※ ログインにはご登録の「施設名」と「パスワード」を使用します。</p>
            </div>

            <h3 style="color:#1864ab;border-left:4px solid #1864ab;padding-left:8px;margin-top:28px">■ トライアル終了後の進め方（本登録の流れ）</h3>
            <p>お試し期間終了後も継続してシステムをご利用いただく場合の手順をご案内いたします。</p>

            <div style="background:#f8f9fa;border:1px solid #ced4da;border-radius:6px;padding:16px;margin:15px 0">
                <h4 style="margin:0 0 8px;color:#222">① 画面上部から本登録を申し込む</h4>
                <p style="margin:0 0 8px;font-size:14px">連絡帳画面上部に表示されている「<strong>📝 本登録を申し込む</strong>」ボタンを押してください。<br>お申し込み後、本メールアドレス宛に初回利用分（1か月分）の請求書が即時発行・送信されます。</p>
                <ul style="margin:0;padding-left:20px;font-size:13px;color:#444">
                    <li>初回利用料金：<strong>4,000円（税抜）／ 税込4,400円</strong></li>
                    <li>2か月目以降：<strong>月額5,000円（税抜）／ 税込5,500円</strong></li>
                    <li>初回お支払期限：請求書発行から10日後（A4印刷用PDFをメールに添付）</li>
                </ul>
                <p style="margin:8px 0 0;font-size:13px;color:#444">${serviceSelectionNotice.replace(/\n/g, "<br>")}</p>
            </div>

            <div style="background:#f8f9fa;border:1px solid #ced4da;border-radius:6px;padding:16px;margin:15px 0">
                <h4 style="margin:0 0 8px;color:#222">② ご利用料金のお振込み</h4>
                <p style="margin:0;font-size:14px">請求書に記載されている振込先（PayPay銀行）へ利用料金をお振込みください。</p>
            </div>

            <div style="background:#f8f9fa;border:1px solid #ced4da;border-radius:6px;padding:16px;margin:15px 0">
                <h4 style="margin:0 0 8px;color:#222">③ 本利用への切り替え（データ引き継ぎ）</h4>
                <p style="margin:0;font-size:14px">入金を確認後、管理者側で本利用へ切り替えいたします。<br><strong>お試し期間中に入力された利用者名簿や連絡帳の記録はすべて保持され、そのまま継続してご利用いただけます。</strong></p>
            </div>

            <p style="font-size:13px;color:#666">※ 無料お試し期間中に本登録のお申し込みがなかった場合、期間終了後に自動的に利用停止となります。勝手に課金されることは一切ございませんのでご安心ください。</p>

            <p style="margin-top:24px">ご不明な点やお困りのことがございましたら、本メールへのご返信、またはお気軽にお問い合わせください。<br>今後ともどうぞよろしくお願い申し上げます。</p>

            <hr style="border:none;border-top:1px solid #dee2e6;margin:28px 0">
            <div style="font-size:12px;color:#666">
                <strong>株式会社えこすまいる</strong><br>
                〒719-1164 岡山県総社市西郡430-2<br>
                連絡先：${escapeHtml(gmailUser)}
            </div>
        </body></html>`;

        await transporter.sendMail({
            from: { name: "株式会社えこすまいる", address: gmailUser },
            to: email,
            subject,
            text: `${text}\n\n${serviceSelectionNotice}`,
            html
        });
    } catch (mailError) {
        logger.error("Failed to send trial welcome email", { facilityId: facilityRef.id, email, error: mailError });
    }

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
    if (!facilitySnapshot.exists || !currentPassword || !await verifyFacilityPassword(facilitySnapshot, currentPassword)) {
        throw new HttpsError("unauthenticated", "現在のパスワードが違います。");
    }
    if (newPassword.length < 6 || newPassword.length > 200) {
        throw new HttpsError("invalid-argument", "新しいパスワードは6文字以上で入力してください。");
    }
    await writeFacilityData(facilityRef, getFirestore().collection("facilityCredentials").doc(facilityId), {
        passwordHash: await hashFacilityPassword(newPassword),
        updatedAt: FieldValue.serverTimestamp()
    });
    return { success: true };
});

exports.changeFacilityEmail = onCall(async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    const currentPassword = typeof request.data?.currentPassword === "string" ? request.data.currentPassword : "";
    const newEmail = typeof request.data?.newEmail === "string" ? request.data.newEmail.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) || newEmail.length > 254) {
        throw new HttpsError("invalid-argument", "正しいメールアドレスを入力してください。");
    }
    const facilityRef = getFirestore().collection("facilities").doc(facilityId);
    const facilitySnapshot = await facilityRef.get();
    if (!facilitySnapshot.exists || !currentPassword || !await verifyFacilityPassword(facilitySnapshot, currentPassword)) {
        throw new HttpsError("unauthenticated", "現在の施設パスワードが違います。");
    }
    await facilityRef.update({ email: newEmail });
    return { email: newEmail };
});

exports.changeFacilityPhone = onCall(async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    const currentPassword = typeof request.data?.currentPassword === "string" ? request.data.currentPassword : "";
    const newPhone = typeof request.data?.newPhone === "string" ? request.data.newPhone.trim() : "";
    if (!newPhone || newPhone.length > 50) {
        throw new HttpsError("invalid-argument", "電話番号を入力してください。");
    }
    const facilityRef = getFirestore().collection("facilities").doc(facilityId);
    const facilitySnapshot = await facilityRef.get();
    if (!facilitySnapshot.exists || !currentPassword || !await verifyFacilityPassword(facilitySnapshot, currentPassword)) {
        throw new HttpsError("unauthenticated", "現在の施設パスワードが違います。");
    }
    await facilityRef.update({ phone: newPhone });
    return { phone: newPhone };
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
    if (!facilitySnapshot.exists || !await verifyFacilityPassword(facilitySnapshot, currentPassword)) {
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

exports.pauseFacilityUsage = onCall(async request => {
    const facilityId = requireFacilityDeletionId(request);
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    const db = getFirestore();
    const facilityRef = db.collection("facilities").doc(facilityId);
    const snapshot = await facilityRef.get();
    if (!snapshot.exists || !password || !await verifyFacilityPassword(snapshot, password)) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    await db.runTransaction(async transaction => {
        const [current, invoices] = await Promise.all([
            transaction.get(facilityRef),
            transaction.get(facilityRef.collection("invoiceHistory"))
        ]);
        if (!current.exists) throw new HttpsError("not-found", "施設情報が見つかりません。");
        assertFacilityRetentionAvailable(current.data());
        if (current.data().usagePaused === true) return;
        if (current.data().status === "locked") {
            throw new HttpsError("failed-precondition", "利用停止中です。管理者へお問い合わせください。");
        }
        if (invoices.docs.some(invoice => invoice.data().status === "sending")) {
            throw new HttpsError("failed-precondition", "請求書の発行処理中です。処理完了後に再度お試しください。");
        }
        transaction.set(facilityRef, {
            status: "locked",
            usagePaused: true,
            usagePausedAt: new Date().toISOString(),
            usageResumeRequestedAt: FieldValue.delete()
        }, { merge: true });
    });
    return { status: "paused" };
});

exports.resumeFacilityUsage = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const facilityId = typeof request.data?.facilityId === "string" ? request.data.facilityId.trim() : "";
    if (!facilityId || facilityId.length > 200 || facilityId.includes("/")) {
        throw new HttpsError("invalid-argument", "施設IDが正しくありません。");
    }
    const db = getFirestore();
    const facilityRef = db.collection("facilities").doc(facilityId);
    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(facilityRef);
        if (!snapshot.exists) throw new HttpsError("not-found", "施設情報が見つかりません。");
        const facility = snapshot.data();
        assertFacilityRetentionAvailable(facility);
        if (facility.usagePaused !== true) {
            throw new HttpsError("failed-precondition", "この施設は一時利用停止中ではありません。");
        }
        const now = new Date().toISOString();
        transaction.set(facilityRef, {
            status: "active",
            usagePaused: false,
            usageResumedAt: now,
            usageResumedBy: request.auth.uid,
            usageResumeRequestedAt: FieldValue.delete(),
            subscriptionStatus: "active",
            subscriptionApplicationStatus: "activated",
            billingAnchorAt: now,
            billingCycleId: crypto.randomBytes(8).toString("hex"),
            ...(facility.subscriptionStatus === "trial" ? {
                planActivatedAt: now
            } : {})
        }, { merge: true });
    });
    return { status: "active" };
});

exports.requestFacilityResumption = onCall(async request => {
    const facilityName = typeof request.data?.facilityName === "string" ? request.data.facilityName.trim() : "";
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    if (!facilityName || !password || facilityName.length > 200 || password.length > 200) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    const db = getFirestore();
    const matches = await db.collection("facilities").where("facilityName", "==", facilityName).limit(2).get();
    let facility = matches.docs.length === 1 ? matches.docs[0] : null;
    if (matches.empty && !facilityName.includes("/")) {
        const legacy = await db.collection("facilities").doc(facilityName).get();
        if (legacy.exists && (!legacy.data().facilityName || legacy.data().facilityName === facilityName)) facility = legacy;
    }
    if (!facility || matches.size > 1 || !await verifyFacilityPassword(facility, password)) {
        throw new HttpsError("unauthenticated", "施設名またはパスワードが違います。");
    }
    return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(facility.ref);
        if (!snapshot.exists || snapshot.data().usagePaused !== true) {
            throw new HttpsError("failed-precondition", "一時利用停止中の施設ではありません。通常のログインからご利用ください。");
        }
        const current = snapshot.data();
        assertFacilityRetentionAvailable(current);
        const requestedAt = current.usageResumeRequestedAt || new Date().toISOString();
        transaction.set(facility.ref, { usageResumeRequestedAt: requestedAt }, { merge: true });
        return { requestedAt, deadline: getFacilityRetentionDeadline(current).toISOString() };
    });
});

exports.activateFacilitySubscription = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const facilityId = typeof request.data?.facilityId === "string" ? request.data.facilityId.trim() : "";
    if (!facilityId || facilityId.length > 200 || facilityId.includes("/")) {
        throw new HttpsError("invalid-argument", "施設IDが正しくありません。");
    }
    const ref = getFirestore().collection("facilities").doc(facilityId);
    await getFirestore().runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new HttpsError("not-found", "施設が見つかりません。");
        const facility = snapshot.data();
        assertFacilityRetentionAvailable(facility);
        if (facility.usagePaused === true || facility.subscriptionStatus !== "trial") {
            throw new HttpsError("failed-precondition", "本登録への切替対象ではありません。一時停止中の場合は利用再開を承認してください。");
        }
        transaction.set(ref, {
            subscriptionStatus: "active", status: "active",
            subscriptionApplicationStatus: "activated", planActivatedAt: new Date().toISOString()
        }, { merge: true });
    });
    return { status: "active" };
});

exports.setFacilityUsageLock = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const facilityId = typeof request.data?.facilityId === "string" ? request.data.facilityId.trim() : "";
    if (!facilityId || facilityId.length > 200 || facilityId.includes("/") || typeof request.data?.locked !== "boolean") {
        throw new HttpsError("invalid-argument", "施設IDまたは利用状態が正しくありません。");
    }
    const ref = getFirestore().collection("facilities").doc(facilityId);
    await getFirestore().runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new HttpsError("not-found", "施設情報が見つかりません。");
        assertFacilityRetentionAvailable(snapshot.data());
        if (snapshot.data().usagePaused === true) {
            throw new HttpsError("failed-precondition", "一時停止中です。利用再開を承認してください。");
        }
        transaction.set(ref, request.data.locked
            ? { status: "locked" }
            : { status: "active", lockReason: FieldValue.delete() }, { merge: true });
    });
    return { status: request.data.locked ? "locked" : "active" };
});

function monthlyInvoiceKey(periodStart, facility) {
    return `${periodStart.replace(/-/g, "")}${facility.billingCycleId ? `-${facility.billingCycleId}` : ""}`;
}

// 管理画面に、LP（WordPress）の訪問者数を Google アナリティクスから読み込んで表示する
exports.getLpAnalyticsSummary = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    try {
        const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/analytics.readonly"] });
        const client = await auth.getClient();
        const response = await client.request({
            url: `https://analyticsdata.googleapis.com/v1beta/properties/${LP_ANALYTICS_PROPERTY_ID}:batchRunReports`,
            method: "POST",
            data: buildLpAnalyticsRequest()
        });
        return { ...parseLpAnalyticsResponse(response.data), fetchedAt: new Date().toISOString() };
    } catch (error) {
        const status = error?.response?.status;
        logger.error("Failed to load LP analytics", { status, message: String(error?.message || error).slice(0, 300) });
        if (status === 403) {
            throw new HttpsError("permission-denied", "Google アナリティクスを読む権限がありません。アナリティクスの設定を確認してください。");
        }
        throw new HttpsError("unavailable", "LPの訪問者数を読み込めませんでした。時間をおいてもう一度お試しください。");
    }
});

exports.previewFacilityDeletion = onCall(async request => {
    const facilityId = requireFacilityDeletionId(request);
    const facilitySnapshot = await getFirestore().collection("facilities").doc(facilityId).get();
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    if (!facilitySnapshot.exists || facilitySnapshot.data().status === "locked" ||
        !password || !await verifyFacilityPassword(facilitySnapshot, password)) {
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

exports.deleteFacilityAccount = onCall({
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    const facilityId = requireFacilityDeletionId(request);
    const password = typeof request.data?.password === "string" ? request.data.password : "";
    const confirmedFacilityName = typeof request.data?.confirmedFacilityName === "string" ? request.data.confirmedFacilityName.trim() : "";
    const facilityRef = getFirestore().collection("facilities").doc(facilityId);
    const facilitySnapshot = await facilityRef.get();
    if (!facilitySnapshot.exists || facilitySnapshot.data().status === "locked" ||
        !password || !await verifyFacilityPassword(facilitySnapshot, password)) {
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

    return executeFacilityCancellation(facilityId, plan);
});

async function executeFacilityCancellation(facilityId, plan, automatic = false) {
    const db = getFirestore();
    const facilityRef = db.collection("facilities").doc(facilityId);
    const facilityName = plan.facility.facilityName || facilityId;
    const cancellationRef = db.collection("facilityCancellations").doc(facilityId);
    const counts = plan.counts;
    await cancellationRef.set({
        facilityId,
        facilityName,
        status: "processing",
        reason: automatic ? "retention_expired" : "requested",
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
            db.collection("facilityLineSettings").doc(facilityId).delete(),
            db.collection("facilityCredentials").doc(facilityId).delete()
        ]);
        if (automatic) {
            try {
                await getAuth().deleteUser(facilityId);
            } catch (error) {
                if (error.code !== "auth/user-not-found") throw error;
            }
        }
        await db.runTransaction(async transaction => {
            transaction.delete(facilityRef);
            transaction.set(cancellationRef, { status: "completed", completedAt: new Date().toISOString() }, { merge: true });
        });
    } catch (error) {
        await cancellationRef.set({
            status: "failed",
            errorMessage: String(error.message || error).slice(0, 500),
            updatedAt: new Date().toISOString()
        }, { merge: true });
        throw new HttpsError("internal", "データ削除を完了できませんでした。管理者へお問い合わせください。");
    }

    const recipient = typeof plan.facility.email === "string" ? plan.facility.email.trim() : "";
    let thankYouEmailStatus = "failed";
    try {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
            throw new Error("Registered facility email is missing or invalid.");
        }
        const gmailUser = INVOICE_GMAIL_USER.value();
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: gmailUser, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
        });
        const email = await transporter.sendMail({
            from: { name: "株式会社えこすまいる", address: gmailUser },
            to: recipient,
            subject: "【えこすまいる連絡帳】ご利用のお礼と退会手続き完了のお知らせ",
            text: `${facilityName} 御中\n\nこれまで「えこすまいる連絡帳」をご利用いただき、誠にありがとうございました。\n日々の大切な記録と、ご家族とのつながりを支えるお手伝いをさせていただきましたこと、心より御礼申し上げます。\n\n${automatic ? "トライアル終了・一時停止から暦で2か月以内に本登録・再開が完了しなかったため、自動退会となりました。" : "お申し込みいただいた退会手続きと、"}施設アカウント・利用者名簿・連絡帳・関連ファイル等の削除処理が完了しました。\n削除したデータは元に戻せません。\nバックアップや退会処理の履歴等は、プライバシーポリシーおよび保存設定に従い、一定期間残る場合があります。\n\nご利用中にお寄せいただいたご意見やご協力に、重ねて感謝申し上げます。\n今後またお役に立てる機会がございましたら、幸いに存じます。\n皆様のますますのご健勝と、貴施設のご発展を心よりお祈り申し上げます。\n\nご不明な点がございましたら、本メールへの返信にてお問い合わせください。\n\n株式会社えこすまいる`
        });
        thankYouEmailStatus = "sent";
        await cancellationRef.set({
            thankYouEmailStatus,
            thankYouEmailSentAt: new Date().toISOString(),
            thankYouEmailMessageId: email.messageId
        }, { merge: true });
    } catch (error) {
        logger.error("Facility deleted but thank-you email or status recording failed", { facilityId, error });
        await cancellationRef.set({
            thankYouEmailStatus,
            thankYouEmailError: String(error.message || error).slice(0, 500)
        }, { merge: true }).catch(logError => logger.error("Failed to record cancellation email outcome", { facilityId, error: logError }));
    }
    return { facilityName, ...counts, deletedStorageFiles: storageResults.length, thankYouEmailStatus };
}

async function writeFacilityData(facilityRef, targetRef, fields) {
    await getFirestore().runTransaction(async transaction => {
        const current = await transaction.get(facilityRef);
        if (!current.exists || current.data().retentionDeletionStartedAt) {
            throw new HttpsError("failed-precondition", "施設アカウントは退会・削除処理中、または削除済みです。");
        }
        transaction.set(targetRef, fields, { merge: true });
    });
}

// 初回請求書の送信後：入金待ちにし、お支払期限の日の終わりまで施設が使えるようにする。
async function markInitialInvoicePending(facilityRef, dueDate) {
    await getFirestore().runTransaction(async transaction => {
        const current = await transaction.get(facilityRef);
        if (!current.exists || current.data().retentionDeletionStartedAt) {
            throw new HttpsError("failed-precondition", "施設アカウントは退会・削除処理中、または削除済みです。");
        }
        transaction.set(facilityRef, {
            subscriptionApplicationStatus: "pending_payment",
            ...getPaymentGraceFields(current.data(), dueDate)
        }, { merge: true });
    });
}

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
        if (!isTrialAccessOpen(facility)) {
            throw new HttpsError("permission-denied", "無料お試し期間が終了しています。");
        }
    }
}

function hashLineCode(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

async function getFacilityLineAccess(facilityId) {
    const db = getFirestore();
    const [facilitySnapshot, settingsSnapshot] = await Promise.all([
        db.collection("facilities").doc(facilityId).get(),
        db.collection("facilityLineSettings").doc(facilityId).get()
    ]);
    const facility = facilitySnapshot.exists ? facilitySnapshot.data() : {};
    const settings = settingsSnapshot.exists ? settingsSnapshot.data() : {};
    const dedicatedConfigured = settingsSnapshot.exists && settings.basicId !== COMMON_LINE_BASIC_ID;
    const commonLineEnabled = facilitySnapshot.exists && facility.commonLineEnabled !== false;
    const lineServiceEnabled = facilitySnapshot.exists && facility.lineServiceEnabled !== false;
    return {
        configured: dedicatedConfigured,
        facilitySettingsPresent: settingsSnapshot.exists,
        commonAccountConfiguredInFacility: settingsSnapshot.exists && !dedicatedConfigured,
        settings: dedicatedConfigured ? settings : {},
        commonLineEnabled,
        lineServiceEnabled,
        lineEnabled: lineServiceEnabled && (dedicatedConfigured || commonLineEnabled)
    };
}

async function requireFacilityLineAccess(facilityId) {
    const access = await getFacilityLineAccess(facilityId);
    if (!access.lineEnabled) {
        throw new HttpsError("failed-precondition", access.lineServiceEnabled
            ? "共通LINEの利用は停止されています。施設専用LINEを設定するか、管理者へお問い合わせください。"
            : "この施設のLINE連携は管理者により停止されています。管理者へお問い合わせください。");
    }
    return access;
}

exports.createLinePairingCode = onCall(async request => {
    const facilityId = requireFacilityId(request);
    const userName = typeof request.data?.userName === "string" ? request.data.userName.trim() : "";
    if (!userName || userName.length > 200) {
        throw new HttpsError("invalid-argument", "利用者を確認できません。");
    }
    await verifyFacilityIsActive(facilityId);
    const lineAccess = await requireFacilityLineAccess(facilityId);

    const userRef = getFirestore().collection("facilities").doc(facilityId).collection("users").doc(userName);
    const userSnapshot = await userRef.get();
    if (!userSnapshot.exists) {
        throw new HttpsError("not-found", "利用者名簿に登録されていません。");
    }

    const code = crypto.randomBytes(6).toString("hex").toUpperCase();
    await writeFacilityData(getFirestore().collection("facilities").doc(facilityId),
        getFirestore().collection("linePairingCodes").doc(hashLineCode(code)), {
        facilityId,
        userName,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });
    const lineSettings = lineAccess.settings;
    return {
        code,
        expiresInHours: 24,
        officialAccountName: lineAccess.configured ? lineSettings.displayName : COMMON_LINE_DISPLAY_NAME,
        officialAccountId: lineAccess.configured ? lineSettings.basicId : COMMON_LINE_BASIC_ID
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
        const facilitySnapshot = await transaction.get(db.collection("facilities").doc(pairing.facilityId));
        if (!facilitySnapshot.exists || facilitySnapshot.data().retentionDeletionStartedAt ||
            facilitySnapshot.data().lineServiceEnabled === false) {
            return { status: "disabled" };
        }
        if (!expectedFacilityId) {
            const settingsSnapshot = await transaction.get(db.collection("facilityLineSettings").doc(pairing.facilityId));
            const hasDedicatedSettings = settingsSnapshot.exists && settingsSnapshot.data().basicId !== COMMON_LINE_BASIC_ID;
            if (facilitySnapshot.data().commonLineEnabled === false || hasDedicatedSettings) {
                return { status: "disabled" };
            }
        } else {
            const settingsSnapshot = await transaction.get(db.collection("facilityLineSettings").doc(pairing.facilityId));
            if (!settingsSnapshot.exists || settingsSnapshot.data().basicId === COMMON_LINE_BASIC_ID) return { status: "disabled" };
        }
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
        if (facilitySnapshot.data().lineAgencyStatus === "pending") {
            transaction.set(db.collection("facilities").doc(pairing.facilityId),
                lineAgencyStatusUpdate(facilitySnapshot.data(), "completed"), { merge: true });
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
        body: JSON.stringify({ replyToken, messages: [{ type: "text", text,
            quickReply: { items: [{ type: "action", action: {
                type: "message", label: "連絡帳を見る", text: "連絡帳を見る"
            } }] }
        }] })
    });
    if (!response.ok) {
        logger.warn("LINE webhook reply failed", { status: response.status });
    }
}

function getFamilyVisibleFields(record, formCustomization) {
    const fields = [];
    const hiddenSections = new Set(Array.isArray(record.hiddenFormSections) ? record.hiddenFormSections : []);
    const allowedFamilyFieldIds = new Set((Array.isArray(formCustomization?.customFields) ? formCustomization.customFields : [])
        .filter(field => field && field.familyVisible === true && typeof field.id === "string")
        .map(field => field.id));
    const hiddenFieldGroups = {
        careJournalArea: new Set(["careStaff", "careJournal", "handoverRequired", "medicalVisit", "conditionChange", "handoverNote"]),
        dayServiceSection: new Set(["careStaff", "temp1", "temp2", "pulse", "spo2", "bpHigh", "bpLow", "mealMain", "mealSub", "water", "medication", "oralCare", "bath", "bathReason", "training", "activity", "bowel", "bowel1", "bowel2", "bowel3"]),
        facilityMessageSection: new Set(["message"]),
        familyMessageSection: new Set(["familyMessage"]),
        facilityPRSection: new Set(["facilityPR"])
    };
    const isResidentialLayout = ["入所", "ユニット入所"].includes(record.serviceType) && record.recordLayout === "residential";
    if (record.serviceType === "グループホーム" || isResidentialLayout) hiddenFieldGroups.dayServiceSection.delete("careStaff");
    const add = (label, key) => {
        if (Object.entries(hiddenFieldGroups).some(([section, keys]) => hiddenSections.has(section) && keys.has(key))) return;
        if (hiddenSections.has("afterSchoolSection") && key.startsWith("afterSchool")) return;
        if (hiddenSections.has("lifeCareSection") && key.startsWith("lifeCare")) return;
        if (hiddenSections.has("groupHomeSection") && key.startsWith("gh")) return;
        if (hiddenSections.has("residentialSection") && key.startsWith("rs")) return;
        if (hiddenSections.has("dayServiceSection") && key.startsWith("ds")) return;
        if (hiddenSections.has("shortStaySection") && (key.startsWith("st") || key.startsWith("num_") || key.startsWith("free_item_"))) return;
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
            ["昼食", "afterSchoolLunch"], ["昼食の摂取量", "afterSchoolLunchIntake"],
            ["本日の活動", "afterSchoolActivityTags"], ["支援の5領域", "afterSchoolDomainTags"],
            ["活動内容", "afterSchoolSupport"],
            ["施設での様子", "afterSchoolEpisode"], ["次回利用予定日", "afterSchoolNextUseDate"],
            ["持ち物・お知らせ", "afterSchoolBelongings"], ["昨晩の睡眠時間", "afterSchoolHomeSleepHours"],
            ["昨晩の睡眠の様子", "afterSchoolHomeSleepQuality"], ["朝の様子", "afterSchoolMorningState"],
            ["保護者確認", "afterSchoolParentSign"], ["ご家族への連絡", "afterSchoolHandover"]
        ].forEach(([label, key]) => add(label, key));
    } else if (record.serviceType === "グループホーム") {
        [
            ["担当スタッフ", "careStaff"], ["介護日誌", "careJournal"],
            ["朝・測定時刻", "ghMorningTime"], ["朝・体温（℃）", "ghMorningTemp"],
            ["朝・脈拍（回/分）", "ghMorningPulse"], ["朝・酸素飽和度（%）", "ghMorningSpo2"],
            ["朝・血圧 上（mmHg）", "ghMorningBpHigh"], ["朝・血圧 下（mmHg）", "ghMorningBpLow"],
            ["夕・測定時刻", "ghEveningTime"], ["夕・体温（℃）", "ghEveningTemp"],
            ["夕・脈拍（回/分）", "ghEveningPulse"], ["夕・酸素飽和度（%）", "ghEveningSpo2"],
            ["夕・血圧 上（mmHg）", "ghEveningBpHigh"], ["夕・血圧 下（mmHg）", "ghEveningBpLow"],
            ["朝食", "ghMealBreakfast"], ["昼食", "ghMealLunch"], ["夕食", "ghMealDinner"],
            ["水分（1日合計・ml）", "ghWater"], ["口腔ケア", "ghOralCare"],
            ["朝の服薬・処置", "ghMedicationMorning"], ["昼の服薬・処置", "ghMedicationNoon"],
            ["夕・就寝前の服薬・処置", "ghMedicationEvening"],
            ["本日の排便", "ghBowel"], ["排便回数（回）", "ghBowelCount"],
            ["排便の時刻・状態", "ghBowelCondition"], ["最終排便日", "ghLastBowelDate"],
            ["排尿の回数・状態", "ghUrination"], ["本日の入浴・清潔保持", "ghBath"],
            ["入浴の様子・未実施理由", "ghBathNote"], ["睡眠・夜間の様子", "ghSleep"],
            ["一緒に行った家事・ご本人の役割", "ghRoles"],
            ["得意なこと・参加時の様子・支援内容", "ghRoleResponse"],
            ["日中の活動・暮らしの様子", "ghDailyLife"],
            ["日用品の残量・補充依頼", "ghSupplies"], ["新しく持ち込んだ衣類・物品の確認", "ghBelongings"]
        ].forEach(([label, key]) => add(label, key));
    } else if (isResidentialLayout) {
        [
            ["担当スタッフ", "careStaff"], ["介護日誌", "careJournal"],
            ["朝・測定時刻", "rsMorningTime"], ["朝・体温（℃）", "rsMorningTemp"],
            ["朝・脈拍（回/分）", "rsMorningPulse"], ["朝・酸素飽和度（%）", "rsMorningSpo2"],
            ["朝・血圧 上（mmHg）", "rsMorningBpHigh"], ["朝・血圧 下（mmHg）", "rsMorningBpLow"],
            ["夕・測定時刻", "rsEveningTime"], ["夕・体温（℃）", "rsEveningTemp"],
            ["夕・脈拍（回/分）", "rsEveningPulse"], ["夕・酸素飽和度（%）", "rsEveningSpo2"],
            ["夕・血圧 上（mmHg）", "rsEveningBpHigh"], ["夕・血圧 下（mmHg）", "rsEveningBpLow"],
            ["朝食", "rsMealBreakfast"], ["昼食", "rsMealLunch"], ["夕食", "rsMealDinner"],
            ["水分（1日合計・ml）", "rsWater"], ["口腔ケア", "rsOralCare"],
            ["朝の服薬・処置", "rsMedicationMorning"], ["昼の服薬・処置", "rsMedicationNoon"],
            ["夕・就寝前の服薬・処置", "rsMedicationEvening"],
            ["本日の排便", "rsBowel"], ["排便回数（回）", "rsBowelCount"],
            ["排便の時刻・状態", "rsBowelCondition"], ["最終排便日", "rsLastBowelDate"],
            ["排尿の回数・状態", "rsUrination"], ["本日の入浴・清潔保持", "rsBath"],
            ["入浴の様子・未実施理由", "rsBathNote"], ["睡眠・夜間の様子", "rsSleep"],
            ["日中の活動・レクリエーション", "rsDailyActivity"], ["ご本人の様子・表情・会話", "rsDailyState"],
            ["日用品の残量・補充のお願い", "rsSupplies"], ["お預かりした衣類・物品", "rsBelongings"],
            ["面会・外出の記録", "rsVisit"]
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
    } else if (isShortStayService(record.serviceType)) {
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
            ["担当スタッフ", "careStaff"], ["利用状況", "dsAttendance"],
            ["お迎え時刻", "dsPickupTime"], ["お送り時刻", "dsDropoffTime"],
            ["行きの送迎", "dsPickupType"], ["帰りの送迎", "dsDropoffType"], ["送迎の補足", "dsTransportNote"],
            ["体温", "temp1"], ["体温（途中）", "temp2"],
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
    for (const field of Array.isArray(record.customFields) ? record.customFields : []) {
        if (!field || field.familyVisible !== true || !allowedFamilyFieldIds.has(field.id) || typeof field.label !== "string") continue;
        const value = field.type === "checkbox"
            ? field.value === true ? "はい" : "いいえ"
            : String(field.value ?? "");
        if (value.trim()) fields.push({ label: field.label, value });
    }
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
    const expirationDate = link.expiresAt?.toDate ? link.expiresAt.toDate() : new Date(link.expiresAt);
    const createdAt = link.createdAt?.toDate ? link.createdAt.toDate() : new Date(link.createdAt);
    const expiration = Number.isFinite(createdAt.getTime())
        ? new Date(Math.min(expirationDate.getTime(), createdAt.getTime() + 3 * 24 * 60 * 60 * 1000))
        : expirationDate;
    if (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()) {
        throw new HttpsError("unauthenticated", "閲覧リンクが無効か、有効期限が切れています。");
    }
    const lineAccess = await getFacilityLineAccess(link.facilityId);
    const sharedLink = link.lineAccountType === "shared" || (!link.lineAccountType && !lineAccess.configured);
    if (!lineAccess.lineEnabled || (sharedLink && !lineAccess.commonLineEnabled)) {
        throw new HttpsError("permission-denied", "この施設のLINEによる閲覧は停止されています。施設へお問い合わせください。");
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
    if (userSnapshot.exists && userSnapshot.data().photoNg !== true &&
        !record.hiddenFormSections?.includes("mediaSection")) {
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
        fields: getFamilyVisibleFields(record, facilitySnapshot.exists ? facilitySnapshot.data().formCustomization : undefined),
        attachments
    };
});

exports.getFacilityAccessStatus = onCall(async request => {
    const facilityId = requireFacilityId(request);
    const snapshot = await getFirestore().collection("facilities").doc(facilityId).get();
    return { status: !snapshot.exists ? "missing" : snapshot.data().status === "locked" ? "locked" : "active" };
});

exports.updateFacilityServiceTypes = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const facilityId = typeof request.data?.facilityId === "string" ? request.data.facilityId : "";
    const serviceTypes = validateFacilityServiceTypes(request.data?.serviceTypes);
    if (!facilityId || facilityId.length > 200 || !serviceTypes) {
        throw new HttpsError("invalid-argument", "施設と使用するサービスを確認してください。");
    }
    const facilityRef = getFirestore().collection("facilities").doc(facilityId);
    const facilitySnapshot = await facilityRef.get();
    if (!facilitySnapshot.exists) throw new HttpsError("not-found", "施設が見つかりません。");
    await facilityRef.update({
        enabledServiceTypes: serviceTypes,
        serviceTypesUpdatedAt: new Date().toISOString()
    });
    return { serviceTypes };
});

exports.updateFacilityBillingServiceTypes = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const facilityId = typeof request.data?.facilityId === "string" ? request.data.facilityId.trim() : "";
    const serviceTypes = validateFacilityServiceTypes(request.data?.serviceTypes);
    if (!facilityId || facilityId.length > 200 || !serviceTypes) {
        throw new HttpsError("invalid-argument", "施設と請求対象サービスを確認してください。");
    }
    const facilityRef = getFirestore().collection("facilities").doc(facilityId);
    const facilitySnapshot = await facilityRef.get();
    if (!facilitySnapshot.exists) throw new HttpsError("not-found", "施設が見つかりません。");
    await facilityRef.update({
        billingServiceTypes: serviceTypes,
        billingServiceTypesUpdatedAt: new Date().toISOString()
    });
    return { serviceTypes };
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
    const lineAccess = await getFacilityLineAccess(facilityId);
    return { recipientCount: lineUserIds.length, lineEnabled: lineAccess.lineEnabled };
});

exports.getFacilityLineSettingsStatus = onCall(async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    const access = await getFacilityLineAccess(facilityId);
    const settings = access.settings;
    return {
        configured: access.configured,
        facilitySettingsPresent: access.facilitySettingsPresent,
        commonAccountConfiguredInFacility: access.commonAccountConfiguredInFacility,
        commonLineEnabled: access.commonLineEnabled,
        lineEnabled: access.lineEnabled,
        displayName: access.commonAccountConfiguredInFacility ? COMMON_LINE_DISPLAY_NAME : settings.displayName || COMMON_LINE_DISPLAY_NAME,
        basicId: access.commonAccountConfiguredInFacility ? COMMON_LINE_BASIC_ID : settings.basicId || COMMON_LINE_BASIC_ID,
        webhookUrl: access.commonAccountConfiguredInFacility
            ? COMMON_LINE_WEBHOOK_URL
            : `${LINE_WEBHOOK_BASE_URL}/${encodeURIComponent(facilityId)}`
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
    if (botInfo.basicId === COMMON_LINE_BASIC_ID) {
        throw new HttpsError("failed-precondition", "共通LINEアカウントは施設専用設定に登録できません。管理者へお問い合わせください。");
    }

    const settingsRef = getFirestore().collection("facilityLineSettings").doc(facilityId);
    const currentSnapshot = await settingsRef.get();
    const previousBasicId = currentSnapshot.exists ? currentSnapshot.data().basicId : COMMON_LINE_BASIC_ID;
    const accountChanged = previousBasicId !== botInfo.basicId;
    await writeFacilityData(getFirestore().collection("facilities").doc(facilityId), settingsRef, {
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
    const db = getFirestore();
    const settingsRef = db.collection("facilityLineSettings").doc(facilityId);
    const settingsSnapshot = await settingsRef.get();
    const preserveFamilyLinks = settingsSnapshot.exists && settingsSnapshot.data().basicId === COMMON_LINE_BASIC_ID;
    await settingsRef.delete();
    if (!preserveFamilyLinks) {
        const users = await db.collection("facilities").doc(facilityId).collection("users").get();
        for (let offset = 0; offset < users.docs.length; offset += 400) {
            const batch = db.batch();
            users.docs.slice(offset, offset + 400).forEach(user => batch.update(user.ref, {
                lineUserIds: [],
                lineLinkedAt: FieldValue.delete()
            }));
            await batch.commit();
        }
    }
    return { removed: true, familyLinksPreserved: preserveFamilyLinks };
});

exports.sendLineRecordNotification = onCall(async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    await requireFacilityLineAccess(facilityId);
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
    const record = recordSnapshot.data();
    if (record.facilityId !== facilityId || record.userName !== userName ||
        record.date !== date || record.serviceType !== serviceType) {
        throw new HttpsError("permission-denied", "連絡帳を確認できません。");
    }
    const lineUserIds = Array.isArray(userSnapshot.data().lineUserIds) ? userSnapshot.data().lineUserIds : [];
    if (!lineUserIds.length) {
        throw new HttpsError("failed-precondition", "保護者のLINE連携がまだ完了していません。");
    }

    await recordSnapshot.ref.update({
        familyPublished: true,
        familyPublishedAt: FieldValue.serverTimestamp()
    });
    return { recipientCount: lineUserIds.length, published: true };
});

async function getFamilyRecordReply(lineUserId, expectedFacilityId) {
    const db = getFirestore();
    const facilities = expectedFacilityId
        ? [await db.collection("facilities").doc(expectedFacilityId).get()]
        : (await db.collection("facilities").where("status", "==", "active").get()).docs;
    const today = dateKey(getTokyoDateParts(new Date()));
    const available = [];
    let linked = false;
    let blocked = false;
    for (const facilityDocument of facilities) {
        if (!facilityDocument.exists) continue;
        const facility = facilityDocument.data();
        if (facility.status === "locked") continue;
        if (facility.subscriptionStatus === "trial" && !isTrialAccessOpen(facility)) continue;
        const users = await facilityDocument.ref.collection("users")
            .where("lineUserIds", "array-contains", lineUserId).get();
        if (facility.lineServiceEnabled === false) {
            if (!users.empty) blocked = true;
            continue;
        }
        if (!expectedFacilityId) {
            const settingsSnapshot = await db.collection("facilityLineSettings").doc(facilityDocument.id).get();
            if (settingsSnapshot.exists && settingsSnapshot.data().basicId !== COMMON_LINE_BASIC_ID) continue;
        }
        if (!expectedFacilityId && facility.commonLineEnabled === false) {
            if (!users.empty) blocked = true;
            continue;
        }
        if (!users.empty) linked = true;
        for (const userDocument of users.docs) {
            const records = await facilityDocument.ref.collection("daily_records")
                .where("userName", "==", userDocument.id).get();
            const matching = records.docs.filter(document => {
                const record = document.data();
                return record.facilityId === facilityDocument.id && record.userName === userDocument.id &&
                    typeof record.serviceType === "string" && record.serviceType.length <= 100 &&
                    document.id === `${record.date}_${record.serviceType}_${record.userName}`;
            }).map(document => document.data());
            for (const record of latestPublishedRecords(matching, today)) {
                available.push({ ...record, facilityName: facility.facilityName || facilityDocument.id });
            }
        }
    }
    if (!linked && blocked) return null;
    if (!linked) return "LINE連携が確認できません。施設から案内された連携コードを送信してください。";
    if (!available.length) return "公開済みの連絡帳はまだありません。時間をおいて再度ご確認ください。";
    const selected = available.sort((first, second) => second.date.localeCompare(first.date)).slice(0, 5);
    const links = await Promise.all(selected.map(async record => {
        const token = crypto.randomBytes(32).toString("hex");
        await writeFacilityData(db.collection("facilities").doc(record.facilityId),
            db.collection("lineRecordLinks").doc(hashLineCode(token)), {
            facilityId: record.facilityId,
            userName: record.userName,
            date: record.date,
            serviceType: record.serviceType,
            lineAccountType: expectedFacilityId ? "dedicated" : "shared",
            createdAt: FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
        });
        return `${record.facilityName}\n${record.userName} 様・${record.date}（${record.serviceType}）\n${LINE_RECORD_BASE_URL}?token=${token}`;
    }));
    return `最新の公開連絡帳です（最大5件・閲覧リンクは3日間有効）。\n\n${links.join("\n\n")}`;
}

exports.deleteExpiredLineLinks = onSchedule({
    schedule: "every day 04:30",
    timeZone: "Asia/Tokyo",
    maxInstances: 1,
    // 起動直後の一時的な500などで実行自体が失敗したときは、数分後に自動で再実行する
    // （送信済み・送信中の記録で二重送信を防いでいるため、再実行しても重複しない）
    retryCount: 3,
    minBackoffSeconds: 120,
    maxBackoffSeconds: 600
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
        if (event.replyToken && event.source?.userId && isFamilyRecordRequest(event)) {
            try {
                const reply = await getFamilyRecordReply(event.source.userId, expectedFacilityId);
                if (reply !== null) await replyToLine(event.replyToken, reply, credentials.channelAccessToken);
            } catch (error) {
                logger.error("LINE family record reply failed", { error });
                await replyToLine(event.replyToken, "連絡帳を取得できませんでした。時間をおいて再度お試しください。", credentials.channelAccessToken).catch(() => {});
            }
            continue;
        }
        if (event.type !== "message" || event.message?.type !== "text" || !event.replyToken || !event.source?.userId) continue;
        const code = event.message.text.trim().toUpperCase();
        if (!/^[A-F0-9]{12}$/.test(code)) continue;
        try {
            const result = await connectLineUser(code, event.source.userId, expectedFacilityId);
            if (result.status === "disabled") continue;
            const reply = result.status === "linked"
                ? `${result.userName} 様のLINE連携が完了しました。下の「連絡帳を見る」を押すと、公開済みの最新連絡帳を確認できます。施設からの自動通知はありません。`
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
    if (facilitySnapshot.data().lineServiceEnabled === false) return response.status(200).send("OK");
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

function getLatestMaturedBillingPeriod(createdAt, now, advanceDays = 10) {
    const registrationDate = createdAt && typeof createdAt.toDate === "function"
        ? createdAt.toDate()
        : new Date(createdAt);
    if (!Number.isFinite(registrationDate.getTime())) return null;

    const anchor = getTokyoDateParts(registrationDate);
    const todayKey = dateKey(getTokyoDateParts(now));
    let latestPeriod = null;
    for (let monthOffset = 1; monthOffset <= 1200; monthOffset++) {
        const startParts = addMonthsToAnchor(anchor, monthOffset - 1);
        const nextStartParts = addMonthsToAnchor(anchor, monthOffset);

        const startDateKey = dateKey(startParts);
        const sendTriggerDate = new Date(`${startDateKey}T00:00:00+09:00`);
        sendTriggerDate.setDate(sendTriggerDate.getDate() - advanceDays);
        const sendTriggerDateKey = dateKey(getTokyoDateParts(sendTriggerDate));

        if (sendTriggerDateKey > todayKey) break;

        const endDate = new Date(Date.UTC(Number(nextStartParts.year), Number(nextStartParts.month) - 1, Number(nextStartParts.day) - 1));
        const endParts = {
            year: String(endDate.getUTCFullYear()),
            month: String(endDate.getUTCMonth() + 1).padStart(2, "0"),
            day: String(endDate.getUTCDate()).padStart(2, "0")
        };
        latestPeriod = {
            startDate: startDateKey,
            endDate: dateKey(endParts)
        };
    }
    return latestPeriod;
}

function formatJapaneseDateKey(value) {
    const [year, month, day] = value.split("-").map(Number);
    return `${year}年${month}月${day}日`;
}

function buildInvoiceItemRows({ serviceTypes, itemTitle, billingPeriod, baseSubtotal, additionalServiceSubtotal, oneTimeAdjustment, lineAgencyFee, tax, total }) {
    const rows = [
        `<tr><td style="border:1px solid #adb5bd;padding:10px">利用サービス</td><td style="border:1px solid #adb5bd;padding:10px">${escapeHtml(serviceTypes.join("、"))}</td></tr>`,
        `<tr><td style="border:1px solid #adb5bd;padding:10px">${escapeHtml(itemTitle)}（${billingPeriod}分）</td><td style="border:1px solid #adb5bd;padding:10px">${baseSubtotal.toLocaleString("ja-JP")}円</td></tr>`
    ];
    if (additionalServiceSubtotal > 0) {
        rows.push(`<tr><td style="border:1px solid #adb5bd;padding:10px">追加サービス利用料</td><td style="border:1px solid #adb5bd;padding:10px">${additionalServiceSubtotal.toLocaleString("ja-JP")}円</td></tr>`);
    }
    if (oneTimeAdjustment) {
        rows.push(`<tr><td style="border:1px solid #adb5bd;padding:10px">${escapeHtml(oneTimeAdjustment.description)}</td><td style="border:1px solid #adb5bd;padding:10px">${oneTimeAdjustment.amount.toLocaleString("ja-JP")}円</td></tr>`);
    }
    if (lineAgencyFee) {
        rows.push(`<tr><td style="border:1px solid #adb5bd;padding:10px">${escapeHtml(lineAgencyFee.description)}</td><td style="border:1px solid #adb5bd;padding:10px">${lineAgencyFee.amount.toLocaleString("ja-JP")}円</td></tr>`);
    }
    rows.push(
        `<tr><td style="border:1px solid #adb5bd;padding:10px">消費税（10%）</td><td style="border:1px solid #adb5bd;padding:10px">${tax.toLocaleString("ja-JP")}円</td></tr>`,
        `<tr><th style="border:1px solid #adb5bd;padding:10px;text-align:left">合計</th><th style="border:1px solid #adb5bd;padding:10px;text-align:left">${total.toLocaleString("ja-JP")}円</th></tr>`
    );
    return rows.join("");
}

function buildInvoiceTextItems({ serviceTypes, itemTitle, billingPeriod, baseSubtotal, additionalServiceSubtotal, oneTimeAdjustment, lineAgencyFee, tax, total }) {
    return [
        `利用サービス：${serviceTypes.join("、")}`,
        `${itemTitle}${billingPeriod ? `（${billingPeriod}分）` : ""}：${baseSubtotal.toLocaleString("ja-JP")}円`,
        ...(additionalServiceSubtotal > 0 ? [`追加サービス利用料：${additionalServiceSubtotal.toLocaleString("ja-JP")}円`] : []),
        ...(oneTimeAdjustment ? [`${oneTimeAdjustment.description}：${oneTimeAdjustment.amount.toLocaleString("ja-JP")}円`] : []),
        ...(lineAgencyFee ? [`${lineAgencyFee.description}：${lineAgencyFee.amount.toLocaleString("ja-JP")}円`] : []),
        `消費税（10%）：${tax.toLocaleString("ja-JP")}円`,
        `税込合計：${total.toLocaleString("ja-JP")}円`
    ].join("\n");
}

async function finalizeOneTimeInvoiceAdjustment(db, facilityRef, adjustment) {
    if (!adjustment) return;
    await db.runTransaction(async transaction => {
        const facilitySnapshot = await transaction.get(facilityRef);
        if (!facilitySnapshot.exists) return;
        const facility = facilitySnapshot.data();
        const pendingAdjustment = normalizeOneTimeInvoiceAdjustment(facility.pendingInvoiceAdjustment);
        if (pendingAdjustment?.id !== adjustment.id) return;
        transaction.set(facilityRef, {
            pendingInvoiceAdjustment: FieldValue.delete(),
            lastConsumedInvoiceAdjustmentId: adjustment.id
        }, { merge: true });
    });
}

function lineAgencyStatusUpdate(facility, status) {
    return {
        lineAgencyStatus: status,
        lineAgencyStatusUpdatedAt: new Date().toISOString(),
        ...(status === "completed" ? { lineAgencyCompletedAt: FieldValue.serverTimestamp() } : {}),
        ...(status === "completed" && facility.lineAgencyFee?.status === "awaiting_completion"
            ? { lineAgencyFee: { ...facility.lineAgencyFee, status: "pending" } } : {}),
        ...(status === null && facility.lineAgencyFee?.status === "awaiting_completion"
            ? { lineAgencyFee: null } : {})
    };
}

function reserveLineAgencyFee(transaction, facilityRef, facility, invoiceRef) {
    const fee = facility.lineAgencyFee;
    if (!fee || !["pending", "reserved"].includes(fee.status)) return null;
    if (fee.status === "reserved" && fee.invoicePath !== invoiceRef.path) return null;
    const normalized = normalizeOneTimeInvoiceAdjustment(fee);
    transaction.set(facilityRef, {
        lineAgencyFee: { ...normalized, status: "reserved", invoicePath: invoiceRef.path }
    }, { merge: true });
    return normalized;
}

async function settleLineAgencyFee(db, facilityRef, invoiceRef, fee, sent) {
    if (!fee) return;
    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(facilityRef);
        const current = snapshot.data()?.lineAgencyFee;
        if (!current || current.id !== fee.id || current.status !== "reserved" || current.invoicePath !== invoiceRef.path) return;
        transaction.set(facilityRef, {
            lineAgencyFee: { ...current, status: sent ? "billed" : "pending",
                ...(sent ? { billedAt: FieldValue.serverTimestamp() } : { invoicePath: null }) }
        }, { merge: true });
    });
}

exports.updateFacilityLineAgencyStatus = onCall(async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const { facilityId, status } = request.data || {};
    if (typeof facilityId !== "string" || !facilityId || facilityId.length > 128 ||
        ![null, "pending", "completed"].includes(status)) {
        throw new HttpsError("invalid-argument", "施設と受付状況を確認してください。");
    }
    const db = getFirestore();
    const ref = db.collection("facilities").doc(facilityId);
    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new HttpsError("not-found", "施設情報が見つかりません。");
        const facility = snapshot.data();
        transaction.set(ref, lineAgencyStatusUpdate(facility, status), { merge: true });
    });
    return { status };
});

exports.requestLineAgencySetup = onCall({
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);
    if (request.data?.acceptedFeeAmount !== 3000) {
        throw new HttpsError("failed-precondition", "代行手数料は税抜3,000円（税込3,300円）です。画面を再読み込みし、料金をご確認のうえお申し込みください。");
    }

    const facilityName = typeof request.data?.facilityName === "string" ? request.data.facilityName.trim() : "";
    const email = typeof request.data?.email === "string" ? request.data.email.trim() : "";
    const phone = typeof request.data?.phone === "string" ? request.data.phone.trim() : "";
    const contactPerson = typeof request.data?.contactPerson === "string" ? request.data.contactPerson.trim() : "";

    if (!facilityName || facilityName.length > 200) {
        throw new HttpsError("invalid-argument", "施設名を入力してください。");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpsError("invalid-argument", "正しいメールアドレスを入力してください。");
    }
    if (!phone || phone.length > 50) {
        throw new HttpsError("invalid-argument", "LINEビジネスアカウント用で使用する電話番号を入力してください。");
    }
    if (!contactPerson || contactPerson.length > 100) {
        throw new HttpsError("invalid-argument", "ご担当者名を入力してください。");
    }

    const db = getFirestore();
    const facilityRef = db.collection("facilities").doc(facilityId);
    const requestedAt = new Date().toISOString();
    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(facilityRef);
        if (!snapshot.exists) throw new HttpsError("not-found", "施設情報が見つかりません。");
        const facility = snapshot.data();
        if (facility.lineAgencyStatus === "pending" ||
            (facility.lineAgencyFee && facility.lineAgencyFee.status !== "billed")) {
            throw new HttpsError("already-exists", "代行申込みは受付済み、または手数料の請求待ちです。管理者へお問い合わせください。");
        }
        transaction.set(facilityRef, {
            lineAgencyStatus: "pending",
            lineAgencyRequestedAt: requestedAt,
            lineAgencyContactPerson: contactPerson,
            lineAgencyEmail: email,
            lineAgencyPhone: phone,
            lineAgencyFee: {
                id: crypto.randomBytes(16).toString("hex"), description: "LINE連携設定代行手数料",
                amount: 3000, status: "awaiting_completion"
            }
        }, { merge: true });
    });

    let notificationStatus = "sent";
    // 管理者および施設側へメール通知
    try {
        const gmailUser = INVOICE_GMAIL_USER.value();
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: gmailUser, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
        });

        const feeNotice = "代行手数料は3,000円にて施設と家族様のLINE連携設定をさせて頂きます。\n税抜3,000円（税込3,300円）です。連携完了後、次に発行する請求書へ一度だけ加算します。";
        const adminMailText = `施設よりLINE連携代行の申込みがありました。\n\n施設名：${facilityName}\n施設ID：${facilityId}\n担当者名：${contactPerson} 様\n連絡先メール：${email}\nLINEビジネスアカウント用電話番号（認証用）：${phone}\n申込日時：${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}\n\n${feeNotice}\n\n管理者コントロールパネルにてご確認の上、連携設定またはサポートを行ってください。`;
        const facilityMailText = `${facilityName}\n${contactPerson} 様\n\nこのたびは「LINE連携代行申込み」をいただき、誠にありがとうございます。\n${feeNotice}\n\n■ お申込み内容\n施設名：${facilityName}\nご担当者名：${contactPerson} 様\nメールアドレス：${email}\n認証用電話番号：${phone}\n\n担当者より順次ご連絡、または設定作業を進めさせていただきます。\nLINE連携が完了すると、連絡帳画面で利用者様のお名前を選択した際に「保護者LINE：1件連携済み」と表示され、ご家族様がLINEから連絡帳を閲覧できるようになります。\n\n今しばらくお待ちくださいますようお願い申し上げます。\n\n株式会社えこすまいる\n連絡先：${gmailUser}`;

        await Promise.all([
            // 管理者宛て
            transporter.sendMail({
                from: { name: "えこすまいる連絡帳システム", address: gmailUser },
                to: gmailUser,
                subject: `【LINE連携代行申込み】${facilityName}（${contactPerson}様）`,
                text: adminMailText
            }),
            // 施設宛て自動返信
            transporter.sendMail({
                from: { name: "株式会社えこすまいる", address: gmailUser },
                to: email,
                subject: `【えこすまいる連絡帳】LINE連携代行のお申込みを受け付けました（${facilityName} 御中）`,
                text: facilityMailText
            })
        ]);
    } catch (mailError) {
        notificationStatus = "failed";
        logger.error("Failed to send line agency request notification emails", { facilityId, error: mailError });
    }

    return { success: true, status: "pending", notificationStatus };
});

exports.sendFacilityInquiry = onCall({
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    const facilityId = requireFacilityId(request);
    await verifyFacilityIsActive(facilityId);

    const facilityName = typeof request.data?.facilityName === "string" ? request.data.facilityName.trim() : "";
    const contactPerson = typeof request.data?.contactPerson === "string" ? request.data.contactPerson.trim() : "";
    const phone = typeof request.data?.phone === "string" ? request.data.phone.trim() : "";
    const email = typeof request.data?.email === "string" ? request.data.email.trim() : "";
    const message = typeof request.data?.message === "string" ? request.data.message.trim() : "";

    if (!facilityName || facilityName.length > 200) {
        throw new HttpsError("invalid-argument", "施設名を入力してください。");
    }
    if (!contactPerson || contactPerson.length > 100) {
        throw new HttpsError("invalid-argument", "ご担当者名を入力してください。");
    }
    if (!phone || phone.length > 50) {
        throw new HttpsError("invalid-argument", "ご連絡先電話番号を入力してください。");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new HttpsError("invalid-argument", "正しいメールアドレスを入力してください。");
    }
    if (!message || message.length > 3000) {
        throw new HttpsError("invalid-argument", "お問合せ内容を入力してください（3000文字以内）。");
    }

    const gmailUser = INVOICE_GMAIL_USER.value();
    const destinationEmail = "ecosmile39@gmail.com";

    const adminMailText = `施設よりお問合せが届きました。\n\n施設名：${facilityName}\n施設ID：${facilityId}\n担当者名：${contactPerson} 様\n電話番号：${phone}\n返信先メールアドレス：${email}\n受付日時：${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n【お問合せ内容】\n${message}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    const facilityMailText = `${facilityName}\n${contactPerson} 様\n\nこのたびは「えこすまいる連絡帳」へお問合せいただき、誠にありがとうございます。\n以下の内容でお問合せを受け付けいたしました。\n内容を確認の上、担当者より順次ご返信・ご連絡を差し上げます。\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n【お問合せ内容】\n施設名：${facilityName}\nご担当者名：${contactPerson} 様\nお電話番号：${phone}\nメールアドレス：${email}\n\n内容：\n${message}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n今しばらくお待ちくださいますようお願い申し上げます。\n\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\nメール：${destinationEmail}`;

    try {
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: gmailUser, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
        });

        await Promise.all([
            // 管理者宛て（ecosmile39@gmail.com）
            transporter.sendMail({
                from: { name: "えこすまいる連絡帳システム", address: gmailUser },
                to: destinationEmail,
                replyTo: email,
                subject: `【連絡帳お問合せ】${facilityName}（${contactPerson}様）`,
                text: adminMailText
            }),
            // 施設宛て控え
            transporter.sendMail({
                from: { name: "株式会社えこすまいる", address: gmailUser },
                to: email,
                subject: `【えこすまいる連絡帳】お問合せを受け付けました（${facilityName} 御中）`,
                text: facilityMailText
            })
        ]);

        // Firestoreに保存
        await getFirestore().collection("facilityInquiries").add({
            facilityId,
            facilityName,
            contactPerson,
            phone,
            email,
            message,
            createdAt: FieldValue.serverTimestamp()
        }).catch(err => logger.warn("Failed to log inquiry", err));

        return { success: true };
    } catch (error) {
        logger.error("Failed to send inquiry email", { facilityId, error });
        throw new HttpsError("internal", "お問合せメールを送信できませんでした。通信環境をご確認のうえ再試行してください。");
    }
});

async function notifyAdminOfSentInvoice({
    transporter, gmailUser, invoiceRef, facilityId, facilityName, recipient,
    invoiceNumber, billingPeriodStart, billingPeriodEnd, dueDate, total, textItems
}) {
    let notification;
    try {
        const result = await transporter.sendMail({
            from: { name: "えこすまいる連絡帳システム", address: gmailUser },
            to: "ecosmile39@gmail.com",
            subject: `【請求書送信完了】${facilityName} / ${invoiceNumber}`,
            text: `施設の請求書を送信しました。\n\n施設名：${facilityName}\n施設ID：${facilityId}\n送信先：${recipient}\n請求書番号：${invoiceNumber}\n請求対象期間：${formatJapaneseDateKey(billingPeriodStart)}〜${formatJapaneseDateKey(billingPeriodEnd)}\nご請求金額（税込）：${total.toLocaleString("ja-JP")}円\nお支払期限：${formatJapaneseDateKey(dueDate)}\n送信処理完了日時：${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}\n\n■ 請求明細（金額は税抜、合計は税込）\n${textItems}\n\nこれは請求書メールの送信処理完了通知です。施設での受信・開封や入金を確認した通知ではありません。\n管理画面：https://renrakucho-green.vercel.app/admin.html`
        });
        notification = {
            adminNotificationStatus: "sent",
            adminNotificationSentAt: FieldValue.serverTimestamp(),
            adminNotificationMessageId: result.messageId,
            adminNotificationFailureMessage: FieldValue.delete()
        };
    } catch (error) {
        logger.error("Invoice sent but administrator notification failed", { facilityId, invoiceNumber, error });
        notification = {
            adminNotificationStatus: "failed",
            adminNotificationFailedAt: FieldValue.serverTimestamp(),
            adminNotificationFailureMessage: String(error.message || error).slice(0, 500)
        };
    }
    await writeFacilityData(getFirestore().collection("facilities").doc(facilityId), invoiceRef, notification)
        .catch(error => logger.error("Failed to record invoice administrator notification status", {
            facilityId, invoiceNumber, error
        }));
}

exports.requestFacilitySubscription = onCall({
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    const facilityId = requireFacilityId(request);
    const serviceTypes = validateFacilityServiceTypes(request.data?.serviceTypes);
    if (!serviceTypes) {
        throw new HttpsError("invalid-argument", "請求対象サービスを1つ以上選択してください。");
    }
    const db = getFirestore();
    const facilityRef = db.collection("facilities").doc(facilityId);
    const invoiceRef = facilityRef.collection("invoiceHistory").doc("INITIAL");
    const initialFacilitySnapshot = await facilityRef.get();
    if (!initialFacilitySnapshot.exists) {
        throw new HttpsError("not-found", "施設情報が見つかりません。");
    }

    const initialFacility = initialFacilitySnapshot.data();
    assertFacilityRetentionAvailable(initialFacility);
    if (initialFacility.usagePaused === true) {
        throw new HttpsError("failed-precondition", "一時利用停止中は請求書を発行できません。管理者へ再開をご相談ください。");
    }
    if (initialFacility.subscriptionStatus !== "trial") {
        throw new HttpsError("failed-precondition", "この施設はトライアル中ではありません。");
    }
    const trialEndsAt = Date.parse(initialFacility.trialEndsAt || "");
    if (!Number.isFinite(trialEndsAt)) {
        throw new HttpsError("failed-precondition", "トライアル終了日を確認できません。販売元へお問い合わせください。");
    }
    const trialExpired = trialEndsAt <= Date.now();
    if (initialFacility.status === "locked" && !trialExpired) {
        throw new HttpsError("failed-precondition", "この施設は利用停止中です。販売元へお問い合わせください。");
    }

    const recipient = typeof initialFacility.email === "string" ? initialFacility.email.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        throw new HttpsError("failed-precondition", "施設の登録メールアドレスが確認できません。販売元へお問い合わせください。");
    }

    const requestedAt = initialFacility.subscriptionRequestedAt
        ? new Date(initialFacility.subscriptionRequestedAt)
        : new Date();
    const requestDateParts = getTokyoDateParts(requestedAt);
    const billingPeriodStart = dateKey(requestDateParts);
    const nextPeriodStartParts = addMonthsToAnchor(requestDateParts, 1);
    const billingPeriodEndDate = new Date(Date.UTC(
        Number(nextPeriodStartParts.year), Number(nextPeriodStartParts.month) - 1, Number(nextPeriodStartParts.day) - 1
    ));
    const billingPeriodEnd = dateKey({
        year: String(billingPeriodEndDate.getUTCFullYear()),
        month: String(billingPeriodEndDate.getUTCMonth() + 1).padStart(2, "0"),
        day: String(billingPeriodEndDate.getUTCDate()).padStart(2, "0")
    });
    const billingAnchorAt = new Date(`${dateKey(nextPeriodStartParts)}T00:00:00+09:00`).toISOString();
    const issueDate = dateKey(getTokyoDateParts(new Date()));
    const dueDateValue = new Date(`${issueDate}T00:00:00+09:00`);
    dueDateValue.setDate(dueDateValue.getDate() + 10);
    const dueDate = dateKey(getTokyoDateParts(dueDateValue));
    const invoiceNumber = `INIT-${billingPeriodStart.replace(/-/g, "")}-${facilityId.toUpperCase()}`;

    const reservation = await db.runTransaction(async transaction => {
        const [facilitySnapshot, invoiceSnapshot] = await Promise.all([
            transaction.get(facilityRef),
            transaction.get(invoiceRef)
        ]);
        if (!facilitySnapshot.exists || facilitySnapshot.data().subscriptionStatus !== "trial" ||
            facilitySnapshot.data().usagePaused === true) {
            throw new HttpsError("failed-precondition", "この施設はトライアル中ではありません。");
        }
        const facility = facilitySnapshot.data();
        const currentTrialEnd = Date.parse(facility.trialEndsAt || "");
        assertFacilityRetentionAvailable(facility);
        const currentTrialExpired = Number.isFinite(currentTrialEnd) && currentTrialEnd <= Date.now();
        if (facility.status === "locked" && !currentTrialExpired) {
            throw new HttpsError("failed-precondition", "この施設は利用停止中です。販売元へお問い合わせください。");
        }
        if (invoiceSnapshot.exists) {
            const invoice = invoiceSnapshot.data();
            if (invoice.status === "sent") {
                const invoicedServiceTypes = validateFacilityServiceTypes(invoice.serviceTypes);
                transaction.set(facilityRef, {
                    ...(invoicedServiceTypes ? {
                        enabledServiceTypes: invoicedServiceTypes,
                        billingServiceTypes: invoicedServiceTypes,
                        enabledServiceTypesUpdatedAt: new Date().toISOString(),
                        billingServiceTypesUpdatedAt: new Date().toISOString()
                    } : {}),
                    subscriptionApplicationStatus: "pending_payment",
                    ...getPaymentGraceFields(facility, invoice.dueDate),
                    subscriptionRequestedAt: facility.subscriptionRequestedAt || requestedAt.toISOString(),
                    billingAnchorAt: facility.billingAnchorAt || billingAnchorAt
                }, { merge: true });
                return { shouldSend: false };
            }
            const attemptStartedAt = invoice.attemptStartedAt && typeof invoice.attemptStartedAt.toDate === "function"
                ? invoice.attemptStartedAt.toDate().getTime()
                : 0;
            if (invoice.status === "sending" && Date.now() - attemptStartedAt < 60 * 60 * 1000) {
                return { shouldSend: false };
            }
        }

        const lineAgencyFee = reserveLineAgencyFee(transaction, facilityRef, facility, invoiceRef);
        const pricing = calculateInvoicePricing(4000, serviceTypes, null, lineAgencyFee);
        transaction.set(facilityRef, {
            enabledServiceTypes: serviceTypes,
            billingServiceTypes: serviceTypes,
            enabledServiceTypesUpdatedAt: new Date().toISOString(),
            billingServiceTypesUpdatedAt: new Date().toISOString()
        }, { merge: true });
        transaction.set(invoiceRef, {
            test: false,
            type: "initial",
            status: "sending",
            facilityId,
            facilityName: facility.facilityName || facilityId,
            serviceTypes,
            recipient,
            invoiceNumber,
            issueDate,
            dueDate,
            billingPeriodStart,
            billingPeriodEnd,
            lineAgencyFee,
            additionalServiceSubtotal: pricing.additionalServiceSubtotal,
            subtotal: pricing.subtotal,
            tax: pricing.tax,
            total: pricing.total,
            attemptStartedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.set(facilityRef, {
            subscriptionApplicationStatus: "invoice_sending",
            subscriptionRequestedAt: facility.subscriptionRequestedAt || requestedAt.toISOString(),
            billingAnchorAt: facility.billingAnchorAt || billingAnchorAt
        }, { merge: true });
        return { shouldSend: true, serviceTypes, ...pricing };
    });

    if (!reservation.shouldSend) {
        return { status: "pending_payment", invoiceNumber };
    }

    const facilityName = initialFacility.facilityName || facilityId;
    const formattedPeriod = `${formatJapaneseDateKey(billingPeriodStart)}〜${formatJapaneseDateKey(billingPeriodEnd)}`;
    const gmailUser = INVOICE_GMAIL_USER.value();
    const { additionalServiceSubtotal, lineAgencyFee = null, subtotal, tax, total } = reservation;
    const invoiceRows = buildInvoiceItemRows({
        serviceTypes,
        itemTitle: "初回システム利用料",
        billingPeriod: formattedPeriod,
        baseSubtotal: 4000,
        additionalServiceSubtotal,
        lineAgencyFee,
        tax,
        total
    });
    const textItems = buildInvoiceTextItems({
        serviceTypes,
        itemTitle: "初回システム利用料",
        billingPeriod: formattedPeriod,
        baseSubtotal: 4000,
        additionalServiceSubtotal,
        lineAgencyFee,
        tax,
        total
    });
    const html = `<!doctype html><html lang="ja"><body style="font-family:sans-serif;color:#222;line-height:1.7;max-width:720px;margin:auto;padding:24px">
        <p>${escapeHtml(facilityName)} 御中</p><h1 style="text-align:center">請求書</h1>
        <p>請求書番号：${escapeHtml(invoiceNumber)}<br>請求対象期間：${formatJapaneseDateKey(billingPeriodStart)}〜${formatJapaneseDateKey(billingPeriodEnd)}<br>発行日：${formatJapaneseDateKey(issueDate)}<br>お支払期限：${formatJapaneseDateKey(dueDate)}</p>
        <p style="font-size:20px;font-weight:bold">ご請求金額（税込）　${total.toLocaleString("ja-JP")}円</p>
        <table style="width:100%;border-collapse:collapse"><thead><tr><th style="border:1px solid #adb5bd;padding:10px;text-align:left">内容</th><th style="border:1px solid #adb5bd;padding:10px;text-align:left">金額</th></tr></thead><tbody>
        ${invoiceRows}</tbody></table>
        <div style="margin-top:28px"><h2>発行元</h2><p>株式会社えこすまいる<br>〒719-1164 岡山県総社市西郡430-2<br>連絡先：${escapeHtml(gmailUser)}<br>適格請求書発行事業者登録番号：なし</p></div>
        <h2>お振込先</h2><p>PayPay銀行<br>店番号：005 ／ 支店名：ビジネス営業部<br>普通 2088889<br>口座名義：カ）エコスマイル</p>
        <p style="margin-top:20px;padding:12px;background:#e7f5ff;border-radius:4px;border:1px solid #74c0fc"><strong>【A4印刷用PDF添付】</strong><br>A4サイズで印刷可能な請求書PDF（<code>請求書_${escapeHtml(invoiceNumber)}.pdf</code>）を本メールに添付しております。印刷して保管される際などにご活用ください。</p>
        <p style="margin-top:20px;padding:12px;background:#fff5f5;border:1px solid #ffa8a8;border-radius:4px;color:#c92a2a;font-weight:bold">${escapeHtml(PAYMENT_SUSPENSION_NOTICE)}</p>
        <p style="margin-top:28px">このたびは本登録をお申し込みいただき、誠にありがとうございます。ご利用をお申し込みくださったことに心より感謝申し上げます。入金確認後、本利用へ切り替えいたします。今後ともどうぞよろしくお願い申し上げます。</p>
        <p>${escapeHtml(FACILITY_RETENTION_NOTICE)}</p>
    </body></html>`;
    const text = `${facilityName} 御中\n請求書番号：${invoiceNumber}\n請求対象期間：${formattedPeriod}\n発行日：${formatJapaneseDateKey(issueDate)}\nお支払期限：${formatJapaneseDateKey(dueDate)}\n${textItems}\n\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\nPayPay銀行 ビジネス営業部（005） 普通 2088889\n口座名義：カ）エコスマイル\n\n【ご注意】${PAYMENT_SUSPENSION_NOTICE}\n\n※ A4印刷用の請求書PDF（請求書_${invoiceNumber}.pdf）を本メールに添付しております。\n\nこのたびは本登録をお申し込みいただき、誠にありがとうございます。ご利用をお申し込みくださったことに心より感謝申し上げます。入金確認後、本利用へ切り替えいたします。今後ともどうぞよろしくお願い申し上げます。\n\n${FACILITY_RETENTION_NOTICE}`;

    let emailResult = null;
    const archivedHtml = html;
    try {
        const pdfBuffer = await generateInvoicePdf({
            facilityName,
            invoiceNumber,
            issueDate: formatJapaneseDateKey(issueDate),
            dueDate: formatJapaneseDateKey(dueDate),
            billingPeriod: formattedPeriod,
            itemTitle: "初回システム利用料",
            serviceTypes,
            additionalServiceSubtotal,
            lineAgencyFee,
            subtotal,
            tax,
            total,
            issuerEmail: gmailUser,
            note: `${PAYMENT_SUSPENSION_NOTICE}\nこのたびは本登録をお申し込みいただき、誠にありがとうございます。ご利用をお申し込みくださったことに心より感謝申し上げます。入金確認後、本利用へ切り替えいたします。今後ともどうぞよろしくお願い申し上げます。`
        });
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: gmailUser, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
        });
        emailResult = await transporter.sendMail({
            from: { name: "株式会社えこすまいる", address: gmailUser },
            to: recipient,
            subject: `【初回請求書】${facilityName} 御中 / ${invoiceNumber}`,
            text,
            html,
            attachments: [
                { filename: `請求書_${invoiceNumber}.pdf`, content: pdfBuffer, contentType: "application/pdf" }
            ]
        });
        await notifyAdminOfSentInvoice({
            transporter, gmailUser, invoiceRef, facilityId, facilityName, recipient,
            invoiceNumber, billingPeriodStart, billingPeriodEnd, dueDate, total, textItems
        });
        await Promise.all([
            writeFacilityData(facilityRef, invoiceRef, { status: "sent", invoiceHtml: archivedHtml, messageId: emailResult.messageId, sentAt: FieldValue.serverTimestamp() }),
            markInitialInvoicePending(facilityRef, dueDate),
            db.collection("invoiceEmailLogs").add({
                test: false,
                type: "initial",
                facilityId,
                facilityName,
                recipient,
                invoiceNumber,
                issueDate,
                dueDate,
                billingPeriodStart,
                billingPeriodEnd,
                serviceTypes,
                additionalServiceSubtotal,
                lineAgencyFee,
                subtotal,
                tax,
                total,
                sentAt: FieldValue.serverTimestamp(),
                messageId: emailResult.messageId
            })
        ]);
        await settleLineAgencyFee(db, facilityRef, invoiceRef, lineAgencyFee, true);
        return { status: "pending_payment", invoiceNumber, recipient };
    } catch (error) {
        if (emailResult) {
            await Promise.all([
                writeFacilityData(facilityRef, invoiceRef, { status: "sent", invoiceHtml: archivedHtml, messageId: emailResult.messageId, sentAt: FieldValue.serverTimestamp() }),
                markInitialInvoicePending(facilityRef, dueDate)
            ]).catch(logError => logger.error("Failed to finalize sent initial invoice", logError));
            await settleLineAgencyFee(db, facilityRef, invoiceRef, lineAgencyFee, true)
                .catch(logError => logger.error("Failed to finalize LINE agency fee", { facilityId, error: logError }));
            logger.error("Initial invoice email was sent but finalization failed", { facilityId, recipient, error });
            if (error.code === "failed-precondition") throw error;
            return { status: "pending_payment", invoiceNumber, recipient };
        }
        await Promise.all([
            writeFacilityData(facilityRef, invoiceRef, { status: "failed", failedAt: FieldValue.serverTimestamp(), failureMessage: String(error.message || error).slice(0, 500) }),
            writeFacilityData(facilityRef, facilityRef, { subscriptionApplicationStatus: "invoice_failed" })
        ]).catch(logError => logger.error("Failed to record initial invoice failure", logError));
        await settleLineAgencyFee(db, facilityRef, invoiceRef, lineAgencyFee, false)
            .catch(logError => logger.error("Failed to release LINE agency fee", { facilityId, error: logError }));
        logger.error("Failed to send initial subscription invoice", { facilityId, recipient, error });
        throw new HttpsError("internal", "初回請求書を送信できませんでした。販売元へお問い合わせください。");
    }
});

exports.issueFacilityInvoiceForAdmin = onCall({
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
        throw new HttpsError("unauthenticated", "管理者としてログインしてください。");
    }
    const facilityId = typeof request.data?.facilityId === "string" ? request.data.facilityId.trim() : "";
    if (!facilityId || facilityId.length > 128) {
        throw new HttpsError("invalid-argument", "施設を特定できません。");
    }

    const db = getFirestore();
    const facilityRef = db.collection("facilities").doc(facilityId);
    const facilitySnapshot = await facilityRef.get();
    if (!facilitySnapshot.exists) {
        throw new HttpsError("not-found", "施設情報が見つかりません。");
    }
    const facility = facilitySnapshot.data();
    assertFacilityRetentionAvailable(facility);
    if (facility.usagePaused === true) {
        throw new HttpsError("failed-precondition", "一時利用停止中は請求書を発行できません。先に利用再開を承認してください。");
    }
    const isInitialInvoice = facility.subscriptionStatus === "trial";
    if (!isInitialInvoice && facility.status !== "active") {
        throw new HttpsError("failed-precondition", "利用中の本登録施設ではないため、月額請求書を発行できません。");
    }

    const facilityName = facility.facilityName || facilityId;
    const recipient = typeof facility.email === "string" ? facility.email.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        throw new HttpsError("failed-precondition", "施設の登録メールアドレスが確認できません。");
    }

    const now = new Date();
    const issueDate = dateKey(getTokyoDateParts(now));
    const dueDateValue = new Date(`${issueDate}T00:00:00+09:00`);
    dueDateValue.setDate(dueDateValue.getDate() + 10);
    const dueDate = dateKey(getTokyoDateParts(dueDateValue));
    let billingPeriodStart;
    let billingPeriodEnd;
    let invoiceNumber;
    let baseSubtotal;
    let invoiceType;

    if (isInitialInvoice) {
        const requestedAt = facility.subscriptionRequestedAt
            ? new Date(facility.subscriptionRequestedAt)
            : now;
        const requestDateParts = getTokyoDateParts(requestedAt);
        billingPeriodStart = dateKey(requestDateParts);
        const nextPeriodStartParts = addMonthsToAnchor(requestDateParts, 1);
        const endDate = new Date(Date.UTC(
            Number(nextPeriodStartParts.year), Number(nextPeriodStartParts.month) - 1, Number(nextPeriodStartParts.day) - 1
        ));
        billingPeriodEnd = dateKey({
            year: String(endDate.getUTCFullYear()),
            month: String(endDate.getUTCMonth() + 1).padStart(2, "0"),
            day: String(endDate.getUTCDate()).padStart(2, "0")
        });
        invoiceNumber = `INIT-${billingPeriodStart.replace(/-/g, "")}-${facilityId.toUpperCase()}`;
        baseSubtotal = 4000;
        invoiceType = "initial";
    } else {
        const period = getLatestMaturedBillingPeriod(
            facility.billingAnchorAt || facility.planActivatedAt || facility.createdAt,
            now
        );
        if (!period) {
            throw new HttpsError("failed-precondition", "請求対象となる確定済みの月額期間がありません。");
        }
        billingPeriodStart = period.startDate;
        billingPeriodEnd = period.endDate;
        invoiceNumber = `INV-${monthlyInvoiceKey(period.startDate, facility)}-${facilityId.toUpperCase()}`;
        baseSubtotal = 5000;
        invoiceType = "monthly";
    }

    const invoiceRef = facilityRef.collection("invoiceHistory").doc(
        isInitialInvoice ? "INITIAL" : `AUTO-${monthlyInvoiceKey(billingPeriodStart, facility)}`
    );
    const gmailUser = INVOICE_GMAIL_USER.value();
    const reservation = await db.runTransaction(async transaction => {
        const [currentFacilitySnapshot, invoiceSnapshot] = await Promise.all([
            transaction.get(facilityRef),
            transaction.get(invoiceRef)
        ]);
        if (!currentFacilitySnapshot.exists) {
            throw new HttpsError("not-found", "施設情報が見つかりません。");
        }
        const currentFacility = currentFacilitySnapshot.data();
        assertFacilityRetentionAvailable(currentFacility);
        if (currentFacility.usagePaused === true ||
            currentFacility.billingCycleId !== facility.billingCycleId) {
            throw new HttpsError("failed-precondition", "利用状態または請求期間が変更されました。施設一覧を更新してください。");
        }
        if ((currentFacility.subscriptionStatus === "trial") !== isInitialInvoice) {
            throw new HttpsError("failed-precondition", "請求中に施設の契約状態が変更されました。施設一覧を更新してください。");
        }
        if (!isInitialInvoice && currentFacility.status !== "active") {
            throw new HttpsError("failed-precondition", "施設が利用中ではないため、月額請求書を発行できません。");
        }
        const serviceTypes = getFacilityBillingServiceTypes(currentFacility);
        const pendingAdjustment = normalizeOneTimeInvoiceAdjustment(currentFacility.pendingInvoiceAdjustment);
        const alreadyConsumed = Boolean(pendingAdjustment && pendingAdjustment.id === currentFacility.lastConsumedInvoiceAdjustmentId);
        const oneTimeAdjustment = alreadyConsumed ? null : pendingAdjustment;
        if (alreadyConsumed) {
            transaction.set(facilityRef, { pendingInvoiceAdjustment: FieldValue.delete() }, { merge: true });
        }
        if (invoiceSnapshot.exists) {
            const previousInvoice = invoiceSnapshot.data();
            if (previousInvoice.status === "sent") {
                throw new HttpsError("already-exists", "この請求対象期間の請求書はすでに発行済みです。請求書履歴をご確認ください。");
            }
            const attemptStartedAt = previousInvoice.attemptStartedAt && typeof previousInvoice.attemptStartedAt.toDate === "function"
                ? previousInvoice.attemptStartedAt.toDate().getTime()
                : 0;
            if (previousInvoice.status === "sending" && Date.now() - attemptStartedAt < 60 * 60 * 1000) {
                throw new HttpsError("already-exists", "この請求書は現在発行処理中です。しばらくしてから履歴をご確認ください。");
            }
        }
        const lineAgencyFee = reserveLineAgencyFee(transaction, facilityRef, currentFacility, invoiceRef);
        const pricing = calculateInvoicePricing(baseSubtotal, serviceTypes, oneTimeAdjustment, lineAgencyFee);
        transaction.set(invoiceRef, {
            test: false,
            type: invoiceType,
            status: "sending",
            facilityId,
            facilityName,
            serviceTypes,
            recipient,
            invoiceNumber,
            issueDate,
            dueDate,
            billingPeriodStart,
            billingPeriodEnd,
            oneTimeAdjustment,
            lineAgencyFee,
            additionalServiceSubtotal: pricing.additionalServiceSubtotal,
            subtotal: pricing.subtotal,
            tax: pricing.tax,
            total: pricing.total,
            manualIssuedBy: request.auth.uid,
            attemptStartedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        if (isInitialInvoice) {
            transaction.set(facilityRef, {
                subscriptionApplicationStatus: "invoice_sending",
                subscriptionRequestedAt: currentFacility.subscriptionRequestedAt || now.toISOString(),
                billingAnchorAt: currentFacility.billingAnchorAt || `${billingPeriodStart}T00:00:00+09:00`
            }, { merge: true });
        }
        return { serviceTypes, ...pricing };
    });
    if (!reservation) {
        throw new HttpsError("internal", "請求書の発行を開始できませんでした。");
    }

    const { serviceTypes, additionalServiceSubtotal, oneTimeAdjustment, lineAgencyFee = null, subtotal, tax, total } = reservation;
    const formattedPeriod = `${formatJapaneseDateKey(billingPeriodStart)}〜${formatJapaneseDateKey(billingPeriodEnd)}`;
    const amountLabel = isInitialInvoice ? "初回システム利用料" : "システム利用料";
    const closing = isInitialInvoice
        ? "本登録のお申し込みをいただき、誠にありがとうございます。ご入金確認後、本利用へ切り替えいたします。"
        : "平素よりシステムをご利用いただき、誠にありがとうございます。今後ともよろしくお願い申し上げます。";
    const invoiceRows = buildInvoiceItemRows({
        serviceTypes,
        itemTitle: amountLabel,
        billingPeriod: formattedPeriod,
        baseSubtotal,
        additionalServiceSubtotal,
        oneTimeAdjustment,
        lineAgencyFee,
        tax,
        total
    });
    const textItems = buildInvoiceTextItems({
        serviceTypes,
        itemTitle: amountLabel,
        billingPeriod: formattedPeriod,
        baseSubtotal,
        additionalServiceSubtotal,
        oneTimeAdjustment,
        lineAgencyFee,
        tax,
        total
    });
    const html = `<!doctype html><html lang="ja"><body style="font-family:sans-serif;color:#222;line-height:1.7;max-width:720px;margin:auto;padding:24px">
        <p>${escapeHtml(facilityName)} 御中</p><h1 style="text-align:center">請求書</h1>
        <p>請求書番号：${escapeHtml(invoiceNumber)}<br>請求対象期間：${formatJapaneseDateKey(billingPeriodStart)}〜${formatJapaneseDateKey(billingPeriodEnd)}<br>発行日：${formatJapaneseDateKey(issueDate)}<br>お支払期限：${formatJapaneseDateKey(dueDate)}</p>
        <p style="font-size:20px;font-weight:bold">ご請求金額（税込）　${total.toLocaleString("ja-JP")}円</p>
        <table style="width:100%;border-collapse:collapse"><thead><tr><th style="border:1px solid #adb5bd;padding:10px;text-align:left">内容</th><th style="border:1px solid #adb5bd;padding:10px;text-align:left">金額</th></tr></thead><tbody>
        ${invoiceRows}</tbody></table>
        <div style="margin-top:28px"><h2>発行元</h2><p>株式会社えこすまいる<br>〒719-1164 岡山県総社市西郡430-2<br>連絡先：${escapeHtml(gmailUser)}<br>適格請求書発行事業者登録番号：なし</p></div>
        <h2>お振込先</h2><p>PayPay銀行<br>店番号：005 ／ 支店名：ビジネス営業部<br>普通 2088889<br>口座名義：カ）エコスマイル</p>
        <p style="margin-top:20px;padding:12px;background:#e7f5ff;border:1px solid #74c0fc"><strong>A4印刷用の請求書PDFを添付しております。</strong></p>
        <p style="margin-top:20px;padding:12px;background:#fff5f5;border:1px solid #ffa8a8;border-radius:4px;color:#c92a2a;font-weight:bold">${escapeHtml(PAYMENT_SUSPENSION_NOTICE)}</p>
        <p style="margin-top:28px">${closing}</p></body></html>`;
    const text = `${facilityName} 御中\n請求書番号：${invoiceNumber}\n請求対象期間：${formattedPeriod}\n発行日：${formatJapaneseDateKey(issueDate)}\nお支払期限：${formatJapaneseDateKey(dueDate)}\n${textItems}\n\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\nPayPay銀行 ビジネス営業部（005） 普通 2088889\n口座名義：カ）エコスマイル\n\n【ご注意】${PAYMENT_SUSPENSION_NOTICE}\n\nA4印刷用の請求書PDFを添付しております。\n${closing}`;
    let emailResult = null;
    try {
        const pdfBuffer = await generateInvoicePdf({
            facilityName,
            invoiceNumber,
            issueDate: formatJapaneseDateKey(issueDate),
            dueDate: formatJapaneseDateKey(dueDate),
            billingPeriod: formattedPeriod,
            itemTitle: amountLabel,
            serviceTypes,
            additionalServiceSubtotal,
            oneTimeAdjustment,
            lineAgencyFee,
            subtotal,
            tax,
            total,
            issuerEmail: gmailUser,
            note: `${PAYMENT_SUSPENSION_NOTICE}\n${closing}`
        });
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: gmailUser, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
        });
        emailResult = await transporter.sendMail({
            from: { name: "株式会社えこすまいる", address: gmailUser },
            to: recipient,
            subject: `【${isInitialInvoice ? "初回" : ""}請求書】${facilityName} 御中 / ${invoiceNumber}`,
            text,
            html,
            attachments: [{ filename: `請求書_${invoiceNumber}.pdf`, content: pdfBuffer, contentType: "application/pdf" }]
        });
        await notifyAdminOfSentInvoice({
            transporter, gmailUser, invoiceRef, facilityId, facilityName, recipient,
            invoiceNumber, billingPeriodStart, billingPeriodEnd, dueDate, total, textItems
        });
        await Promise.all([
            writeFacilityData(facilityRef, invoiceRef, {
                status: "sent",
                invoiceHtml: html,
                messageId: emailResult.messageId,
                sentAt: FieldValue.serverTimestamp()
            }),
            db.collection("invoiceEmailLogs").add({
                test: false,
                type: invoiceType,
                manual: true,
                facilityId,
                facilityName,
                recipient,
                invoiceNumber,
                issueDate,
                dueDate,
                billingPeriodStart,
                billingPeriodEnd,
                serviceTypes,
                additionalServiceSubtotal,
                oneTimeAdjustment,
                lineAgencyFee,
                subtotal,
                tax,
                total,
                sentAt: FieldValue.serverTimestamp(),
                messageId: emailResult.messageId
            })
        ]);
        await finalizeOneTimeInvoiceAdjustment(db, facilityRef, oneTimeAdjustment);
        await settleLineAgencyFee(db, facilityRef, invoiceRef, lineAgencyFee, true);
        if (isInitialInvoice) {
            await markInitialInvoicePending(facilityRef, dueDate);
        }
        return { invoiceNumber, recipient, type: invoiceType };
    } catch (error) {
        if (emailResult) {
            await writeFacilityData(facilityRef, invoiceRef, {
                status: "sent",
                invoiceHtml: html,
                messageId: emailResult.messageId,
                sentAt: FieldValue.serverTimestamp()
            }).catch(logError => logger.error("Failed to finalize manually sent invoice", { facilityId, error: logError }));
            await finalizeOneTimeInvoiceAdjustment(db, facilityRef, oneTimeAdjustment)
                .catch(logError => logger.error("Failed to clear sent one-time invoice adjustment", { facilityId, error: logError }));
            await settleLineAgencyFee(db, facilityRef, invoiceRef, lineAgencyFee, true)
                .catch(logError => logger.error("Failed to finalize LINE agency fee", { facilityId, error: logError }));
            if (isInitialInvoice) {
                await markInitialInvoicePending(facilityRef, dueDate)
                    .catch(logError => logger.error("Failed to update initial invoice status", { facilityId, error: logError }));
            }
            logger.error("Manual invoice email sent but finalization failed", { facilityId, recipient, error });
            throw new HttpsError("internal", "請求書メールは送信済みですが、履歴の確定に失敗しました。重複送信を避けるため、請求書履歴をご確認ください。");
        }
        await writeFacilityData(facilityRef, invoiceRef, {
            status: "failed",
            failedAt: FieldValue.serverTimestamp(),
            failureMessage: String(error.message || error).slice(0, 500)
        }).catch(logError => logger.error("Failed to record manual invoice failure", { facilityId, error: logError }));
        await settleLineAgencyFee(db, facilityRef, invoiceRef, lineAgencyFee, false)
            .catch(logError => logger.error("Failed to release LINE agency fee", { facilityId, error: logError }));
        if (isInitialInvoice) {
            await writeFacilityData(facilityRef, facilityRef, { subscriptionApplicationStatus: "invoice_failed" })
                .catch(logError => logger.error("Failed to update failed initial invoice status", { facilityId, error: logError }));
        }
        logger.error("Failed to issue manual invoice", { facilityId, recipient, error });
        throw new HttpsError("internal", "請求書を発行できませんでした。請求書履歴をご確認のうえ、必要に応じて再試行してください。");
    }
});

exports.sendTestInvoiceEmail = onCall({
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async request => {
    const { facilityId } = request.data || {};
    if (request.auth?.token.role !== "admin" || request.auth.token.mfaVerified !== true) {
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
    const serviceTypes = getFacilityBillingServiceTypes(facility);
    const oneTimeAdjustment = normalizeOneTimeInvoiceAdjustment(facility.pendingInvoiceAdjustment);
    const lineAgencyFee = facility.lineAgencyFee?.status === "pending"
        ? normalizeOneTimeInvoiceAdjustment(facility.lineAgencyFee) : null;
    const pricing = calculateInvoicePricing(5000, serviceTypes, oneTimeAdjustment, lineAgencyFee);
    const now = new Date();
    const dateParts = getTokyoDateParts(now);
    const issueDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const dueDateValue = new Date(Date.UTC(
        Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day) + 10
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
        <p style="font-size:20px;font-weight:bold">ご請求金額（税込）　${pricing.total.toLocaleString("ja-JP")}円</p>
        <table style="width:100%;border-collapse:collapse"><thead><tr><th style="border:1px solid #adb5bd;padding:10px;text-align:left">内容</th><th style="border:1px solid #adb5bd;padding:10px;text-align:left">金額</th></tr></thead><tbody>
        ${buildInvoiceItemRows({
            serviceTypes,
            itemTitle: "システム利用料",
            billingPeriod: billingMonth,
            baseSubtotal: 5000,
            additionalServiceSubtotal: pricing.additionalServiceSubtotal,
            oneTimeAdjustment,
            lineAgencyFee,
            tax: pricing.tax,
            total: pricing.total
        })}</tbody></table>
        <div style="margin-top:28px"><h2>発行元</h2><p>株式会社えこすまいる<br>〒719-1164 岡山県総社市西郡430-2<br>連絡先：${escapeHtml(gmailUser)}<br>適格請求書発行事業者登録番号：なし</p></div>
        <h2>お振込先</h2><p>PayPay銀行<br>店番号：005 ／ 支店名：ビジネス営業部<br>普通 2088889<br>口座名義：カ）エコスマイル</p>
        <p style="margin-top:20px;padding:12px;background:#e7f5ff;border-radius:4px;border:1px solid #74c0fc"><strong>【A4印刷用PDF添付】</strong><br>A4サイズで印刷可能なテスト請求書PDF（<code>テスト請求書_${escapeHtml(invoiceNumber)}.pdf</code>）を本メールに添付しております。</p>
        <p style="background:#fff4e6;padding:12px">これは送信テストです。実際の請求・お支払いは発生しません。</p>
        <p>平素よりシステムをご利用いただき、誠にありがとうございます。今後ともどうぞよろしくお願い申し上げます。</p>
    </body></html>`;
    const textItems = buildInvoiceTextItems({
        serviceTypes,
        itemTitle: "システム利用料",
        billingPeriod: billingMonth,
        baseSubtotal: 5000,
        additionalServiceSubtotal: pricing.additionalServiceSubtotal,
        oneTimeAdjustment,
        lineAgencyFee,
        tax: pricing.tax,
        total: pricing.total
    });
    const text = `${facilityName} 御中\nテスト請求書（実請求ではありません）\n請求書番号：${invoiceNumber}\n発行日：${formatJapaneseDate(dateParts)}\n支払期限：${formatJapaneseDate(dueParts)}\n${textItems}\n\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\nPayPay銀行 ビジネス営業部（005） 普通 2088889\n口座名義：カ）エコスマイル\n\n※ A4印刷用の請求書PDFを本メールに添付しております。\n\nこれは送信テストです。実際の請求・お支払いは発生しません。\n\n平素よりシステムをご利用いただき、誠にありがとうございます。今後ともどうぞよろしくお願い申し上げます。`;

    try {
        const pdfBuffer = await generateInvoicePdf({
            facilityName,
            invoiceNumber,
            issueDate: formatJapaneseDate(dateParts),
            dueDate: formatJapaneseDate(dueParts),
            billingPeriod: `${billingMonth}分`,
            itemTitle: "システム利用料",
            serviceTypes,
            additionalServiceSubtotal: pricing.additionalServiceSubtotal,
            oneTimeAdjustment,
            lineAgencyFee,
            subtotal: pricing.subtotal,
            tax: pricing.tax,
            total: pricing.total,
            issuerEmail: gmailUser,
            note: "これは送信テストです。実際の請求・お支払いは発生しません。"
        });
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
            attachments: [
                {
                    filename: `テスト請求書_${invoiceNumber}.pdf`,
                    content: pdfBuffer,
                    contentType: "application/pdf"
                }
            ]
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
            serviceTypes,
            additionalServiceSubtotal: pricing.additionalServiceSubtotal,
            oneTimeAdjustment,
            lineAgencyFee,
            subtotal: pricing.subtotal,
            tax: pricing.tax,
            total: pricing.total,
            sentAt: FieldValue.serverTimestamp(),
            messageId: result.messageId,
            invoiceHtml: html
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
    // 起動直後の一時的な500などで実行自体が失敗したときは、数分後に自動で再実行する
    // （送信済み・送信中の記録で二重送信を防いでいるため、再実行しても重複しない）
    retryCount: 3,
    minBackoffSeconds: 120,
    maxBackoffSeconds: 600,
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async () => {
    const db = getFirestore();
    const now = new Date();
    const issueDate = dateKey(getTokyoDateParts(now));
    const dueDateValue = new Date(`${issueDate}T00:00:00+09:00`);
    dueDateValue.setDate(dueDateValue.getDate() + 10);
    const invoiceDueDate = dateKey(getTokyoDateParts(dueDateValue));
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
        if (facility.subscriptionStatus === "trial" || facility.usagePaused === true) {
            skippedCount++;
            continue;
        }
        const recipient = typeof facility.email === "string" ? facility.email.trim() : "";
        if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
            skippedCount++;
            logger.warn("Skipping monthly invoice: facility email is missing or invalid", { facilityId });
            continue;
        }

        const period = getLatestMaturedBillingPeriod(
            facility.billingAnchorAt || facility.planActivatedAt || facility.createdAt,
            now
        );
        if (!period) {
            skippedCount++;
            const billingStart = facility.billingAnchorAt || facility.planActivatedAt || facility.createdAt;
            const billingStartTime = billingStart && typeof billingStart.toDate === "function"
                ? billingStart.toDate().getTime()
                : new Date(billingStart).getTime();
            if (Number.isFinite(billingStartTime)) {
                logger.info("Skipping monthly invoice: no billing period is due yet", { facilityId });
            } else {
                logger.warn("Skipping monthly invoice: facility registration date is missing or invalid", { facilityId });
            }
            continue;
        }

        const historyRef = db.collection("facilities").doc(facilityId)
            .collection("invoiceHistory").doc(`AUTO-${monthlyInvoiceKey(period.startDate, facility)}`);
        const facilityRef = facilityDocument.ref;
        const reservation = await db.runTransaction(async transaction => {
            const [currentFacilitySnapshot, historySnapshot] = await Promise.all([
                transaction.get(facilityRef),
                transaction.get(historyRef)
            ]);
            if (!currentFacilitySnapshot.exists) return null;
            const currentFacility = currentFacilitySnapshot.data();
            if (currentFacility.status !== "active" || currentFacility.subscriptionStatus === "trial" ||
                currentFacility.usagePaused === true || currentFacility.billingCycleId !== facility.billingCycleId) return null;
            if (historySnapshot.exists) {
                const history = historySnapshot.data();
                if (history.status === "sent") return null;
                const attemptStartedAt = history.attemptStartedAt && typeof history.attemptStartedAt.toDate === "function"
                    ? history.attemptStartedAt.toDate().getTime()
                    : 0;
                if (history.status === "sending" && Date.now() - attemptStartedAt < 60 * 60 * 1000) return null;
            }
            const serviceTypes = getFacilityBillingServiceTypes(currentFacility);
            const pendingAdjustment = normalizeOneTimeInvoiceAdjustment(currentFacility.pendingInvoiceAdjustment);
            const alreadyConsumed = Boolean(pendingAdjustment && pendingAdjustment.id === currentFacility.lastConsumedInvoiceAdjustmentId);
            const oneTimeAdjustment = alreadyConsumed ? null : pendingAdjustment;
            if (alreadyConsumed) {
                transaction.set(facilityRef, { pendingInvoiceAdjustment: FieldValue.delete() }, { merge: true });
            }
            const lineAgencyFee = reserveLineAgencyFee(transaction, facilityRef, currentFacility, historyRef);
            const pricing = calculateInvoicePricing(5000, serviceTypes, oneTimeAdjustment, lineAgencyFee);
            transaction.set(historyRef, {
                test: false,
                status: "sending",
                facilityId,
                facilityName: currentFacility.facilityName || facilityId,
                serviceTypes,
                recipient,
                issueDate,
                dueDate: invoiceDueDate,
                billingPeriodStart: period.startDate,
                billingPeriodEnd: period.endDate,
                oneTimeAdjustment,
                lineAgencyFee,
                additionalServiceSubtotal: pricing.additionalServiceSubtotal,
                subtotal: pricing.subtotal,
                tax: pricing.tax,
                total: pricing.total,
                attemptStartedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            return { serviceTypes, pricing, oneTimeAdjustment };
        });
        if (!reservation) {
            skippedCount++;
            continue;
        }
        const { serviceTypes, pricing, oneTimeAdjustment } = reservation;
        const lineAgencyFee = pricing.lineAgencyFee || null;

        const invoiceNumber = `INV-${monthlyInvoiceKey(period.startDate, facility)}-${facilityId.toUpperCase()}`;
        const formattedPeriod = `${formatJapaneseDateKey(period.startDate)}〜${formatJapaneseDateKey(period.endDate)}`;
        const invoiceRows = buildInvoiceItemRows({
            serviceTypes,
            itemTitle: "システム利用料",
            billingPeriod: formattedPeriod,
            baseSubtotal: 5000,
            additionalServiceSubtotal: pricing.additionalServiceSubtotal,
            oneTimeAdjustment,
            lineAgencyFee,
            tax: pricing.tax,
            total: pricing.total
        });
        const textItems = buildInvoiceTextItems({
            serviceTypes,
            itemTitle: "システム利用料",
            billingPeriod: formattedPeriod,
            baseSubtotal: 5000,
            additionalServiceSubtotal: pricing.additionalServiceSubtotal,
            oneTimeAdjustment,
            lineAgencyFee,
            tax: pricing.tax,
            total: pricing.total
        });
        const html = `<!doctype html><html lang="ja"><body style="font-family:sans-serif;color:#222;line-height:1.7;max-width:720px;margin:auto;padding:24px">
            <p>${escapeHtml(facilityName)} 御中</p><h1 style="text-align:center">請求書</h1>
            <p>請求書番号：${escapeHtml(invoiceNumber)}<br>発行日：${formatJapaneseDateKey(issueDate)}<br>お支払期限：${formatJapaneseDateKey(invoiceDueDate)}</p>
            <p style="font-size:20px;font-weight:bold">ご請求金額（税込）　${pricing.total.toLocaleString("ja-JP")}円</p>
            <table style="width:100%;border-collapse:collapse"><thead><tr><th style="border:1px solid #adb5bd;padding:10px;text-align:left">内容</th><th style="border:1px solid #adb5bd;padding:10px;text-align:left">金額</th></tr></thead><tbody>
            ${invoiceRows}</tbody></table>
            <div style="margin-top:28px"><h2>発行元</h2><p>株式会社えこすまいる<br>〒719-1164 岡山県総社市西郡430-2<br>連絡先：${escapeHtml(gmailUser)}<br>適格請求書発行事業者登録番号：なし</p></div>
            <h2>お振込先</h2><p>PayPay銀行<br>店番号：005 ／ 支店名：ビジネス営業部<br>普通 2088889<br>口座名義：カ）エコスマイル</p>
            <p style="margin-top:20px;padding:12px;background:#e7f5ff;border-radius:4px;border:1px solid #74c0fc"><strong>【A4印刷用PDF添付】</strong><br>A4サイズで印刷可能な請求書PDF（<code>請求書_${escapeHtml(invoiceNumber)}.pdf</code>）を本メールに添付しております。印刷して保管される際などにご活用ください。</p>
            <p style="margin-top:20px;padding:12px;background:#fff5f5;border:1px solid #ffa8a8;border-radius:4px;color:#c92a2a;font-weight:bold">${escapeHtml(PAYMENT_SUSPENSION_NOTICE)}</p>
            <p style="margin-top:28px">平素よりシステムをご利用いただき、誠にありがとうございます。今後ともどうぞよろしくお願い申し上げます。</p>
        </body></html>`;
        const text = `${facilityName} 御中\n請求書番号：${invoiceNumber}\n請求対象期間：${formattedPeriod}\n発行日：${formatJapaneseDateKey(issueDate)}\nお支払期限：${formatJapaneseDateKey(invoiceDueDate)}\n${textItems}\n\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\nPayPay銀行 ビジネス営業部（005） 普通 2088889\n口座名義：カ）エコスマイル\n\n【ご注意】${PAYMENT_SUSPENSION_NOTICE}\n\n※ A4印刷用の請求書PDF（請求書_${invoiceNumber}.pdf）を本メールに添付しております。\n\n平素よりシステムをご利用いただき、誠にありがとうございます。今後ともどうぞよろしくお願い申し上げます。`;

        let emailResult = null;
        try {
            const pdfBuffer = await generateInvoicePdf({
                facilityName,
                invoiceNumber,
                issueDate: formatJapaneseDateKey(issueDate),
                dueDate: formatJapaneseDateKey(invoiceDueDate),
                billingPeriod: formattedPeriod,
                itemTitle: "システム利用料",
                serviceTypes,
                additionalServiceSubtotal: pricing.additionalServiceSubtotal,
                oneTimeAdjustment,
                lineAgencyFee,
                subtotal: pricing.subtotal,
                tax: pricing.tax,
                total: pricing.total,
                issuerEmail: gmailUser,
                note: `${PAYMENT_SUSPENSION_NOTICE}\n平素よりシステムをご利用いただき、誠にありがとうございます。今後ともどうぞよろしくお願い申し上げます。`
            });
            emailResult = await transporter.sendMail({
                from: { name: "株式会社えこすまいる", address: gmailUser },
                to: recipient,
                subject: `【請求書】${facilityName} 御中 / ${invoiceNumber}`,
                text,
                html,
                attachments: [
                    { filename: `請求書_${invoiceNumber}.pdf`, content: pdfBuffer, contentType: "application/pdf" }
                ]
            });
            await notifyAdminOfSentInvoice({
                transporter, gmailUser, invoiceRef: historyRef, facilityId, facilityName, recipient,
                invoiceNumber, billingPeriodStart: period.startDate, billingPeriodEnd: period.endDate,
                dueDate: invoiceDueDate, total: pricing.total, textItems
            });
            const archivedHtml = html;
            await historyRef.set({
                status: "sent",
                test: false,
                invoiceNumber,
                billingMonth: formattedPeriod,
                invoiceHtml: archivedHtml,
                messageId: emailResult.messageId,
                sentAt: FieldValue.serverTimestamp()
            }, { merge: true });
            await finalizeOneTimeInvoiceAdjustment(db, facilityRef, oneTimeAdjustment);
            await settleLineAgencyFee(db, facilityRef, historyRef, lineAgencyFee, true);
            await db.collection("invoiceEmailLogs").add({
                test: false,
                facilityId,
                facilityName,
                recipient,
                invoiceNumber,
                issueDate,
                dueDate: invoiceDueDate,
                billingPeriodStart: period.startDate,
                billingPeriodEnd: period.endDate,
                serviceTypes,
                additionalServiceSubtotal: pricing.additionalServiceSubtotal,
                oneTimeAdjustment,
                lineAgencyFee,
                subtotal: pricing.subtotal,
                tax: pricing.tax,
                total: pricing.total,
                sentAt: FieldValue.serverTimestamp(),
                messageId: emailResult.messageId
            }).catch(error => logger.warn("Invoice email sent but audit logging failed", { facilityId, error }));
            sentCount++;
        } catch (error) {
            if (emailResult) {
                await historyRef.set({
                    status: "sent",
                    invoiceNumber,
                    billingMonth: formattedPeriod,
                    invoiceHtml: html,
                    messageId: emailResult.messageId,
                    sentAt: FieldValue.serverTimestamp()
                }, { merge: true }).catch(logError => logger.error("Failed to finalize sent monthly invoice", { facilityId, error: logError }));
                await finalizeOneTimeInvoiceAdjustment(db, facilityRef, oneTimeAdjustment)
                    .catch(logError => logger.error("Failed to clear sent one-time invoice adjustment", { facilityId, error: logError }));
                await settleLineAgencyFee(db, facilityRef, historyRef, lineAgencyFee, true)
                    .catch(logError => logger.error("Failed to finalize LINE agency fee", { facilityId, error: logError }));
                logger.error("Monthly invoice email sent but finalization failed", { facilityId, recipient, error });
                sentCount++;
                continue;
            }
            failedCount++;
            await historyRef.set({
                status: "failed",
                failedAt: FieldValue.serverTimestamp(),
                failureMessage: String(error.message || error).slice(0, 500)
            }, { merge: true }).catch(logError => logger.error("Failed to record invoice send failure", logError));
            await settleLineAgencyFee(db, facilityRef, historyRef, lineAgencyFee, false)
                .catch(logError => logger.error("Failed to release LINE agency fee", { facilityId, error: logError }));
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

exports.sendTrialExpiryReminders = onSchedule({
    schedule: "every day 09:00",
    timeZone: "Asia/Tokyo",
    maxInstances: 1,
    // 起動直後の一時的な500などで実行自体が失敗したときは、数分後に自動で再実行する
    // （送信済み・送信中の記録で二重送信を防いでいるため、再実行しても重複しない）
    retryCount: 3,
    minBackoffSeconds: 120,
    maxBackoffSeconds: 600,
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async () => {
    const db = getFirestore();
    const now = new Date();
    const facilitiesSnapshot = await db.collection("facilities").where("subscriptionStatus", "==", "trial").get();
    const candidates = facilitiesSnapshot.docs.filter(document => {
        const facility = document.data();
        return facility.status !== "locked" &&
            !["invoice_sending", "pending_payment"].includes(facility.subscriptionApplicationStatus) &&
            isTrialReminderDue(facility.trialEndsAt, now);
    });
    if (!candidates.length) {
        logger.info("Trial expiry reminder run completed", { eligible: 0, sent: 0, skipped: 0, failed: 0 });
        return;
    }

    const gmailUser = INVOICE_GMAIL_USER.value();
    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: gmailUser, pass: INVOICE_GMAIL_APP_PASSWORD.value() }
    });
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const facilityDocument of candidates) {
        const facilityId = facilityDocument.id;
        const facility = facilityDocument.data();
        const facilityRef = facilityDocument.ref;
        const facilityName = facility.facilityName || facilityId;
        const recipient = typeof facility.email === "string" ? facility.email.trim() : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
            skippedCount++;
            logger.warn("Skipping trial expiry reminder: facility email is missing or invalid", { facilityId });
            continue;
        }

        const reservedForSending = await db.runTransaction(async transaction => {
            const currentSnapshot = await transaction.get(facilityRef);
            if (!currentSnapshot.exists) return false;
            const currentFacility = currentSnapshot.data();
            if (currentFacility.status === "locked" ||
                currentFacility.subscriptionStatus !== "trial" ||
                ["invoice_sending", "pending_payment"].includes(currentFacility.subscriptionApplicationStatus) ||
                !isTrialReminderDue(currentFacility.trialEndsAt, new Date())) {
                return false;
            }
            if (currentFacility.trialReminderStatus === "sent") return false;
            const attemptStartedAt = currentFacility.trialReminderAttemptAt?.toDate
                ? currentFacility.trialReminderAttemptAt.toDate().getTime()
                : 0;
            if (currentFacility.trialReminderStatus === "sending" && Date.now() - attemptStartedAt < 60 * 60 * 1000) {
                return false;
            }
            transaction.set(facilityRef, {
                trialReminderStatus: "sending",
                trialReminderAttemptAt: FieldValue.serverTimestamp()
            }, { merge: true });
            return true;
        });
        if (!reservedForSending) {
            skippedCount++;
            continue;
        }

        const trialEndDateValue = facility.trialEndsAt?.toDate
            ? facility.trialEndsAt.toDate()
            : new Date(facility.trialEndsAt);
        const trialEndDate = formatJapaneseDateKey(dateKey(getTokyoDateParts(trialEndDateValue)));
        const daysRemaining = daysUntilTrialEnds(facility.trialEndsAt, new Date());
        const applicationPending = ["invoice_sending", "pending_payment"].includes(facility.subscriptionApplicationStatus);
        const applicationFailed = facility.subscriptionApplicationStatus === "invoice_failed";
        const nextStep = applicationPending
            ? "本登録のお申し込みは受け付けています。登録メールに届いた請求書とお支払い状況をご確認ください。"
            : applicationFailed
                ? "本登録のお申し込み後、請求書を送信できていません。ログイン画面から連絡帳を開き、「初回請求書を再送する」を押してください。"
                : "継続してご利用の場合は、下記ログイン画面から連絡帳を開き、「本登録を申し込む」を押してください。";
        const text = `${facilityName} 御中\n\nえこすまいる連絡帳の無料お試し期間終了日が、あと${daysRemaining}日（${trialEndDate}）です。\n\n${nextStep}\n\nトライアル期間終了までに本登録への切り替えが完了しない場合、システムは自動的に利用停止となります。終了から暦で2か月以内に本登録が完了した場合、削除していない名簿・文字の記録を引き継げます。写真・動画の従来の保存期限は延長しません。\n\n${FACILITY_RETENTION_NOTICE}\n\nログイン画面：https://renrakucho-green.vercel.app/login.html\n\nご不明な点がございましたら、このメールへの返信または販売元までお問い合わせください。\n\n株式会社えこすまいる`;
        const html = `<!doctype html><html lang="ja"><body style="font-family:sans-serif;color:#333;line-height:1.8;max-width:680px;margin:auto;padding:20px">
            <h2 style="color:#e8590c;border-bottom:2px solid #e8590c;padding-bottom:8px">無料お試し期間終了のお知らせ</h2>
            <p><strong>${escapeHtml(facilityName)} 御中</strong></p>
            <p>えこすまいる連絡帳の無料お試し期間終了日が、<strong>あと${daysRemaining}日（${escapeHtml(trialEndDate)}）</strong>です。</p>
            <div style="background:#fff9db;border:1px solid #fab005;border-radius:6px;padding:16px;margin:20px 0">${escapeHtml(nextStep)}</div>
            <p>トライアル期間終了までに本登録への切り替えが完了しない場合、システムは自動的に利用停止となります。終了から暦で2か月以内に本登録が完了した場合、削除していない名簿・文字の記録を引き継げます。写真・動画の従来の保存期限は延長しません。</p>
            <p>${escapeHtml(FACILITY_RETENTION_NOTICE)}</p>
            <p><a href="https://renrakucho-green.vercel.app/login.html" style="display:inline-block;background:#2b8a3e;color:white;text-decoration:none;padding:10px 18px;border-radius:5px">連絡帳にログインする</a></p>
            <p>ご不明な点がございましたら、このメールへの返信または販売元までお問い合わせください。</p>
            <p>株式会社えこすまいる</p>
        </body></html>`;

        try {
            await transporter.sendMail({
                from: { name: "えこすまいる連絡帳システム", address: gmailUser },
                to: recipient,
                subject: `【重要】無料お試し期間終了まであと3日です（${facilityName} 御中）`,
                text,
                html
            });
            await writeFacilityData(facilityRef, facilityRef, {
                trialReminderStatus: "sent",
                trialReminderSentAt: FieldValue.serverTimestamp(),
                trialReminderFailureMessage: FieldValue.delete()
            });
            sentCount++;
        } catch (error) {
            failedCount++;
            await writeFacilityData(facilityRef, facilityRef, {
                trialReminderStatus: "failed",
                trialReminderFailedAt: FieldValue.serverTimestamp(),
                trialReminderFailureMessage: String(error.message || error).slice(0, 500)
            });
            logger.error("Failed to send trial expiry reminder", { facilityId, recipient, error });
        }
    }

    logger.info("Trial expiry reminder run completed", {
        eligible: candidates.length,
        sent: sentCount,
        skipped: skippedCount,
        failed: failedCount
    });
});

exports.deleteExpiredFacilityAccounts = onSchedule({
    schedule: "every 60 minutes",
    timeZone: "Asia/Tokyo",
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 540,
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD]
}, async () => {
    const db = getFirestore();
    const facilities = await db.collection("facilities").get();
    const failures = [];
    let deleted = 0;
    for (const snapshot of facilities.docs) {
        const facilityId = snapshot.id;
        try {
            if (!isFacilityRetentionExpired(snapshot.data(), new Date())) continue;
            const claimed = await db.runTransaction(async transaction => {
                const current = await transaction.get(snapshot.ref);
                if (!current.exists || !isFacilityRetentionExpired(current.data(), new Date())) return false;
                transaction.set(snapshot.ref, {
                    status: "locked",
                    retentionDeletionStartedAt: current.data().retentionDeletionStartedAt || new Date().toISOString()
                }, { merge: true });
                return true;
            });
            if (!claimed) continue;
            const plan = await buildFacilityDeletionPlan(facilityId);
            if (plan.ambiguousLegacyNames.length) {
                throw new Error(`他施設と共有の可能性がある旧ファイルがあるため、自動削除を保留しました（該当利用者${plan.ambiguousLegacyNames.length}名）。管理者の確認が必要です。`);
            }
            await executeFacilityCancellation(facilityId, plan, true);
            deleted++;
        } catch (error) {
            failures.push(facilityId);
            logger.error("Automatic facility cancellation failed", { facilityId, error });
            await db.collection("facilityCancellations").doc(facilityId).set({
                facilityId, facilityName: snapshot.data().facilityName || facilityId,
                reason: "retention_expired", status: "failed",
                requestedAt: snapshot.data().retentionDeletionStartedAt || new Date().toISOString(),
                errorMessage: String(error.message || error).slice(0, 500),
                updatedAt: new Date().toISOString()
            }, { merge: true }).catch(logError => logger.error("Failed to record automatic cancellation failure", { facilityId, error: logError }));
        }
    }
    logger.info("Expired facility cancellation completed", { scanned: facilities.size, deleted, failed: failures.length });
    if (failures.length) throw new Error(`Automatic facility cancellation requires attention for ${failures.length} facilities.`);
});

exports.lockExpiredTrials = onSchedule("every 60 minutes", async () => {
    const facilitiesSnapshot = await getFirestore().collection("facilities").get();
    const now = Date.now();
    const expiredFacilities = facilitiesSnapshot.docs.filter(document => {
        const facility = document.data();
        if (facility.status === "locked" || facility.subscriptionStatus !== "trial") return false;
        const accessEndsAt = getTrialAccessEndsAt(facility);
        return !Number.isFinite(accessEndsAt) || accessEndsAt <= now;
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

function getTokyoDateKey(date = new Date()) {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(date);
}

// 入金期限を過ぎても未入金の請求書がある施設を、期限の翌日に自動でロックする。
// 一度ロックに使った請求書には印を付け、管理者が手動で解除した後に同じ請求書で再ロックしない。
exports.lockOverdueInvoiceFacilities = onSchedule("every 60 minutes", async () => {
    const db = getFirestore();
    const todayKey = getTokyoDateKey();
    const facilitiesSnapshot = await db.collection("facilities").get();
    let locked = 0;
    const failures = [];
    for (const facilityDoc of facilitiesSnapshot.docs) {
        const facility = facilityDoc.data();
        if (facility.status === "locked" || facility.usagePaused === true) continue;
        try {
            const invoicesSnapshot = await facilityDoc.ref.collection("invoiceHistory").where("status", "==", "sent").get();
            const overdueInvoices = findOverdueUnpaidInvoices(invoicesSnapshot.docs, todayKey);
            if (!overdueInvoices.length) continue;
            const didLock = await db.runTransaction(async transaction => {
                const current = await transaction.get(facilityDoc.ref);
                if (!current.exists || current.data().status === "locked" || current.data().usagePaused === true) return false;
                const freshInvoices = await Promise.all(overdueInvoices.map(invoiceDoc => transaction.get(invoiceDoc.ref)));
                const stillOverdue = findOverdueUnpaidInvoices(freshInvoices.filter(invoiceDoc => invoiceDoc.exists), todayKey);
                if (!stillOverdue.length) return false;
                transaction.set(facilityDoc.ref, {
                    status: "locked",
                    lockReason: "payment_overdue",
                    paymentOverdueLockedAt: FieldValue.serverTimestamp(),
                    paymentOverdueInvoiceNumbers: stillOverdue.map(invoiceDoc => invoiceDoc.data().invoiceNumber || invoiceDoc.id)
                }, { merge: true });
                stillOverdue.forEach(invoiceDoc => transaction.update(invoiceDoc.ref, { overdueLockAppliedAt: FieldValue.serverTimestamp() }));
                return true;
            });
            if (didLock) locked++;
        } catch (error) {
            failures.push(facilityDoc.id);
            logger.error("Overdue invoice lock failed", { facilityId: facilityDoc.id, error: error.message });
        }
    }
    if (locked) logger.info("Facilities locked for overdue invoices", { count: locked, todayKey });
    if (failures.length) throw new Error(`Overdue invoice lock failed for ${failures.length} facilities.`);
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
    // 起動直後の一時的な500で1日分のバックアップが抜けないよう、失敗時は再実行する
    retryCount: 3,
    minBackoffSeconds: 120,
    maxBackoffSeconds: 600,
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
