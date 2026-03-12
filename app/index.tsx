import { predictDisease } from "@/util/predict";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { useRef, useState } from "react";
import {
    ActivityIndicator,
    FlatList,
    Image,
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";

const ALL_LABELS: string[] = require("@/util/labels.json");

const PLANTS = Array.from(
  new Set(ALL_LABELS.map((l) => l.split("___")[0].replace(/_/g, " "))),
).sort();

type PredictionResult = {
  disease: string;
  confidence: number;
  isHealthy: boolean;
};

export default function HomeScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [selectedPlant, setSelectedPlant] = useState<string | null>(null);
  const [plantPickerOpen, setPlantPickerOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const cameraRef = useRef<CameraView>(null);

  async function takePhoto() {
    if (!cameraRef.current) return;
    const captured = await cameraRef.current.takePictureAsync({
      quality: 0.85,
    });
    if (captured?.uri) {
      setPhoto(captured.uri);
      setResult(null);
      setCameraOpen(false);
      runInference(captured.uri);
    }
  }

  async function runInference(uri: string) {
    setLoading(true);
    try {
      const prediction = await predictDisease(uri, "efficientnet");
      setResult(prediction);
    } catch (e) {
      console.error("Prediction error", e);
    } finally {
      setLoading(false);
    }
  }

  async function pickFromGallery() {
    if (!selectedPlant) {
      setPlantPickerOpen(true);
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.85,
    });
    if (!picked.canceled && picked.assets[0]?.uri) {
      setPhoto(picked.assets[0].uri);
      setResult(null);
      runInference(picked.assets[0].uri);
    }
  }

  if (!permission) return <View style={styles.container} />;

  // ── Camera screen ──────────────────────────────────────────────────────────
  if (cameraOpen) {
    return (
      <View style={styles.container}>
        <CameraView ref={cameraRef} style={styles.camera} facing="back" />
        <View style={styles.shutterRow}>
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => setCameraOpen(false)}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.shutterBtn} onPress={takePhoto}>
            <View style={styles.shutterInner} />
          </TouchableOpacity>
          <View style={styles.shutterSpacer} />
        </View>
      </View>
    );
  }

  // ── Main screen ────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {/* Plant picker modal */}
      <Modal visible={plantPickerOpen} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Select Plant</Text>
            <FlatList
              data={PLANTS}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[
                    styles.listItem,
                    selectedPlant === item && styles.listItemSelected,
                  ]}
                  onPress={() => {
                    setSelectedPlant(item);
                    setPlantPickerOpen(false);
                  }}
                >
                  <Text
                    style={[
                      styles.listItemText,
                      selectedPlant === item && styles.listItemTextSelected,
                    ]}
                  >
                    {item}
                  </Text>
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity
              style={styles.modalCloseBtn}
              onPress={() => setPlantPickerOpen(false)}
            >
              <Text style={styles.modalCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.appTitle}>🌿 Crop Doctor</Text>

        {/* ── Plant selector ── */}
        <TouchableOpacity
          style={styles.selectorCard}
          onPress={() => setPlantPickerOpen(true)}
        >
          <Text style={styles.selectorLabel}>PLANT</Text>
          <Text style={styles.selectorValue}>
            {selectedPlant ?? "Tap to choose a plant →"}
          </Text>
        </TouchableOpacity>

        {/* ── Photo preview / placeholder ── */}
        {photo ? (
          <Image
            source={{ uri: photo }}
            style={styles.preview}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.photoPlaceholder}>
            <Text style={styles.placeholderIcon}>🌱</Text>
            <Text style={styles.placeholderText}>
              {selectedPlant
                ? "Take a photo to diagnose"
                : "Select a plant, then take a photo"}
            </Text>
          </View>
        )}

        {/* ── Analyzing spinner ── */}
        {loading && (
          <View style={styles.resultCard}>
            <ActivityIndicator size="large" color="#3a8f3a" />
            <Text style={styles.analyzingText}>Analysing image…</Text>
          </View>
        )}

        {/* ── Result card ── */}
        {result && !loading && (
          <View
            style={[
              styles.resultCard,
              result.isHealthy
                ? styles.resultCardHealthy
                : styles.resultCardSick,
            ]}
          >
            <Text style={styles.resultBadge}>
              {result.isHealthy ? "✅ Healthy" : "⚠️ Disease Detected"}
            </Text>
            <Text style={styles.resultDisease}>
              {result.disease.replace(/___/g, " › ").replace(/_/g, " ")}
            </Text>

            {/* Confidence bar */}
            <View style={styles.barTrack}>
              <View
                style={[
                  styles.barFill,
                  { width: `${result.confidence}%` as any },
                  result.isHealthy ? styles.barFillHealthy : styles.barFillSick,
                ]}
              />
            </View>
            <Text style={styles.confidenceText}>
              Confidence: {result.confidence.toFixed(1)}%
            </Text>

            <TouchableOpacity
              style={styles.retakeBtn}
              onPress={() => {
                setPhoto(null);
                setResult(null);
              }}
            >
              <Text style={styles.retakeBtnText}>Try Another Photo</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* ── Bottom bar ── */}
      <View style={styles.bottomBar}>
        {!selectedPlant && (
          <Text style={styles.bottomHint}>Select a plant first</Text>
        )}
        <View style={styles.bottomBtns}>
          {/* Gallery button */}
          <TouchableOpacity
            style={[
              styles.galleryBtn,
              !selectedPlant && styles.cameraBtnDisabled,
            ]}
            onPress={pickFromGallery}
          >
            <Text style={styles.galleryIcon}>🖼️</Text>
          </TouchableOpacity>

          {/* Camera button */}
          <TouchableOpacity
            style={[
              styles.cameraBtn,
              !selectedPlant && styles.cameraBtnDisabled,
            ]}
            onPress={async () => {
              if (!selectedPlant) {
                setPlantPickerOpen(true);
                return;
              }
              if (!permission.granted) {
                const res = await requestPermission();
                if (!res.granted) return;
              }
              setPhoto(null);
              setResult(null);
              setCameraOpen(true);
            }}
          >
            <Text style={styles.cameraIcon}>📷</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f1f0f" },

  // Scrollable content
  content: {
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 24,
    gap: 16,
  },
  appTitle: {
    color: "#7ecf7e",
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: 1,
    marginBottom: 4,
  },

  // Plant selector
  selectorCard: {
    width: "100%",
    backgroundColor: "#1a3a1a",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#2e5e2e",
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  selectorLabel: {
    color: "#6aab6a",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.5,
    marginBottom: 4,
  },
  selectorValue: {
    color: "#dfffdf",
    fontSize: 16,
    fontWeight: "500",
  },

  // Photo area
  preview: {
    width: "100%",
    height: 280,
    borderRadius: 16,
  },
  photoPlaceholder: {
    width: "100%",
    height: 200,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: "#2e5e2e",
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#152015",
    gap: 10,
  },
  placeholderIcon: { fontSize: 38 },
  placeholderText: {
    color: "#6aab6a",
    fontSize: 14,
    textAlign: "center",
    paddingHorizontal: 24,
  },

  // Result card
  resultCard: {
    width: "100%",
    backgroundColor: "#1a3a1a",
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    gap: 10,
  },
  resultCardHealthy: { borderWidth: 1.5, borderColor: "#3a8f3a" },
  resultCardSick: { borderWidth: 1.5, borderColor: "#c0392b" },
  resultBadge: {
    color: "#dfffdf",
    fontSize: 18,
    fontWeight: "700",
  },
  resultDisease: {
    color: "#aacfaa",
    fontSize: 15,
    textAlign: "center",
  },
  barTrack: {
    width: "100%",
    height: 8,
    backgroundColor: "#0f1f0f",
    borderRadius: 4,
    overflow: "hidden",
  },
  barFill: { height: "100%", borderRadius: 4 },
  barFillHealthy: { backgroundColor: "#3a8f3a" },
  barFillSick: { backgroundColor: "#c0392b" },
  confidenceText: { color: "#6aab6a", fontSize: 13 },
  analyzingText: {
    color: "#6aab6a",
    fontSize: 15,
    marginTop: 8,
  },
  retakeBtn: {
    marginTop: 4,
    paddingVertical: 10,
    paddingHorizontal: 28,
    backgroundColor: "#2e5e2e",
    borderRadius: 24,
  },
  retakeBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },

  // Bottom bar
  bottomBar: {
    height: 100,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0a160a",
    borderTopWidth: 1,
    borderTopColor: "#1e3a1e",
    gap: 6,
  },
  bottomHint: { color: "#6aab6a", fontSize: 12 },
  bottomBtns: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
  },
  cameraBtn: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: "#3a8f3a",
    alignItems: "center",
    justifyContent: "center",
    elevation: 8,
    shadowColor: "#3a8f3a",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
  },
  galleryBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: "#1a3a1a",
    borderWidth: 1.5,
    borderColor: "#3a8f3a",
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  cameraBtnDisabled: {
    backgroundColor: "#2a4a2a",
    borderColor: "#2a4a2a",
    elevation: 0,
  },
  cameraIcon: { fontSize: 30 },
  galleryIcon: { fontSize: 24 },

  // Camera UI
  camera: { flex: 1 },
  shutterRow: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 110,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 36,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  cancelBtn: { width: 70, alignItems: "center" },
  cancelText: { color: "#fff", fontSize: 16 },
  shutterBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#fff",
  },
  shutterSpacer: { width: 70 },

  // Plant picker modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
    justifyContent: "flex-end",
  },
  modalBox: {
    backgroundColor: "#152015",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 20,
    paddingHorizontal: 16,
    paddingBottom: 32,
    maxHeight: "75%",
  },
  modalTitle: {
    color: "#7ecf7e",
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 14,
  },
  listItem: {
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 10,
    marginBottom: 6,
    backgroundColor: "#1a3a1a",
  },
  listItemSelected: { backgroundColor: "#2e5e2e" },
  listItemText: { color: "#aacfaa", fontSize: 15 },
  listItemTextSelected: { color: "#fff", fontWeight: "600" },
  modalCloseBtn: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 14,
    backgroundColor: "#2e5e2e",
    alignItems: "center",
  },
  modalCloseBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
