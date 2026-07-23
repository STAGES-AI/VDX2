/**
 * Minimal ambient types for "bun:test" so the vdx bun tests typecheck in this
 * app's tsconfig ("types" is pinned to vite/client and bun-types is not a
 * declared dependency). Bun itself supplies the real implementation at run
 * time; extend the matcher list here if a test needs more.
 */
declare module "bun:test" {
  export interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeCloseTo(expected: number, digits?: number): void;
    toHaveLength(expected: number): void;
    toBeTruthy(): void;
    toBeUndefined(): void;
    toThrow(expected?: string | RegExp): void;
    not: Matchers;
  }
  export function expect(actual: unknown): Matchers;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
