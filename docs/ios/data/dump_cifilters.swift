// Dumps the Core Image filter catalog (plus AVAudioUnit parameter trees and Vision request
// availability) of the iOS runtime it runs on, as JSON. No timing: render cost on a CI
// simulator (no real GPU) says nothing about an iPhone, so cost classes in
// ON_DEVICE_TOOLS.md are estimates. Built for the iOS Simulator SDK and run
// with `xcrun simctl spawn` by .github/workflows/dump-cifilters.yml.
//
//   dump_cifilters catalog <out.json>   CIFilter attributes + category membership
//   dump_cifilters platform <out.json>  AVAudioUnit parameter trees + Vision request revisions
//
// Output is deterministic (sorted keys) apart from environment.generatedAt.

import AVFoundation
import CoreImage
import Foundation
import Metal
import Vision

// MARK: - JSON helpers

func num(_ d: Double) -> Any {
    if d.isNaN { return "NaN" }
    if d.isInfinite { return d > 0 ? "inf" : "-inf" }
    return d
}

func jsonValue(_ v: Any?) -> Any {
    guard let v = v else { return NSNull() }
    if let n = v as? NSNumber {
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue }
        let t = String(cString: n.objCType)
        if t == "f" || t == "d" { return num(n.doubleValue) }
        return n
    }
    if let s = v as? String { return s }
    if let vec = v as? CIVector {
        return ["CIVector": (0..<vec.count).map { num(Double(vec.value(at: $0))) }]
    }
    if let c = v as? CIColor {
        return ["CIColor": [num(Double(c.red)), num(Double(c.green)), num(Double(c.blue)), num(Double(c.alpha))]]
    }
    if let img = v as? CIImage {
        let e = img.extent
        return ["CIImage": e.isInfinite ? "infinite" : "\(e.origin.x),\(e.origin.y),\(e.size.width)x\(e.size.height)"]
    }
    if let a = v as? NSAttributedString { return ["NSAttributedString": a.string] }
    if let d = v as? Data { return ["NSData": d.count] }
    if let arr = v as? [Any] { return arr.map { jsonValue($0) } }
    if let dict = v as? [String: Any] {
        var out: [String: Any] = [:]
        for (k, x) in dict { out[k] = jsonValue(x) }
        return out
    }
    let cf = v as AnyObject
    if CFGetTypeID(cf) == CGColorSpace.typeID {
        let cs = cf as! CGColorSpace
        return ["CGColorSpace": (cs.name as String?) ?? "unnamed"]
    }
    if let val = v as? NSValue {
        return ["NSValue": String(cString: val.objCType), "description": val.description]
    }
    return ["class": String(describing: type(of: v)), "description": String(describing: v)]
}

func writeJSON(_ obj: Any, to path: String) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
    FileManager.default.createFile(atPath: path, contents: data)
    FileHandle.standardError.write("wrote \(path) (\(data.count) bytes)\n".data(using: .utf8)!)
}

func environmentInfo() -> [String: Any] {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    let env = ProcessInfo.processInfo.environment
    return [
        "operatingSystemVersion": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
        "operatingSystemVersionString": ProcessInfo.processInfo.operatingSystemVersionString,
        "simulatorRuntimeVersion": env["SIMULATOR_RUNTIME_VERSION"] ?? NSNull(),
        "simulatorRuntimeBuild": env["SIMULATOR_RUNTIME_BUILD_VERSION"] ?? NSNull(),
        "simulatorModel": env["SIMULATOR_MODEL_IDENTIFIER"] ?? NSNull(),
        "simulatorDeviceName": env["SIMULATOR_DEVICE_NAME"] ?? NSNull(),
        "metalDevice": MTLCreateSystemDefaultDevice()?.name ?? NSNull(),
        "generatedAt": ISO8601DateFormatter().string(from: Date()),
    ]
}

// MARK: - Catalog

