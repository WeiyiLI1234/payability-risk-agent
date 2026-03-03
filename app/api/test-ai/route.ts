import { generateText } from "ai";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: "In one sentence, what is Payability?",
    });

    return NextResponse.json({ success: true, response: text });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
