-- Migration: Remove unused folder_classes table
-- The folder_classes table was part of an earlier design but is not used.
-- The app uses a simpler model: Folders → Sections → Files

-- First, update folder_sections to remove the folder_class_id constraint
-- (any sections that were in classes would need to be moved to folders first,
--  but since classes were never used, this should be empty)

-- Drop the constraint that requires either folder_id or folder_class_id
ALTER TABLE folder_sections DROP CONSTRAINT IF EXISTS section_parent_check;

-- Drop the folder_class_id column from folder_sections
ALTER TABLE folder_sections DROP COLUMN IF EXISTS folder_class_id;

-- Add a NOT NULL constraint on folder_id since sections now only belong to folders
-- First, delete any orphaned sections that don't have a folder_id (shouldn't exist)
DELETE FROM folder_sections WHERE folder_id IS NULL;

-- Now make folder_id required
ALTER TABLE folder_sections ALTER COLUMN folder_id SET NOT NULL;

-- Drop the folder_classes table
DROP TABLE IF EXISTS folder_classes CASCADE;

-- Drop the index that referenced folder_classes
DROP INDEX IF EXISTS idx_folder_sections_class;
