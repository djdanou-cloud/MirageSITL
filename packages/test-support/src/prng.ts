/** Version 1: Mulberry32 with uint32 seed/stream mixing. Not cryptographic. */
export const RANDOM_ALGORITHM = 'mulberry32-mix32-v1';
function uint32(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Expected uint32 seed/stream ID');
}
function mix32(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}
export class SeededRandom {
  private state = 0;
  constructor(seed: number, streamId: number) { this.reset(seed, streamId); }
  reset(seed: number, streamId: number): void {
    uint32(seed); uint32(streamId);
    this.state = mix32(seed ^ mix32(streamId ^ 0x9e3779b9));
  }
  /**
   * reset() with the seed read from `values[index]`, for a seed applied on the physics step (TASK-093): no double crosses
   * a call, where V8 can box it. The same state as reset(values[index], streamId).
   */
  resetFrom(values: Float64Array, index: number, streamId: number): void {
    const seed = values[index]!;
    if (!(seed >= 0 && seed <= 0xffffffff && seed === Math.floor(seed))) throw new Error('Expected uint32 seed/stream ID');
    uint32(streamId);
    this.state = mix32(seed ^ mix32(streamId ^ 0x9e3779b9));
  }
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }
  nextFloat(): number { return this.nextUint32() / 4294967296; }
  /**
   * A standard normal from the next two uniforms, x = √(−2·ln(1 − u1))·cos(2π·u2), into a slot, for the physics step (TASK-106). The
   * draws of two nextFloat calls, written out: a uint32 returned from a call V8 does not inline is boxed, and several of these to a
   * tick do not all inline. Allocation-free.
   */
  nextGaussianInto(out: Float64Array, index: number): void {
    const first = (this.state + 0x6d2b79f5) >>> 0, second = (first + 0x6d2b79f5) >>> 0;
    this.state = second;
    let a = Math.imul(first ^ (first >>> 15), first | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    let b = Math.imul(second ^ (second >>> 15), second | 1);
    b ^= b + Math.imul(b ^ (b >>> 7), b | 61);
    const u1 = ((a ^ (a >>> 14)) >>> 0) / 4294967296, u2 = ((b ^ (b >>> 14)) >>> 0) / 4294967296;
    out[index] = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
  }
}
