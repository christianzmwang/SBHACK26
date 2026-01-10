-- Migration: Add folders support
-- This migration adds tables to support the frontend's folder/class/section hierarchy

-- Folders table (supports nested subfolders via parent_folder_id)
CREATE TABLE IF NOT EXISTS folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  parent_folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for user's folders
CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_folder_id);

-- Classes table (classes within folders, linked to courses)
CREATE TABLE IF NOT EXISTS folder_classes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  color VARCHAR(50) DEFAULT 'bg-indigo-600',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Index for folder's classes
CREATE INDEX IF NOT EXISTS idx_folder_classes_folder ON folder_classes(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_classes_course ON folder_classes(course_id);

-- Sections table (custom sections for classes or folders)
CREATE TABLE IF NOT EXISTS folder_sections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  folder_id UUID REFERENCES folders(id) ON DELETE CASCADE,
  folder_class_id UUID REFERENCES folder_classes(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(50) DEFAULT 'custom', -- 'textbook', 'syllabus', 'lecture_notes', 'practice_questions', 'custom'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  -- Either folder_id or folder_class_id must be set, but not both
  CONSTRAINT section_parent_check CHECK (
    (folder_id IS NOT NULL AND folder_class_id IS NULL) OR
    (folder_id IS NULL AND folder_class_id IS NOT NULL)
  )
);

-- Index for sections
CREATE INDEX IF NOT EXISTS idx_folder_sections_folder ON folder_sections(folder_id);
CREATE INDEX IF NOT EXISTS idx_folder_sections_class ON folder_sections(folder_class_id);

-- Files table (files within sections)
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

-- Index for section's files
CREATE INDEX IF NOT EXISTS idx_section_files_section ON section_files(section_id);
CREATE INDEX IF NOT EXISTS idx_section_files_material ON section_files(material_id);

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_folders_updated_at ON folders;
CREATE TRIGGER update_folders_updated_at BEFORE UPDATE ON folders
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_folder_classes_updated_at ON folder_classes;
CREATE TRIGGER update_folder_classes_updated_at BEFORE UPDATE ON folder_classes
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_folder_sections_updated_at ON folder_sections;
CREATE TRIGGER update_folder_sections_updated_at BEFORE UPDATE ON folder_sections
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
