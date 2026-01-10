import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extractTextFromPDF = async (filePath) => {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  } catch (error) {
    throw new Error(`Error extracting text from PDF: ${error.message}`);
  }
};

const extractTextFromDocx = async (filePath) => {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } catch (error) {
    throw new Error(`Error extracting text from DOCX: ${error.message}`);
  }
};

const extractTextFromTxt = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  } catch (error) {
    throw new Error(`Error reading text file: ${error.message}`);
  }
};

const getFileExtension = (filename) => {
  return path.extname(filename).toLowerCase();
};

export const processDocuments = async (files) => {
  const extractedTexts = [];

  for (const file of files) {
    const filePath = file.path;
    const extension = getFileExtension(file.originalname);

    let text = '';

    try {
      switch (extension) {
        case '.pdf':
          text = await extractTextFromPDF(filePath);
          break;
        case '.docx':
        case '.doc':
          text = await extractTextFromDocx(filePath);
          break;
        case '.txt':
        case '.md':
          text = await extractTextFromTxt(filePath);
          break;
        default:
          text = await extractTextFromTxt(filePath);
      }

      if (text && text.trim().length > 0) {
        extractedTexts.push(text);
      }
    } catch (error) {
      console.error(`Error processing file ${file.originalname}:`, error.message);
    } finally {
      try {
        await fs.unlink(filePath);
      } catch (unlinkError) {
        console.error(`Error deleting temporary file ${filePath}:`, unlinkError.message);
      }
    }
  }

  return extractedTexts.join('\n\n---\n\n');
};
