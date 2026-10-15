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
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }
  nextFloat(): number { return this.nextUint32() / 4294967296; }
}
