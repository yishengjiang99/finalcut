#!/usr/bin/env python3
"""Regenerates the data-driven tables in docs/ios/ON_DEVICE_TOOLS.md from the simulator dumps.

    python3 docs/ios/data/render_catalog.py

Rewrites the text between <!-- BEGIN GENERATED:<name> --> and <!-- END GENERATED:<name> -->.
Ranges, defaults and min iOS come from cifilters-ios26.5.json (newest dump) and are checked
against cifilters-ios17.5.json. Cost classes and notes are engineering estimates, not measurements.
"""
import json
import math
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DOC = os.path.join(HERE, '..', 'ON_DEVICE_TOOLS.md')
NEW = json.load(open(os.path.join(HERE, 'cifilters-ios26.5.json')))
OLD = json.load(open(os.path.join(HERE, 'cifilters-ios17.5.json')))
F = NEW['filters']

# Primary section per filter (first match wins) so each filter is listed once.
SECTIONS = [
    ('Transition', 'Transitions (need two clips; single clip = fade via the existing CI chain)'),
    ('Generator', 'Generators (no input image: overlays, patterns, codes)'),
    ('Gradient', 'Gradients (no input image except the mask-distance ones)'),
    ('CompositeOperation', 'Compositing and blend modes (need a second image)'),
    ('Reduction', 'Reductions (analysis: output is a 1xN or 1x1 statistics image, not a picture)'),
    ('ColorAdjustment', 'Color adjustment'),
    ('ColorEffect', 'Color effects'),
    ('Blur', 'Blur'),
    ('Sharpen', 'Sharpen'),
    ('Halftone', 'Halftone'),
    ('Tile', 'Tile and kaleidoscope'),
    ('DistortionEffect', 'Distortion'),
    ('Geometry', 'Geometry'),
    ('Stylize', 'Stylize'),
]

