---
name: av-editor
version: 0.1.0
description: Audio/video editing using local FFmpeg (no API key needed)
triggers:
  - video editing
  - audio editing
  - trim video
  - cut video
  - merge videos
  - transcode
  - extract audio
  - video to gif
  - change speed
  - adjust volume
  - video info
---

# Audio/Video Editor Skill

Local FFmpeg-based media processing. Zero API keys required.

## Available Tools

### av_get_info
Get metadata about a media file.
```
av_get_info(file: "path/to/video.mp4")
```
Returns: duration, format, codecs, resolution, bitrate.

### av_trim
Cut a segment from video/audio.
```
av_trim(file: "input.mp4", output: "clip.mp4", start: "00:01:30", duration: "30")
```
- `start`: HH:MM:SS or seconds
- `duration` or `end`: how long to keep

### av_merge
Concatenate multiple files into one.
```
av_merge(files: "part1.mp4,part2.mp4,part3.mp4", output: "full.mp4")
```
- All files must have same codec types
- Supports 2-50 files

### av_transcode
Convert format, codec, or resolution.
```
av_transcode(file: "input.mov", output: "output.mp4", videoCodec: "libx265", resolution: "1920x1080")
```
- Common codecs: libx264, libx265, libvpx-vp9, aac, libmp3lame
- CRF 0-51 (lower = better quality)

### av_extract_audio
Extract audio from video.
```
av_extract_audio(file: "video.mp4", output: "audio.mp3", format: "mp3", bitrate: "320k")
```
- Formats: mp3, aac, wav, flac, ogg

### av_extract_frames
Export video frames as images.
```
av_extract_frames(file: "video.mp4", outputDir: "./frames", fps: 2, format: "png", maxFrames: 50)
```
- fps: frames per second to extract
- maxFrames: cap total output

### av_speed
Change playback speed.
```
av_speed(file: "video.mp4", output: "fast.mp4", factor: 2.0)
```
- factor > 1 = faster (timelapse)
- factor < 1 = slower (slow-mo)

### av_volume
Adjust audio volume.
```
av_volume(file: "video.mp4", output: "loud.mp4", volume: "3dB")
```
- dB: "-6dB" (quieter), "3dB" (louder)
- Multiplier: "2" (double), "0.5" (half)

### av_to_gif
Convert video to animated GIF.
```
av_to_gif(file: "video.mp4", output: "anim.gif", start: "5", duration: "3", width: 480)
```
- width: controls file size (smaller = less KB)
- fps: frame rate (default 15)

## Requirements

FFmpeg must be installed on the system:
- **Ubuntu CI**: `sudo apt-get install -y ffmpeg`
- **macOS**: `brew install ffmpeg`
- **Windows**: download from https://ffmpeg.org/download.html

## Typical Workflows

### Shorten a video for social media
1. `av_get_info` → check duration
2. `av_trim` → cut the best segment
3. `av_transcode` → resize to 1080p, output as mp4

### Extract highlight clip
1. `av_trim` → cut segment
2. `av_speed` → optional speed change
3. `av_volume` → adjust audio

### Prepare podcast from video
1. `av_extract_audio` → get mp3 track
2. `av_volume` → normalize levels
