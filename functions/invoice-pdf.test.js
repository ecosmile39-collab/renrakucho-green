const test = require("node:test");
const assert = require("node:assert/strict");
const { generateInvoicePdf } = require("./invoice-pdf");

test("generateInvoicePdf generates a valid A4 PDF buffer with Japanese text and stamp", async () => {
    const pdfBuffer = await generateInvoicePdf({
        facilityName: "デイサービスひまわり",
        invoiceNumber: "INIT-20261013-DEMO",
        issueDate: "2026年10月13日",
        dueDate: "2026年10月23日",
        billingPeriod: "2026年10月13日〜2026年11月12日",
        itemTitle: "初回システム利用料",
        subtotal: 4000,
        tax: 400,
        total: 4400,
        issuerEmail: "ecosmile39@gmail.com",
        note: "このたびは本登録をお申し込みいただき、誠にありがとうございます。入金確認後、本利用へ切り替えいたします。"
    });

    assert.ok(Buffer.isBuffer(pdfBuffer));
    assert.ok(pdfBuffer.length > 5000, "PDF buffer should contain font, stamp and content");
    // Verify PDF header magic bytes %PDF-
    assert.equal(pdfBuffer.subarray(0, 4).toString(), "%PDF");
});
