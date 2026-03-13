# Developer Guide: Video Transitions

## Quick Start

The video transitions feature is integrated into the FinalCut application and works seamlessly with the existing AI chat interface.

## How It Works

### 1. User Interaction
Users can request transitions using natural language in the chat:
```
"Add a crossfade transition between these two clips"
"Create a fade between my videos"
"Add a slide transition from left to right"
```

### 2. AI Processing
The xAI Grok API interprets the request and calls the `add_video_transition` tool with appropriate parameters:
```javascript
{
  "videos": [videoData1, videoData2],
  "transition": "crossfade",
  "duration": 2
}
```

### 3. Server Processing
The request is sent to `/api/transition-videos` endpoint which:
1. Receives multiple video files
2. Applies FFmpeg filtergraph for transitions
3. Returns the processed video with transitions applied

### 4. Result Display
The processed video is displayed in the chat interface and becomes the new working video for subsequent edits.

## Code Flow

```
User prompt → xAI Grok API → toolFunctions.add_video_transition() → 
  → /api/transition-videos endpoint → FFmpeg processing → 
    → Processed video returned → UI updates
```

## Integration Points

### 1. Tool Definition (tools.js)
```javascript
{
  type: 'function',
  function: {
    name: 'add_video_transition',
    description: 'Add professional transitions between multiple video clips...',
    parameters: {
      videos: [...],
      transition: 'crossfade|fade|dissolve|wipe_left|...',
      duration: 1
    }
  }
}
```

### 2. Client Function (toolFunctions.js)
```javascript
add_video_transition: async (args, videoFileData, setVideoFileData, addMessage) => {
  // Validate inputs
  // Create FormData with multiple videos
  // Call server endpoint
  // Update UI with result
}
```

### 3. Server Endpoint (server.js)
```javascript
app.post('/api/transition-videos', upload.array('videos', 10), async (req, res) => {
  // Process multiple video files
  // Build FFmpeg filtergraph
  // Apply transitions
  // Return processed video
}
```

## Current Limitations

### Video Duration Detection
The current implementation uses a simplified concat approach. For true crossfade/xfade transitions with proper overlap, we need to:

1. Get video durations via ffprobe:
```javascript
ffmpeg.ffprobe(inputPath, (err, metadata) => {
  const duration = metadata.format.duration;
  // Use duration to calculate xfade offset
});
```

2. Build xfade filter with correct offsets:
```javascript
// For two videos with durations d1 and d2
const offset = d1 - transitionDuration;
filterComplex = `[0:v][1:v]xfade=transition=fade:duration=${duration}:offset=${offset}[v]`;
```

### Why Not Implemented Yet
- Requires asynchronous duration detection for each video
- More complex error handling
- Increased processing time
- Current concat approach is simpler and more reliable for MVP

## Testing

### Unit Tests
Tests are in `src/test/transitions.test.js`:
```bash
npm test -- src/test/transitions.test.js
```

### Manual Testing
To manually test transitions:

1. Start the server:
```bash
npm run server
```

2. In another terminal, start the dev server:
```bash
npm run dev
```

3. Upload multiple video files (or use sample videos)

4. Use AI prompts to request transitions:
   - "Add a crossfade between clips"
   - "Create a fade transition"
   - etc.

## Future Enhancements

### Phase 2: True xfade Transitions
- Implement duration detection via ffprobe
- Build xfade filters with proper offsets
- Support different transitions per junction

### Phase 3: Advanced Features
- Preview transitions before applying
- Custom transition curves (ease-in, ease-out)
- 3D transition effects
- Transition templates

### Phase 4: UI Improvements
- Visual timeline editor
- Drag-and-drop video ordering
- Real-time preview of transitions
- Adjustable transition points

## API Reference

### POST /api/transition-videos

**Request**:
- Content-Type: `multipart/form-data`
- Body:
  - `videos`: Array of video files (2-10 files)
  - `transition`: String (transition type)
  - `duration`: Number (seconds, default: 1)

**Response**:
- Content-Type: `video/mp4`
- Body: Processed video binary data

**Error Response**:
```json
{
  "error": "Error message"
}
```

## Debugging

### Enable FFmpeg Logging
Uncomment logging in server.js:
```javascript
command
  .on('start', (cmd) => console.log('FFmpeg command:', cmd))
  .on('progress', (progress) => console.log('Processing:', progress))
  .on('end', () => console.log('Processing finished'))
  .on('error', (err) => console.error('Error:', err))
```

### Common Issues

1. **Videos not concatenating properly**
   - Check video codecs are compatible
   - Ensure all videos have same resolution
   - Verify audio streams exist

2. **Transitions not visible**
   - Check transition duration vs video length
   - Verify filtergraph syntax
   - Test with longer videos

3. **Out of memory errors**
   - Reduce video file sizes
   - Limit number of clips
   - Increase Node.js memory limit

## Contributing

To add new transition types:

1. Add transition to `buildWipeFilter()` or create new builder function
2. Add case in `/api/transition-videos` endpoint
3. Update tool definition in `tools.js`
4. Add tests in `transitions.test.js`
5. Update documentation