HEAVY = {
    'CIBokehBlur', 'CIDepthBlurEffect', 'CIMaskedVariableBlur', 'CIKMeans', 'CICoreMLModelFilter',
    'CIPersonSegmentation', 'CISaliencyMapFilter', 'CIDocumentEnhancer', 'CIDroste', 'CIGlassDistortion',
    'CIDepthOfField', 'CIPaletteCentroid', 'CIPalettize', 'CIEdgePreserveUpsampleFilter',
}
MEDIUM = {
    'CIGaussianBlur', 'CIBoxBlur', 'CIDiscBlur', 'CIMotionBlur', 'CIZoomBlur', 'CINoiseReduction',
    'CIMedianFilter', 'CIMorphologyGradient', 'CIMorphologyMaximum', 'CIMorphologyMinimum',
    'CIMorphologyRectangleMaximum', 'CIMorphologyRectangleMinimum', 'CISharpenLuminance', 'CIUnsharpMask',
    'CIBloom', 'CIGloom', 'CIHighlightShadowAdjust', 'CIComicEffect', 'CICrystallize', 'CIPointillize',
    'CIEdgeWork', 'CILineOverlay', 'CIConvolution7X7', 'CIConvolutionRGB7X7', 'CIConvolution9Horizontal',
    'CIConvolution9Vertical', 'CIConvolutionRGB9Horizontal', 'CIConvolutionRGB9Vertical', 'CIGaborGradients',
    'CICannyEdgeDetector', 'CIColorThresholdOtsu', 'CIHistogramDisplayFilter', 'CIAreaHistogram',
    'CIAreaLogarithmicHistogram', 'CIAreaAlphaWeightedHistogram', 'CILabDeltaE', 'CIGuidedFilter',
    'CITorusLensDistortion', 'CIGlassLozenge', 'CIShadedMaterial', 'CIHeightFieldFromMask',
    'CILenticularHaloGenerator', 'CISunbeamsGenerator', 'CIDisintegrateWithMaskTransition',
    'CIPageCurlTransition', 'CIPageCurlWithShadowTransition', 'CIRippleTransition', 'CICopyMachineTransition',
    'CISpotColor', 'CICameraCalibrationLensCorrection', 'CIDistanceGradientFromRedMask',
    'CISignedDistanceGradientFromRedMask', 'CIDither', 'CIAttributedTextImageGenerator', 'CITextImageGenerator',
    'CIMeshGenerator',
}
NOTES = {
    'CIRandomGenerator': 'static noise: offset it per frame for animated grain',
    'CIPersonSegmentation': 'ML mask (low res); prefer Vision + temporal smoothing (see Vision)',
    'CISaliencyMapFilter': 'ML saliency heat map',
    'CIDepthBlurEffect': 'needs depth/disparity (Portrait photos only)',
    'CIDepthOfField': 'fake tilt-shift from two points; several blurs',
    'CIDepthToDisparity': 'depth data only', 'CIDisparityToDepth': 'depth data only',
    'CICameraCalibrationLensCorrection': 'needs AVCameraCalibrationData (capture-time only)',
    'CICoreMLModelFilter': 'needs a bundled Core ML model',
    'CIDocumentEnhancer': 'document scans; not flagged video',
    'CIAttributedTextImageGenerator': 'text overlay; the app uses Core Text instead',
    'CITextImageGenerator': 'text overlay; the app uses Core Text instead',
    'CIToneMapHeadroom': 'HDR to SDR headroom mapping', 'CISystemToneMap': 'HDR tone map (system curve)',
    'CIKMeans': 'palette extraction (analysis)', 'CIPalettize': 'needs a palette image (e.g. from CIKMeans)',
    'CIColorCube': 'LUT (see LUTs)', 'CIColorCubeWithColorSpace': 'LUT (see LUTs)',
    'CIColorCubesMixedWithMask': 'two LUTs mixed by a mask (see LUTs)',
    'CIColorMatrix': 'channel math (see Channel math)', 'CIColorPolynomial': 'channel math',
    'CIColorCrossPolynomial': 'channel math',
    'CILineOverlay': 'output is black lines on transparent: composite over white or the frame',
    'CIMaskedVariableBlur': 'blur amount from a mask (tilt-shift, background blur)',
    'CIHoleDistortion': 'leaves transparent hole', 'CICircularWrap': 'output has transparent area',
    'CIDroste': 'very expensive at 1080p',
    'CIStraightenFilter': 'rotate + crop to fill (horizon fix)',
    'CIPerspectiveCorrection': 'needs 4 corner points (e.g. from VNDetectRectanglesRequest)',
    'CIKeystoneCorrectionCombined': 'needs corner/focal data', 'CIKeystoneCorrectionHorizontal': 'needs corner data',
    'CIKeystoneCorrectionVertical': 'needs corner data',
    'CIVignetteEffect': 'radius in px: scale with frame', 'CIMix': 'blend two images by amount',
}
for n in F:
    if n.startswith('CIConvolution'):
        NOTES.setdefault(n, 'custom kernel weights')
    if n.startswith('CIMorphology'):
        NOTES.setdefault(n, 'dilate/erode; cost grows with radius')
BLURS = {'CIGaussianBlur', 'CIBoxBlur', 'CIDiscBlur', 'CIMotionBlur', 'CIZoomBlur', 'CIBokehBlur', 'CIBloom',
         'CIGloom', 'CINoiseReduction', 'CIMedianFilter', 'CIUnsharpMask', 'CISharpenLuminance'}


def fnum(x):
    if isinstance(x, bool):
        return 'true' if x else 'false'
    if isinstance(x, (int, float)):
        if isinstance(x, float) and abs(x) > 1e30:
            return '∞' if x > 0 else '-∞'
        for k, name in ((math.pi, 'π'), (math.pi / 2, 'π/2'), (2 * math.pi, '2π'), (4 * math.pi, '4π')):
            if abs(abs(x) - k) < 1e-9:
                return ('-' if x < 0 else '') + name
        s = f'{x:.4g}'
        return s
    return str(x)


def fval(v):
    if v is None:
        return 'nil'
    if isinstance(v, dict):
        k = next(iter(v))
        if k in ('CIVector', 'CIColor'):
            return ('(' if k == 'CIVector' else 'rgba(') + ','.join(fnum(x) for x in v[k]) + ')'
        if k == 'NSData':
            return f'{v[k]} B data'
        return k
    return fnum(v)


