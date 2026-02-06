# Video Transitions Feature

## Overview

The FinalCut video editor now supports professional transitions between multiple video clips. This feature enables smooth scene transitions in vlogs, professional-looking montages, and educational content with multiple segments.

## Supported Transitions

### 1. Crossfade
Smooth blend between clips with gradual opacity transition.
```
"Add a crossfade transition between these two clips"
"Create a smooth crossfade lasting 2 seconds"
```

### 2. Fade
Fade to black between clips for a classic transition effect.
```
"Add a fade transition between clips"
"Fade between these segments"
```

### 3. Dissolve
Gradual dissolve effect creating a smooth blend.
```
"Dissolve from clip 1 to clip 2"
"Add a dissolve transition"
```

### 4. Wipe Transitions
Directional wipe transitions that reveal the next clip.

- **Wipe Left**: Next clip wipes in from left to right
- **Wipe Right**: Next clip wipes in from right to left  
- **Wipe Up**: Next clip wipes in from bottom to top
- **Wipe Down**: Next clip wipes in from top to bottom

```
"Add a wipe left transition"
"Wipe from right to left between clips"
```

### 5. Slide Transitions
Similar to wipe but with a sliding motion effect.

- **Slide Left**: Clips slide from right to left
- **Slide Right**: Clips slide from left to right
- **Slide Up**: Clips slide from bottom to top
- **Slide Down**: Clips slide from top to bottom

```
"Add a slide transition from left to right"
"Slide the next clip in from the bottom"
```

## Technical Details

### Implementation

The transition feature uses FFmpeg's complex filtergraph capabilities to:
1. Accept multiple video files as input
2. Apply the specified transition effect between clips
3. Combine audio tracks smoothly
4. Output a single video with all transitions applied

### API Endpoint

**Endpoint**: `POST /api/transition-videos`

**Parameters**:
- `videos`: Array of video files (minimum 2 required)
- `transition`: Transition type (crossfade, fade, dissolve, wipe_left, wipe_right, wipe_up, wipe_down, slide_left, slide_right, slide_up, slide_down)
- `duration`: Transition duration in seconds (default: 1)

**Example Request**:
```javascript
const formData = new FormData();
formData.append('videos', videoFile1, 'clip1.mp4');
formData.append('videos', videoFile2, 'clip2.mp4');
formData.append('transition', 'crossfade');
formData.append('duration', 2);

const response = await fetch('/api/transition-videos', {
  method: 'POST',
  body: formData
});

const processedVideo = await response.arrayBuffer();
```

### Client-Side Function

The `add_video_transition` function in `toolFunctions.js` provides a client-side interface:

```javascript
await toolFunctions.add_video_transition(
  {
    videos: [videoData1, videoData2, videoData3],
    transition: 'crossfade',
    duration: 2
  },
  currentVideoData,
  setVideoFileData,
  addMessage
);
```

## AI Integration

The transition feature is integrated with the xAI Grok API through the tool definitions in `tools.js`. Users can request transitions using natural language:

### Example Prompts

1. **Basic Transition**:
   - "Add a fade transition between these two clips"
   - "Create a crossfade between the videos"

2. **Specific Duration**:
   - "Add a 2-second crossfade transition"
   - "Create a smooth fade lasting 3 seconds"

3. **Directional Transitions**:
   - "Add a slide transition from left to right"
   - "Wipe from the bottom to reveal the next clip"

4. **Multiple Clips**:
   - "Add crossfade transitions between all my clips"
   - "Create a montage with fade transitions"

## Use Cases

### 1. Vlogs
Create smooth transitions between different scenes or locations in your vlog.

### 2. Montages
Build professional-looking montages with crossfade or dissolve transitions.

### 3. Educational Content
Transition smoothly between different topics or segments in educational videos.

### 4. Marketing Videos
Create dynamic product showcases with slide or wipe transitions.

### 5. Social Media Content
Produce engaging content for Instagram Reels, TikTok, or YouTube Shorts with quick transitions.

## Limitations

1. **File Size**: Each video file is limited to 100MB
2. **Number of Clips**: Maximum of 10 clips can be processed in a single transition operation
3. **Format**: All input videos should be in MP4 format for best compatibility
4. **Duration**: Transition durations are applied uniformly between all clips
5. **Current Implementation**: The current version uses FFmpeg's `concat` filter for combining clips with basic fade effects. For true crossfade/xfade transitions with overlap, video durations need to be detected first via ffprobe, which will be added in a future version.

## Audio Handling

The transition system intelligently handles videos with and without audio streams:

- **All videos have audio**: Audio streams are concatenated along with video
- **No videos have audio**: Only video streams are concatenated (no audio output)
- **Mixed (some have audio, some don't)**: Silent audio tracks are automatically added to videos without audio before concatenation, ensuring smooth audio transitions

This ensures that transitions work correctly even when combining videos from different sources that may or may not have audio tracks.

## Technical Notes

The current implementation uses a simplified approach for transitions:
- **Concat-based**: Videos are concatenated using FFmpeg's concat filter
- **Fade effects**: Fade in/out effects are applied at clip boundaries
- **Audio mixing**: Audio tracks are concatenated smoothly with automatic silent audio generation when needed
- **Audio stream detection**: Uses ffprobe to detect which videos have audio streams before building the filter graph

Future versions will support:
- True xfade transitions with proper video overlap
- Dynamic offset calculation based on video durations
- Custom transition timing for each clip junction

## Future Enhancements

Potential improvements for future versions:
- Custom transition timing for each clip junction
- More advanced transition effects (zoom, rotate, 3D effects)
- Preview functionality before final rendering
- Support for different transition durations between different clips
- Real-time preview of transitions
