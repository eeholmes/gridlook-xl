import Blosc from "numcodecs/blosc";
import * as zarr from "zarrita";

import { createPcodecDecoder } from "@/lib/data/pcodecWasm.ts";

class Fletcher32Codec {
  readonly kind = "bytes_to_bytes";

  static fromConfig() {
    return new Fletcher32Codec();
  }

  encode(): never {
    throw new Error(
      "Fletcher32 encoding is not supported because this codec is read-only"
    );
  }

  decode(bytes: Uint8Array): Uint8Array {
    return bytes.subarray(0, Math.max(0, bytes.byteLength - 4));
  }
}

let registered = false;
export function registerZarrCodecs() {
  if (registered) {
    return;
  }
  const codecFactory = async () => Fletcher32Codec;
  const bloscCodecFactory = async () => Blosc as never;
  const pcodecCodecFactory = async () => (await createPcodecDecoder()) as never;
  if (!zarr.registry.has("fletcher32")) {
    zarr.registry.set("fletcher32", codecFactory);
  }
  if (!zarr.registry.has("numcodecs.fletcher32")) {
    zarr.registry.set("numcodecs.fletcher32", codecFactory);
  }
  if (!zarr.registry.has("blosc2")) {
    zarr.registry.set("blosc2", bloscCodecFactory);
  }
  if (!zarr.registry.has("numcodecs.blosc2")) {
    zarr.registry.set("numcodecs.blosc2", bloscCodecFactory);
  }
  if (!zarr.registry.has("numcodecs.pcodec")) {
    zarr.registry.set("numcodecs.pcodec", pcodecCodecFactory);
  }
  registered = true;
}

registerZarrCodecs();
