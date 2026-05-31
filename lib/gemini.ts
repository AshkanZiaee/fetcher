import { GoogleGenAI, Type } from "@google/genai";
import type { Analysis, Draft, RawJob } from "./types";

const MODEL = "gemini-2.5-flash-lite";

const schema = {
  type: Type.OBJECT,
  properties: {
    matchScore: { type: Type.INTEGER, description: "0–100 fit vs the profile" },
    recommend: { type: Type.STRING, enum: ["apply", "maybe", "skip"] },
    matchReason: { type: Type.STRING, description: "1–2 sentences, concrete" },
    salary: { type: Type.STRING, description: "salary if stated, else empty" },
    coverLetterNeeded: { type: Type.STRING, enum: ["yes", "no", "unknown"] },
    quickApply: { type: Type.STRING, enum: ["yes", "no", "unknown"] },
    remote: { type: Type.STRING, enum: ["onsite", "hybrid", "remote", "unknown"] },
    employmentType: { type: Type.STRING },
    seniority: { type: Type.STRING },
    language: {
      type: Type.STRING,
      description: 'main working language of the role, e.g. "German", "English", "German/English"',
    },
    tags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "3–6 short category tags",
    },
    keyRequirements: { type: Type.ARRAY, items: { type: Type.STRING } },
    redFlags: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: [
    "matchScore",
    "recommend",
    "matchReason",
    "coverLetterNeeded",
    "quickApply",
    "remote",
    "employmentType",
    "seniority",
    "language",
    "tags",
    "keyRequirements",
    "redFlags",
  ],
} as const;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is empty — add it to .env.local");
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

export async function analyzeJob(job: RawJob, profile: string): Promise<Analysis> {
  const ai = getClient();
  const prompt = `You are a sharp job-search assistant. Compare ONE job posting to the
candidate profile and return the structured verdict.

Scoring rules:
- matchScore: honest 0–100. Reward stack/role/seniority/language/location fit.
  Penalize hard for deal-breakers in the profile. Be decisive, not generous.
- recommend: "apply" (>=70 and no deal-breaker), "maybe" (45–69), "skip" (<45).
- salary: copy it only if the posting states it; otherwise empty string.
- coverLetterNeeded / quickApply: infer from the posting; "unknown" if unclear.
- language: the main working language of the role ("German", "English", or
  "German/English"). Infer from the posting language + any stated requirement.
- tags: 3–6 short, scannable labels for filtering — stack/domain/type, e.g.
  "React", "TypeScript", "Remote", "Hybrid", "Werkstudent", "Teilzeit",
  "Fintech", "Senior", "Junior-friendly", "German required", "English OK".
- keyRequirements: the 3–6 must-haves. redFlags: anything that hurts fit.

=== CANDIDATE PROFILE ===
${profile}

=== JOB POSTING ===
Company: ${job.company}
Title: ${job.title}
Location: ${job.location}
${job.description}`;

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: schema as any,
          temperature: 0.2,
        },
      });
      break;
    } catch (e: any) {
      const is429 = String(e?.message ?? e).includes("429");
      if (is429 && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue; // back off and retry on rate limit
      }
      throw e;
    }
  }

  const parsed = JSON.parse(res.text ?? "{}");
  return {
    ...parsed,
    salary: parsed.salary ? parsed.salary : null,
  } as Analysis;
}

const draftSchema = {
  type: Type.OBJECT,
  properties: {
    language: { type: Type.STRING, description: '"German" or "English" — match the posting' },
    coverLetter: { type: Type.STRING, description: "a complete, ready-to-send cover letter" },
    bullets: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "3–5 sharp 'why I fit' bullet points",
    },
    shortMessage: {
      type: Type.STRING,
      description: "a 2–3 sentence message for a quick-apply / recruiter DM",
    },
  },
  required: ["language", "coverLetter", "bullets", "shortMessage"],
} as const;

export async function draftApplication(job: RawJob, profile: string): Promise<Draft> {
  const ai = getClient();
  const prompt = `Write a job application for this candidate, tailored to this posting.

Rules:
- Detect the posting's language and write EVERYTHING in it (German posting → German letter).
- Be specific: tie the candidate's real projects/skills to THIS role's requirements. No fluff, no clichés ("Hiermit bewerbe ich mich…" is fine to open in German).
- The candidate is a real person — use first person, confident but not arrogant. Keep the cover letter ~180–250 words.
- bullets: 3–5 crisp "why I'm a fit" points the candidate can paste anywhere.
- shortMessage: a 2–3 sentence version for LinkedIn quick-apply or a recruiter message.

=== CANDIDATE PROFILE ===
${profile}

=== JOB POSTING ===
Company: ${job.company}
Title: ${job.title}
Location: ${job.location}
${job.description || "(no description available — write from the title + company)"}`;

  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: draftSchema as any, temperature: 0.5 },
  });
  return JSON.parse(res.text ?? "{}") as Draft;
}
