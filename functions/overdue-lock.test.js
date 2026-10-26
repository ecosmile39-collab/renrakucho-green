const assert = require("node:assert/strict");
const { test } = require("node:test");
const { findOverdueUnpaidInvoices } = require("./overdue-lock");

const docOf = (id, data) => ({ id, data: () => data });

test("only sent, unpaid, real invoices past their due date are overdue", () => {
    const docs = [
        docOf("past", { status: "sent", dueDate: "2026-10-25" }),
        docOf("dueToday", { status: "sent", dueDate: "2026-10-26" }),
        docOf("future", { status: "sent", dueDate: "2026-11-05" }),
        docOf("paid", { status: "sent", dueDate: "2026-10-01", paymentStatus: "paid" }),
        docOf("test", { status: "sent", dueDate: "2026-10-01", test: true }),
        docOf("sending", { status: "sending", dueDate: "2026-10-01" }),
        docOf("alreadyLocked", { status: "sent", dueDate: "2026-10-01", overdueLockAppliedAt: "x" }),
        docOf("noDue", { status: "sent" }),
        docOf("badDue", { status: "sent", dueDate: "2026年10月1日" }),
        docOf("unpaidExplicit", { status: "sent", dueDate: "2026-10-20", paymentStatus: "unpaid" })
    ];
    assert.deepEqual(findOverdueUnpaidInvoices(docs, "2026-10-26").map(doc => doc.id), ["past", "unpaidExplicit"]);
});