def params(f):
    out = []
    for i in f['inputs']:
        k = i['key']
        if k == 'inputImage':
            continue
        cls = i.get('class', '')
        if cls == 'CIImage':
            out.append(f'`{k}` (image)')
            continue
        s = f'`{k}`'
        if 'default' in i:
            s += '=' + fval(i['default'])
        lo, hi = i.get('min'), i.get('max')
        if lo is not None or hi is not None:
            s += f' [{fval(lo) if lo is not None else ""}…{fval(hi) if hi is not None else ""}]'
        slo, shi = i.get('sliderMin'), i.get('sliderMax')
        if slo is not None or shi is not None:
            s += f' {{{fval(slo)}…{fval(shi)}}}'
        if cls not in ('NSNumber', 'CIVector', 'CIColor') and cls:
            s += f' ({cls})'
        out.append(s)
    return '; '.join(out) or '–'


def has_input_image(f):
    return any(i['key'] == 'inputImage' for i in f['inputs'])


def extra_images(f):
    return [i['key'] for i in f['inputs'] if i.get('class') == 'CIImage' and i['key'] != 'inputImage']


def media(name, f, section):
    cats = f['categories'] or []
    video = 'CICategoryVideo' in cats
    if section == 'Transition':
        return 'multi-clip'
    if section in ('Generator', 'Gradient') and not has_input_image(f):
        return 'overlay src' + ('' if video else ' (photo)')
    if section == 'CompositeOperation':
        return '2nd image'
    if section == 'Reduction':
        return 'analysis'
    if extra_images(f):
        return 'needs ' + ', '.join(x.replace('input', '').lower() for x in extra_images(f)) + ('' if video else ' (photo)')
    return 'both' if video else 'photo'


def cost(name, section):
    if name in HEAVY:
        return 'heavy'
    if name in MEDIUM:
        return 'medium'
    return 'cheap'


def min_ios(name, f):
    a = f.get('availableIOS')
    s = {'18': '18', '19': '26'}.get(str(a), str(a))
    if name not in OLD['filters']:
        s += ' (not in 17.5)'
    return s


def desc(f):
    d = f.get('localizedDescription') or ''
    d = d.strip().split('. ')[0].rstrip('.')
    return d.replace('|', '/')


def catalog():
    seen = set()
    lines = []
    for cat, title in SECTIONS:
        names = [n for n in NEW['categories'][cat] if n not in seen]
        seen.update(names)
        lines.append(f'### {title} ({len(names)})\n')
        lines.append('| Filter | Display name | What it does (Apple text, first sentence) | Parameters: `key`=default [min…max] {slider} | Media | Min iOS | Cost | Notes |')
        lines.append('|---|---|---|---|---|---|---|---|')
        for n in names:
            f = F[n]
            note = NOTES.get(n, '')
            if n in BLURS:
                note = (note + '; ' if note else '') + 'clampedToExtent() then crop; cost grows with radius'
            lines.append(f"| `{n}` | {f['displayName']} | {desc(f)} | {params(f)} | {media(n, f, cat)} | {min_ios(n, f)} | {cost(n, cat)} | {note} |")
        lines.append('')
    return '\n'.join(lines)


def diff():
    added = sorted(set(F) - set(OLD['filters']))
    lines = [f'- **iOS 17.5:** {OLD["filterCount"]} filters. **iOS 26.5:** {NEW["filterCount"]} filters. None removed.',
             '- Added after 17.5 (`CIAttributeFilterAvailable_iOS`; Core Image reports iOS 26 as "19"): ' +
             ', '.join(f'`{n}` ({min_ios(n, F[n]).split(" ")[0]})' for n in added) + '.']
    changes = []
    for n in sorted(set(F) & set(OLD['filters'])):
        a = {i['key']: i for i in OLD['filters'][n]['inputs']}
        b = {i['key']: i for i in F[n]['inputs']}
        if set(a) != set(b):
            changes.append(f'`{n}` gained {", ".join("`%s`" % k for k in sorted(set(b) - set(a)))}')
        for k in sorted(set(a) & set(b)):
            if k == 'inputExtent':
                continue
            for x in ('min', 'max', 'sliderMin', 'sliderMax'):
                if a[k].get(x) != b[k].get(x):
                    changes.append(f'`{n}.{k}` {x} {fval(a[k].get(x)) if x in a[k] else "unset"} → {fval(b[k].get(x))}')
    lines.append('- Parameter changes 17.5 → 26.5: ' + '; '.join(changes) + '. Area/reduction `inputExtent` defaults changed from (0,0,640,80) to (0,0,0,0); always pass an explicit extent.')
    counts = ', '.join(f'{k} {OLD["categoryCounts"].get(k, 0)}→{v}' for k, v in sorted(NEW['categoryCounts'].items()) if k != 'all')
    lines.append(f'- Category counts (17.5→26.5): {counts}.')
    return '\n'.join(lines)


