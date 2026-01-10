-- =============================================
-- SBHACK26 Complete Database Schema
-- Run this ONCE in Supabase SQL Editor to set up everything
-- =============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- USERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  google_id VARCHAR(255) UNIQUE,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  image TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- =============================================
-- FOLDERS (for organizing course materials)
-- =============================================
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  parent_folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_folder_id);

-- =============================================
-- FOLDER SECTIONS (sections within folders)
-- =============================================
CREATE TABLE IF NOT EXISTS folder_sections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(50) DEFAULT 'custom',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_folder_sections_folder ON folder_sections(folder_id);

-- =============================================
-- MATERIALS (processed documents)
-- =============================================
CREATE TABLE IF NOT EXISTS materials (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type VARCHAR(50) NOT NULL,
  title VARCHAR(500) NOT NULL,
  file_name VARCHAR(500),
  file_path VARCHAR(1000),
  total_chunks INTEGER DEFAULT 0,
  has_math BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- MATERIAL CHUNKS (with vector embeddings)
-- =============================================
CREATE TABLE IF NOT EXISTS material_chunks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  material_id UUID REFERENCES materials(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_type VARCHAR(50) DEFAULT 'text',
  has_math BOOLEAN DEFAULT FALSE,
  latex_content TEXT,
  embedding vector(1536),
  token_count INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_material ON material_chunks(material_id);
CREATE INDEX IF NOT EXISTS idx_chunks_content_type ON material_chunks(content_type);
CREATE INDEX IF NOT EXISTS idx_chunks_metadata ON material_chunks USING GIN (metadata);

-- Vector similarity search index
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON material_chunks 
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- =============================================
-- SECTION FILES (files uploaded to sections)
-- =============================================
CREATE TABLE IF NOT EXISTS section_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  section_id UUID REFERENCES folder_sections(id) ON DELETE CASCADE,
  material_id UUID REFERENCES materials(id) ON DELETE SET NULL,
  name VARCHAR(500) NOT NULL,
  size VARCHAR(50),
  text_content TEXT,
  upload_date TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_section_files_section ON section_files(section_id);
CREATE INDEX IF NOT EXISTS idx_section_files_material ON section_files(material_id);

-- =============================================
-- PRACTICE FOLDERS (for organizing quizzes/flashcards)
-- =============================================
CREATE TABLE IF NOT EXISTS practice_folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  parent_folder_id UUID REFERENCES practice_folders(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  color VARCHAR(50) DEFAULT 'indigo',
  icon VARCHAR(50) DEFAULT 'folder',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_practice_folders_user ON practice_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_practice_folders_parent ON practice_folders(parent_folder_id);

-- =============================================
-- QUIZ SETS
-- =============================================
CREATE TABLE IF NOT EXISTS quiz_sets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES practice_folders(id) ON DELETE SET NULL,
  section_ids UUID[],
  name VARCHAR(500) NOT NULL,
  description TEXT,
  total_questions INTEGER DEFAULT 0,
  difficulty VARCHAR(20) DEFAULT 'mixed',
  best_score INTEGER,
  attempt_count INTEGER DEFAULT 0,
  last_attempted_at TIMESTAMP,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_sets_user ON quiz_sets(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_sets_folder ON quiz_sets(folder_id);

-- =============================================
-- QUESTIONS (within quiz sets)
-- =============================================
CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_set_id UUID REFERENCES quiz_sets(id) ON DELETE CASCADE,
  question_index INTEGER,
  question TEXT NOT NULL,
  question_type VARCHAR(50) DEFAULT 'multiple_choice',
  options JSONB,
  correct_answer VARCHAR(10),
  explanation TEXT,
  difficulty VARCHAR(20) DEFAULT 'medium',
  topic VARCHAR(255),
  chapter INTEGER,
  source_chunk_ids UUID[],
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_set_id);

-- =============================================
-- FLASHCARD SETS
-- =============================================
CREATE TABLE IF NOT EXISTS flashcard_sets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  folder_id UUID REFERENCES practice_folders(id) ON DELETE SET NULL,
  section_ids UUID[],
  name VARCHAR(500) NOT NULL,
  description TEXT,
  total_cards INTEGER DEFAULT 0,
  mastery_count INTEGER DEFAULT 0,
  last_studied_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flashcard_sets_user ON flashcard_sets(user_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_sets_folder ON flashcard_sets(folder_id);

-- =============================================
-- FLASHCARDS (within flashcard sets)
-- =============================================
CREATE TABLE IF NOT EXISTS flashcards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flashcard_set_id UUID REFERENCES flashcard_sets(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  topic VARCHAR(255),
  chapter INTEGER,
  difficulty VARCHAR(20) DEFAULT 'medium',
  source_chunk_ids UUID[],
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flashcards_set ON flashcards(flashcard_set_id);

-- =============================================
-- QUIZ ATTEMPTS (track quiz history)
-- =============================================
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_set_id UUID REFERENCES quiz_sets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  percentage INTEGER NOT NULL,
  answers JSONB NOT NULL,
  time_taken INTEGER,
  completed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON quiz_attempts(quiz_set_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts(user_id);

-- =============================================
-- FLASHCARD SESSIONS (track study sessions)
-- =============================================
CREATE TABLE IF NOT EXISTS flashcard_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flashcard_set_id UUID REFERENCES flashcard_sets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  cards_studied INTEGER NOT NULL,
  cards_mastered INTEGER DEFAULT 0,
  time_spent INTEGER,
  completed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flashcard_sessions_set ON flashcard_sessions(flashcard_set_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_sessions_user ON flashcard_sessions(user_id);

-- =============================================
-- HELPER FUNCTION: Auto-update updated_at
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers to tables with updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_folders_updated_at ON folders;
CREATE TRIGGER update_folders_updated_at BEFORE UPDATE ON folders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_folder_sections_updated_at ON folder_sections;
CREATE TRIGGER update_folder_sections_updated_at BEFORE UPDATE ON folder_sections
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_materials_updated_at ON materials;
CREATE TRIGGER update_materials_updated_at BEFORE UPDATE ON materials
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_practice_folders_updated_at ON practice_folders;
CREATE TRIGGER update_practice_folders_updated_at BEFORE UPDATE ON practice_folders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- DONE! Your database is ready.
-- =============================================
