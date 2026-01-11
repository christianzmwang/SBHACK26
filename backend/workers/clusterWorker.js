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
 * @param {Array} chunks - Chunks with embeddings, in document order
 * @param {number} minTopics - Minimum topics to create (default 3)
 * @param {number} maxTopics - Maximum topics to create (default 15)
 */
const detectTopicBoundaries = (chunks, minTopics = 3, maxTopics = 15) => {
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
  
  // Step 3: Find the strongest boundaries
  // Sort by score (highest first) and pick top candidates
  const sortedBoundaries = [...boundaryScores].sort((a, b) => b.score - a.score);
  
  // Calculate statistics for adaptive thresholding
  const allDrops = boundaryScores.map(b => b.score).filter(s => s > 0);
  if (allDrops.length === 0) {
    // No clear boundaries - use even splits
    return createEvenSplits(chunks, Math.min(maxTopics, Math.ceil(chunks.length / 15)));
  }
  
  const avgDrop = allDrops.reduce((a, b) => a + b, 0) / allDrops.length;
  const stdDev = Math.sqrt(allDrops.reduce((sum, d) => sum + Math.pow(d - avgDrop, 2), 0) / allDrops.length);
  
  // Adaptive threshold: boundaries with drops above (mean + 0.5*stdDev) are significant
  const threshold = avgDrop + 0.5 * stdDev;
  
  // Select boundaries above threshold, but respect min/max constraints
  let selectedBoundaries = sortedBoundaries
    .filter(b => b.score >= threshold)
    .map(b => b.index)
    .sort((a, b) => a - b); // Sort by position in document
  
  // Ensure minimum spacing between boundaries (at least 5 chunks per topic)
  const minSpacing = Math.max(5, Math.floor(chunks.length / maxTopics));
  selectedBoundaries = filterBySpacing(selectedBoundaries, minSpacing);
  
  // Enforce min/max topics
  const targetBoundaries = Math.min(maxTopics - 1, Math.max(minTopics - 1, selectedBoundaries.length));
  
  if (selectedBoundaries.length > targetBoundaries) {
    // Too many boundaries - keep only the strongest ones
    selectedBoundaries = sortedBoundaries
      .slice(0, targetBoundaries * 2) // Take top candidates
      .map(b => b.index)
      .sort((a, b) => a - b);
    selectedBoundaries = filterBySpacing(selectedBoundaries, minSpacing);
    selectedBoundaries = selectedBoundaries.slice(0, targetBoundaries);
  } else if (selectedBoundaries.length < minTopics - 1) {
    // Too few boundaries - add more from the sorted list
    for (const boundary of sortedBoundaries) {
      if (selectedBoundaries.length >= minTopics - 1) break;
      if (!selectedBoundaries.includes(boundary.index)) {
        // Check spacing
        const fitsSpacing = selectedBoundaries.every(
          existing => Math.abs(existing - boundary.index) >= minSpacing
        );
        if (fitsSpacing) {
          selectedBoundaries.push(boundary.index);
          selectedBoundaries.sort((a, b) => a - b);
        }
      }
    }
  }
  
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

/**
 * Filter boundaries to ensure minimum spacing between them
 */
const filterBySpacing = (boundaries, minSpacing) => {
  if (boundaries.length <= 1) return boundaries;
  
  const filtered = [boundaries[0]];
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] - filtered[filtered.length - 1] >= minSpacing) {
      filtered.push(boundaries[i]);
    }
  }
  return filtered;
};

/**
 * Create evenly-spaced topic splits when no clear boundaries exist
 */
const createEvenSplits = (chunks, numTopics) => {
  const clusters = [];
  const chunkSize = Math.ceil(chunks.length / numTopics);
  
  for (let i = 0; i < numTopics; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, chunks.length);
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
  }
  
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

  // Use topic boundary detection - respects document order and finds natural topic shifts
  const topics = detectTopicBoundaries(validChunks, 3, 15);
  
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