# apply_filter allowlist: (filter, primary param or None for blend-only, id) — see the doc for the rule.
APPLY_FILTER = [
    ('twirl', 'CITwirlDistortion', 'inputAngle'), ('vortex', 'CIVortexDistortion', 'inputAngle'),
    ('bulge', 'CIBumpDistortion', 'inputScale'), ('bulge_line', 'CIBumpDistortionLinear', 'inputScale'),
    ('pinch', 'CIPinchDistortion', 'inputScale'), ('circle_splash', 'CICircleSplashDistortion', 'inputRadius'),
    ('hole', 'CIHoleDistortion', 'inputRadius'), ('light_tunnel', 'CILightTunnel', 'inputRotation'),
    ('torus_lens', 'CITorusLensDistortion', 'inputRefraction'), ('glass_lozenge', 'CIGlassLozenge', 'inputRefraction'),
    ('circular_wrap', 'CICircularWrap', 'inputAngle'), ('droste', 'CIDroste', 'inputZoom'),
    ('kaleidoscope', 'CIKaleidoscope', None), ('triangle_kaleidoscope', 'CITriangleKaleidoscope', None),
    ('op_art_tile', 'CIOpTile', 'inputScale'), ('mirror_tile_4', 'CIFourfoldReflectedTile', None),
    ('rotated_tile_6', 'CISixfoldRotatedTile', None), ('mirror_tile_8', 'CIEightfoldReflectedTile', None),
    ('mirror_tile_12', 'CITwelvefoldReflectedTile', None),
    ('dot_screen', 'CIDotScreen', 'inputWidth'), ('line_screen', 'CILineScreen', 'inputWidth'),
    ('hatched_screen', 'CIHatchedScreen', 'inputWidth'), ('circular_screen', 'CICircularScreen', 'inputWidth'),
    ('cmyk_halftone', 'CICMYKHalftone', 'inputWidth'),
    ('monochrome_tint', 'CIColorMonochrome', 'inputIntensity'), ('duotone', 'CIFalseColor', None),
    ('white_point', 'CIWhitePointAdjust', None), ('dither', 'CIDither', 'inputIntensity'),
    ('max_component_gray', 'CIMaximumComponent', None), ('min_component_gray', 'CIMinimumComponent', None),
    ('threshold', 'CIColorThreshold', 'inputThreshold'),
    ('sunbeams', 'CISunbeamsGenerator', None), ('lens_flare', 'CILenticularHaloGenerator', None),
    ('star_shine', 'CIStarShineGenerator', None),
]
# (identity, value at 0.5, value at 1.0) where the dumped identity/default gives a useless curve.
# These are our choices, not Apple values; everything else is derived from the dump.
PRIMARY_OVERRIDE = {
    'CIBumpDistortionLinear': (0, 0.5, 1),  # dump reports identity 1 for inputScale, which is not a no-op
    'CIDotScreen': (2, 12, 50), 'CILineScreen': (2, 12, 50), 'CIHatchedScreen': (2, 12, 50),
    'CICircularScreen': (2, 12, 50), 'CICMYKHalftone': (2, 12, 100),  # Apple default 6 px is faint at 1080p
}
CARD = {
    'twirl': 'Twirl', 'vortex': 'Vortex', 'bulge': 'Bulge', 'bulge_line': 'Bulge band', 'pinch': 'Pinch',
    'circle_splash': 'Circle splash', 'hole': 'Hole', 'light_tunnel': 'Light tunnel', 'torus_lens': 'Ring lens',
    'glass_lozenge': 'Glass lens', 'circular_wrap': 'Circle wrap', 'droste': 'Infinite spiral',
    'kaleidoscope': 'Kaleidoscope', 'triangle_kaleidoscope': 'Triangle kaleidoscope', 'op_art_tile': 'Op art',
    'mirror_tile_4': 'Mirror tiles', 'rotated_tile_6': 'Rotated tiles', 'mirror_tile_8': 'Mirror tiles ×8',
    'mirror_tile_12': 'Mirror tiles ×12', 'dot_screen': 'Dot screen', 'line_screen': 'Line screen',
    'hatched_screen': 'Crosshatch', 'circular_screen': 'Ring screen', 'cmyk_halftone': 'Print halftone',
    'monochrome_tint': 'One-color tint', 'duotone': 'Duotone', 'white_point': 'White point', 'dither': 'Dither',
    'max_component_gray': 'Bright gray', 'min_component_gray': 'Dark gray', 'threshold': 'Two-tone',
    'sunbeams': 'Sunbeams', 'lens_flare': 'Lens flare', 'star_shine': 'Star shine',
}
GENERATORS = {'CISunbeamsGenerator', 'CILenticularHaloGenerator', 'CIStarShineGenerator'}


