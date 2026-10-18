import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
test("direct contact WASM runs in an isolated browser Worker", async ({ page }) => {
    test.setTimeout(300000);
    execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
    const bytes = Array.from(readFileSync("packages/physics/dist/contact/contact.wasm"));
    await page.goto("/");
    const result = await page.evaluate(async (bytes) => {
        const code = `onmessage=async e=>{
      try {
        const {instance}=await WebAssembly.instantiate(new Uint8Array(e.data),{}), x=instance.exports;
        const h=new Float64Array(x.memory.buffer),c=x.contact_config_ptr()/8,i=x.contact_input_ptr()/8,o=x.contact_output_ptr()/8;
        h[c]=1;h[c+2]=1;h[c+3]=.1;h[c+8]=-1;h[c+12]=1;h[c+19]=h[c+20]=h[c+21]=.004;h[c+24]=-1;h[c+26]=9.80665;
        if(x.contact_initialize()!==0)throw Error('initialize');
        const before=x.memory.buffer;h[i+14]=1/1200;
        for(let n=0;n<1000000;n++)if(x.contact_step()!==0)throw Error('step '+n);
        postMessage({z:h[o+2],calls:x.contact_allocation_calls(),bytes:x.contact_allocation_bytes(),stable:before===x.memory.buffer,probe:x.contact_allocator_probe()});
        x.contact_dispose();
      }catch(e){postMessage({error:String(e)})}
    }`;
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        try {
            return await new Promise<unknown>((resolve, reject) => {
                const worker = new Worker(url);
                worker.onmessage = e => { const value: unknown = e.data; worker.terminate(); resolve(value); };
                worker.onerror = e => { worker.terminate(); reject(new Error(e.message)); };
                worker.postMessage(bytes);
            });
        }
        finally {
            URL.revokeObjectURL(url);
        }
    }, bytes);
    expect(result).toMatchObject({ calls: 0, bytes: 0, stable: true, probe: 1 });
    expect(result).toHaveProperty("z", expect.closeTo(-0.1, 2));
});
