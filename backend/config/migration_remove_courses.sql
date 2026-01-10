-- Migration: Remove courses dependency
-- This migration removes the course_id foreign key constraints and drops the courses table
-- Run this after backing up your data!

-- Step 1: Drop foreign key constraints from dependent tables
ALTER TABLE materials DROP CONSTRAINT IF EXISTS materials_course_id_fkey;
ALTER TABLE syllabus_requirements DROP CONSTRAINT IF EXISTS syllabus_requirements_course_id_fkey;
ALTER TABLE quiz_sets DROP CONSTRAINT IF EXISTS quiz_sets_course_id_fkey;
ALTER TABLE flashcard_sets DROP CONSTRAINT IF EXISTS flashcard_sets_course_id_fkey;
ALTER TABLE generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_course_id_fkey;
ALTER TABLE folder_classes DROP CONSTRAINT IF EXISTS folder_classes_course_id_fkey;

-- Step 2: Drop the course_id columns (optional - keeps data cleaner)
-- Uncomment these if you want to completely remove the columns
-- ALTER TABLE materials DROP COLUMN IF EXISTS course_id;
-- ALTER TABLE syllabus_requirements DROP COLUMN IF EXISTS course_id;
-- ALTER TABLE quiz_sets DROP COLUMN IF EXISTS course_id;
-- ALTER TABLE flashcard_sets DROP COLUMN IF EXISTS course_id;
-- ALTER TABLE generation_jobs DROP COLUMN IF EXISTS course_id;
-- ALTER TABLE folder_classes DROP COLUMN IF EXISTS course_id;

-- Step 3: Drop indexes related to courses
DROP INDEX IF EXISTS idx_materials_course;
DROP INDEX IF EXISTS idx_courses_user;
DROP INDEX IF EXISTS idx_folder_classes_course;

-- Step 4: Drop the courses table
DROP TABLE IF EXISTS courses CASCADE;

-- Verify the changes
-- SELECT table_name, column_name 
-- FROM information_schema.columns 
-- WHERE column_name = 'course_id';
