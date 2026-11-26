// The H.264 settings every re-encoding browser op uses. Edits chain (each edit's output is the
// next one's input), so loss compounds: on a 1080p clip crf 23 measured ~40 dB Y-PSNR per edit
// and ~35 dB after five, crf 18 ~44 dB and ~38 dB, at about the same veryfast encode time.
// yuv420p keeps 8-bit High profile, the H.264 every phone and browser plays.
export const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'];
