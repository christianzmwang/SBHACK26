-- Migration: Enable Row Level Security (RLS) on all public tables
-- This migration enables RLS and creates policies to protect data
-- Service role connections (like the backend API) bypass RLS automatically

-- =============================================
-- ENABLE RLS ON ALL TABLES
-- =============================================

-- Empty

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE folder_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE section_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE flashcard_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE flashcards ENABLE ROW LEVEL SECURITY;
ALTER TABLE flashcard_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_attempts ENABLE ROW LEVEL SECURITY;

-- =============================================
-- USERS TABLE POLICIES
-- =============================================

-- Users can read their own profile
CREATE POLICY "users_select_own" ON users
  FOR SELECT
  USING (auth.uid()::text = google_id OR auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "users_update_own" ON users
  FOR UPDATE
  USING (auth.uid()::text = google_id OR auth.uid() = id);

-- Users can insert their own profile (during signup)
CREATE POLICY "users_insert_own" ON users
  FOR INSERT
  WITH CHECK (auth.uid()::text = google_id OR auth.uid() = id);

-- =============================================
-- FOLDERS TABLE POLICIES
-- =============================================

-- Users can only see their own folders
CREATE POLICY "folders_select_own" ON folders
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can only insert folders for themselves
CREATE POLICY "folders_insert_own" ON folders
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can only update their own folders
CREATE POLICY "folders_update_own" ON folders
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can only delete their own folders
CREATE POLICY "folders_delete_own" ON folders
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- =============================================
-- FOLDER_SECTIONS TABLE POLICIES
-- =============================================

-- Users can see sections in their folders
CREATE POLICY "folder_sections_select_own" ON folder_sections
  FOR SELECT
  USING (
    folder_id IN (
      SELECT id FROM folders 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can insert sections in their folders
CREATE POLICY "folder_sections_insert_own" ON folder_sections
  FOR INSERT
  WITH CHECK (
    folder_id IN (
      SELECT id FROM folders 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can update sections in their folders
CREATE POLICY "folder_sections_update_own" ON folder_sections
  FOR UPDATE
  USING (
    folder_id IN (
      SELECT id FROM folders 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can delete sections in their folders
CREATE POLICY "folder_sections_delete_own" ON folder_sections
  FOR DELETE
  USING (
    folder_id IN (
      SELECT id FROM folders 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- =============================================
-- SECTION_FILES TABLE POLICIES
-- =============================================

-- Users can see files in their sections
CREATE POLICY "section_files_select_own" ON section_files
  FOR SELECT
  USING (
    section_id IN (
      SELECT fs.id FROM folder_sections fs
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can insert files in their sections
CREATE POLICY "section_files_insert_own" ON section_files
  FOR INSERT
  WITH CHECK (
    section_id IN (
      SELECT fs.id FROM folder_sections fs
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can update files in their sections
CREATE POLICY "section_files_update_own" ON section_files
  FOR UPDATE
  USING (
    section_id IN (
      SELECT fs.id FROM folder_sections fs
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can delete files in their sections
CREATE POLICY "section_files_delete_own" ON section_files
  FOR DELETE
  USING (
    section_id IN (
      SELECT fs.id FROM folder_sections fs
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- =============================================
-- MATERIALS TABLE POLICIES
-- =============================================

-- Users can see materials linked to their section files
CREATE POLICY "materials_select_own" ON materials
  FOR SELECT
  USING (
    id IN (
      SELECT sf.material_id FROM section_files sf
      JOIN folder_sections fs ON sf.section_id = fs.id
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can insert materials (backend handles the linking)
CREATE POLICY "materials_insert_own" ON materials
  FOR INSERT
  WITH CHECK (true);

-- Users can update their own materials
CREATE POLICY "materials_update_own" ON materials
  FOR UPDATE
  USING (
    id IN (
      SELECT sf.material_id FROM section_files sf
      JOIN folder_sections fs ON sf.section_id = fs.id
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can delete their own materials
CREATE POLICY "materials_delete_own" ON materials
  FOR DELETE
  USING (
    id IN (
      SELECT sf.material_id FROM section_files sf
      JOIN folder_sections fs ON sf.section_id = fs.id
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- =============================================
-- MATERIAL_CHUNKS TABLE POLICIES
-- =============================================

-- Users can see chunks of their materials
CREATE POLICY "material_chunks_select_own" ON material_chunks
  FOR SELECT
  USING (
    material_id IN (
      SELECT sf.material_id FROM section_files sf
      JOIN folder_sections fs ON sf.section_id = fs.id
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Backend inserts chunks (service role bypasses RLS)
CREATE POLICY "material_chunks_insert" ON material_chunks
  FOR INSERT
  WITH CHECK (true);

-- Users can update chunks of their materials
CREATE POLICY "material_chunks_update_own" ON material_chunks
  FOR UPDATE
  USING (
    material_id IN (
      SELECT sf.material_id FROM section_files sf
      JOIN folder_sections fs ON sf.section_id = fs.id
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can delete chunks of their materials
CREATE POLICY "material_chunks_delete_own" ON material_chunks
  FOR DELETE
  USING (
    material_id IN (
      SELECT sf.material_id FROM section_files sf
      JOIN folder_sections fs ON sf.section_id = fs.id
      JOIN folders f ON fs.folder_id = f.id
      WHERE f.user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- =============================================
-- QUIZ_SETS TABLE POLICIES
-- =============================================

-- Users can see their own quiz sets
CREATE POLICY "quiz_sets_select_own" ON quiz_sets
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can insert quiz sets for themselves
CREATE POLICY "quiz_sets_insert_own" ON quiz_sets
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can update their own quiz sets
CREATE POLICY "quiz_sets_update_own" ON quiz_sets
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can delete their own quiz sets
CREATE POLICY "quiz_sets_delete_own" ON quiz_sets
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- =============================================
-- FLASHCARD_SETS TABLE POLICIES
-- =============================================

-- Users can see their own flashcard sets
CREATE POLICY "flashcard_sets_select_own" ON flashcard_sets
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can insert flashcard sets for themselves
CREATE POLICY "flashcard_sets_insert_own" ON flashcard_sets
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can update their own flashcard sets
CREATE POLICY "flashcard_sets_update_own" ON flashcard_sets
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can delete their own flashcard sets
CREATE POLICY "flashcard_sets_delete_own" ON flashcard_sets
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- =============================================
-- QUESTIONS TABLE POLICIES
-- =============================================

-- Users can see questions in their quiz sets
CREATE POLICY "questions_select_own" ON questions
  FOR SELECT
  USING (
    quiz_set_id IN (
      SELECT id FROM quiz_sets 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Backend inserts questions (service role bypasses RLS)
CREATE POLICY "questions_insert" ON questions
  FOR INSERT
  WITH CHECK (true);

-- Users can update questions in their quiz sets
CREATE POLICY "questions_update_own" ON questions
  FOR UPDATE
  USING (
    quiz_set_id IN (
      SELECT id FROM quiz_sets 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can delete questions in their quiz sets
CREATE POLICY "questions_delete_own" ON questions
  FOR DELETE
  USING (
    quiz_set_id IN (
      SELECT id FROM quiz_sets 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- =============================================
-- FLASHCARDS TABLE POLICIES
-- =============================================

-- Users can see flashcards in their flashcard sets
CREATE POLICY "flashcards_select_own" ON flashcards
  FOR SELECT
  USING (
    flashcard_set_id IN (
      SELECT id FROM flashcard_sets 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Backend inserts flashcards (service role bypasses RLS)
CREATE POLICY "flashcards_insert" ON flashcards
  FOR INSERT
  WITH CHECK (true);

-- Users can update flashcards in their sets
CREATE POLICY "flashcards_update_own" ON flashcards
  FOR UPDATE
  USING (
    flashcard_set_id IN (
      SELECT id FROM flashcard_sets 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- Users can delete flashcards in their sets
CREATE POLICY "flashcards_delete_own" ON flashcards
  FOR DELETE
  USING (
    flashcard_set_id IN (
      SELECT id FROM flashcard_sets 
      WHERE user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid())
    )
  );

-- =============================================
-- FLASHCARD_SESSIONS TABLE POLICIES
-- =============================================

-- Users can see their own sessions
CREATE POLICY "flashcard_sessions_select_own" ON flashcard_sessions
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can insert their own sessions
CREATE POLICY "flashcard_sessions_insert_own" ON flashcard_sessions
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can update their own sessions
CREATE POLICY "flashcard_sessions_update_own" ON flashcard_sessions
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can delete their own sessions
CREATE POLICY "flashcard_sessions_delete_own" ON flashcard_sessions
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- =============================================
-- PRACTICE_FOLDERS TABLE POLICIES
-- =============================================

-- Users can see their own practice folders
CREATE POLICY "practice_folders_select_own" ON practice_folders
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can insert their own practice folders
CREATE POLICY "practice_folders_insert_own" ON practice_folders
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can update their own practice folders
CREATE POLICY "practice_folders_update_own" ON practice_folders
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can delete their own practice folders
CREATE POLICY "practice_folders_delete_own" ON practice_folders
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- =============================================
-- QUIZ_ATTEMPTS TABLE POLICIES
-- =============================================

-- Users can see their own quiz attempts
CREATE POLICY "quiz_attempts_select_own" ON quiz_attempts
  FOR SELECT
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can insert their own quiz attempts
CREATE POLICY "quiz_attempts_insert_own" ON quiz_attempts
  FOR INSERT
  WITH CHECK (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can update their own quiz attempts
CREATE POLICY "quiz_attempts_update_own" ON quiz_attempts
  FOR UPDATE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));

-- Users can delete their own quiz attempts
CREATE POLICY "quiz_attempts_delete_own" ON quiz_attempts
  FOR DELETE
  USING (user_id IN (SELECT id FROM users WHERE google_id = auth.uid()::text OR id = auth.uid()));
