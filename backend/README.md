# SBHACK26 Backend - RAG-Powered Study Assistant

A Node.js backend service that powers the study platform with intelligent quiz generation, flashcard creation, and document processing.

## Features

- **Smart Document Processing**: Upload textbooks, syllabi, notes, and audio files with math-aware chunking
- **Audio Transcription**: Upload MP3 files and automatically transcribe them to text using Deepgram
- **RAG-Powered Quiz Generation**: Generate quizzes using semantic search over your materials
- **Math Support**: Special handling for LaTeX, equations, and mathematical content
- **Flashcard Generation**: Create study flashcards from your materials

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 15+ with pgvector extension (Supabase recommended)
- OpenAI API key
- Deepgram API key (optional, for audio transcription)
- OpenRouter API key (for LLM calls)

### 1. Database Setup (Supabase)

1. Create a project at [supabase.com](https://supabase.com)
2. Go to SQL Editor and run `config/schema.sql`
3. Copy your connection string from Project Settings > Database

### 2. Environment Setup

Create a `.env` file in the backend directory:

```bash
# Required
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@YOUR_PROJECT.supabase.co:5432/postgres
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
FRONTEND_URL=http://localhost:3000

# Optional
DEEPGRAM_API_KEY=...
NODE_ENV=development
PORT=3001
```

### 3. Install & Run

```bash
npm install
npm run dev
```

### 4. Verify Environment

```bash
npm run verify-env
```

## API Endpoints

### Health Check
- `GET /api/health` - Server health check

### Users
- `POST /api/users/upsert` - Create or update user

### Folders
- `GET /api/folders` - Get user's folders
- `POST /api/folders` - Create folder
- `PUT /api/folders/:folderId` - Update folder
- `DELETE /api/folders/:folderId` - Delete folder

### Sections
- `POST /api/folders/:folderId/sections` - Create section
- `GET /api/sections/:sectionId` - Get section
- `DELETE /api/sections/:sectionId` - Delete section

### Files
- `POST /api/sections/:sectionId/files` - Upload files
- `GET /api/files/:fileId/content` - Get file content
- `DELETE /api/files/:fileId` - Delete file

### Practice
- `GET /api/practice/overview` - Get practice overview
- `GET /api/practice/folders` - Get practice folders
- `POST /api/practice/quizzes/generate` - Generate quiz
- `POST /api/practice/flashcards/generate` - Generate flashcards
- `GET /api/practice/quizzes/:quizId` - Get quiz
- `POST /api/practice/quizzes/:quizId/attempt` - Submit quiz attempt

## Supported File Types

- **Documents**: PDF (.pdf), Word (.docx, .doc), Text (.txt), Markdown (.md), LaTeX (.tex), RTF (.rtf)
- **Audio**: MP3 (.mp3) - automatically transcribed to text using Deepgram

## Deployment

### Render

1. Push your code to GitHub
2. Create a new Web Service on [render.com](https://render.com)
3. Connect your repository
4. Set environment variables in Render dashboard
5. Deploy!

The `render.yaml` file is included for easy deployment configuration.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (Supabase) |
| `OPENAI_API_KEY` | Yes | OpenAI API key for embeddings |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for LLM calls |
| `FRONTEND_URL` | Yes | Frontend URL for CORS |
| `DEEPGRAM_API_KEY` | No | Deepgram API key for audio transcription |
| `PORT` | No | Server port (default: 3001) |
| `NODE_ENV` | No | Environment (development/production) |

## License

MIT
