const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { readFileSync } = require("fs");
const path = require("path");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const nodemailer = require("nodemailer");

initializeApp();

const VIDEO_RETENTION_MS = 72 * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 50;
const INVOICE_TEST_RECIPIENT = "ecosmile39@gmail.com";
const INVOICE_GMAIL_USER = defineSecret("INVOICE_GMAIL_USER");
const INVOICE_GMAIL_APP_PASSWORD = defineSecret("INVOICE_GMAIL_APP_PASSWORD");
const INVOICE_ADMIN_KEY = defineSecret("INVOICE_ADMIN_KEY");
const companyStampPng = readFileSync(path.join(__dirname, "company_stamp.png"));
const companyStampDataUrl = `data:image/png;base64,${companyStampPng.toString("base64")}`;

function escapeHtml(value) {
    return String(value || "").replace(/[&<>\"']/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[character]));
}

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
    secrets: [INVOICE_GMAIL_USER, INVOICE_GMAIL_APP_PASSWORD, INVOICE_ADMIN_KEY]
}, async request => {
    const { facilityId, adminKey } = request.data || {};
    if (typeof adminKey !== "string" || adminKey !== INVOICE_ADMIN_KEY.value()) {
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
    </body></html>`;
    const text = `${facilityName} 御中\nテスト請求書（実請求ではありません）\n請求書番号：${invoiceNumber}\n発行日：${formatJapaneseDate(dateParts)}\n支払期限：${formatJapaneseDate(dueParts)}\nシステム利用料（${billingMonth}分）：5,000円\n消費税（10%）：500円\n税込合計：5,500円\n\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\nPayPay銀行 ビジネス営業部（005） 普通 2088889\n口座名義：カ）エコスマイル\n\nこれは送信テストです。実際の請求・お支払いは発生しません。`;

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
        </body></html>`;
        const text = `${facilityName} 御中\n請求書番号：${invoiceNumber}\n請求対象期間：${formattedPeriod}\n発行日：${formatJapaneseDateKey(issueDate)}\nお支払期限：${formatJapaneseDateKey(dueDate)}\nシステム利用料：5,000円\n消費税（10%）：500円\n税込合計：5,500円\n\n株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\nPayPay銀行 ビジネス営業部（005） 普通 2088889\n口座名義：カ）エコスマイル`;

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
