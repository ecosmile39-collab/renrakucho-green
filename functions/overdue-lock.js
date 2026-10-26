// 入金期限（dueDate、YYYY-MM-DD）を過ぎても未入金の請求書を探す。
// 期限当日は対象外で、翌日（todayKey > dueDate）から対象になる。
// テスト請求書・未送信・入金済み・すでにロックに使った請求書は対象外。
function findOverdueUnpaidInvoices(invoiceDocs, todayKey) {
    return invoiceDocs.filter(invoiceDoc => {
        const invoice = invoiceDoc.data();
        return invoice.test !== true &&
            invoice.status === "sent" &&
            invoice.paymentStatus !== "paid" &&
            !invoice.overdueLockAppliedAt &&
            typeof invoice.dueDate === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(invoice.dueDate) &&
            invoice.dueDate < todayKey;
    });
}

module.exports = { findOverdueUnpaidInvoices };
