type TDecodeExport =
  | "decompress_f32"
  | "decompress_f64"
  | "decompress_i8"
  | "decompress_u8"
  | "decompress_i16"
  | "decompress_u16"
  | "decompress_i32"
  | "decompress_u32"
  | "decompress_i64"
  | "decompress_u64";

type TFreeExport =
  | "free_u8_input"
  | "free_f32"
  | "free_f64"
  | "free_i8"
  | "free_u8"
  | "free_i16"
  | "free_u16"
  | "free_i32"
  | "free_u32"
  | "free_i64"
  | "free_u64";

type TPcodecWasmExports = {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  free_u8_input(ptr: number, len: number): void;
} & Record<
  TDecodeExport,
  (ptr: number, len: number, outLenPtr: number) => number
> &
  Record<TFreeExport, (ptr: number, len: number) => void>;

type TPcodecTypedArray =
  | Float32ArrayConstructor
  | Float64ArrayConstructor
  | Int8ArrayConstructor
  | Uint8ArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | BigInt64ArrayConstructor
  | BigUint64ArrayConstructor;

type TPcodecFormat = {
  decodeExport: TDecodeExport;
  freeExport: TFreeExport;
  typedArray: TPcodecTypedArray;
};

type TPcodecContext = {
  wasm: TPcodecWasmExports;
  formats: Record<string, TPcodecFormat>;
};

const wasmBase = import.meta.env?.BASE_URL ?? "/";
const wasmUrl = `${wasmBase}pcodec/pcodec.wasm`;
let contextPromise: Promise<TPcodecContext> | null = null;

const formats: Record<string, TPcodecFormat> = {
  float32: {
    decodeExport: "decompress_f32",
    freeExport: "free_f32",
    typedArray: Float32Array,
  },
  float64: {
    decodeExport: "decompress_f64",
    freeExport: "free_f64",
    typedArray: Float64Array,
  },
  int8: {
    decodeExport: "decompress_i8",
    freeExport: "free_i8",
    typedArray: Int8Array,
  },
  uint8: {
    decodeExport: "decompress_u8",
    freeExport: "free_u8",
    typedArray: Uint8Array,
  },
  int16: {
    decodeExport: "decompress_i16",
    freeExport: "free_i16",
    typedArray: Int16Array,
  },
  uint16: {
    decodeExport: "decompress_u16",
    freeExport: "free_u16",
    typedArray: Uint16Array,
  },
  int32: {
    decodeExport: "decompress_i32",
    freeExport: "free_i32",
    typedArray: Int32Array,
  },
  uint32: {
    decodeExport: "decompress_u32",
    freeExport: "free_u32",
    typedArray: Uint32Array,
  },
  int64: {
    decodeExport: "decompress_i64",
    freeExport: "free_i64",
    typedArray: BigInt64Array,
  },
  uint64: {
    decodeExport: "decompress_u64",
    freeExport: "free_u64",
    typedArray: BigUint64Array,
  },
};

async function loadPcodecContext(): Promise<TPcodecContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const response = await fetch(wasmUrl);
      if (!response.ok) {
        throw new Error(`Failed to load pcodec wasm from ${wasmUrl}`);
      }
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return {
        wasm: instance.exports as unknown as TPcodecWasmExports,
        formats,
      };
    })();
  }
  return await contextPromise;
}

function copyBytes(memory: WebAssembly.Memory, ptr: number, bytes: Uint8Array) {
  new Uint8Array(memory.buffer, ptr, bytes.byteLength).set(bytes);
}

export class PcodecDecoder {
  readonly kind = "bytes_to_bytes" as const;

  #dataType: string;

  constructor(dataType: string) {
    this.#dataType = dataType;
  }

  static fromConfig(
    _config: Record<string, unknown>,
    meta: { dataType: string }
  ) {
    return new PcodecDecoder(meta.dataType);
  }

  encode(): never {
    throw new Error(
      "PCodec encoding is not supported because this codec is read-only"
    );
  }

  async decode(bytes: Uint8Array): Promise<Uint8Array> {
    const context = await loadPcodecContext();
    const format = context.formats[this.#dataType];
    if (!format) {
      throw new Error(`Unsupported pcodec data type: ${this.#dataType}`);
    }

    const { wasm } = context;
    const inputPtr = wasm.alloc(bytes.byteLength);
    const outputLenPtr = wasm.alloc(4);
    try {
      copyBytes(wasm.memory, inputPtr, bytes);
      const outputPtr = wasm[format.decodeExport](
        inputPtr,
        bytes.byteLength,
        outputLenPtr
      );
      const outputLen = new DataView(wasm.memory.buffer).getUint32(
        outputLenPtr,
        true
      );
      const typedArray = new format.typedArray(
        wasm.memory.buffer,
        outputPtr,
        outputLen
      ).slice();
      const copied = new Uint8Array(
        typedArray.buffer,
        typedArray.byteOffset,
        typedArray.byteLength
      ).slice();
      wasm[format.freeExport](outputPtr, outputLen);
      return copied;
    } finally {
      wasm.free_u8_input(inputPtr, bytes.byteLength);
      wasm.free_u8_input(outputLenPtr, 4);
    }
  }
}

export async function createPcodecDecoder() {
  return PcodecDecoder;
}
