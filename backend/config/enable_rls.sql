-- Enable RLS and add policies for all tables
-- Run this in Supabase SQL Editor

-- 1. USERS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own data" ON users;
CREATE POLICY "Users can manage their own data" ON users
    FOR ALL
    USING (auth.uid() = id);

-- 2. FOLDERS
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own folders" ON folders;
CREATE POLICY "Users can manage their own folders" ON folders
    FOR ALL
    USING (auth.uid() = user_id);

-- 3. FOLDER SECTIONS (Linked to Folders)
ALTER TABLE folder_sections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own folder sections" ON folder_sections;
CREATE POLICY "Users can manage their own folder sections" ON folder_sections
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM folders
            WHERE folders.id = folder_sections.folder_id
            AND folders.user_id = auth.uid()
        )
    );

-- 4. MATERIALS (No direct user link, assuming public/shared for now to avoid breakage)
ALTER TABLE materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all access to materials" ON materials;
CREATE POLICY "Allow all access to materials" ON materials
    FOR ALL
    USING (true);

-- 5. MATERIAL CHUNKS
ALTER TABLE material_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all access to material chunks" ON material_chunks;
CREATE POLICY "Allow all access to material chunks" ON material_chunks
    FOR ALL
    USING (true);

-- 6. SECTION FILES (Linked to Section -> Folder)
ALTER TABLE section_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own section files" ON section_files;
CREATE POLICY "Users can manage their own section files" ON section_files
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM folder_sections
            JOIN folders ON folders.id = folder_sections.folder_id
            WHERE folder_sections.id = section_files.section_id
            AND folders.user_id = auth.uid()
        )
    );

-- 7. PRACTICE FOLDERS
ALTER TABLE practice_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own practice folders" ON practice_folders;
CREATE POLICY "Users can manage their own practice folders" ON practice_folders
    FOR ALL
    USING (auth.uid() = user_id);

-- 8. QUIZ SETS
ALTER TABLE quiz_sets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own quiz sets" ON quiz_sets;
CREATE POLICY "Users can manage their own quiz sets" ON quiz_sets
    FOR ALL
    USING (auth.uid() = user_id);

-- 9. QUESTIONS (Linked to Quiz Sets)
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own questions" ON questions;
CREATE POLICY "Users can manage their own questions" ON questions
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM quiz_sets
            WHERE quiz_sets.id = questions.quiz_set_id
            AND quiz_sets.user_id = auth.uid()
        )
    );

-- 10. FLASHCARD SETS
ALTER TABLE flashcard_sets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own flashcard sets" ON flashcard_sets;
CREATE POLICY "Users can manage their own flashcard sets" ON flashcard_sets
    FOR ALL
    USING (auth.uid() = user_id);

-- 11. FLASHCARDS (Linked to Flashcard Sets)
ALTER TABLE flashcards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own flashcards" ON flashcards;
CREATE POLICY "Users can manage their own flashcards" ON flashcards
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM flashcard_sets
            WHERE flashcard_sets.id = flashcards.flashcard_set_id
            AND flashcard_sets.user_id = auth.uid()
        )
    );

-- 12. QUIZ ATTEMPTS
ALTER TABLE quiz_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own quiz attempts" ON quiz_attempts;
CREATE POLICY "Users can manage their own quiz attempts" ON quiz_attempts
    FOR ALL
    USING (auth.uid() = user_id);

-- 13. FLASHCARD SESSIONS
ALTER TABLE flashcard_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage their own flashcard sessions" ON flashcard_sessions;
CREATE POLICY "Users can manage their own flashcard sessions" ON flashcard_sessions
    FOR ALL
    USING (auth.uid() = user_id);
