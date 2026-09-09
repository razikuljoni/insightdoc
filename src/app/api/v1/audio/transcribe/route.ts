/**
 * POST /api/v1/audio/transcribe — voice input for the chat composer (ASR)
 *
 * Accepts a multipart 'audio' field (MediaRecorder blob from the browser),
 * converts to base64 and delegates to the z-ai speech-to-text service.
 * Backend-only SDK usage (z-ai-web-dev-sdk is never imported client-side).
 */
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/server/bootstrap';
import { TranscribeResponseSchema } from '@/lib/types';
import { getZAI } from '@/server/zai';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** 15 MB cap — roughly 8 minutes of 16kHz mono speech; generous for a question. */
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    await getCurrentUser();

    const form = await request.formData().catch(() => null);
    const audio = form?.get('audio');
    if (!(audio instanceof File)) {
      return NextResponse.json({ error: 'No audio recording provided' }, { status: 400 });
    }
    if (audio.size === 0) {
      return NextResponse.json({ error: 'Recording is empty — try again' }, { status: 400 });
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: 'Recording too long (max ~8 minutes)' }, { status: 413 });
    }

    const bytes = Buffer.from(await audio.arrayBuffer());

    const zai = await getZAI();

    const response = await zai.audio.asr.create({ file_base64: bytes.toString('base64') });
    const text = (response?.text ?? '').replace(/\s+/g, ' ').trim();

    if (!text) {
      return NextResponse.json(
        { error: 'No speech detected in the recording' },
        { status: 422 },
      );
    }

    const dto = TranscribeResponseSchema.parse({ text });
    return NextResponse.json(dto);
  } catch (error) {
    console.error('[POST /audio/transcribe]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Transcription failed' },
      { status: 500 },
    );
  }
}
