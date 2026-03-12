import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import { inflate } from "pako";

const labels: string[] = require("./labels.json");

export type ModelType = "efficientnet" | "mobilenet";
type StatusHandler = (status: string) => void;

type PredictOptions = {
  onStatusChange?: StatusHandler;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return "Unknown error.";
};

const buildStageError = (stage: string, error: unknown) =>
  new Error(`${stage}: ${getErrorMessage(error)}`);

// ─── Lazy-load fast-tflite so a JSI binding failure doesn't crash the module ─
type TfliteLib = typeof import("react-native-fast-tflite");
type ModelInstance = { run: (inputs: unknown[]) => Promise<unknown[]> };

let tflite: TfliteLib | null = null;
try {
  tflite = require("react-native-fast-tflite") as TfliteLib;
} catch (e) {
  console.error(
    "[predict] react-native-fast-tflite unavailable – rebuild with expo run:android/ios\n",
    e,
  );
}

const modelCache: Partial<Record<ModelType, ModelInstance>> = {};

export const loadModel = async (type: ModelType): Promise<ModelInstance> => {
  if (!tflite)
    throw new Error(
      "react-native-fast-tflite is not available. Use expo run:android or expo run:ios.",
    );

  if (modelCache[type]) return modelCache[type]!;

  const file =
    type === "efficientnet"
      ? require("./crop_disease.tflite")
      : require("./plant_model.tflite");

  const m = await tflite.loadTensorflowModel(file);
  modelCache[type] = m as ModelInstance;
  console.log(`✅ Model loaded: ${type}`);
  return m as ModelInstance;
};

// ─── Image → Float32Array (224 × 224 × 3) ────────────────────────────────────
// Steps:
//  1. Resize to 224×224, export as lossless PNG via expo-image-manipulator
//  2. Read base64, decode to Uint8Array
//  3. Parse PNG chunks → collect IDAT data → pako-inflate (zlib)
//  4. Un-filter each scanline (all 5 PNG filter types)
//  5. Convert uint8 RGB(A) → normalised float32 RGB in [0, 1]
const imageToTensor = async (imageUri: string): Promise<Float32Array> => {
  // Step 1 – resize
  const { uri: resizedUri } = await ImageManipulator.manipulateAsync(
    imageUri,
    [{ resize: { width: 224, height: 224 } }],
    { compress: 1, format: ImageManipulator.SaveFormat.PNG },
  );

  // Step 2 – read PNG bytes
  const b64 = await FileSystem.readAsStringAsync(resizedUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bin = atob(b64);
  const png = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) png[i] = bin.charCodeAt(i);

  // Step 3 – parse PNG chunks
  let colorType = 2; // 2 = RGB, 6 = RGBA
  const idatParts: Uint8Array[] = [];
  let off = 8; // skip 8-byte PNG signature
  while (off + 12 <= png.length) {
    const len =
      ((png[off] << 24) |
        (png[off + 1] << 16) |
        (png[off + 2] << 8) |
        png[off + 3]) >>>
      0;
    const type = String.fromCharCode(
      png[off + 4],
      png[off + 5],
      png[off + 6],
      png[off + 7],
    );
    if (type === "IHDR") {
      colorType = png[off + 17]; // bit 16 of IHDR data
    } else if (type === "IDAT") {
      idatParts.push(png.slice(off + 8, off + 8 + len));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len; // 4 len + 4 type + len data + 4 CRC
  }

  // Concatenate IDAT chunks then inflate the zlib stream
  let totalLen = 0;
  for (const p of idatParts) totalLen += p.length;
  const idat = new Uint8Array(totalLen);
  let p = 0;
  for (const part of idatParts) {
    idat.set(part, p);
    p += part.length;
  }
  const raw = inflate(idat); // pako decompresses zlib-wrapped DEFLATE

  // Step 4 – un-filter scanlines
  const W = 224,
    H = 224;
  const bpp = colorType === 6 ? 4 : 3; // bytes per pixel: RGBA=4, RGB=3
  const stride = 1 + W * bpp; // filter byte + row pixels
  const pixels = new Float32Array(W * H * 3);
  const prev = new Uint8Array(W * bpp); // previous reconstructed row
  const curr = new Uint8Array(W * bpp); // current  reconstructed row

  for (let y = 0; y < H; y++) {
    const filter = raw[y * stride];
    const rowBase = y * stride + 1;

    for (let i = 0; i < W * bpp; i++) {
      const x = raw[rowBase + i];
      const a = i >= bpp ? curr[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;

      switch (filter) {
        case 0:
          curr[i] = x;
          break;
        case 1:
          curr[i] = (x + a) & 0xff;
          break;
        case 2:
          curr[i] = (x + b) & 0xff;
          break;
        case 3:
          curr[i] = (x + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          curr[i] = (x + pr) & 0xff;
          break;
        }
        default:
          curr[i] = x;
      }
    }

    // Write normalised RGB floats (skip alpha if RGBA)
    for (let x = 0; x < W; x++) {
      const dst = (y * W + x) * 3;
      pixels[dst] = curr[x * bpp] / 255.0;
      pixels[dst + 1] = curr[x * bpp + 1] / 255.0;
      pixels[dst + 2] = curr[x * bpp + 2] / 255.0;
    }

    prev.set(curr); // save row for next iteration's filter calculations
  }

  return pixels;
};

// ─── Public inference function ────────────────────────────────────────────────
export const predictDisease = async (
  imageUri: string,
  modelType: ModelType,
  options: PredictOptions = {},
) => {
  const { onStatusChange } = options;

  onStatusChange?.("Loading model...");
  let m: ModelInstance;
  try {
    m = await loadModel(modelType);
  } catch (error) {
    throw buildStageError("Failed to load model", error);
  }

  onStatusChange?.("Preparing image...");
  let tensor: Float32Array;
  try {
    tensor = await imageToTensor(imageUri);
  } catch (error) {
    throw buildStageError("Failed to prepare image", error);
  }

  onStatusChange?.("Running inference...");
  let output: unknown[];
  try {
    output = await m.run([tensor]);
  } catch (error) {
    throw buildStageError("Failed to run inference", error);
  }

  onStatusChange?.("Processing result...");
  const rawProbabilities = output[0];
  if (!(rawProbabilities instanceof Float32Array)) {
    throw new Error("Failed to process result: model output is invalid.");
  }

  const probabilities = Array.from(rawProbabilities);
  const maxIndex = probabilities.indexOf(Math.max(...probabilities));
  const confidence = (probabilities[maxIndex] * 100).toFixed(1);
  const diseaseName = labels[maxIndex] ?? "Unknown";

  return {
    disease: diseaseName,
    confidence: parseFloat(confidence),
    isHealthy: diseaseName.toLowerCase().includes("healthy"),
    modelUsed:
      modelType === "efficientnet" ? "EfficientNetV2B0" : "MobileNet Small",
  };
};
