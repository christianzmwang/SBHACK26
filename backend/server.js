import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Import routes
import generateRoutes from './routes/generate.js';
import materialsRoutes from './routes/materials.js';
import foldersRoutes from './routes/folders.js';
import usersRoutes from './routes/users.js';
import voiceRoutes from './routes/voice.js';

// Import services
import { initializeDatabase } from './config/database.js';
import { errorHandler } from './services/utils.js';
import { cleanupOldFiles } from './middleware/upload.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration - allow multiple origins
const allowedOrigins = [
  'http://localhost:3000',
  process.env.FRONTEND_URL,
].filter(Boolean); // Remove undefined/null values

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`CORS blocked request from: ${origin}`);
      callback(null, true); // Allow anyway in development, or use: callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging in development
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Routes
app.use('/api', generateRoutes);      // Original generate route
app.use('/api', materialsRoutes);     // Materials management
app.use('/api', foldersRoutes);       // Folders, classes, sections, and practice generation
app.use('/api/users', usersRoutes);   // User management
app.use('/api/voice', voiceRoutes);   // Voice agent (Deepgram integration)

// Error handler
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Initialize database and start server
const startServer = async () => {
  // Clean up any leftover temporary files from previous sessions
  try {
    await cleanupOldFiles(0);
    console.log('[OK] Cleaned up temporary upload files');
  } catch (e) {
    console.warn('[WARN] Failed to clean up temp files:', e.message);
  }

  // Start the HTTP server first (don't wait for database)
  const server = app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                    SBHACK26 Backend Server                      ║
╠════════════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                                   ║
║  Environment: ${process.env.NODE_ENV || 'development'}                                ║
║                                                                 ║
║  API Endpoints:                                                 ║
║  ├─ GET  /api/health                  Health check              ║
║  ├─ POST /api/users/upsert            Upsert user               ║
║  ├─ GET  /api/folders                 Get user folders          ║
║  ├─ POST /api/folders                 Create folder             ║
║  ├─ POST /api/sections/:id/files      Upload files              ║
║  ├─ GET  /api/materials               List materials            ║
║  ├─ POST /api/materials/search        Search materials          ║
║  ├─ GET  /api/practice/overview       Practice overview         ║
║  ├─ GET  /api/practice/folders        Practice folders          ║
║  ├─ POST /api/practice/quizzes/generate  Generate quiz          ║
║  ├─ POST /api/practice/flashcards/generate  Generate flashcards ║
║  ├─ GET  /api/practice/quizzes/:id    Get saved quiz            ║
║  ├─ POST /api/voice/token             Get Deepgram token        ║
║  ├─ POST /api/voice/chat              Voice chat with context   ║
║  └─ POST /api/voice/tts               Text to speech            ║
╚════════════════════════════════════════════════════════════════╝
    `);
  });

  // Increase timeout for large file uploads (5 minutes)
  server.timeout = 300000;
  server.keepAliveTimeout = 305000;
  server.headersTimeout = 310000;

  // Initialize database in background (don't block server startup)
  if (process.env.DATABASE_URL) {
    initializeDatabase()
      .then((initialized) => {
        if (initialized) {
          console.log('[OK] Database connected and initialized');
        } else {
          console.warn('[WARN] Database initialization incomplete - will retry on first query');
        }
      })
      .catch((err) => {
        console.warn('[WARN] Database initialization failed:', err.message);
        console.warn('[WARN] Database will be initialized lazily on first query');
      });
  } else {
    console.warn('[WARN] DATABASE_URL not set - database features disabled');
  }
};

startServer();
