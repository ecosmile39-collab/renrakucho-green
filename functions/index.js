const { initializeApp } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

initializeApp();

const VIDEO_RETENTION_MS = 72 * 60 * 60 * 1000;
const DELETE_BATCH_SIZE = 50;

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
