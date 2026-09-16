import { newQuickJSWASMModule, newVariant, RELEASE_SYNC, type QuickJSContext, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";
import type { BoardAPI, EngineResult, MemoryStats, Workload } from "./types";

export class Engine {
  private deadline = Infinity;
  private calls = 0;
  private codeUnits = 0;
  private closed = false;
  private constructor(readonly module: QuickJSWASMModule, readonly runtime: QuickJSRuntime, readonly vm: QuickJSContext) {}

  static async create(wasm: ArrayBuffer, guest: string, api?: BoardAPI): Promise<Engine> {
    // The bundled IIFE has no import.meta.url. Emscripten still resolves a
    // filename even when bytes are supplied; this is never fetched.
    const module = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmBinary: wasm, wasmLocation: "quickjs.wasm" }));
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(64 * 1024 * 1024);
    runtime.setMaxStackSize(1024 * 1024);
    const vm = runtime.newContext();
    const engine = new Engine(module, runtime, vm);
    runtime.setInterruptHandler(() => performance.now() >= engine.deadline);
    if (api) {
      const read = vm.newFunction("__read", (methodHandle, argumentHandle) => {
        const method = vm.getString(methodHandle);
        const argument = vm.getString(argumentHandle);
        let result: unknown;
        switch (method) {
          case "catalog": result = api.catalog(); break;
          case "item": result = api.item(argument); break;
          case "net": result = api.net(argument); break;
          default: throw new Error("Denied board method");
        }
        const json = JSON.stringify(result);
        engine.calls++;
        engine.codeUnits += json.length;
        return vm.newString(json);
      });
      vm.setProp(vm.global, "__read", read);
      read.dispose();
    }
    try { engine.evaluate(guest, 5000); }
    catch (error) { engine.dispose(); throw error; }
    return engine;
  }

  evaluate(code: string, deadlineMs = 5000): unknown {
    this.deadline = performance.now() + deadlineMs;
    try {
      const result = this.vm.evalCode(code, "plugin.js");
      if (result.error) {
        const error = this.vm.dump(result.error);
        result.error.dispose();
        throw new Error(typeof error?.message === "string" ? error.message : String(error));
      }
      try { return this.vm.dump(result.value); }
      finally { result.value.dispose(); }
    } finally { this.deadline = Infinity; }
  }

  private call(name: string, text: string): string | undefined {
    this.deadline = performance.now() + 5000;
    const fn = this.vm.getProp(this.vm.global, name);
    const value = this.vm.newString(text);
    try {
      const result = this.vm.callFunction(fn, this.vm.undefined, value);
      if (result.error) {
        const error = this.vm.dump(result.error);
        result.error.dispose();
        throw new Error(error?.message ?? String(error));
      }
      try { return this.vm.typeof(result.value) === "string" ? this.vm.getString(result.value) : undefined; }
      finally { result.value.dispose(); }
    } finally {
      value.dispose(); fn.dispose(); this.deadline = Infinity;
    }
  }
  load(text: string): number {
    const start = performance.now(); this.call("__load", text); return performance.now() - start;
  }
  patch(text: string): number {
    const start = performance.now(); this.call("__patch", text); return performance.now() - start;
  }
  run(workload: Workload): Omit<EngineResult, "memory"> {
    if (!Number.isInteger(workload.passes) || workload.passes < 1 || workload.passes > 50) throw new Error("Pass count must be 1–50");
    this.calls = 0; this.codeUnits = 0;
    const start = performance.now();
    const text = this.call("__run", JSON.stringify(workload));
    const report = JSON.parse(text!);
    const executionMs = performance.now() - start;
    return { report, executionMs, bridgeCalls: this.calls, bridgeStringCodeUnits: this.codeUnits };
  }
  memory(): MemoryStats {
    const handle = this.runtime.computeMemoryUsage();
    try {
      const usage = this.vm.dump(handle);
      return {
        quickjsUsedBytes: usage.memory_used_size,
        quickjsAllocatedBytes: usage.malloc_size,
        wasmCapacityBytes: this.module.getWasmMemory().buffer.byteLength,
      };
    } finally { handle.dispose(); }
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.vm.dispose(); this.runtime.dispose();
  }
}
