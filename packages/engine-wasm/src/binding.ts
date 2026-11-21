/**
 * WASM binding for the Rust execution engine.
 *
 * The same `ib_cmd` JSON protocol is used by the native C ABI (Windows/Android)
 * and the browser extension. No platform access happens inside WASM.
 */

export interface EngineError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
  platform_detail?: string;
  retryable?: boolean;
}

export interface EngineResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: EngineError;
}

interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  ib_new: () => number;
  ib_destroy: (engine: number) => void;
  ib_alloc: (size: number) => number;
  ib_free: (pointer: number, size: number) => void;
  ib_cmd: (engine: number, pointer: number, length: number) => number;
  ib_response_ptr: () => number;
  ib_response_len: () => number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class WasmEngine {
  private readonly exports: WasmExports;
  private readonly engine: number;
  private disposed = false;

  private constructor(exports: WasmExports) {
    this.exports = exports;
    this.engine = exports.ib_new();
  }

  static async fromBytes(bytes: BufferSource): Promise<WasmEngine> {
    const module = await WebAssembly.compile(bytes);
    return WasmEngine.fromModule(module);
  }

  /** Reuse a compiled module: compilation is the expensive, retained part. */
  static async fromModule(module: WebAssembly.Module): Promise<WasmEngine> {
    const instance = await WebAssembly.instantiate(module, {});
    return new WasmEngine(instance.exports as WasmExports);
  }

  static async fromUrl(url: string | URL, init?: RequestInit): Promise<WasmEngine> {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`failed to fetch wasm: ${response.status}`);
    return WasmEngine.fromBytes(await response.arrayBuffer());
  }

  static async fromFile(path: string): Promise<WasmEngine> {
    const { readFile } = await import('node:fs/promises');
    return WasmEngine.fromBytes(await readFile(path));
  }

  /** Executes one protocol command. Throws only on transport/ABI failure. */
  command<T = unknown>(command: Record<string, unknown>): EngineResponse<T> {
    if (this.disposed) throw new Error('engine disposed');
    const bytes = encoder.encode(JSON.stringify(command));
    const pointer = this.exports.ib_alloc(bytes.length);
    if (pointer === 0 && bytes.length > 0) throw new Error('wasm allocation failed');
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
    const length = this.exports.ib_cmd(this.engine, pointer, bytes.length);
    const responsePointer = this.exports.ib_response_ptr();
    const copy = new Uint8Array(this.exports.memory.buffer, responsePointer, length).slice();
    this.exports.ib_free(pointer, bytes.length);
    return JSON.parse(decoder.decode(copy)) as EngineResponse<T>;
  }

  loadJson(flowJson: string) {
    return this.command({ cmd: 'load_json', json: flowJson });
  }

  load(flow: unknown) {
    return this.command({ cmd: 'load', flow });
  }

  validate() {
    return this.command({ cmd: 'validate' });
  }

  arm() {
    return this.command({ cmd: 'arm' });
  }

  start(options: {
    run_id: string;
    now_mono_ms: number;
    wall_time_ms: number;
    variables?: Record<string, unknown>;
    start_step_id?: string;
    single_step?: boolean;
  }) {
    return this.command({ cmd: 'start', variables: {}, ...options });
  }

  submit(input: Record<string, unknown>) {
    return this.command({ cmd: 'submit', input });
  }

  configure(config: Record<string, unknown>) {
    return this.command({ cmd: 'config', config });
  }

  snapshot() {
    return this.command({ cmd: 'snapshot' });
  }

  events() {
    return this.command({ cmd: 'events' });
  }

  state() {
    return this.command({ cmd: 'state' });
  }

  reset() {
    return this.command({ cmd: 'reset' });
  }

  dispose() {
    if (!this.disposed) {
      this.exports.ib_destroy(this.engine);
      this.disposed = true;
    }
  }
}
