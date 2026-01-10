import axios from 'axios';
import FormData from 'form-data';

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DEEPGRAM_API_URL = 'https://api.deepgram.com/v1/speak';

export const textToSpeech = async (text) => {
  if (!DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is not configured');
  }

  if (!text || text.trim().length === 0) {
    throw new Error('Text is required for TTS');
  }

  try {
    const formData = new FormData();
    formData.append('text', text);

    const response = await axios.post(
      `${DEEPGRAM_API_URL}?model=nova-2&encoding=linear16&sample_rate=24000`,
      formData,
      {
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          ...formData.getHeaders()
        },
        responseType: 'arraybuffer'
      }
    );

    const audioBuffer = Buffer.from(response.data);
    const base64Audio = audioBuffer.toString('base64');

    return {
      audio: base64Audio,
      metadata: {
        format: 'linear16',
        sampleRate: 24000,
        model: 'nova-2',
        size: audioBuffer.length
      }
    };
  } catch (error) {
    if (error.response) {
      throw new Error(`Deepgram API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`Error calling Deepgram TTS: ${error.message}`);
  }
};
