-- Migration: Clean up legacy course-based schema and add section-based practice generation
-- This removes unused course-based columns and adds user/section based quiz and flashcard generation

-- =====================
-- QUIZ_SETS TABLE
-- =====================

-- Add user_id column (required for section-based quizzes)
ALTER TABLE quiz_sets ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Add section_ids array (to track which sections the quiz was generated from)
ALTER TABLE quiz_sets ADD COLUMN IF NOT EXISTS section_ids UUID[];

-- Drop legacy columns that are no longer used
ALTER TABLE quiz_sets DROP COLUMN IF EXISTS course_id;
ALTER TABLE quiz_sets DROP COLUMN IF EXISTS chapters_covered;
ALTER TABLE quiz_sets DROP COLUMN IF EXISTS topics_covered;
ALTER TABLE quiz_sets DROP COLUMN IF EXISTS syllabus_aligned;

-- Add index for user lookups
CREATE INDEX IF NOT EXISTS idx_quiz_sets_user ON quiz_sets(user_id);

-- =====================
-- FLASHCARD_SETS TABLE
-- =====================

-- Add user_id column
ALTER TABLE flashcard_sets ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Add section_ids array
ALTER TABLE flashcard_sets ADD COLUMN IF NOT EXISTS section_ids UUID[];

-- Drop legacy columns
ALTER TABLE flashcard_sets DROP COLUMN IF EXISTS course_id;
ALTER TABLE flashcard_sets DROP COLUMN IF EXISTS chapters_covered;

-- Add index for user lookups
CREATE INDEX IF NOT EXISTS idx_flashcard_sets_user ON flashcard_sets(user_id);

-- =====================
-- DROP LEGACY TABLES (no longer used)
-- =====================

-- Drop courses table (materials are now managed via folders/sections)
DROP TABLE IF EXISTS courses CASCADE;

-- Drop syllabus_requirements table (no longer used)
DROP TABLE IF EXISTS syllabus_requirements CASCADE;

-- Drop generation_jobs table (no longer used)
DROP TABLE IF EXISTS generation_jobs CASCADE;

-- =====================
-- MATERIALS TABLE CLEANUP
-- =====================

-- Remove course_id from materials (materials are linked via section_files)
ALTER TABLE materials DROP COLUMN IF EXISTS course_id;
