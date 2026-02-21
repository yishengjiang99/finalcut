import { describe, it, expect } from 'vitest';
import { tools, systemPrompt } from '../tools.js';

describe('Tools Module', () => {
  it('exports systemPrompt', () => {
    expect(systemPrompt).toBeDefined();
    expect(typeof systemPrompt).toBe('string');
    expect(systemPrompt.length).toBeGreaterThan(0);
  });

  it('exports tools array', () => {
    expect(tools).toBeDefined();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('has resize_video tool', () => {
    const resizeTool = tools.find(t => t.function.name === 'resize_video');
    expect(resizeTool).toBeDefined();
    expect(resizeTool.function.parameters.required).toContain('width');
    expect(resizeTool.function.parameters.required).toContain('height');
  });

  it('has crop_video tool', () => {
    const cropTool = tools.find(t => t.function.name === 'crop_video');
    expect(cropTool).toBeDefined();
    expect(cropTool.function.parameters.required).toContain('x');
    expect(cropTool.function.parameters.required).toContain('y');
    expect(cropTool.function.parameters.required).toContain('width');
    expect(cropTool.function.parameters.required).toContain('height');
  });

  it('has rotate_video tool', () => {
    const rotateTool = tools.find(t => t.function.name === 'rotate_video');
    expect(rotateTool).toBeDefined();
    expect(rotateTool.function.parameters.required).toContain('angle');
  });

  it('has add_text tool', () => {
    const textTool = tools.find(t => t.function.name === 'add_text');
    expect(textTool).toBeDefined();
    expect(textTool.function.parameters.required).toContain('text');
  });

  it('has trim_video tool', () => {
    const trimTool = tools.find(t => t.function.name === 'trim_video');
    expect(trimTool).toBeDefined();
    expect(trimTool.function.parameters.required).toContain('start');
    expect(trimTool.function.parameters.required).toContain('end');
  });

  it('has adjust_speed tool', () => {
    const speedTool = tools.find(t => t.function.name === 'adjust_speed');
    expect(speedTool).toBeDefined();
    expect(speedTool.function.parameters.required).toContain('speed');
  });

  it('has adjust_audio_volume tool', () => {
    const volumeTool = tools.find(t => t.function.name === 'adjust_audio_volume');
    expect(volumeTool).toBeDefined();
    expect(volumeTool.function.parameters.required).toContain('volume');
  });

  it('has audio_fade tool', () => {
    const fadeTool = tools.find(t => t.function.name === 'audio_fade');
    expect(fadeTool).toBeDefined();
    expect(fadeTool.function.parameters.required).toContain('type');
    expect(fadeTool.function.parameters.required).toContain('duration');
  });

  it('has audio_highpass tool', () => {
    const highpassTool = tools.find(t => t.function.name === 'audio_highpass');
    expect(highpassTool).toBeDefined();
    expect(highpassTool.function.parameters.required).toContain('frequency');
  });

  it('has audio_lowpass tool', () => {
    const lowpassTool = tools.find(t => t.function.name === 'audio_lowpass');
    expect(lowpassTool).toBeDefined();
    expect(lowpassTool.function.parameters.required).toContain('frequency');
  });

  it('has audio_echo tool', () => {
    const echoTool = tools.find(t => t.function.name === 'audio_echo');
    expect(echoTool).toBeDefined();
    expect(echoTool.function.parameters.required).toContain('delay');
    expect(echoTool.function.parameters.required).toContain('decay');
  });

  it('has adjust_bass tool', () => {
    const bassTool = tools.find(t => t.function.name === 'adjust_bass');
    expect(bassTool).toBeDefined();
    expect(bassTool.function.parameters.required).toContain('gain');
  });

  it('has adjust_treble tool', () => {
    const trebleTool = tools.find(t => t.function.name === 'adjust_treble');
    expect(trebleTool).toBeDefined();
    expect(trebleTool.function.parameters.required).toContain('gain');
  });

  it('has audio_equalizer tool', () => {
    const equalizerTool = tools.find(t => t.function.name === 'audio_equalizer');
    expect(equalizerTool).toBeDefined();
    expect(equalizerTool.function.parameters.required).toContain('frequency');
    expect(equalizerTool.function.parameters.required).toContain('gain');
  });

  it('has normalize_audio tool', () => {
    const normalizeTool = tools.find(t => t.function.name === 'normalize_audio');
    expect(normalizeTool).toBeDefined();
    expect(normalizeTool.function.parameters.required).toContain('target');
  });

  it('has audio_delay tool', () => {
    const delayTool = tools.find(t => t.function.name === 'audio_delay');
    expect(delayTool).toBeDefined();
    expect(delayTool.function.parameters.required).toContain('delay');
  });

  it('has audio_chorus tool', () => {
    const chorusTool = tools.find(t => t.function.name === 'audio_chorus');
    expect(chorusTool).toBeDefined();
    expect(chorusTool.function.description).toContain('chorus');
  });

  it('has audio_flanger tool', () => {
    const flangerTool = tools.find(t => t.function.name === 'audio_flanger');
    expect(flangerTool).toBeDefined();
    expect(flangerTool.function.description).toContain('flanger');
  });

  it('has audio_phaser tool', () => {
    const phaserTool = tools.find(t => t.function.name === 'audio_phaser');
    expect(phaserTool).toBeDefined();
    expect(phaserTool.function.description).toContain('phaser');
  });

  it('has audio_vibrato tool', () => {
    const vibratoTool = tools.find(t => t.function.name === 'audio_vibrato');
    expect(vibratoTool).toBeDefined();
    expect(vibratoTool.function.description).toContain('vibrato');
  });

  it('has audio_tremolo tool', () => {
    const tremoloTool = tools.find(t => t.function.name === 'audio_tremolo');
    expect(tremoloTool).toBeDefined();
    expect(tremoloTool.function.description).toContain('tremolo');
  });

  it('has audio_compressor tool', () => {
    const compressorTool = tools.find(t => t.function.name === 'audio_compressor');
    expect(compressorTool).toBeDefined();
    expect(compressorTool.function.description).toContain('compression');
  });

  it('has audio_gate tool', () => {
    const gateTool = tools.find(t => t.function.name === 'audio_gate');
    expect(gateTool).toBeDefined();
    expect(gateTool.function.description).toContain('gate');
  });

  it('has audio_stereo_widen tool', () => {
    const stereoTool = tools.find(t => t.function.name === 'audio_stereo_widen');
    expect(stereoTool).toBeDefined();
    expect(stereoTool.function.description).toContain('stereo');
  });

  it('has audio_reverse tool', () => {
    const reverseTool = tools.find(t => t.function.name === 'audio_reverse');
    expect(reverseTool).toBeDefined();
    expect(reverseTool.function.description.toLowerCase()).toContain('reverse');
  });

  it('has audio_limiter tool', () => {
    const limiterTool = tools.find(t => t.function.name === 'audio_limiter');
    expect(limiterTool).toBeDefined();
    expect(limiterTool.function.description).toContain('limiter');
  });

  it('has audio_silence_remove tool', () => {
    const silenceTool = tools.find(t => t.function.name === 'audio_silence_remove');
    expect(silenceTool).toBeDefined();
    expect(silenceTool.function.description).toContain('silence');
  });

  it('has audio_pan tool', () => {
    const panTool = tools.find(t => t.function.name === 'audio_pan');
    expect(panTool).toBeDefined();
    expect(panTool.function.parameters.required).toContain('pan');
    expect(panTool.function.description.toLowerCase()).toContain('pan');
  });

  it('has resize_video_preset tool', () => {
    const presetTool = tools.find(t => t.function.name === 'resize_video_preset');
    expect(presetTool).toBeDefined();
    expect(presetTool.function.parameters.required).toContain('preset');
    expect(presetTool.function.parameters.properties.preset.enum).toEqual([
      '9:16', '16:9', '1:1', '2:3', '3:2'
    ]);
  });

  it('has adjust_brightness tool', () => {
    const brightnessTool = tools.find(t => t.function.name === 'adjust_brightness');
    expect(brightnessTool).toBeDefined();
    expect(brightnessTool.function.parameters.required).toContain('brightness');
    expect(brightnessTool.function.description).toContain('brightness');
  });

  it('has adjust_hue tool', () => {
    const hueTool = tools.find(t => t.function.name === 'adjust_hue');
    expect(hueTool).toBeDefined();
    expect(hueTool.function.parameters.required).toContain('degrees');
    expect(hueTool.function.description).toContain('hue');
  });

  it('has adjust_saturation tool', () => {
    const saturationTool = tools.find(t => t.function.name === 'adjust_saturation');
    expect(saturationTool).toBeDefined();
    expect(saturationTool.function.parameters.required).toContain('saturation');
    expect(saturationTool.function.description).toContain('saturation');
  });

  it('has get_video_dimensions tool', () => {
    const dimensionsTool = tools.find(t => t.function.name === 'get_video_dimensions');
    expect(dimensionsTool).toBeDefined();
    expect(dimensionsTool.function.description).toContain('dimensions');
    expect(dimensionsTool.function.parameters.required).toEqual([]);
  });

  it('has get_supported_formats tool', () => {
    const formatsTool = tools.find(t => t.function.name === 'get_supported_formats');
    expect(formatsTool).toBeDefined();
    expect(formatsTool.function.description.toLowerCase()).toContain('format');
    expect(formatsTool.function.parameters.required).toEqual([]);
  });

  it('has convert_video_format tool', () => {
    const convertVideoTool = tools.find(t => t.function.name === 'convert_video_format');
    expect(convertVideoTool).toBeDefined();
    expect(convertVideoTool.function.parameters.required).toContain('format');
    expect(convertVideoTool.function.parameters.properties.format.enum).toEqual([
      'mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'
    ]);
    expect(convertVideoTool.function.description).toContain('Convert video');
  });

  it('has convert_audio_format tool', () => {
    const convertAudioTool = tools.find(t => t.function.name === 'convert_audio_format');
    expect(convertAudioTool).toBeDefined();
    expect(convertAudioTool.function.parameters.required).toContain('format');
    expect(convertAudioTool.function.parameters.properties.format.enum).toEqual([
      'mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'
    ]);
    expect(convertAudioTool.function.description).toContain('Convert audio');
  });

  it('has extract_audio tool', () => {
    const extractAudioTool = tools.find(t => t.function.name === 'extract_audio');
    expect(extractAudioTool).toBeDefined();
    expect(extractAudioTool.function.parameters.properties.format).toBeDefined();
    expect(extractAudioTool.function.parameters.properties.format.enum).toEqual([
      'mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'
    ]);
    expect(extractAudioTool.function.description).toContain('Extract audio');
  });

  it('has generate_captions tool', () => {
    const captionsTool = tools.find(t => t.function.name === 'generate_captions');
    expect(captionsTool).toBeDefined();
    expect(captionsTool.function.description).toContain('subtitles');
    expect(captionsTool.function.parameters.required).toEqual([]);
    expect(captionsTool.function.parameters.properties.language).toBeDefined();
    expect(captionsTool.function.parameters.properties.translate_language).toBeDefined();
    expect(captionsTool.function.parameters.properties.style.enum).toEqual(['default', 'white_on_black', 'yellow']);
    expect(captionsTool.function.parameters.properties.position.enum).toEqual(['bottom', 'top']);
    expect(captionsTool.function.parameters.properties.burn_in).toBeDefined();
  });

  it('all tools have proper structure', () => {
    tools.forEach(tool => {
      expect(tool.type).toBe('function');
      expect(tool.function.name).toBeDefined();
      expect(tool.function.description).toBeDefined();
      expect(tool.function.parameters).toBeDefined();
      expect(tool.function.parameters.type).toBe('object');
      expect(tool.function.parameters.properties).toBeDefined();
      expect(tool.function.parameters.required).toBeDefined();
    });
  });
});
