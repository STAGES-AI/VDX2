# Originating verified case, 2026-10-17

Evidence class: faithful summary of observed source bytes, processing results and readback from the originating task. No raw transcript or user media is bundled with this skill.

- Source: 768x768 H.264 yuv420p, 24fps,124 video frames; video duration5.166667s; container/AAC audio duration5.184s. The filename said black background, but inspected frames showed a pale neutral plate.
- Foreground: orange block character with black eyes/mouth, enclosed white teeth/glints and detached yellow animated accent rays. The owner explicitly retained the yellow accents.
- Repaired failures: a3px interior guide retained pale H.264 contamination in a leg notch; a5px guide cleaned it. Filled silhouettes trapped pale plate in frame17 armpits; inspected negative-space masks removed300 visible pale pixels without touching face/teeth/glints. Initial per-frame accent treatment created opaque cream blocks during a fade; source-reference colors recovered estimated translucent yellow/brown graphics. Writable-image copying plus a nonempty body invariant corrected a flood-fill preservation test. Detached dust and invisible RGB/chroma handling were checked separately.
- Final MOV: ProRes4444 with decoded yuva444p12le alpha,124frames at24fps; exact original compressedAAC packet hash preserved. SHA256 ec1e138069628b53bcc40d4e0df4a1bafe84838b94902e233014c276fb0ab9d3.
- Final WebM: silentVP9 with alpha readback through libvpx-vp9,124frames at24fps. SHA256 cc69b2a204984880c60f533feccfdde5861ff15217b6ad92a51e6f2bd4a5742e. An optional OpusWebM emitted a container/parser warning; its packets decoded and OGG remux decoded cleanly, but the delivered browser copy was silent instead. Audio remained intact in the MOV.
- All124 decoded alpha planes checked in each export. Clear outer margins remained fully transparent. Maximum8-bit alpha difference versus working PNG was1/255; mean0.0034089/255MOV and0.0127284/255WebM.
- Visual evidence: all-frame body contact sheets, selected native black/white/blue/checker composites, enlarged notch/negative-space/fade crops and final encoded preview contact sheet. Full-speed playback was not established by those checks. Some source compression/mottling remains in faint accents; absolute artifact-free or true original-alpha recovery was not claimed.
- Requested transparent GIF:124frames,768x768,5170ms,looping,transparent in every frame. GIF hard-alpha/palette/timing limitations apply.

Case-specific parameters and timing are evidence, not defaults for other clips. The generalized helper is separately tested on synthetic non768 fixtures; those tests do not certify arbitrary subjects or backgrounds.
