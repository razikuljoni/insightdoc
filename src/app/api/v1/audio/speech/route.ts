/**
 * POST /api/v1/audio/speech — read-aloud narration for assistant answers (TTS)
 *
 * The TTS API caps input at 1024 characters per request, so the answer text is
 * split on sentence boundaries, synthesized chunk-by-chunk (24kHz 16-bit mono
 * WAV), and the PCM payloads are merged into ONE seamless WAV response so the
 * client hears a single continuous narration.
 */
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/server/bootstrap';
import { recordAudit } from '@/server/audit';
import { SpeechRequestSchema } from '@/lib/types';
import { getZAI } from '@/server/zai';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const TTS_CHUNK_CHARS = 950;
const SAMPLE_RATE = 24000;
const VOICE = 'tongtong';

/** Split text into ≤950-char pieces on sentence boundaries (TTS API limit: 1024). */
function splitForTts(text: string): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+["')\]]?\s*|[^.!?…]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length <= TTS_CHUNK_CHARS) {
      current += sentence;
    } else {
      if (current.trim()) chunks.push(current.trim());
      // A single over-long sentence (no punctuation) is hard-split as fallback
      if (sentence.length > TTS_CHUNK_CHARS) {
        for (let i = 0; i < sentence.length; i += TTS_CHUNK_CHARS) {
          chunks.push(sentence.slice(i, i + TTS_CHUNK_CHARS).trim());
        }
        current = '';
      } else {
        current = sentence;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

/** Locate the RIFF `data` subchunk inside a WAV buffer. */
function extractWavPcm(buffer: Buffer): { pcm: Buffer; bitsPerSample: number; numChannels: number } {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('TTS returned a non-WAV payload');
  }
  let offset = 12; // skip RIFF + size + WAVE
  let bitsPerSample = 16;
  let numChannels = 1;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 8 + 16 <= buffer.length) {
      numChannels = buffer.readUInt16LE(offset + 10);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    }
    if (id === 'data') {
      const end = Math.min(offset + 8 + size, buffer.length);
      return { pcm: buffer.subarray(offset + 8, end), bitsPerSample, numChannels };
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error('TTS WAV payload missing data chunk');
}

/** Rebuild a single 44-byte-header WAV around concatenated PCM payloads. */
function buildWav(pcm: Buffer, numChannels: number, bitsPerSample: number): Buffer {
  const byteRate = (SAMPLE_RATE * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Synthesize one chunk with bounded retries (upstream occasionally 500s transiently). */
async function ttsWithRetry(
  zai: Awaited<ReturnType<(typeof import('z-ai-web-dev-sdk'))['default']['create']>>,
  chunk: string,
  speed: number,
  attempts = 3,
): Promise<Awaited<ReturnType<typeof zai.audio.tts.create>>> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await zai.audio.tts.create({
        input: chunk,
        voice: VOICE,
        speed,
        response_format: 'wav',
        stream: false,
      });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 400 * (i + 1))); // 400ms, 800ms backoff
    }
  }
  throw lastError instanceof Error ? lastError : new Error('TTS synthesis failed after retries');
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();

    const body: unknown = await request.json().catch(() => null);
    const parsed = SpeechRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid request' },
        { status: 400 },
      );
    }
    const { text, speed } = parsed.data;

    // Strip markdown decoration so the narration sounds natural
    const speakable = text
      .replace(/\[(\d{1,2})\]/g, '') // citation markers
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/[*_#>`|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!speakable) {
      return NextResponse.json({ error: 'Nothing speakable in this answer' }, { status: 422 });
    }

    const zai = await getZAI();

    const chunks = splitForTts(speakable);
    let bitsPerSample = 16;
    let numChannels = 1;
    const pcmParts: Buffer[] = [];

    for (const chunk of chunks) {
      const response = await ttsWithRetry(zai, chunk, speed);
      const arrayBuffer = await response.arrayBuffer();
      const { pcm, bitsPerSample: bits, numChannels: ch } = extractWavPcm(
        Buffer.from(new Uint8Array(arrayBuffer)),
      );
      bitsPerSample = bits;
      numChannels = ch;
      pcmParts.push(pcm);
    }

    const wav = buildWav(Buffer.concat(pcmParts), numChannels, bitsPerSample);

    await recordAudit({
      actorEmail: user.email,
      action: 'audio.speech',
      targetType: 'chat',
      detail: { chars: speakable.length, chunks: chunks.length, speed },
    }).catch(() => undefined); // narration is ephemeral — never fail playback on audit

    return new NextResponse(new Uint8Array(wav), {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(wav.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[POST /audio/speech]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Speech synthesis failed' },
      { status: 500 },
    );
  }
}
