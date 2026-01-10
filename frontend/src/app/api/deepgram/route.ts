import { NextResponse } from "next/server";

// This endpoint provides the Deepgram API key to the client
// In production, you should implement proper authentication and rate limiting
export async function GET() {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "Deepgram API key not configured" },
      { status: 500 }
    );
  }

  return NextResponse.json({ apiKey });
}
