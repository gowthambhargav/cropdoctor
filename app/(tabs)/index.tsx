import { useState, useRef } from 'react'
import {
  View, Text, TouchableOpacity,
  StyleSheet, ActivityIndicator, Image
} from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Speech from 'expo-speech'
import { loadModel, predictDisease } from '@/util/predict'

export default function Index() {
  const [permission, requestPermission] = useCameraPermissions()
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
  const cameraRef = useRef<CameraView>(null)

  // Preload model on mount
  useState(() => { loadModel() })

  const scanLeaf = async () => {
    if (!cameraRef.current) return

    setLoading(true)
    setResult(null)

    try {
      // Take photo
      const pic = await cameraRef.current.takePictureAsync({
        quality: 0.8,
        base64: false
      })

      setPhoto(pic!.uri)

      // Predict
      const prediction = await predictDisease(pic!.uri)
      setResult(prediction)

      // Speak result in Hindi
      const message = prediction.isHealthy
        ? `आपकी फसल स्वस्थ है`
        : `आपकी फसल में ${prediction.disease} रोग है। कृपया कृषि विशेषज्ञ से संपर्क करें`

      Speech.speak(message, {
        language: 'hi-IN',
        rate: 0.8
      })

    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const reset = () => {
    setResult(null)
    setPhoto(null)
  }

  if (!permission?.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>ParnaDrishti 🌿</Text>
        <Text style={styles.sub}>Camera access needed</Text>
        <TouchableOpacity style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Allow Camera</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <View style={styles.container}>

      {/* Camera or Photo Preview */}
      {!photo ? (
        <CameraView ref={cameraRef} style={styles.camera} facing="back">
          <View style={styles.overlay}>
            <Text style={styles.hint}>Point at a leaf</Text>
          </View>
        </CameraView>
      ) : (
        <Image source={{ uri: photo }} style={styles.camera} />
      )}

      {/* Result Card */}
      {result && (
        <View style={[
          styles.resultCard,
          { borderColor: result.isHealthy ? '#22c55e' : '#ef4444' }
        ]}>
          <Text style={styles.emoji}>
            {result.isHealthy ? '✅' : '⚠️'}
          </Text>
          <Text style={styles.diseaseName}>
            {result.disease.replace(/_/g, ' ')}
          </Text>
          <Text style={styles.confidence}>
            Confidence: {result.confidence}%
          </Text>
          <TouchableOpacity style={styles.resetBtn} onPress={reset}>
            <Text style={styles.btnText}>Scan Again</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Scan Button */}
      {!result && (
        <TouchableOpacity
          style={styles.scanBtn}
          onPress={scanLeaf}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" size="large" />
            : <Text style={styles.scanText}>📷 Scan Leaf</Text>
          }
        </TouchableOpacity>
      )}

    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  camera: { flex: 1 },
  overlay: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 40
  },
  hint: {
    color: '#fff',
    fontSize: 16,
    backgroundColor: '#00000066',
    padding: 8,
    borderRadius: 8
  },
  scanBtn: {
    backgroundColor: '#16a34a',
    padding: 20,
    alignItems: 'center'
  },
  scanText: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  resultCard: {
    backgroundColor: '#1e293b',
    margin: 16,
    padding: 20,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center'
  },
  emoji: { fontSize: 48 },
  diseaseName: {
    color: '#fff',
    fontSize: 20,
    fontWeight: 'bold',
    textAlign: 'center',
    marginTop: 8
  },
  confidence: { color: '#94a3b8', marginTop: 4, fontSize: 14 },
  title: { fontSize: 28, fontWeight: 'bold', color: '#16a34a' },
  sub: { color: '#64748b', marginTop: 8 },
  btn: {
    backgroundColor: '#16a34a',
    padding: 14,
    borderRadius: 10,
    marginTop: 20
  },
  resetBtn: {
    backgroundColor: '#334155',
    padding: 12,
    borderRadius: 10,
    marginTop: 16,
    paddingHorizontal: 24
  },
  btnText: { color: '#fff', fontWeight: 'bold', fontSize: 16 }
})
