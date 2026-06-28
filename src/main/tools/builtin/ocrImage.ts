import { z } from 'zod'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  path: z.string().describe('Absolute path to the image file to OCR.'),
  language: z
    .string()
    .optional()
    .describe(
      'OCR language code (ISO 639-3 or Tesseract code). ' +
        'Examples: "eng" (English), "chi_sim" (Simplified Chinese), ' +
        '"jpn" (Japanese), "fra" (French), "deu" (German), "spa" (Spanish). ' +
        'Defaults to "eng" if not specified. Use "+" to combine, e.g. "eng+chi_sim".'
    )
})

type Input = z.infer<typeof schema>

/** Maximum image size to process (avoids OOM on huge images). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // 20 MB
/** Timeout for OCR processing (some complex images take a while). */
const OCR_TIMEOUT_MS = 30_000

/**
 * Tesseract.js OCR tool.
 *
 * Uses a pure-WASM Tesseract engine — no native deps, no install step.
 * The ~8 MB language data files are downloaded on first use and cached
 * locally. Language data is fetched from jsdelivr CDN, so the first call
 * for each language requires internet access.
 */
const def: BuiltinToolDef<Input> = {
  name: 'ocr_image',
  description:
    'Extract text from an image file using OCR (optical character recognition). ' +
    'Use this when the user attaches an image and you need to read text from it, ' +
    'or when you encounter an image file in the workspace whose text contents you need. ' +
    'Supports 100+ languages via Tesseract. ' +
    'The first call for a given language downloads ~8 MB of language data (cached thereafter). ' +
    'Images larger than 20 MB are rejected. ' +
    'Note: OCR works best on clear, high-contrast text in standard fonts. ' +
    'Handwriting, stylized fonts, and low-resolution images will produce imperfect results.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the image file to OCR.'
      },
      language: {
        type: 'string',
        description:
          'OCR language code. Examples: "eng" (English), "chi_sim" (Simplified Chinese), ' +
          '"jpn" (Japanese). Defaults to "eng". Use "+" to combine, e.g. "eng+chi_sim".'
      }
    },
    required: ['path'],
    additionalProperties: false
  },
  toolset: 'file',
  needsConfirmation: false,
  emoji: '🔍',
  maxResultSizeChars: 50_000,
  async handler(input) {
    const lang = input.language?.trim() || 'eng'

    // Reject images over the size limit (avoid OOM)
    const { stat } = await import('fs/promises')
    const fileStat = await stat(input.path)
    if (fileStat.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image too large: ${(fileStat.size / 1024 / 1024).toFixed(1)} MB (max 20 MB)`
      )
    }

    // Dynamically import tesseract.js — keeps the main bundle lean
    const { createWorker } = await import('tesseract.js')

    const worker = await createWorker(lang, 1, {
      // Suppress verbose tesseract logging
      logger: () => {}
    })

    try {
      // Set a timeout so OCR doesn't hang forever on problematic images
      const result = await Promise.race([
        worker.recognize(input.path),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`OCR timed out after ${OCR_TIMEOUT_MS / 1000}s`)), OCR_TIMEOUT_MS)
        )
      ])

      const text = result.data.text?.trim()
      if (!text) {
        return `(No text found in image: ${input.path})`
      }

      // Include confidence info
      const confidence = result.data.confidence != null
        ? `\n## OCR confidence: ${Math.round(result.data.confidence)}%`
        : ''

      return `## OCR result for: ${input.path}\n## Language: ${lang}${confidence}\n\n${text}`
    } catch (err) {
      throw new Error(
        `OCR failed: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      await worker.terminate()
    }
  }
}

export function createOcrImageTool(): AgentTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.jsonSchema,
    source: 'builtin',
    toolset: def.toolset,
    needsConfirmation: def.needsConfirmation ?? false,
    emoji: def.emoji,
    maxResultSizeChars: def.maxResultSizeChars,
    async run(input: unknown): Promise<string> {
      const parsed = def.schema.parse(input)
      return def.handler(parsed)
    }
  }
}
