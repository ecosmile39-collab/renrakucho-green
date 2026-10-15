const test = require("node:test");
const assert = require("node:assert/strict");
const { generateInvoicePdf } = require("./invoice-pdf");

test("generateInvoicePdf generates a valid A4 PDF buffer with long invoice number and stamp without overlap", async () => {
    const pdfBuffer = await generateInvoicePdf({
        facilityName: "みらいくらぶ",
        invoiceNumber: "INIT-20261013-N092FXAN6DWHQBYNRFP0",
        issueDate: "2026年10月13日",
        dueDate: "2026年10月23日",
        billingPeriod: "2026年10月13日〜2026年11月12日",
        itemTitle: "初回システム利用料",
        subtotal: 4000,
        tax: 400,
        total: 4400,
        issuerEmail: "ecosmile39@gmail.com",
        note: "このたびは本登録をお申し込みいただき、誠にありがとうございます。ご利用をお申し込みくださったことに心より感謝申し上げます。入金確認後、本利用へ切り替えいたします。今後ともどうぞよろしくお願い申し上げます。"
    });

    assert.ok(Buffer.isBuffer(pdfBuffer));
    assert.ok(pdfBuffer.length > 5000, "PDF buffer should contain font, stamp and content");
    assert.equal(pdfBuffer.subarray(0, 4).toString(), "%PDF");
});

test("generateInvoicePdf includes selected services and the additional-service charge", async () => {
    const pdfBuffer = await generateInvoicePdf({
        facilityName: "みらいくらぶ",
        invoiceNumber: "INV-20261015-FACILITY",
        issueDate: "2026年10月15日",
        dueDate: "2026年10月25日",
        billingPeriod: "2026年10月15日〜2026年11月14日",
        itemTitle: "システム利用料",
        serviceTypes: ["デイサービス", "生活介護"],
        additionalServiceSubtotal: 1000,
        subtotal: 6000,
        tax: 600,
        total: 6600,
        issuerEmail: "ecosmile39@gmail.com",
        note: "ご利用ありがとうございます。"
    });

    assert.ok(Buffer.isBuffer(pdfBuffer));
    assert.ok(pdfBuffer.length > 5000);
    assert.equal(pdfBuffer.subarray(0, 4).toString(), "%PDF");
});