let categories: [(String, String)] = [
    ("ColorAdjustment", kCICategoryColorAdjustment), ("ColorEffect", kCICategoryColorEffect),
    ("Blur", kCICategoryBlur), ("Sharpen", kCICategorySharpen), ("Stylize", kCICategoryStylize),
    ("DistortionEffect", kCICategoryDistortionEffect), ("Generator", kCICategoryGenerator),
    ("CompositeOperation", kCICategoryCompositeOperation), ("Geometry", kCICategoryGeometryAdjustment),
    ("Transition", kCICategoryTransition), ("Halftone", kCICategoryHalftoneEffect),
    ("Tile", kCICategoryTileEffect), ("Gradient", kCICategoryGradient), ("Reduction", kCICategoryReduction),
    ("VideoCompatible", kCICategoryVideo), ("StillImage", kCICategoryStillImage),
    ("BuiltIn", kCICategoryBuiltIn), ("Interlaced", kCICategoryInterlaced),
    ("NonSquarePixels", kCICategoryNonSquarePixels), ("HighDynamicRange", kCICategoryHighDynamicRange),
    ("FilterGenerator", kCICategoryFilterGenerator),
]

let inputAttrKeys: [(String, String)] = [
    ("class", kCIAttributeClass), ("type", kCIAttributeType), ("displayName", kCIAttributeDisplayName),
    ("description", kCIAttributeDescription), ("default", kCIAttributeDefault),
    ("identity", kCIAttributeIdentity), ("min", kCIAttributeMin), ("max", kCIAttributeMax),
    ("sliderMin", kCIAttributeSliderMin), ("sliderMax", kCIAttributeSliderMax),
]

func catalog() -> [String: Any] {
    let names = CIFilter.filterNames(inCategory: nil).sorted()
    var membership: [String: [String]] = [:]
    for (label, cat) in categories { membership[label] = CIFilter.filterNames(inCategory: cat).sorted() }
    var filters: [String: Any] = [:]
    for name in names {
        guard let f = CIFilter(name: name) else { filters[name] = ["error": "CIFilter(name:) returned nil"]; continue }
        let attrs = f.attributes
        var inputs: [[String: Any]] = []
        for key in f.inputKeys {
            var entry: [String: Any] = ["key": key]
            if let a = attrs[key] as? [String: Any] {
                for (label, k) in inputAttrKeys where a[k] != nil { entry[label] = jsonValue(a[k]) }
            }
            inputs.append(entry)
        }
        filters[name] = [
            "displayName": jsonValue(attrs[kCIAttributeFilterDisplayName]),
            "localizedName": jsonValue(CIFilter.localizedName(forFilterName: name)),
            "localizedDescription": jsonValue(CIFilter.localizedDescription(forFilterName: name)),
            "categories": jsonValue(attrs[kCIAttributeFilterCategories]),
            "availableIOS": jsonValue(attrs[kCIAttributeFilterAvailable_iOS]),
            "availableMac": jsonValue(attrs[kCIAttributeFilterAvailable_Mac]),
            "inputs": inputs,
            "outputKeys": f.outputKeys,
        ]
    }
    var counts: [String: Int] = ["all": names.count]
    for (k, v) in membership { counts[k] = v.count }
    return ["environment": environmentInfo(), "filterCount": names.count, "categoryCounts": counts,
            "categories": membership, "filters": filters]
}

// MARK: - Platform (audio units, Vision)

func auParams(_ unit: AVAudioUnit) -> [[String: Any]] {
    guard let tree = unit.auAudioUnit.parameterTree else { return [] }
    return tree.allParameters.map { p in
        var d: [String: Any] = ["identifier": p.identifier, "displayName": p.displayName,
                                "min": num(Double(p.minValue)), "max": num(Double(p.maxValue)),
                                "value": num(Double(p.value)), "unit": Int(p.unit.rawValue)]
        if let u = p.unitName { d["unitName"] = u }
        if let s = p.valueStrings { d["valueStrings"] = s }
        return d
    }
}

