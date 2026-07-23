/**
 * MediaTime — fixed-point time in ticks, inherited from OpenCut classic's Rust
 * `time` crate (TICKS_PER_SECOND = 120_000, chosen to divide common frame
 * rates exactly: 24, 25, 30, 48, 50, 60, 23.976 (24000/1001), 29.97, 59.94).
 *
 * Represented as a plain number of ticks. Number is safe: 2^53 ticks ≈ 2,380
 * years of media. All timeline math happens in ticks; seconds only at the
 * edges (ffmpeg args, UI display, provider durations).
 */

export const TICKS_PER_SECOND = 120_000;

export type MediaTime = number; // integer ticks

export interface FrameRate {
  numerator: number;
  denominator: number;
}

export const FPS_24: FrameRate = { numerator: 24, denominator: 1 };
export const FPS_25: FrameRate = { numerator: 25, denominator: 1 };
export const FPS_30: FrameRate = { numerator: 30, denominator: 1 };
export const FPS_60: FrameRate = { numerator: 60, denominator: 1 };
export const FPS_23_976: FrameRate = { numerator: 24000, denominator: 1001 };
export const FPS_29_97: FrameRate = { numerator: 30000, denominator: 1001 };
export const FPS_59_94: FrameRate = { numerator: 60000, denominator: 1001 };

export const mt = {
  fromSeconds(seconds: number): MediaTime {
    if (!Number.isFinite(seconds)) throw new Error(`Invalid seconds: ${seconds}`);
    return Math.round(seconds * TICKS_PER_SECOND);
  },

  toSeconds(t: MediaTime): number {
    return t / TICKS_PER_SECOND;
  },

  ticksPerFrame(rate: FrameRate): number {
    const tpf = (TICKS_PER_SECOND * rate.denominator) / rate.numerator;
    if (!Number.isInteger(tpf)) {
      // Non-exact rates still get a consistent (rounded) tick grid.
      return Math.round(tpf);
    }
    return tpf;
  },

  fromFrames(frames: number, rate: FrameRate): MediaTime {
    return frames * mt.ticksPerFrame(rate);
  },

  toFramesRound(t: MediaTime, rate: FrameRate): number {
    return Math.round(t / mt.ticksPerFrame(rate));
  },

  toFramesFloor(t: MediaTime, rate: FrameRate): number {
    return Math.floor(t / mt.ticksPerFrame(rate));
  },

  roundToFrame(t: MediaTime, rate: FrameRate): MediaTime {
    return mt.toFramesRound(t, rate) * mt.ticksPerFrame(rate);
  },

  /** "MM:SS.mmm" for logs and chat narration. */
  format(t: MediaTime): string {
    const total = mt.toSeconds(t);
    const m = Math.floor(total / 60);
    const s = total - m * 60;
    return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
  },
};
