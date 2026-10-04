// Lift the subject out of a photo with Apple's Vision framework — the same foreground-instance
// model that powers "Lift Subject" in Photos — and write a mask PNG that matches the photo
// pixel for pixel (white = subject). Load it in the web editor with 「匯入遮罩」.
//
// Requires macOS 14+ (VNGenerateForegroundInstanceMaskRequest).
//
//   swift lift-subject.swift photo.jpg                 → photo.mask.png, every subject
//   swift lift-subject.swift photo.jpg out.png         → custom output path
//   swift lift-subject.swift photo.jpg --at 0.5,0.6    → only the subject under that point
//                                                        (0…1, from the top-left), like a tap
//   swift lift-subject.swift photo.jpg --cutout        → also write photo.cutout.png

import CoreImage
import Foundation
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

var positional: [String] = []
var tapPoint: CGPoint?
var writeCutout = false
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
    switch arg {
    case "--at":
        guard let value = args.next() else { fail("--at needs x,y") }
        let parts = value.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 2 else { fail("--at expects x,y between 0 and 1, e.g. 0.5,0.6") }
        tapPoint = CGPoint(x: parts[0], y: parts[1])
    case "--cutout":
        writeCutout = true
    default:
        positional.append(arg)
    }
}
guard let inputPath = positional.first else {
    fail("usage: swift lift-subject.swift <photo> [mask.png] [--at x,y] [--cutout]")
}

let inputURL = URL(fileURLWithPath: inputPath)
let base = inputURL.deletingPathExtension()
let maskURL = positional.count > 1 ? URL(fileURLWithPath: positional[1]) : base.appendingPathExtension("mask.png")

// Browsers draw photos upright (EXIF orientation applied), so the mask must be computed upright too.
guard let image = CIImage(contentsOf: inputURL, options: [.applyOrientationProperty: true]) else {
    fail("cannot read \(inputPath)")
}

let request = VNGenerateForegroundInstanceMaskRequest()
let handler = VNImageRequestHandler(ciImage: image)
do {
    try handler.perform([request])
} catch {
    fail("Vision failed: \(error.localizedDescription)")
}
guard let observation = request.results?.first, !observation.allInstances.isEmpty else {
    fail("no subject found")
}

var instances = observation.allInstances
if let point = tapPoint {
    // instanceMask is a low-res label map: 0 = background, 1…n = subject instances.
    let labels = observation.instanceMask
    CVPixelBufferLockBaseAddress(labels, .readOnly)
    let width = CVPixelBufferGetWidth(labels)
    let height = CVPixelBufferGetHeight(labels)
    let row = CVPixelBufferGetBytesPerRow(labels)
    let x = min(width - 1, max(0, Int(point.x * Double(width))))
    let y = min(height - 1, max(0, Int(point.y * Double(height))))
    let label = CVPixelBufferGetBaseAddress(labels)!.load(fromByteOffset: y * row + x, as: UInt8.self)
    CVPixelBufferUnlockBaseAddress(labels, .readOnly)
    guard label != 0 else { fail("no subject at \(point.x),\(point.y); try another point or omit --at") }
    instances = IndexSet(integer: Int(label))
}

let context = CIContext()
do {
    let maskBuffer = try observation.generateScaledMaskForImage(forInstances: instances, from: handler)
    let mask = CIImage(cvPixelBuffer: maskBuffer)
    try context.writePNGRepresentation(
        of: mask, to: maskURL, format: .L8, colorSpace: CGColorSpaceCreateDeviceGray())
    print("mask   → \(maskURL.path)")

    if writeCutout {
        let cutoutURL = base.appendingPathExtension("cutout.png")
        let cutout = try observation.generateMaskedImage(
            ofInstances: instances, from: handler, croppedToInstancesExtent: false)
        try context.writePNGRepresentation(
            of: CIImage(cvPixelBuffer: cutout), to: cutoutURL, format: .RGBA8,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        print("cutout → \(cutoutURL.path)")
    }
} catch {
    fail("could not write output: \(error.localizedDescription)")
}
