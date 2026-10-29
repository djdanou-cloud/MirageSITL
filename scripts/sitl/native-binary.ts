/** Cold native executable admission. ELF64 gABI and Apple mach-o/loader.h layouts. */
import { accessSync, constants, readFileSync, statSync } from "node:fs";

export interface NativeBinaryIdentity {
  readonly format: "elf64" | "mach-o64";
  readonly architecture: "arm64" | "x64";
}

/** Inspect a thin, little-endian 64-bit image for the actual host, never a script or DLL. */
export function inspectNativeBinary(bytes: Uint8Array, platform: string, architecture: string): NativeBinaryIdentity {
  if (architecture !== "arm64" && architecture !== "x64") throw new Error("Unsupported native SITL host architecture");
  if (platform !== "darwin" && platform !== "linux") throw new Error("Native SITL requires macOS or Linux");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (offset: number): number => {
    const value = view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 4294967296;
    if (!Number.isSafeInteger(value)) throw new Error("Native executable offset exceeds the safe range");
    return value;
  };
  if (platform === "darwin") {
    if (bytes.length < 32 || view.getUint32(0, true) !== 0xfeedfacf ||
        view.getUint32(4, true) !== (architecture === "arm64" ? 0x0100000c : 0x01000007) ||
        view.getUint32(12, true) !== 2) throw new Error("Expected a host-matching Mach-O64 executable");
    const count = view.getUint32(16, true);
    const size = view.getUint32(20, true);
    const end = 32 + size;
    if (!count || end > bytes.length || count > size / 8) throw new Error("Invalid Mach-O load-command table");
    let offset = 32;
    let executableSegment = false;
    let entryPoint = false;
    for (let i = 0; i < count; i++) {
      if (offset + 8 > end) throw new Error("Truncated Mach-O load command");
      const command = view.getUint32(offset, true);
      const length = view.getUint32(offset + 4, true);
      if (length < 8 || length % 8 || offset + length > end) throw new Error("Invalid Mach-O load-command length");
      if (command === 0x19) { // LC_SEGMENT_64
        if (length < 72) throw new Error("Truncated Mach-O segment");
        const fileOffset = u64(offset + 40);
        const fileSize = u64(offset + 48);
        if (fileOffset + fileSize > bytes.length) throw new Error("Mach-O segment exceeds the file");
        if (fileSize > 0 && (view.getUint32(offset + 60, true) & 4)) executableSegment = true;
      }
      if (command === 0x80000028 && length >= 24 || command === 5 && length >= 16) entryPoint = true;
      offset += length;
    }
    if (offset !== end || !executableSegment || !entryPoint) throw new Error("Mach-O executable lacks code or an entry point");
    return { format: "mach-o64", architecture };
  }
  if (bytes.length < 64 || view.getUint32(0, true) !== 0x464c457f ||
      bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 ||
      ![2, 3].includes(view.getUint16(16, true)) ||
      view.getUint16(18, true) !== (architecture === "arm64" ? 183 : 62) ||
      view.getUint32(20, true) !== 1 || view.getUint16(52, true) !== 64) throw new Error("Expected a host-matching ELF64 executable");
  const offset = u64(32);
  const stride = view.getUint16(54, true);
  const count = view.getUint16(56, true);
  if (offset < 64 || stride !== 56 || !count || offset + stride * count > bytes.length) throw new Error("Invalid ELF program-header table");
  const entry = u64(24);
  if (entry === 0) throw new Error("ELF executable has no entry point");
  let executableSegment = false;
  let entryMapped = false;
  for (let i = 0; i < count; i++) {
    const start = offset + i * stride;
    const fileOffset = u64(start + 8);
    const fileSize = u64(start + 32);
    if (fileOffset + fileSize > bytes.length) throw new Error("ELF segment exceeds the file");
    if (view.getUint32(start, true) === 1 && fileSize > 0 && (view.getUint32(start + 4, true) & 1)) {
      executableSegment = true;
      const address = u64(start + 16);
      if (entry >= address && entry - address < fileSize) entryMapped = true;
    }
  }
  if (!executableSegment || !entryMapped) throw new Error("ELF entry point is not in a code segment");
  return { format: "elf64", architecture };
}

export function readNativeExecutable(path: string, platform = process.platform, architecture = process.arch): {
  bytes: Buffer; identity: NativeBinaryIdentity;
} {
  if (!statSync(path).isFile()) throw new Error("Native SITL binary is not a regular file");
  accessSync(path, constants.X_OK);
  const bytes = readFileSync(path);
  return { bytes, identity: inspectNativeBinary(bytes, platform, architecture) };
}
