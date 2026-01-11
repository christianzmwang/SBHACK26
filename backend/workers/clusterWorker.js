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

/**
 * Topic Boundary Detection using Sequential Similarity Analysis
 * 
 * This approach respects the document's natural flow by:
 * 1. Analyzing similarity between consecutive chunks
 * 2. Finding significant drops in similarity (topic shifts)
 * 3. Using adaptive thresholds based on the document's characteristics
 * 
 * No artificial min/max constraints - finds natural topic breaks only
 * 
 * @param {Array} chunks - Chunks with embeddings, in document order
 */
const detectTopicBoundaries = (chunks) => {
  if (chunks.length === 0) return [];
  if (chunks.length <= 3) {
    return [{ chunks, centroid: calculateCentroid(chunks), size: chunks.length }];
  }
  
  // Step 1: Calculate similarity between consecutive chunks
  const consecutiveSimilarities = [];
  for (let i = 0; i < chunks.length - 1; i++) {
    const sim = cosineSimilarity(chunks[i].embedding, chunks[i + 1].embedding);
    consecutiveSimilarities.push({ index: i, similarity: sim });
  }
  
  // Step 2: Calculate local context - use a sliding window to find relative drops
  // A topic boundary is where similarity drops significantly compared to neighbors
  const windowSize = Math.min(5, Math.floor(chunks.length / 10) + 2);
  const boundaryScores = [];
  
  for (let i = 0; i < consecutiveSimilarities.length; i++) {
    const currentSim = consecutiveSimilarities[i].similarity;
    
    // Calculate average similarity in surrounding window
    let windowSum = 0;
    let windowCount = 0;
    for (let j = Math.max(0, i - windowSize); j <= Math.min(consecutiveSimilarities.length - 1, i + windowSize); j++) {
      if (j !== i) {
        windowSum += consecutiveSimilarities[j].similarity;
        windowCount++;
      }
    }
    const windowAvg = windowCount > 0 ? windowSum / windowCount : currentSim;
    
    // Boundary score: how much lower is this similarity compared to context?
    // Higher score = more likely to be a topic boundary
    const drop = windowAvg - currentSim;
    boundaryScores.push({
      index: i,
      similarity: currentSim,
      windowAvg: windowAvg,
      drop: drop,
      score: drop > 0 ? drop : 0
    });
  }
  
  // Step 3: Find natural boundaries using adaptive thresholding
  const allDrops = boundaryScores.map(b => b.score).filter(s => s > 0);
  
  if (allDrops.length === 0) {
    // No variation in similarity - return as single topic
    console.log(`[Cluster] No similarity variation found - returning as single topic`);
    return [{ chunks, centroid: calculateCentroid(chunks), size: chunks.length }];
  }
  
  // Calculate statistics for adaptive thresholding
  const avgDrop = allDrops.reduce((a, b) => a + b, 0) / allDrops.length;
  const stdDev = Math.sqrt(allDrops.reduce((sum, d) => sum + Math.pow(d - avgDrop, 2), 0) / allDrops.length);
  
  // Adaptive threshold: boundaries with drops above (mean + 0.75*stdDev) are significant
  // Using 0.75 gives a good balance - finds clear topic shifts without being too sensitive
  const threshold = avgDrop + 0.75 * stdDev;
  
  // Select all boundaries that exceed the threshold - these are natural topic breaks
  let selectedBoundaries = boundaryScores
    .filter(b => b.score >= threshold)
    .map(b => b.index)
    .sort((a, b) => a - b); // Sort by position in document
  
  console.log(`[Cluster] Threshold: ${threshold.toFixed(4)}, Found ${selectedBoundaries.length} boundaries above threshold`);
  
  // Step 4: Create topic clusters from boundaries
  const clusters = [];
  let start = 0;
  
  for (const boundaryIndex of selectedBoundaries) {
    const end = boundaryIndex + 1; // Include the chunk before the boundary
    const topicChunks = chunks.slice(start, end);
    if (topicChunks.length > 0) {
      clusters.push({
        chunks: topicChunks,
        centroid: calculateCentroid(topicChunks),
        size: topicChunks.length,
        startIndex: start,
        endIndex: end - 1
      });
    }
    start = end;
  }
  
  // Add final cluster
  if (start < chunks.length) {
    const topicChunks = chunks.slice(start);
    clusters.push({
      chunks: topicChunks,
      centroid: calculateCentroid(topicChunks),
      size: topicChunks.length,
      startIndex: start,
      endIndex: chunks.length - 1
    });
  }
  
  console.log(`[Cluster] Found ${selectedBoundaries.length} natural topic boundaries, created ${clusters.length} topics`);
  console.log(`[Cluster] Topic sizes: ${clusters.map(c => c.size).join(', ')}`);
  
  return clusters;
};

// Main clustering function - uses topic boundary detection for natural topics
const clusterChunksByTopic = (chunks, numClusters = 6, minChunksPerGroup = 1) => {
  if (chunks.length === 0) return [];

  // Filter chunks with valid embeddings and preserve original order
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

  // Use topic boundary detection - finds natural topic shifts without artificial constraints
  const topics = detectTopicBoundaries(validChunks);
  
  console.log(`[Cluster] Created ${topics.length} natural topics from ${validChunks.length} chunks`);

  return topics;
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
