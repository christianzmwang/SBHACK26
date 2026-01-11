import { parentPort } from 'worker_threads';

// Helper: Calculate cosine similarity
const cosineSimilarity = (a, b) => {
  if (a.length !== b.length) {
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

// Calculate centroid (mean) of embeddings
const calculateCentroid = (chunks) => {
  if (chunks.length === 0) return null;
  
  const dims = chunks[0].embedding.length;
  const mean = new Array(dims).fill(0);
  
  for (const chunk of chunks) {
    for (let d = 0; d < dims; d++) {
      mean[d] += chunk.embedding[d];
    }
  }
  
  for (let d = 0; d < dims; d++) {
    mean[d] /= chunks.length;
  }
  
  return mean;
};

// Calculate similarity between two clusters using average linkage
const clusterSimilarity = (clusterA, clusterB) => {
  // Use centroid similarity for efficiency (O(1) vs O(n*m) for full linkage)
  return cosineSimilarity(clusterA.centroid, clusterB.centroid);
};

/**
 * Hierarchical Agglomerative Clustering
 * Discovers natural topic groups based on semantic similarity
 * 
 * @param {Array} chunks - Chunks with embeddings
 * @param {number} similarityThreshold - Stop merging when similarity drops below this (default 0.65)
 * @param {number} minClusters - Minimum number of clusters to maintain (default 2)
 */
const hierarchicalCluster = (chunks, similarityThreshold = 0.65, minClusters = 2) => {
  if (chunks.length === 0) return [];
  if (chunks.length === 1) return [{ chunks, centroid: chunks[0].embedding, size: 1 }];
  
  // Start with each chunk as its own cluster
  let clusters = chunks.map((chunk, idx) => ({
    id: idx,
    chunks: [chunk],
    centroid: chunk.embedding,
    size: 1
  }));
  
  // Iteratively merge most similar clusters until threshold is reached
  while (clusters.length > minClusters) {
    // Find the two most similar clusters
    let bestSim = -1;
    let bestI = 0;
    let bestJ = 1;
    
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = clusterSimilarity(clusters[i], clusters[j]);
        if (sim > bestSim) {
          bestSim = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }
    
    // Stop if best similarity is below threshold - natural topic boundary found
    if (bestSim < similarityThreshold) {
      break;
    }
    
    // Merge the two most similar clusters
    const mergedChunks = [...clusters[bestI].chunks, ...clusters[bestJ].chunks];
    const mergedCluster = {
      id: clusters[bestI].id,
      chunks: mergedChunks,
      centroid: calculateCentroid(mergedChunks),
      size: mergedChunks.length
    };
    
    // Remove old clusters and add merged one
    clusters = clusters.filter((_, idx) => idx !== bestI && idx !== bestJ);
    clusters.push(mergedCluster);
  }
  
  // Sort by size (largest first)
  clusters.sort((a, b) => b.size - a.size);
  
  return clusters;
};

// Main clustering function - now uses hierarchical clustering for natural topics
const clusterChunksByTopic = (chunks, numClusters = 6, minChunksPerGroup = 1) => {
  if (chunks.length === 0) return [];

  // Filter chunks with valid embeddings
  const validChunks = chunks.filter(c => {
    if (!c.embedding) return false;
    if (Array.isArray(c.embedding)) return true;
    if (typeof c.embedding === 'string') {
      try {
        const parsed = JSON.parse(c.embedding);
        if (Array.isArray(parsed)) {
          c.embedding = parsed;
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
  
  if (validChunks.length <= 2) {
    return [{ chunks: validChunks, centroid: calculateCentroid(validChunks), size: validChunks.length }];
  }

  // Use hierarchical clustering to find natural topic boundaries
  // Similarity threshold of 0.65 works well for distinguishing topics
  // while keeping related content together
  const naturalClusters = hierarchicalCluster(validChunks, 0.65, 2);
  
  console.log(`[Cluster] Discovered ${naturalClusters.length} natural topic clusters from ${validChunks.length} chunks`);

  return naturalClusters;
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
