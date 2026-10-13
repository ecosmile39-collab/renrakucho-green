const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

const FONT_PATH = path.join(__dirname, "fonts", "ipaexg.ttf");
const STAMP_PATH = path.join(__dirname, "company_stamp.png");

/**
 * Generate an A4 single-page PDF buffer for an invoice.
 * @param {Object} options
 * @param {string} options.facilityName
 * @param {string} options.invoiceNumber
 * @param {string} options.issueDate - YYYY年M月D日 formatted or YYYY-MM-DD
 * @param {string} options.dueDate - YYYY年M月D日 formatted or YYYY-MM-DD
 * @param {string} options.billingPeriod - formatted period string
 * @param {string} options.itemTitle - e.g. "初回システム利用料" or "システム利用料"
 * @param {number} options.subtotal
 * @param {number} options.tax
 * @param {number} options.total
 * @param {string} options.issuerEmail
 * @param {string} options.note - appreciation message or note
 * @returns {Promise<Buffer>}
 */
function generateInvoicePdf({
    facilityName,
    invoiceNumber,
    issueDate,
    dueDate,
    billingPeriod,
    itemTitle,
    subtotal,
    tax,
    total,
    issuerEmail,
    note
}) {
    return new Promise((resolve, reject) => {
        try {
            // A4 dimensions in points: 595.28 x 841.89
            const doc = new PDFDocument({
                size: "A4",
                margin: 40,
                autoFirstPage: true
            });

            const chunks = [];
            doc.on("data", chunk => chunks.push(chunk));
            doc.on("end", () => resolve(Buffer.concat(chunks)));
            doc.on("error", err => reject(err));

            doc.registerFont("Japanese", FONT_PATH);
            doc.font("Japanese");

            const pageWidth = 595.28;
            const margin = 45;
            const contentWidth = pageWidth - margin * 2; // ~505pt

            // Title
            doc.fontSize(22)
                .text("請　求　書", margin, 45, { align: "center", width: contentWidth });

            // Horizontal line under title
            doc.moveTo(margin, 75).lineTo(pageWidth - margin, 75).lineWidth(1.5).stroke("#2b8a3e");

            // Facility name (left)
            doc.fontSize(14)
                .text(`${facilityName}  御中`, margin, 95, { width: 280 });

            doc.fontSize(10)
                .fillColor("#444444")
                .text("下記のとおりご請求申し上げます。", margin, 120);

            // Total amount box (left side)
            doc.rect(margin, 140, 260, 42).fillAndStroke("#f1f8f2", "#2b8a3e");
            doc.fillColor("#222222")
                .fontSize(11)
                .text("ご請求金額（税込）", margin + 12, 148);
            doc.fontSize(16)
                .fillColor("#1e6b2e")
                .text(`¥ ${total.toLocaleString()}-`, margin + 120, 153, { width: 135, align: "right" });

            // Invoice details & Issuer info (right side)
            const rightColX = 330;
            const rightColWidth = contentWidth - (rightColX - margin);

            doc.fillColor("#222222").fontSize(9);
            let rightY = 92;
            doc.text(`請求書番号：${invoiceNumber}`, rightColX, rightY);
            rightY += 15;
            doc.text(`発行日：${issueDate}`, rightColX, rightY);
            rightY += 15;
            doc.text(`お支払期限：${dueDate}`, rightColX, rightY);
            rightY += 15;
            doc.text(`請求対象期間：${billingPeriod}`, rightColX, rightY);

            // Issuer block
            rightY += 22;
            doc.fontSize(10).text("【発行元】", rightColX, rightY);
            rightY += 14;
            doc.fontSize(9)
                .text("株式会社えこすまいる\n〒719-1164 岡山県総社市西郡430-2\n適格請求書発行事業者登録番号：なし", rightColX, rightY, {
                    lineGap: 3
                });
            if (issuerEmail) {
                doc.text(`連絡先：${issuerEmail}`, rightColX, rightY + 38);
            }

            // Stamp image
            if (fs.existsSync(STAMP_PATH)) {
                doc.image(STAMP_PATH, pageWidth - margin - 65, rightY + 2, { width: 62, height: 62 });
            }

            // Table of items
            const tableTop = 225;
            const colDescX = margin;
            const colDescW = 345;
            const colAmountX = margin + colDescW;
            const colAmountW = contentWidth - colDescW;

            // Table Header
            doc.rect(colDescX, tableTop, contentWidth, 24).fillAndStroke("#e9ecef", "#adb5bd");
            doc.fillColor("#222222").fontSize(10)
                .text("内　容", colDescX + 10, tableTop + 7)
                .text("金　額", colAmountX, tableTop + 7, { width: colAmountW - 10, align: "right" });

            // Row 1: Subtotal
            let rowY = tableTop + 24;
            doc.rect(colDescX, rowY, contentWidth, 26).stroke("#adb5bd");
            doc.fillColor("#222222").fontSize(9)
                .text(`${itemTitle}（${billingPeriod}分）`, colDescX + 10, rowY + 8)
                .text(`¥ ${subtotal.toLocaleString()}`, colAmountX, rowY + 8, { width: colAmountW - 10, align: "right" });

            // Row 2: Tax
            rowY += 26;
            doc.rect(colDescX, rowY, contentWidth, 26).stroke("#adb5bd");
            doc.fillColor("#222222").fontSize(9)
                .text("消費税（10%）", colDescX + 10, rowY + 8)
                .text(`¥ ${tax.toLocaleString()}`, colAmountX, rowY + 8, { width: colAmountW - 10, align: "right" });

            // Row 3: Total
            rowY += 26;
            doc.rect(colDescX, rowY, contentWidth, 28).fillAndStroke("#f8f9fa", "#2b8a3e");
            doc.fillColor("#1e6b2e").fontSize(10)
                .text("合　計（税込）", colDescX + 10, rowY + 8)
                .text(`¥ ${total.toLocaleString()}`, colAmountX, rowY + 8, { width: colAmountW - 10, align: "right" });

            // Bank details block
            let bankY = rowY + 45;
            doc.rect(margin, bankY, contentWidth, 75).fillAndStroke("#fdfdfd", "#ced4da");
            doc.fillColor("#1e6b2e").fontSize(11).text("【お振込先】", margin + 15, bankY + 12);
            doc.fillColor("#222222").fontSize(10).text(
                "PayPay銀行　ビジネス営業部（店番号：005）\n普通預金　口座番号：2088889\n口座名義：カ）エコスマイル",
                margin + 15,
                bankY + 30,
                { lineGap: 4 }
            );

            // Note / Appreciation block
            if (note) {
                let noteY = bankY + 95;
                doc.rect(margin, noteY, contentWidth, 70).fillAndStroke("#fffbf5", "#f08c00");
                doc.fillColor("#7c4a03").fontSize(10).text("【ご案内・備考】", margin + 15, noteY + 10);
                doc.fillColor("#333333").fontSize(9).text(note, margin + 15, noteY + 28, {
                    width: contentWidth - 30,
                    lineGap: 4
                });
            }

            // Footer
            doc.fontSize(8).fillColor("#888888").text(
                "※ 振込手数料は貴社にてご負担くださいますようお願い申し上げます。",
                margin,
                780,
                { align: "center", width: contentWidth }
            );

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = {
    generateInvoicePdf
};
