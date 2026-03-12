import * as FileSystem from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { inflate } from "pako";

const labels: string[] = require("./labels.json");
const plantLabels: Record<string, string> = require("./labels_m2.json");

const LEAF_CONFIDENCE_THRESHOLD = 0.3;
const LEAF_MISMATCH_BLOCK_THRESHOLD = 0.55;

export type ModelType = "efficientnet" | "mobilenet";
type StatusHandler = (status: string) => void;

type PredictOptions = {
  onStatusChange?: StatusHandler;
  selectedPlant?: string | null;
};

const normalizePlantName = (value: string) =>
  value.toLowerCase().replace(/_/g, " ").replace(/,/g, "").trim();

const getPlantNameFromLabel = (label: string) => label.split("___")[0] ?? "";

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

const toProbabilities = (scores: number[]) => {
  if (scores.length === 0) {
    return scores;
  }

  const allBetweenZeroAndOne = scores.every(
    (value) => value >= 0 && value <= 1,
  );
  const sum = scores.reduce((total, value) => total + value, 0);

  // If the model already emits probabilities, keep them as-is.
  if (allBetweenZeroAndOne && Math.abs(sum - 1) < 0.05) {
    return scores;
  }

  // Convert logits (or arbitrary scores) to probabilities.
  const maxScore = Math.max(...scores);
  const expScores = scores.map((value) => Math.exp(value - maxScore));
  const expSum = expScores.reduce((total, value) => total + value, 0);
  if (expSum <= 0 || !Number.isFinite(expSum)) {
    return scores;
  }

  return expScores.map((value) => value / expSum);
};

// ─── Lazy-load fast-tflite so a JSI binding failure doesn't crash the module ─
type TfliteLib = typeof import("react-native-fast-tflite");
type ModelInstance = { run: (inputs: unknown[]) => Promise<unknown[]> };

type PlantMatch = {
  plant: string;
  confidence: number;
};

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

const getLabelsForModel = (type: ModelType) =>
  type === "efficientnet" ? labels : Object.values(plantLabels);

export const loadModel = async (type: ModelType): Promise<ModelInstance> => {
  if (!tflite)
    throw new Error(
      "react-native-fast-tflite is not available. Use expo run:android or expo run:ios.",
    );

  if (modelCache[type]) return modelCache[type]!;

  const file = require("./plant_model.tflite");

  const m = await tflite.loadTensorflowModel(file);
  modelCache[type] = m as ModelInstance;
  console.log(`✅ Model loaded: ${type}`);
  return m as ModelInstance;
};

const getProbabilitiesFromOutput = (output: unknown[]) => {
  const rawProbabilities = output[0];
  if (!(rawProbabilities instanceof Float32Array)) {
    throw new Error("model output is invalid.");
  }

  return Array.from(rawProbabilities);
};

const runModel = async (type: ModelType, tensor: Float32Array) => {
  const model = await loadModel(type);
  const output = await model.run([tensor]);
  return toProbabilities(getProbabilitiesFromOutput(output));
};

const getBestPlantMatch = (
  probabilities: number[],
  modelLabels: string[],
): PlantMatch | null => {
  const totals = new Map<string, number>();

  modelLabels.forEach((label, index) => {
    const plant = normalizePlantName(getPlantNameFromLabel(label));
    const score = probabilities[index] ?? 0;
    totals.set(plant, (totals.get(plant) ?? 0) + score);
  });

  let bestPlant: string | null = null;
  let bestConfidence = -1;
  for (const [plant, confidence] of totals) {
    if (confidence > bestConfidence) {
      bestPlant = plant;
      bestConfidence = confidence;
    }
  }

  if (!bestPlant) {
    return null;
  }

  return {
    plant: bestPlant,
    confidence: bestConfidence,
  };
};

const validateSelectedLeaf = async (
  tensor: Float32Array,
  selectedPlant: string | null | undefined,
) => {
  if (!selectedPlant) {
    return;
  }

  const probabilities = await runModel("mobilenet", tensor);
  const bestPlantMatch = getBestPlantMatch(
    probabilities,
    getLabelsForModel("mobilenet"),
  );

  if (
    !bestPlantMatch ||
    bestPlantMatch.confidence < LEAF_CONFIDENCE_THRESHOLD
  ) {
    // The detector is uncertain: continue to disease inference instead of blocking.
    return;
  }

  const normalizedSelectedPlant = normalizePlantName(selectedPlant);
  if (
    bestPlantMatch.plant !== normalizedSelectedPlant &&
    bestPlantMatch.confidence >= LEAF_MISMATCH_BLOCK_THRESHOLD
  ) {
    throw new Error(
      `Selected plant does not match the photo. Detected ${bestPlantMatch.plant} leaf instead.`,
    );
  }
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
  const imageContext = ImageManipulator.manipulate(imageUri);
  imageContext.resize({ width: 224, height: 224 });
  const renderedImage = await imageContext.renderAsync();
  const { uri: resizedUri } = await renderedImage.saveAsync({
    compress: 1,
    format: SaveFormat.PNG,
  });

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
  const { onStatusChange, selectedPlant } = options;

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

  onStatusChange?.("Validating leaf...");
  try {
    await validateSelectedLeaf(tensor, selectedPlant);
  } catch (error) {
    throw buildStageError("Leaf validation failed", error);
  }

  onStatusChange?.("Running inference...");
  let probabilities: number[];
  try {
    probabilities = await runModel(modelType, tensor);
  } catch (error) {
    throw buildStageError("Failed to run inference", error);
  }

  onStatusChange?.("Processing result...");
  const normalizedSelectedPlant = selectedPlant
    ? normalizePlantName(selectedPlant)
    : null;

  const candidateIndexes = labels
    .map((label, index) => ({
      index,
      plant: normalizePlantName(getPlantNameFromLabel(label)),
    }))
    .filter(({ plant }) =>
      normalizedSelectedPlant ? plant === normalizedSelectedPlant : true,
    )
    .map(({ index }) => index);

  if (candidateIndexes.length === 0) {
    throw new Error(
      selectedPlant
        ? `No disease labels were found for ${selectedPlant}.`
        : "No disease labels are available for prediction.",
    );
  }

  const maxIndex = candidateIndexes.reduce((bestIndex, currentIndex) =>
    probabilities[currentIndex] > probabilities[bestIndex]
      ? currentIndex
      : bestIndex,
  );
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
