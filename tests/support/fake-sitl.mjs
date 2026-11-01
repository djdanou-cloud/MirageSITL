// A fake ArduPilot SITL for the launcher tests (TASK-151, TASK-154). The
// wrapper from fake-firmware.ts runs it as
//   node fake-sitl.mjs --fake-mode MODE <SITL arguments>
// in the experiment's working directory. Every mode prints its SITL
// arguments as JSON on stdout and writes logs/00000001.BIN. Modes:
//   idle              wait until signalled; nothing on stderr. Prints
//                     "fake sitl alive N" on stdout every 100 ms, and
//                     "received SIGTERM" before SIGTERM ends it as usual
//   exit3             a diagnostics line on stderr, exit code 3 after 200 ms
//   ignore-term       ignore SIGTERM, so only SIGKILL ends it
//   fork              a diagnostics line on stderr and a /bin/sleep grandchild
//                     whose PID goes to grandchild.pid
//   bind-busy <port>  listen on TCP 127.0.0.1:<port>; when the port is taken,
//                     print ArduPilot's bind failure line on stderr and exit 1
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const MODE_FLAG = "--fake-mode";
if (process.argv[2] !== MODE_FLAG || process.argv[3] === undefined) {
  console.error(`fake sitl: expected ${MODE_FLAG} MODE before the SITL arguments`);
  process.exit(2);
}
const mode = process.argv[3];
const args = process.argv.slice(4);
const [name, ...operands] = mode.split(" ");

console.log(JSON.stringify({ args }));
mkdirSync("logs", { recursive: true });
writeFileSync("logs/00000001.BIN", Buffer.from([0xa3, 0x95, 0x80, 1, 2, 3]));

if (name === "idle" && operands.length === 0) {
  let beats = 0;
  setInterval(() => console.log(`fake sitl alive ${++beats}`), 100);
  process.once("SIGTERM", () => {
    console.log("received SIGTERM");
    // With its only listener gone, SIGTERM has its default action again, so the run still ends by the signal.
    process.kill(process.pid, "SIGTERM");
  });
} else if (name === "exit3" && operands.length === 0) {
  console.error("fake sitl diagnostics");
  setTimeout(() => process.exit(3), 200);
} else if (name === "ignore-term" && operands.length === 0) {
  process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
} else if (name === "fork" && operands.length === 0) {
  console.error("fake sitl diagnostics");
  const child = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  writeFileSync("grandchild.pid", String(child.pid));
} else if (name === "bind-busy" && operands.length === 1 && /^[1-9][0-9]{0,4}$/.test(operands[0]) && Number(operands[0]) <= 65535) {
  const port = Number(operands[0]);
  const listener = createServer();
  listener.once("error", error => {
    // The message format of ArduPilot's SITL UARTDriver for a TCP listener it cannot bind.
    if (error.code === "EADDRINUSE") console.error(`bind failed on port ${port} - Address already in use`);
    else console.error(`fake sitl: listen on port ${port} failed: ${error.message}`);
    process.exit(1);
  });
  listener.listen(port, "127.0.0.1");
} else {
  console.error(`fake sitl: unknown mode ${JSON.stringify(mode)}`);
  process.exit(2);
}
setInterval(() => undefined, 1000);
