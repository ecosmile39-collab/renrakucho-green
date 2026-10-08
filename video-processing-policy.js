export const MAX_VIDEO_SOURCE_BYTES = 250 * 1024 * 1024;
export const MAX_VIDEO_OUTPUT_BYTES = 5_000_000;
export const MAX_VIDEO_DURATION_SECONDS = 30;

export const VIDEO_ENCODING_PROFILES = [
    { width: 854, height: 480, crf: 27, maxRateKbps: 1100 },
    { width: 854, height: 480, crf: 32, maxRateKbps: 900 },
    { width: 854, height: 480, crf: 37, maxRateKbps: 700 },
    { width: 854, height: 480, crf: 42, maxRateKbps: 500 },
    { width: 640, height: 360, crf: 45, maxRateKbps: 350 }
];

export function getVideoEncodingArguments(inputName, outputName, profile) {
    return [
        "-i", inputName,
        "-t", String(MAX_VIDEO_DURATION_SECONDS),
        "-vf", `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", String(profile.crf),
        "-maxrate", `${profile.maxRateKbps}k`, "-bufsize", `${profile.maxRateKbps}k`,
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
        "-movflags", "+faststart", outputName
    ];
}

export function isVideoOutputWithinLimit(fileSize) {
    return Number.isSafeInteger(fileSize) && fileSize > 0 && fileSize <= MAX_VIDEO_OUTPUT_BYTES;
}
