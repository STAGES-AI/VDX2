# Repeatable local workflow

## Intake and plan

Use ffprobe on the exact input to record width/height, video stream, pixel format, timestamps, frame count, frame rate, source audio and rotation. Confirm constant frame rate before a frame-sequence path; variable-rate input needs a timestamp-preserving route, not an arbitrary fps conversion. Do not infer plate color or alpha support from the filename/container alone.

Keep the input bytes unchanged. Select an output directory explicitly, check that it is on the designated mounted writable storage, and preserve the input SHA256. Record whether accents, shadows and motion blur are foreground. Choose a subject seed inside the opaque connected body, plate mode, interior sampling width and only source-verified optional regions. Inspect defaults against the actual scale rather than copying 768px or a reference frame number from the originating example.

The CLI supports inspect and render modes; run `python3 scripts/video_matte.py --help` from the installed skill package for the exact current parameters. Use an existing Python with NumPy and Pillow; do not assume the OS Python has them or install dependencies without a justified task-local environment. Discover FFmpeg/ffprobe rather than assuming Homebrew paths. The CLI should reject unsupported timing and unavailable dependencies with an explicit error.

## Matte and color

For a neutral pale plate behind a saturated subject, estimate the plate from bright low-chroma background samples. Use warm color separation for the initial contour, preserve enclosed subject features, and inspect holes that belong to the plate. Erode enough pixels into the opaque foreground to obtain clean color samples; too shallow a guide can treat compressed pale edge pixels as opaque. Expand a narrow trimap, fit alpha from the plate-to-foreground color vector, and unmix the plate from edge colors. Clamp uncertain faint-edge colors to supported source hues.

Treat detached graphics separately from the connected body. A temporal color reference is taken from actual fully visible graphics, with the body excluded using a verified nonempty connected component. Palette/reference samples must not include orange body fragments when estimating yellow accents. Estimate the fade opacity rather than normalizing each frame's faded pale color to opaque. Use only inspected asset-specific ROIs as parameters; no reusable module should embed the originating leg/armpit coordinates.

Pillow pitfall: a NumPy-backed `Image.fromarray` can be read-only. Use a writable `.copy()` before `ImageDraw.floodfill`, then assert that the expected subject component is nonempty. A vacuous byte-preservation comparison is not a pass.

Clean genuinely disconnected body dust without deleting intended accents, thin features or motion blur. Extend source-supported RGB a few pixels into fully transparent surroundings before 4:2:0 color conversion. This invisible RGB extension prevents alpha edges from mixing with black chroma during browser encoding.

## Review and delivery

Build black/white/saturated-color/checkerboard composites at native scale and enlarged edge crops. Inspect the entire animation, especially moving arm gaps, cheek/fist notches, leg gaps, facial whites, accent onset/fade and first/last frames. Record whether review was full playback, all-frame contact sheets, selected native crops, numeric checks or some combination. Do not describe one evidence class as another.

Decode the outputs again. Check every alpha plane, source/output dimensions and frame counts, timing and transparent borders where the source composition has clear margins. Compare alpha against the working matte with an explicit tolerance that accounts for conversion. Copied master audio should match a compressed-packet hash, not merely a codec label. Preserve the master if a secondary browser codec fails; label any silent secondary version explicitly.

A MOV/ProRes4444 or VP9/WebM file may show a black background in a viewer that ignores alpha. Verify with a capable decoder and real compositing. A checkerboard MP4 is a review copy with baked squares, not transparent media. GIF offers binary transparency and quantized timing only; preserve the soft-alpha master alongside it.

CLI verification results do not certify live CUE execution, project import, installed desktop behavior or production acceptance. Read back any authorized import/asset attachment through the receiving product before claiming it.
