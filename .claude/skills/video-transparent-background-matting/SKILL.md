---
name: video-transparent-background-matting
description: Use when removing a video or animation background around a character or object, preserving moving body edges and detached accents, or delivering transparent alpha MOV, WebM and GIF files with whole-sequence quality checks.
---

# Remove an animation background with clean moving edges

Preserve the supplied character, performance, frame geometry and timing. Recover an alpha matte from the existing pixels; do not redraw or regenerate the subject. A compressed RGB source has no known original alpha, so clean observed output is a quality result, not proof of mathematically artifact-free recovery.

## Procedure

1. Inspect the actual source. Probe dimensions, timing, frame count, pixel format and audio; sample the beginning, motion extremes, gaps and ending at full resolution. Read the pixels rather than the filename. Identify a simple pale plate versus a textured/changing background. Confirm whether detached marks, glow, props or shadows belong to the animation when intent is unclear. Preserve the original and record its hash before processing.
2. Select the route. The supplied [local helper](scripts/video_matte.py) is for a saturated subject against a near-neutral pale plate with inspected seed/mask settings. Read [the workflow](references/workflow.md) before running it. It is not a general human segmentation model, black-screen keyer or automatic roto system. For overlapping plate/subject colors, hair, complex backgrounds, occlusion or changing exposure, use a verified temporal matting/roto workflow in an available host application and review the same delivery checks. Do not force the pale-plate helper onto unsuitable footage.
3. Build a continuous silhouette and an edge trimap. Keep enclosed white teeth and eye glints opaque. Inspect enclosed negative spaces such as armpits and finger gaps; hole filling can trap background there. Supply negative-space regions only after inspecting this exact clip. Keep intentional detached accents rather than retaining every dust island. Estimate fractional edge alpha from supported inner colors and the plate, then remove plate color contamination from edge RGB. Use an actual visible accent reference for fading detached graphics; do not bake a fade-to-white into opaque RGB or invent a new yellow. Never reuse this case's coordinates or reference frame as a default for another clip.
4. Validate the entire sequence before delivery. Check all frames for missing body regions, detached residues, outer-border opacity, unexpected holes, frame count and timing. Inspect moving contours, silhouette notches, negative spaces and accent fade transitions over black, white, saturated color and checkerboard at native scale and enlarged crops. One clean still is insufficient. Review the full animation for flicker, edge chatter, color fringes and cut-off motion blur; numeric checks supplement this review. Preserve uncertainty if full-motion review is unavailable.
5. Export and decode the actual files. Prefer ProRes 4444 MOV for the alpha editing master; preserve compatible source audio exactly and verify compressed packet hashes when copied. Provide a silent alpha WebM browser copy with the silence labeled, plus a baked checkerboard preview. Extend invisible edge RGB before chroma-subsampled encoding to avoid dark fringes. Verify alpha planes and all frames after decoding with a decoder that supports the format's alpha. If a GIF is requested, disclose its 256-color palette, hard transparency, silent playback and quantized frame delays; it cannot preserve soft alpha or a fully smooth translucent fade. Display the resulting GIF inline when the chat renderer supports it and include a file link.

## Host and product handoff

The portable Python helper requires an authorized local host with FFmpeg, ffprobe, NumPy and Pillow. A CUE skill-library entry is instructional guidance and does not grant shell access, expose local files, install Python, or create a product tool. Use the current authorized desktop/creative host or an explicit Codex handoff, preserving source and output identities. If the current consumer cannot execute the helper or import the result, name that concrete gap and still deliver the prepared workflow and review evidence. Do not claim a bundled Markdown guide is an executable app feature.

Keep source, frames, configuration, logs and outputs in the owner's designated writable task storage. On the originating host this is the matching repository folder on NAS. Never silently fall back to internal temporary storage or overwrite the input. Paid generation, external uploads and unrelated app installation are not part of this local extraction workflow.

## Evidence and outcome

Deliver the alpha master, explicitly labeled browser/GIF variants and preview; record input/output hashes, metadata, exact processing parameters and masks, all-frame alpha/timing results, source-audio preservation, visual review scope and remaining limitations. Separate instruction discovery, local helper tests, product account installation, installed-app behavior and user acceptance. See [the verified case and its limits](references/case-study.md) for the originating evidence.

## Failure case

A white-background key removes teeth, a filled silhouette turns an arm gap white, a fading accent becomes an opaque cream block, or transparent RGB creates a dark encoded fringe. Repair the applicable mask/color/encoding path, regenerate only affected validated stages where safe, and recheck the full sequence and decoded delivery. Never hide a failed verification behind a successful encoder exit or promise zero artifacts from an unknown matte.
