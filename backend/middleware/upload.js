import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadDir = path.join(__dirname, '../uploads');

// Ensure upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// Allowed file types for course materials
const allowedExtensions = [
  '.pdf',      // PDF documents
  '.docx',     // Word documents
  '.doc',      // Legacy Word
  '.txt',      // Plain text
  '.md',       // Markdown
  '.markdown', // Markdown alternative
  '.tex',      // LaTeX files
  '.rtf',      // Rich text
  '.mp3',      // Audio files (transcribed via Deepgram)
];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${ext} is not allowed. Allowed types: ${allowedExtensions.join(', ')}`));
  }
};

// Configure multer with larger limits for textbooks and audio files
export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit (increased for audio files)
    files: 10 // Max 10 files per request
  }
});

// Single file upload
export const uploadSingle = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit (increased for audio files)
  }
}).single('file');

// Cleanup function to remove a specific uploaded file
export const cleanupFile = async (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
      console.log(`[Cleanup] Removed temp file: ${path.basename(filePath)}`);
    }
  } catch (error) {
    console.error(`[Cleanup] Failed to remove file ${filePath}:`, error.message);
  }
};

// Cleanup multiple files
export const cleanupFiles = async (files) => {
  if (!files || !Array.isArray(files)) return;
  
  for (const file of files) {
    await cleanupFile(file.path);
  }
};

// Cleanup function to remove old temp files (for scheduled cleanup)
export const cleanupOldFiles = async (maxAgeHours = 24) => {
  try {
    if (!fs.existsSync(uploadDir)) return;
    
    const files = await fs.promises.readdir(uploadDir);
    const now = Date.now();
    const maxAge = maxAgeHours * 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = await fs.promises.stat(filePath);
      
      if (now - stats.mtimeMs > maxAge) {
        await fs.promises.unlink(filePath);
        console.log(`[Cleanup] Removed old file: ${file}`);
      }
    }
  } catch (error) {
    console.error('[Cleanup] Error cleaning up old files:', error.message);
  }
};

export default upload;
