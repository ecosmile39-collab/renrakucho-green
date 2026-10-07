function isFamilyRecordRequest(event) {
    return (event.type === "message" && event.message?.type === "text" &&
        event.message.text.trim() === "連絡帳を見る") ||
        (event.type === "postback" && event.postback?.data === "view_records");
}

function latestPublishedRecords(records, today) {
    const published = records.filter(record => record.familyPublished === true &&
        /^\d{4}-\d{2}-\d{2}$/.test(record.date || "") && record.date <= today);
    const latestDate = published.reduce((latest, record) => record.date > latest ? record.date : latest, "");
    return published.filter(record => record.date === latestDate)
        .sort((first, second) => String(first.serviceType).localeCompare(String(second.serviceType)));
}

module.exports = { isFamilyRecordRequest, latestPublishedRecords };