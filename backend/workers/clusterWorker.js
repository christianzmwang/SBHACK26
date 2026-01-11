import { parentPort } from 'worker_threads';

// Helper: Calculate cosine similarity
const cosineSimilarity = (a, b) => {
  if (a.length !== b.length) {
    // Should not happen if data is consistent, but return 0 to be safe
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

// Helper: Initialize centroids (K-means++)
const initializeCentroids = (chunks, k) => {
  if (chunks.length <= k) {
    return chunks.map(c => c.embedding);
  }

  const centroids = [];
  const usedIndices = new Set();

  // First centroid: random
  const firstIdx = Math.floor(Math.random() * chunks.length);
  centroids.push(chunks[firstIdx].embedding);
  usedIndices.add(firstIdx);

  // Remaining centroids: weighted by distance from existing centroids
  while (centroids.length < k) {
    const distances = chunks.map((chunk, idx) => {
      if (usedIndices.has(idx)) return 0;
      
      // Find minimum distance to any existing centroid
      const minDist = Math.min(
        ...centroids.map(c => 1 - cosineSimilarity(chunk.embedding, c))
      );
      return minDist * minDist; // Square for probability weighting
    });

    const totalDist = distances.reduce((a, b) => a + b, 0);
    if (totalDist === 0) break;

    // Weighted random selection
    let random = Math.random() * totalDist;
    let selectedIdx = 0;
    for (let i = 0; i < distances.length; i++) {
      random -= distances[i];
      if (random <= 0) {
        selectedIdx = i;
        break;
      }
    }

    if (!usedIndices.has(selectedIdx)) {
      centroids.push(chunks[selectedIdx].embedding);
      usedIndices.add(selectedIdx);
    }
  }

  return centroids;
};

// Main clustering function
const clusterChunksByTopic = (chunks, numClusters = 6, minChunksPerGroup = 1) => {
  if (chunks.length === 0) return [];
  
  // Adjust cluster count if we have fewer chunks
  const actualClusters = Math.min(numClusters, Math.ceil(chunks.length / minChunksPerGroup));
  
  if (actualClusters <= 1) {
    return [{ chunks, centroid: null }];
  }

  // Filter chunks with valid embeddings - handle both array and JSON string formats
  const validChunks = chunks.filter(c => {
    if (!c.embedding) return false;
    if (Array.isArray(c.embedding)) return true;
    // Try to parse if it's a string (PostgreSQL sometimes returns JSON as string)
    if (typeof c.embedding === 'string') {
      try {
        const parsed = JSON.parse(c.embedding);
        if (Array.isArray(parsed)) {
          c.embedding = parsed; // Replace string with parsed array
          return true;
        }
      } catch (e) {
        return false;
      }
    }
    return false;
  });
  
  if (validChunks.length === 0) {
    return [{ chunks, centroid: null }];
  }

  // Initialize centroids using k-means++
  let centroids = initializeCentroids(validChunks, actualClusters);
  
  // K-means iterations
  const maxIterations = 10;
  let assignments = new Array(validChunks.length).fill(0);
  
  for (let iter = 0; iter < maxIterations; iter++) {
    // Assignment step: assign each chunk to nearest centroid
    const newAssignments = validChunks.map((chunk) => {
      let bestCluster = 0;
      let bestSimilarity = -1;
      
      for (let c = 0; c < centroids.length; c++) {
        const similarity = cosineSimilarity(chunk.embedding, centroids[c]);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestCluster = c;
        }
      }
      
      return bestCluster;
    });

    // Check for convergence
    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    assignments = newAssignments;
    
    if (!changed) {
      break;
    }

    // Update step: recalculate centroids
    const newCentroids = [];
    for (let c = 0; c < centroids.length; c++) {
      const clusterChunks = validChunks.filter((_, i) => assignments[i] === c);
      
      if (clusterChunks.length === 0) {
        newCentroids.push(centroids[c]); // Keep old centroid
        continue;
      }

      // Calculate mean embedding
      const dims = clusterChunks[0].embedding.length;
      const mean = new Array(dims).fill(0);
      
      for (const chunk of clusterChunks) {
        for (let d = 0; d < dims; d++) {
          mean[d] += chunk.embedding[d];
        }
      }
      
      for (let d = 0; d < dims; d++) {
        mean[d] /= clusterChunks.length;
      }
      
      newCentroids.push(mean);
    }
    
    centroids = newCentroids;
  }

  // Build cluster objects
  const clusters = [];
  for (let c = 0; c < centroids.length; c++) {
    const clusterChunks = validChunks.filter((_, i) => assignments[i] === c);
    if (clusterChunks.length > 0) {
      clusters.push({
        chunks: clusterChunks,
        centroid: centroids[c],
        size: clusterChunks.length
      });
    }
  }

  // Sort clusters by size (largest first) for balanced distribution
  clusters.sort((a, b) => b.size - a.size);

  return clusters;
};

// Listen for messages
if (parentPort) {
  parentPort.on('message', (data) => {
    try {
      const { chunks, numClusters, minChunksPerGroup } = data;
      const result = clusterChunksByTopic(chunks, numClusters, minChunksPerGroup);
      parentPort.postMessage({ success: true, result });
    } catch (error) {
      parentPort.postMessage({ success: false, error: error.message });
    }
  });
}