def primary_map(f, key, name=None):
    if name in PRIMARY_OVERRIDE:
        ident, mid, hi = PRIMARY_OVERRIDE[name]
        return ident, mid, hi, (lambda t: ident + (mid - ident) * 2 * t if t <= 0.5 else mid + (hi - mid) * (2 * t - 1))
    i = next(x for x in f['inputs'] if x['key'] == key)
    d = i.get('default')
    ident = i.get('identity', i.get('sliderMin', i.get('min', 0)))
    hi = i.get('sliderMax', i.get('max'))
    if not isinstance(ident, (int, float)) or isinstance(ident, bool):
        ident = i.get('sliderMin', 0)
    mid = d if d != ident else (ident + hi) / 2
    at = lambda t: ident + (mid - ident) * 2 * t if t <= 0.5 else mid + (hi - mid) * (2 * t - 1)
    return ident, mid, hi, at


def apply_filter_table():
    lines = ['| `name` (enum) | Core Image filter | Card title | Intensity drives | 0 / 0.25 / **0.5** / 0.8 / 1.0 | Other params (dumped defaults) | Min iOS | Cost |',
             '|---|---|---|---|---|---|---|---|']
    for enum, n, key in APPLY_FILTER:
        f = F[n]
        others = '; '.join(p for p in params(f).split('; ') if not (key and p.startswith(f'`{key}`')))
        if key:
            ident, mid, hi, at = primary_map(f, key, n)
            vals = ' / '.join(('**%s**' if t == 0.5 else '%s') % fnum(round(at(t), 4)) for t in (0, 0.25, 0.5, 0.8, 1.0))
            drives = f'`{key}`' + (' (our curve)' if n in PRIMARY_OVERRIDE else '')
        elif n in GENERATORS:
            vals = 'opacity 0 / 50% / **100%** / 100% / 100%'
            drives = 'overlay opacity (screen blend)'
        else:
            vals = 'mix 0 / 50% / **100%** / 100% / 100%'
            drives = 'mix with original'
        lines.append(f"| `{enum}` | `{n}` | Look · {CARD[enum]} | {drives} | {vals} | {others} | {min_ios(n, f)} | {cost(n, '')} |")
    return '\n'.join(lines)


def replace(doc, name, body):
    pat = re.compile(rf'(<!-- BEGIN GENERATED:{name} -->\n).*?(<!-- END GENERATED:{name} -->)', re.S)
    if not pat.search(doc):
        raise SystemExit(f'marker {name} missing')
    return pat.sub(lambda m: m.group(1) + body.rstrip() + '\n' + m.group(2), doc)


if __name__ == '__main__':
    doc = open(DOC).read()
    doc = replace(doc, 'ci-diff', diff())
    doc = replace(doc, 'ci-catalog', catalog())
    doc = replace(doc, 'apply-filter', apply_filter_table())
    schemas = open(os.path.join(HERE, 'proposed-tools-build11.json')).read()
    doc = replace(doc, 'schemas', '<details><summary>proposed-tools-build11.json</summary>\n\n```json\n' + schemas.rstrip() + '\n```\n\n</details>')
    open(DOC, 'w').write(doc)
    print('updated', os.path.relpath(DOC))
