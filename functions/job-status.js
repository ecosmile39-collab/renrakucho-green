// 定期処理の結果を systemStatus/{jobId} に記録し、管理画面の「システムの健康状態」に表示する。
// 記録に失敗しても、本来の処理には影響させない。
function createJobStatusWrapper(getDb, logger = console) {
    const write = async (jobId, data) => {
        try {
            await getDb().collection("systemStatus").doc(jobId).set({ jobId, ...data }, { merge: true });
        } catch (error) {
            logger.warn?.("Failed to record scheduled job status", { jobId, message: String(error?.message || error) });
        }
    };

    return function withJobStatus(jobId, handler) {
        return async (...args) => {
            await write(jobId, { lastStartedAt: new Date() });
            try {
                const result = await handler(...args);
                const finishedAt = new Date();
                const details = result && typeof result === "object" && !Array.isArray(result) ? result : null;
                await write(jobId, { lastStatus: "success", lastFinishedAt: finishedAt, lastSuccessAt: finishedAt, lastError: "", ...(details ? { details } : {}) });
                return result;
            } catch (error) {
                await write(jobId, { lastStatus: "error", lastFinishedAt: new Date(), lastError: String(error?.message || error).slice(0, 300) });
                throw error;
            }
        };
    };
}

module.exports = { createJobStatusWrapper };
