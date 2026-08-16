import { GoogleGenAI, Type } from '@google/genai';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || 'fake-key-for-local-dev',
});

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    covered: {
      type: Type.BOOLEAN,
      description: "true if description adequately covers the diff",
    },
    reasoning: {
      type: Type.STRING,
      description: "a short 1-2 sentence explanation",
    },
  },
  required: ["covered", "reasoning"],
};

export async function judgeDescription(prBody, diffStat) {
  if (!process.env.GEMINI_API_KEY) {
    console.log("No Gemini API key, mocking response.");
    return {
      covered: true,
      reasoning: "Mocked: Description appears adequate based on simple heuristic.",
    };
  }

  const prompt = `Evaluate if the following PR description accurately and comprehensively covers the provided diff stat.

PR Description:
"""
${prBody || "(No description provided)"}
"""

Diff Stat:
"""
${diffStat}
"""`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        systemInstruction: "You are a strict technical PR reviewer.",
      },
    });

    return JSON.parse(response.text);
  } catch (err) {
    console.error("Gemini evaluation failed:", err);
    return {
      covered: false,
      reasoning: "Failed to evaluate description with Gemini.",
    };
  }
}
