import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectNativeBinary, readNativeExecutable } from "../scripts/sitl/native-binary.ts";

// Independent byte fixtures from mach-o/loader.h (Apple SDK) and ELF64 gABI.
// Neither fixture is executed or registered as real firmware evidence.
function mach(cpu = 0x0100000c): Uint8Array {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, cpu, true);
  view.setUint32(12, 2, true); // MH_EXECUTE
  view.setUint32(16, 2, true);
  view.setUint32(20, 96, true);
  view.setUint32(32, 0x19, true); // LC_SEGMENT_64
  view.setUint32(36, 72, true);
  view.setUint32(80, 128, true); // filesize at command+48
  view.setUint32(92, 5, true); // initprot: read+execute
  view.setUint32(104, 0x80000028, true); // LC_MAIN
  view.setUint32(108, 24, true);
  return bytes;
}
function elf(machine = 183): Uint8Array {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 69, 76, 70, 2, 1, 1]);
  view.setUint16(16, 2, true);
  view.setUint16(18, machine, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 120, true); // e_entry inside the executable load segment
  view.setUint32(32, 64, true); // e_phoff
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  view.setUint32(64, 1, true); // PT_LOAD
  view.setUint32(68, 5, true); // PF_R|PF_X
  view.setUint32(96, 128, true); // p_filesz
  return bytes;
}
it("admits host-matching Mach-O executables on macOS and retains ELF64 on Linux", () => {
  expect(inspectNativeBinary(mach(), "darwin", "arm64")).toEqual({ format: "mach-o64", architecture: "arm64" });
  expect(inspectNativeBinary(mach(0x01000007), "darwin", "x64")).toEqual({ format: "mach-o64", architecture: "x64" });
  expect(inspectNativeBinary(elf(), "linux", "arm64")).toEqual({ format: "elf64", architecture: "arm64" });
  expect(inspectNativeBinary(elf(62), "linux", "x64")).toEqual({ format: "elf64", architecture: "x64" });
});
it("rejects magic-only, truncated, wrong-host, wrong-architecture and non-executable images", () => {
  for (const [bytes, platform, arch] of [
    [mach().subarray(0, 4), "darwin", "arm64"],
    [elf().subarray(0, 4), "linux", "arm64"],
    [mach().subarray(0, 100), "darwin", "arm64"],
    [elf().subarray(0, 100), "linux", "arm64"],
    [mach(), "darwin", "x64"], [elf(), "linux", "x64"],
    [elf(), "darwin", "arm64"], [mach(), "linux", "arm64"],
    [mach(), "win32", "arm64"], [mach(), "darwin", "ia32"],
  ] as const) expect(() => inspectNativeBinary(bytes, platform, arch)).toThrow();
  for (const [offset, value] of [[12, 6], [16, 0], [20, 0xffffffff], [36, 4], [80, 129], [92, 1], [104, 0]]) {
    const bytes = mach();
    const view = new DataView(bytes.buffer);
    // The fixed fixture mutations above have exactly two entries each.
    view.setUint32(offset!, value!, true);
    expect(() => inspectNativeBinary(bytes, "darwin", "arm64")).toThrow();
  }
  for (const [offset, value] of [[16, 1], [18, 62], [54, 8], [56, 0]]) {
    const bytes = elf();
    new DataView(bytes.buffer).setUint16(offset!, value!, true);
    expect(() => inspectNativeBinary(bytes, "linux", "arm64")).toThrow();
  }
});
it("requires executable permission and accepts the actual host Node executable", () => {
  expect(readNativeExecutable(process.execPath).identity.architecture).toBe(process.arch);
  const directory = mkdtempSync(join(tmpdir(), "mirage-native-admission-"));
  try {
    const file = join(directory, "not-executable");
    writeFileSync(file, mach());
    chmodSync(file, 0o600);
    expect(() => readNativeExecutable(file, "darwin", "arm64")).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


it("rejects ELF shared objects without an entry point", () => {
  const bytes = elf();
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 3, true); // ET_DYN: also used by PIE executables.
  view.setUint32(24, 0, true);
  expect(() => inspectNativeBinary(bytes, "linux", "arm64")).toThrow();
});
