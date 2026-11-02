import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { launch } from './harness'

/**
 * Local speech-to-text: real speech (macOS `say`) through the in-app Whisper
 * worker. Downloads the model on first run, so it only runs when MINT_VOICE=1.
 */
test.skip(process.env.MINT_VOICE !== '1' || process.platform !== 'darwin', 'set MINT_VOICE=1 on macOS')

test('local Whisper transcribes real speech in the app', async () => {
  test.setTimeout(600_000)
  execFileSync('say', ['-o', '/tmp/mint-voice-test.wav', '--data-format=LEI16@16000', 'What is an eigenvector, and why does it keep its direction?'])
  const bytes = Array.from(readFileSync('/tmp/mint-voice-test.wav'))
  const m = await launch()
  try {
    const text = await m.page.evaluate(async (data) => {
      const hook = (window as unknown as { __mintVoiceTest: { transcribeEncoded: (b: ArrayBuffer) => Promise<string> } }).__mintVoiceTest
      return hook.transcribeEncoded(new Uint8Array(data).buffer)
    }, bytes)
    console.log('transcript:', text)
    expect(text.toLowerCase()).toContain('eigenvector')
    expect(m.errors.filter((e) => !/Permissions policy|DevTools/.test(e))).toEqual([])
  } finally {
    await m.close()
  }
})

test('the system voice speaks a tutor reply to completion', async () => {
  const m = await launch()
  try {
    const result = await m.page.evaluate(
      () =>
        new Promise<{ voices: number; ended: boolean; voice: string }>((resolve) => {
          const go = () => {
            const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'))
            const u = new SpeechSynthesisUtterance('Look at the arrow.')
            u.voice = voices[0] ?? null
            u.rate = 1.4
            u.onend = () => resolve({ voices: voices.length, ended: true, voice: u.voice?.name ?? '' })
            u.onerror = () => resolve({ voices: voices.length, ended: false, voice: u.voice?.name ?? '' })
            speechSynthesis.speak(u)
          }
          if (speechSynthesis.getVoices().length) go()
          else speechSynthesis.addEventListener('voiceschanged', go, { once: true })
          setTimeout(() => resolve({ voices: speechSynthesis.getVoices().length, ended: false, voice: 'timeout' }), 20000)
        })
    )
    console.log('tts:', result)
    expect(result.voices).toBeGreaterThan(0)
    expect(result.ended).toBe(true)
  } finally {
    await m.close()
  }
})
