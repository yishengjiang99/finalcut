# Video Dimensions Tool - Usage Example

## Overview

The `get_video_dimensions` tool allows you to retrieve metadata about an uploaded video, including:
- Resolution (width x height)
- Duration
- Video codec
- Frame rate
- Bitrate
- File size

## How to Use

### 1. Upload a video
Upload any video file through the web interface.

### 2. Ask for dimensions
After uploading, you can ask the AI assistant questions like:
- "What are the dimensions of this video?"
- "Tell me about this video's properties"
- "What's the resolution and duration?"
- "Give me the video metadata"

### 3. The AI will call the tool
The AI assistant will automatically call the `get_video_dimensions` tool, which will:
1. Load the video into FFmpeg
2. Extract metadata from FFmpeg logs
3. Parse and format the information
4. Send the results back to the AI
5. The AI will present the information to you in a readable format

## Example Output

```
Video Information:
Resolution: 1920x1080
Video Codec: h264
Duration: 00:01:30.50
Frame Rate: 30 fps
Bitrate: 5000 kb/s
File Size: 15.42 MB
```

## Technical Details

The tool works by:
1. Writing the video file to FFmpeg's virtual filesystem
2. Running FFmpeg with the `-i` flag to probe the video
3. Capturing FFmpeg's log output which contains metadata
4. Parsing the logs using regular expressions to extract:
   - Video stream information (codec, dimensions)
   - Duration
   - Frame rate
   - Bitrate
5. Formatting and returning the results

## Integration with LLM

The tool is automatically available to the LLM (Grok) through the function calling interface. When a user asks about video properties, the LLM will:
1. Recognize the request relates to video metadata
2. Call the `get_video_dimensions` function
3. Receive the structured output
4. Present the information to the user in natural language

This enables conversational queries like:
- "How long is this video?" → AI calls tool → "The video is 1 minute and 30 seconds long"
- "What's the resolution?" → AI calls tool → "The video is 1920x1080 (Full HD)"
- "Is this 4K?" → AI calls tool and analyzes → "No, this is Full HD (1080p), not 4K"
