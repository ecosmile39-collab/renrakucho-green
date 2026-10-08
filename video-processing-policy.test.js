import assert from "node:assert/strict";
import { test } from "node:test";
import {
    MAX_VIDEO_DURATION_SECONDS,
    MAX_VIDEO_OUTPUT_BYTES,
    MAX_VIDEO_SOURCE_BYTES,
    VIDEO_ENCODING_PROFILES,
    getVideoEncodingArguments,
    isVideoOutputWithinLimit
} from "./video-processing-policy.js";

test("video policy sets a 30-second, 5 MB output limit and retains the source guard", () => {
    assert.equal(MAX_VIDEO_DURATION_SECONDS, 30);
    assert.equal(MAX_VIDEO_OUTPUT_BYTES, 5_000_000);
    assert.equal(MAX_VIDEO_SOURCE_BYTES, 250 * 1024 * 1024);
});

test("every encoding profile trims at 30 seconds, preserves aspect ratio and reduces bitrate progressively", () => {
    const rates = VIDEO_ENCODING_PROFILES.map(profile => profile.maxRateKbps);
    assert.deepEqual(rates, [1100, 900, 700, 500, 350]);
    for (const profile of VIDEO_ENCODING_PROFILES) {
        const args = getVideoEncodingArguments("input.video", "output.mp4", profile);
        assert.equal(args[args.indexOf("-t") + 1], "30");
        assert.equal(args[args.indexOf("-b:a") + 1], "64k");
        assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
        assert.match(args[args.indexOf("-vf") + 1], /force_original_aspect_ratio=decrease/);
        assert.equal(args.at(-1), "output.mp4");
    }
});

test("only nonempty outputs up to 5 MB can be uploaded", () => {
    assert.equal(isVideoOutputWithinLimit(1), true);
    assert.equal(isVideoOutputWithinLimit(MAX_VIDEO_OUTPUT_BYTES), true);
    assert.equal(isVideoOutputWithinLimit(MAX_VIDEO_OUTPUT_BYTES + 1), false);
    assert.equal(isVideoOutputWithinLimit(0), false);
    assert.equal(isVideoOutputWithinLimit(-1), false);
    assert.equal(isVideoOutputWithinLimit(1.5), false);
});