func platform() -> [String: Any] {
    var audio: [String: Any] = [:]
    let eq = AVAudioUnitEQ(numberOfBands: 1)
    audio["AVAudioUnitEQ(1 band)"] = ["parameters": auParams(eq),
                                      "bandDefaults": ["frequency": num(Double(eq.bands[0].frequency)),
                                                       "bandwidth": num(Double(eq.bands[0].bandwidth)),
                                                       "gain": num(Double(eq.bands[0].gain)),
                                                       "filterType": eq.bands[0].filterType.rawValue,
                                                       "bypass": eq.bands[0].bypass],
                                      "globalGain": num(Double(eq.globalGain))]
    let reverb = AVAudioUnitReverb()
    audio["AVAudioUnitReverb"] = ["parameters": auParams(reverb), "wetDryMix": num(Double(reverb.wetDryMix))]
    let delay = AVAudioUnitDelay()
    audio["AVAudioUnitDelay"] = ["parameters": auParams(delay),
                                 "defaults": ["delayTime": num(delay.delayTime), "feedback": num(Double(delay.feedback)),
                                              "lowPassCutoff": num(Double(delay.lowPassCutoff)),
                                              "wetDryMix": num(Double(delay.wetDryMix))]]
    let dist = AVAudioUnitDistortion()
    audio["AVAudioUnitDistortion"] = ["parameters": auParams(dist), "preGain": num(Double(dist.preGain)),
                                      "wetDryMix": num(Double(dist.wetDryMix))]
    let tp = AVAudioUnitTimePitch()
    audio["AVAudioUnitTimePitch"] = ["parameters": auParams(tp),
                                     "defaults": ["pitch": num(Double(tp.pitch)), "rate": num(Double(tp.rate)),
                                                  "overlap": num(Double(tp.overlap))]]
    let vs = AVAudioUnitVarispeed()
    audio["AVAudioUnitVarispeed"] = ["parameters": auParams(vs), "rate": num(Double(vs.rate))]

    let visionClasses = [
        "VNGeneratePersonSegmentationRequest", "VNGeneratePersonInstanceMaskRequest",
        "VNGenerateForegroundInstanceMaskRequest", "VNDetectFaceRectanglesRequest",
        "VNDetectFaceLandmarksRequest", "VNDetectFaceCaptureQualityRequest", "VNRecognizeTextRequest",
        "VNDetectHorizonRequest", "VNGenerateAttentionBasedSaliencyImageRequest",
        "VNGenerateObjectnessBasedSaliencyImageRequest", "VNDetectHumanRectanglesRequest",
        "VNDetectHumanBodyPoseRequest", "VNDetectHumanBodyPose3DRequest", "VNDetectHumanHandPoseRequest",
        "VNDetectAnimalBodyPoseRequest", "VNRecognizeAnimalsRequest", "VNClassifyImageRequest",
        "VNGenerateImageFeaturePrintRequest", "VNTrackObjectRequest", "VNTrackOpticalFlowRequest",
        "VNGenerateOpticalFlowRequest", "VNTranslationalImageRegistrationRequest",
        "VNHomographicImageRegistrationRequest", "VNDetectTrajectoriesRequest", "VNDetectRectanglesRequest",
        "VNDetectBarcodesRequest", "VNDetectDocumentSegmentationRequest", "VNDetectContoursRequest",
        "VNCalculateImageAestheticsScoresRequest", "VNDetectLensSmudgeRequest",
    ]
    var vision: [String: Any] = [:]
    for name in visionClasses {
        if let cls = NSClassFromString(name) as? VNRequest.Type {
            vision[name] = ["available": true, "supportedRevisions": Array(cls.supportedRevisions),
                            "currentRevision": cls.currentRevision]
        } else {
            vision[name] = ["available": false]
        }
    }
    return ["environment": environmentInfo(), "audioUnits": audio, "vision": vision]
}

// MARK: - main

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: dump_cifilters catalog|platform <out.json>\n".data(using: .utf8)!)
    exit(2)
}
switch args[1] {
case "catalog": writeJSON(catalog(), to: args[2])
case "platform": writeJSON(platform(), to: args[2])
default: exit(2)
}
