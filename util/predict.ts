import { loadTensorflowModel, TensorflowModel } from 'react-native-fast-tflite'
import * as FileSystem from 'expo-file-system'
//import labels from "../assets/model/labels.json"
const labels = require('./labels.json')

let model: TensorflowModel | null = null

// Load model directly — no Asset needed
export const loadModel = async () => {
	if (model) return model

	model = await loadTensorflowModel(
		require('./plant_model.tflite')
	)

	console.log('✅ Model loaded')
	return model
}

// Convert image to tensor
const imageToTensor = async (imageUri: string): Promise<Float32Array> => {
	const base64 = await FileSystem.readAsStringAsync(imageUri, {
		encoding: 'base64'
	})

	const imageData = atob(base64)
	const pixels = new Float32Array(224 * 224 * 3)

	for (let i = 0; i < pixels.length; i++) {
		pixels[i] = imageData.charCodeAt(i) / 255.0
	}

	return pixels
}

// Main prediction function
export const predictDisease = async (imageUri: string) => {
	const m = await loadModel()

	const tensor = await imageToTensor(imageUri)
	const output = await m.run([tensor])

	const probabilities = Array.from(output[0] as Float32Array)
	const maxIndex = probabilities.indexOf(Math.max(...probabilities))
	const confidence = (probabilities[maxIndex] * 100).toFixed(1)
	const diseaseName = labels[maxIndex.toString()]

	return {
		disease: diseaseName,
		confidence: parseFloat(confidence),
		isHealthy: diseaseName.toLowerCase().includes('healthy')
	}
}
