# Voice Agent Quick Start Guide

## Setup (5 minutes)

### 1. Add Deepgram API Key

Add to `backend/.env`:
```bash
DEEPGRAM_API_KEY=your_key_here
```

Get your key at [deepgram.com](https://deepgram.com/dashboard)

### 2. Restart Backend

```bash
cd backend
npm run dev
```

### 3. Test It Out

1. Navigate to the Practice page
2. Click the floating microphone button (bottom-right) or press `V`
3. Click the microphone to start
4. Grant microphone permissions
5. Start speaking!

## What to Say

### During a Quiz

- "Can you explain this question?"
- "What does this mean?"
- "I'm stuck between answers A and B"
- "Can you give me a hint?"
- "What concept is this testing?"

### After Quiz Results

- "Why did I get question 3 wrong?"
- "Can you explain the correct answer?"
- "What should I study more?"
- "How can I improve my score?"

### With Flashcards

- "Help me remember this"
- "What's a good way to memorize this?"
- "Can you explain this concept?"
- "Give me another example"

### General

- "What should I study next?"
- "How am I doing?"
- "Explain this topic to me"

## Visual Guide

```
┌─────────────────────────────────────────┐
│ 🎯 Quiz: Question 5 of 10                │
├─────────────────────────────────────────┤
│                                          │
│  What is the capital of France?         │
│                                          │
│  ○ A. London                            │
│  ○ B. Paris         [VOICE BUTTON] 🎤  │
│  ○ C. Berlin                            │
│  ○ D. Madrid                            │
│                                          │
└─────────────────────────────────────────┘

Click the floating button or press 'V'
```

## Voice Agent Modal

```
┌─────────────────────────────────────────────────┐
│ 🟢 Voice Study Assistant               ✕       │
├─────────────────────────────────────────────────┤
│                                                 │
│  [USER] Can you explain this question?         │
│                                                 │
│  [AI] This question is asking about European   │
│       capitals. Think about which city is      │
│       the center of French government...       │
│                                                 │
│  Speaking...  ● ● ●                            │
│                                                 │
├─────────────────────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓▓░░░░░░ (Audio Level)                 │
│                                                 │
│              🎤                                 │
│          Listening...                          │
│                                                 │
│   Context: Quiz Question 5                     │
│                                                 │
│   Press Space to toggle • Esc to close         │
└─────────────────────────────────────────────────┘
```

## States

### 🔴 Not Connected
- Click microphone to start
- Button is white

### 🟢 Connected & Ready
- Ready to listen
- Button is blue
- Audio level shows activity

### 🔴 Listening
- You're speaking
- Button is red and pulsing
- Live transcript appears

### 💬 Processing
- AI is thinking
- Processing indicator shows

### 🔊 Speaking
- AI is responding
- Bouncing dots animation
- Text displayed in real-time

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `V` | Open/close voice assistant (anywhere) |
| `Space` | Start/stop listening (when modal open) |
| `Esc` | Close modal |

## Tips

✅ **DO:**
- Speak naturally and clearly
- Wait for "Listening..." indicator
- Ask follow-up questions
- Use it during any study mode

❌ **DON'T:**
- Don't speak too fast
- Don't interrupt AI responses
- Don't expect it to give direct answers (it provides hints!)

## Troubleshooting

**No microphone access?**
→ Check browser permissions (usually in address bar)

**Not transcribing?**
→ Check system microphone settings
→ Try reloading the page

**No AI response?**
→ Check backend is running
→ Verify DEEPGRAM_API_KEY in backend/.env

**No audio playback?**
→ Check system volume
→ Check browser isn't muted

## Features

- ✅ Real-time speech recognition
- ✅ Context-aware AI responses
- ✅ Natural voice playback
- ✅ Live captions
- ✅ Audio level visualization
- ✅ Keyboard shortcuts
- ✅ Eager end-of-turn detection
- ✅ Automatic turn resumption

## Privacy

- ✅ Temporary tokens (5-min expiry)
- ✅ No audio stored
- ✅ No transcripts saved
- ✅ Requires explicit permission

---

**Ready to study smarter?** Press `V` and start chatting! 🎓✨
