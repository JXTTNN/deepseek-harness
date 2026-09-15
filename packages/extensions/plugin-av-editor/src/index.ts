/**
 * Plugin: Audio/Video Editor
 *
 * FFmpeg-based media processing tools. All operations run entirely
 * locally with zero API keys required. Covers the most common
 * audio/video editing workflows:
 *
 *   - av_trim          → cut a segment from video/audio
 *   - av_merge         → concatenate multiple files into one
 *   - av_transcode     → convert between formats / codecs
 *   - av_extract_audio → extract audio track from a video file
 *   - av_get_info      → probe file metadata (duration, codecs, resolution)
 *   - av_extract_frames→ export individual frames as PNG/JPG
 *   - av_speed         → change playback speed (slow-mo / timelapse)
 *   - av_volume        → adjust audio volume (dB or percentage)
 *   - av_to_gif        → convert video segment to animated GIF
 *
 * Requires: FFmpeg installed on the runner or local machine.
 * On Ubuntu CI: `sudo apt-get install -y ffmpeg`
 *
 * @module @deepseek-ai/dsh-plugin-av-editor
 */

import { execSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool as _defineTool } from '@deepseek-ai/dsh-tools'
const defineTool = _defineTool as any

export const name = 'plugin-av-editor'
export const inject = ['tools']

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Run a shell command synchronously, return trimmed output. */
function sh(cmd: string, timeoutMs = 120_000): string {
  try {
    return execSync(cmd, {
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (e: any) {
    return (e.stderr || e.stdout || e.message || '').trim()
  }
}



/** Run ffprobe and return parsed JSON. */
function ffprobe(filePath: string): Record<string, any> {
  const cmd = [
    'ffprobe',
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    `"${filePath}"`,
  ].join(' ')
  const out = sh(cmd, 10_000)
  try { return JSON.parse(out) } catch { return { error: out } }
}

/** Validate a file path exists. */
function assertFile(path: string): string {
  const resolved = resolve(path)
  if (!existsSync(resolved)) throw new Error(`File not found: ${resolved}`)
  return resolved
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function apply(ctx: Context): void {

  // ---- av_get_info ---------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'av_get_info',
    description:
      'Probe a media file and return metadata: duration, codecs, resolution, '
      + 'bitrate, format, and stream details. Uses ffprobe.',
    parameters: {
      file: { type: 'string', required: true, description: 'Path to video/audio file.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          duration: { type: 'string' },
          format: { type: 'string' },
          videoCodec: { type: 'string' },
          audioCodec: { type: 'string' },
          resolution: { type: 'string' },
          bitrate: { type: 'string' },
          raw: { type: 'object' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text' as const,
        text: [
          `Format: ${v.format}`,
          `Duration: ${v.duration}`,
          `Resolution: ${v.resolution}`,
          `Video codec: ${v.videoCodec}`,
          `Audio codec: ${v.audioCodec}`,
          `Bitrate: ${v.bitrate}`,
        ].join('\n'),
      }],
    },
    execute: async (args: any) => {
      const file = assertFile(args.file)
      const info = ffprobe(file)

      const fmt = info.format ?? {}
      const streams: any[] = info.streams ?? []
      const video = streams.find((s: any) => s.codec_type === 'video')
      const audio = streams.find((s: any) => s.codec_type === 'audio')

      return {
        duration: fmt.duration ? `${Number(fmt.duration).toFixed(2)}s` : 'unknown',
        format: fmt.format_long_name ?? fmt.format_name ?? 'unknown',
        videoCodec: video ? `${video.codec_name} ${video.profile ?? ''}`.trim() : 'none',
        audioCodec: audio ? `${audio.codec_name} ${audio.sample_rate ? audio.sample_rate + 'Hz' : ''}`.trim() : 'none',
        resolution: video ? `${video.width}x${video.height}` : 'N/A',
        bitrate: fmt.bit_rate ? `${(Number(fmt.bit_rate) / 1000).toFixed(0)} kbps` : 'unknown',
        raw: info,
      }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Info: ${basename(String(args.file))}`, kind: 'read' as const }),
  }))

  // ---- av_trim -------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'av_trim',
    description:
      'Cut a segment from a video or audio file. Specify start time and duration (or end time). '
      + 'Output is re-encoded to preserve frames at cut points.',
    parameters: {
      file: { type: 'string', required: true, description: 'Source file path.' },
      output: { type: 'string', required: true, description: 'Output file path.' },
      start: { type: 'string', description: 'Start time (HH:MM:SS or seconds, default "0").' },
      duration: { type: 'string', description: 'Duration to keep (HH:MM:SS or seconds).' },
      end: { type: 'string', description: 'End time (HH:MM:SS or seconds). Ignored if duration given.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          input: { type: 'string' },
          output: { type: 'string' },
          trimmedFrom: { type: 'string' },
          trimmedTo: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ Trimmed ${v.trimmedFrom} → ${v.trimmedTo}\nOutput: ${v.output}`
          : `❌ Trim failed: ${v.error ?? 'unknown error'}`,
      }],
    },
    execute: async (args: any) => {
      const file = assertFile(args.file)
      const start = args.start ?? '0'
      const out = args.output

      const timeArgs = args.duration
        ? `-ss ${start} -t ${args.duration}`
        : args.end
          ? `-ss ${start} -to ${args.end}`
          : `-ss ${start}`

      const cmd = `ffmpeg -y -i "${file}" ${timeArgs} -c:v libx264 -c:a aac -movflags +faststart "${out}"`
      const result = sh(cmd)

      const ok = existsSync(out)
      return {
        ok,
        input: file,
        output: out,
        trimmedFrom: start,
        trimmedTo: args.duration ? `${start}+${args.duration}` : args.end ?? 'EOF',
        ...(ok ? {} : { error: result }),
      }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Trim: ${basename(String(args.file))}`, kind: 'write' as const }),
  }))

  // ---- av_merge ------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'av_merge',
    description:
      'Concatenate multiple video/audio files into a single output. All files must have '
      + 'the same codec types. Supports 2-50 files.',
    parameters: {
      files: { type: 'string', required: true, description: 'Comma-separated list of input file paths.' },
      output: { type: 'string', required: true, description: 'Output file path.' },
      format: { type: 'string', enum: ['mp4', 'mkv', 'webm', 'avi', 'mov'], description: 'Container format. Default: mp4.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          fileCount: { type: 'integer' },
          output: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ Merged ${v.fileCount} files → ${v.output}`
          : `❌ Merge failed`,
      }],
    },
    execute: async (args: any) => {
      const files = args.files.split(',').map((f: string) => f.trim())
      if (files.length < 2) throw new Error('Need at least 2 files to merge')
      if (files.length > 50) throw new Error('Maximum 50 files per merge')

      files.forEach((f: any) => assertFile(f))

      // Write file list for ffmpeg concat demuxer
      const listContent = files.map((f: string) => `file '${resolve(f).replace(/'/g, "'\\''")}'`).join('\n')
      const listPath = resolve(args.output + '.filelist.txt')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(listPath, listContent)

      const cmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${args.output}"`
      const result = sh(cmd)

      const ok = existsSync(args.output)
      try { (await import('node:fs')).unlinkSync(listPath) } catch {}

      return { ok, fileCount: files.length, output: args.output, ...(ok ? {} : { error: result }) }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Merge ${args.files.split(',').length} files`, kind: 'write' as const }),
  }))

  // ---- av_transcode --------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'av_transcode',
    description:
      'Convert a media file to a different format, codec, or resolution. '
      + 'Supports common web formats (mp4/webm/mkv/avi/mov/flac/mp3/aac/ogg).',
    parameters: {
      file: { type: 'string', required: true, description: 'Source file path.' },
      output: { type: 'string', required: true, description: 'Output file path (extension determines format).' },
      videoCodec: { type: 'string', description: 'Video codec: libx264, libx265, libvpx-vp9, copy. Default: libx264.' },
      audioCodec: { type: 'string', description: 'Audio codec: aac, libmp3lame, libopus, copy. Default: aac.' },
      resolution: { type: 'string', description: 'Target resolution, e.g. 1920x1080 or 1280x720.' },
      crf: { type: 'integer', description: 'Quality (0-51, lower=better). Default: 23 (good quality).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          input: { type: 'string' },
          output: { type: 'string' },
          videoCodec: { type: 'string' },
          audioCodec: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ Transcoded: ${v.videoCodec}+${v.audioCodec}\n${v.output}`
          : `❌ Transcode failed`,
      }],
    },
    execute: async (args: any) => {
      const file = assertFile(args.file)
      const vCodec = args.videoCodec ?? 'libx264'
      const aCodec = args.audioCodec ?? 'aac'
      const crf = args.crf ?? 23

      const filters: string[] = []
      if (args.resolution) filters.push(`-vf scale=${args.resolution.replace('x', ':')}`)

      const cmd = [
        'ffmpeg', '-y', '-i', `"${file}"`,
        '-c:v', vCodec, '-c:a', aCodec,
        `-crf ${crf}`,
        ...filters,
        '-movflags', '+faststart',
        `"${args.output}"`,
      ].join(' ')

      const result = sh(cmd)
      const ok = existsSync(args.output)
      return {
        ok, input: file, output: args.output, videoCodec: vCodec, audioCodec: aCodec,
        ...(ok ? {} : { error: result }),
      }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Transcode: ${basename(String(args.file))}`, kind: 'write' as const }),
  }))

  // ---- av_extract_audio ----------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'av_extract_audio',
    description:
      'Extract the audio track from a video file and save as mp3, aac, wav, flac, or ogg.',
    parameters: {
      file: { type: 'string', required: true, description: 'Source video file.' },
      output: { type: 'string', required: true, description: 'Output audio file path.' },
      format: { type: 'string', enum: ['mp3', 'aac', 'wav', 'flac', 'ogg'], description: 'Audio format. Default: mp3.' },
      bitrate: { type: 'string', description: 'Audio bitrate, e.g. 192k, 320k. Default: 192k.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          input: { type: 'string' },
          output: { type: 'string' },
          format: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ Extracted ${v.format} audio → ${v.output}`
          : `❌ Audio extraction failed`,
      }],
    },
    execute: async (args: any) => {
      const file = assertFile(args.file)
      const fmt = args.format ?? 'mp3'
      const bitrate = args.bitrate ?? '192k'

      const codecMap: Record<string, string> = {
        mp3: 'libmp3lame', aac: 'aac', wav: 'pcm_s16le', flac: 'flac', ogg: 'libvorbis',
      }
      const codec = codecMap[fmt] ?? 'libmp3lame'

      const cmd = `ffmpeg -y -i "${file}" -vn -acodec ${codec} -ab ${bitrate} "${args.output}"`
      const result = sh(cmd)
      const ok = existsSync(args.output)
      return { ok, input: file, output: args.output, format: fmt, ...(ok ? {} : { error: result }) }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Extract audio: ${basename(String(args.file))}`, kind: 'write' as const }),
  }))

  // ---- av_extract_frames ---------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'av_extract_frames',
    description:
      'Export individual frames from a video as PNG or JPG images. '
      + 'Supports extracting every Nth frame or at a specific FPS.',
    parameters: {
      file: { type: 'string', required: true, description: 'Source video file.' },
      outputDir: { type: 'string', required: true, description: 'Directory to save frames.' },
      fps: { type: 'number', description: 'Frames per second to extract. Default: 1 (one frame/sec).' },
      format: { type: 'string', enum: ['png', 'jpg'], description: 'Image format. Default: png.' },
      maxFrames: { type: 'integer', description: 'Maximum number of frames to extract. Default: 100.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          frameCount: { type: 'integer' },
          outputDir: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ Extracted ${v.frameCount} frames → ${v.outputDir}`
          : `❌ Frame extraction failed`,
      }],
    },
    execute: async (args: any) => {
      const file = assertFile(args.file)
      const fps = args.fps ?? 1
      const fmt = args.format ?? 'png'
      const maxFrames = args.maxFrames ?? 100

      const outPattern = `${args.outputDir}/frame_%04d.${fmt}`
      const cmd = `ffmpeg -y -i "${file}" -vf "fps=${fps}" -frames:v ${maxFrames} "${outPattern}"`
      const result = sh(cmd, 300_000)

      const { readdirSync } = await import('node:fs')
      const frameCount = readdirSync(args.outputDir).filter((f: string) => f.endsWith(`.${fmt}`)).length

      return { ok: frameCount > 0, frameCount, outputDir: args.outputDir, ...(frameCount === 0 ? { error: result } : {}) }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Frames: ${basename(String(args.file))}`, kind: 'write' as const }),
  }))

  // ---- av_speed ------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'av_speed',
    description:
      'Change the playback speed of a video/audio file. Values > 1.0 speed up (timelapse), '
      + '< 1.0 slow down. Audio pitch is preserved.',
    parameters: {
      file: { type: 'string', required: true, description: 'Source file.' },
      output: { type: 'string', required: true, description: 'Output file.' },
      factor: { type: 'number', required: true, description: 'Speed factor. 2.0 = 2× faster, 0.5 = half speed.' },
      adjustAudio: { type: 'boolean', description: 'Also adjust audio speed. Default: true.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          factor: { type: 'number' },
          output: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ Speed ×${v.factor} → ${v.output}`
          : `❌ Speed change failed`,
      }],
    },
    execute: async (args: any) => {
      const file = assertFile(args.file)
      const factor = args.factor
      const adjustAudio = args.adjustAudio !== false

      const videoFilter = `setpts=${1/factor}*PTS`
      const audioFilter = adjustAudio ? `-af atempo=${factor}` : '-an'

      const cmd = `ffmpeg -y -i "${file}" -filter_complex "[0:v]${videoFilter}[v]" -map "[v]" ${audioFilter} -map 0:a? "${args.output}"`
      const result = sh(cmd)
      const ok = existsSync(args.output)
      return { ok, factor, output: args.output, ...(ok ? {} : { error: result }) }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Speed ×${args.factor}: ${basename(String(args.file))}`, kind: 'write' as const }),
  }))

  // ---- av_volume -----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'av_volume',
    description:
      'Adjust audio volume of a media file. Use dB (e.g. "-6dB" to reduce, "3dB" to boost) '
      + 'or a multiplier (e.g. "2" for double, "0.5" for half).',
    parameters: {
      file: { type: 'string', required: true, description: 'Source file (video or audio).' },
      output: { type: 'string', required: true, description: 'Output file.' },
      volume: { type: 'string', required: true, description: 'Volume change: dB string like "-6dB" or multiplier like "2.0".' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          volume: { type: 'string' },
          output: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ Volume ${v.volume} → ${v.output}`
          : `❌ Volume adjustment failed`,
      }],
    },
    execute: async (args: any) => {
      const file = assertFile(args.file)
      const vol = args.volume

      const cmd = `ffmpeg -y -i "${file}" -af volume=${vol} -c:v copy "${args.output}"`
      const result = sh(cmd)
      const ok = existsSync(args.output)
      return { ok, volume: vol, output: args.output, ...(ok ? {} : { error: result }) }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `Volume ${args.volume}: ${basename(String(args.file))}`, kind: 'write' as const }),
  }))

  // ---- av_to_gif -----------------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'av_to_gif',
    description:
      'Convert a video segment to an animated GIF. Optionally specify start time, duration, '
      + 'and output width to control file size.',
    parameters: {
      file: { type: 'string', required: true, description: 'Source video file.' },
      output: { type: 'string', required: true, description: 'Output GIF path.' },
      start: { type: 'string', description: 'Start time. Default: 0.' },
      duration: { type: 'string', description: 'Duration in seconds. Default: 5.' },
      width: { type: 'integer', description: 'Output width in pixels (height auto). Default: 480.' },
      fps: { type: 'number', description: 'GIF frame rate. Default: 15.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          output: { type: 'string' },
          sizeBytes: { type: 'integer' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text' as const,
        text: v.ok
          ? `✅ GIF created: ${(v.sizeBytes / 1024).toFixed(0)} KB → ${v.output}`
          : `❌ GIF conversion failed`,
      }],
    },
    execute: async (args: any) => {
      const file = assertFile(args.file)
      const start = args.start ?? '0'
      const duration = args.duration ?? '5'
      const width = args.width ?? 480
      const fps = args.fps ?? 15

      const palettePath = args.output + '.palette.png'
      const vf = `fps=${fps},scale=${width}:-1:flags=lanczos`

      // Two-pass for better quality
      sh(`ffmpeg -y -ss ${start} -t ${duration} -i "${file}" -vf "${vf},palettegen" "${palettePath}"`)
      const cmd = `ffmpeg -y -ss ${start} -t ${duration} -i "${file}" -i "${palettePath}" -lavfi "${vf} [x]; [x][1:v] paletteuse" "${args.output}"`
      const result = sh(cmd, 60_000)

      try { sh(`rm "${palettePath}"`) } catch {}
      const ok = existsSync(args.output)
      const sizeBytes = ok ? statSync(args.output).size : 0
      return { ok, output: args.output, sizeBytes, ...(ok ? {} : { error: result }) }
    },
    presentCall: (args: any) => ({ card: 'generic' as const, title: `GIF: ${basename(String(args.file))}`, kind: 'write' as const }),
  }))
}
