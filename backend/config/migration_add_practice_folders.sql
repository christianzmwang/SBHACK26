-- Migration: Add practice folders support
-- This migration adds tables to organize quizzes and flashcards into folders

-- Practice folders table (for organizing quizzes and flashcards)
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

-- Index for user's practice folders
CREATE INDEX IF NOT EXISTS idx_practice_folders_user ON practice_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_practice_folders_parent ON practice_folders(parent_folder_id);

-- Add folder_id to quiz_sets (nullable for backwards compatibility)
ALTER TABLE quiz_sets ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES practice_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_quiz_sets_folder ON quiz_sets(folder_id);

-- Add folder_id to flashcard_sets
ALTER TABLE flashcard_sets ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES practice_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_flashcard_sets_folder ON flashcard_sets(folder_id);

-- Add additional metadata to quiz_sets
ALTER TABLE quiz_sets ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE quiz_sets ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMP;
ALTER TABLE quiz_sets ADD COLUMN IF NOT EXISTS best_score INTEGER;
ALTER TABLE quiz_sets ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0;

-- Add additional metadata to flashcard_sets
ALTER TABLE flashcard_sets ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE flashcard_sets ADD COLUMN IF NOT EXISTS last_studied_at TIMESTAMP;
ALTER TABLE flashcard_sets ADD COLUMN IF NOT EXISTS mastery_count INTEGER DEFAULT 0;

-- Quiz attempts table (to track practice history)
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_set_id UUID REFERENCES quiz_sets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  total_questions INTEGER NOT NULL,
  percentage INTEGER NOT NULL,
  answers JSONB NOT NULL, -- { questionId: { answer, isCorrect } }
  time_taken INTEGER, -- in seconds
  completed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON quiz_attempts(quiz_set_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user ON quiz_attempts(user_id);

-- Flashcard study sessions (to track flashcard progress)
CREATE TABLE IF NOT EXISTS flashcard_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  flashcard_set_id UUID REFERENCES flashcard_sets(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  cards_studied INTEGER NOT NULL,
  cards_mastered INTEGER DEFAULT 0,
  time_spent INTEGER, -- in seconds
  completed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flashcard_sessions_set ON flashcard_sessions(flashcard_set_id);
CREATE INDEX IF NOT EXISTS idx_flashcard_sessions_user ON flashcard_sessions(user_id);

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_practice_folders_updated_at ON practice_folders;
CREATE TRIGGER update_practice_folders_updated_at BEFORE UPDATE ON practice_folders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
