import Foundation
import Vision
import PDFKit
import AppKit

// ocr.swift <file>  —— 使用 macOS Vision 对图片/PDF 做 OCR（中英）
let args = CommandLine.arguments
guard args.count > 1 else { fputs("用法: swift ocr.swift <file>\n", stderr); exit(2) }
let url = URL(fileURLWithPath: args[1])
var cgs: [CGImage] = []
if url.pathExtension.lowercased() == "pdf", let doc = PDFDocument(url: url) {
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let rect = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2.0
        let w = Int(rect.width * scale), h = Int(rect.height * scale)
        guard w > 0, h > 0, let ctx = CGContext(data: nil, width: w, height: h,
            bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: ctx)
        if let img = ctx.makeImage() { cgs.append(img) }
    }
} else if let img = NSImage(contentsOf: url), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    cgs.append(cg)
}
if cgs.isEmpty { fputs("无法读取文件或页面为空\n", stderr); exit(3) }
var out = ""
for (idx, cg) in cgs.enumerated() {
    if cgs.count > 1 { out += "\n## 第 \(idx + 1) 页\n" }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([req])
    if let obs = req.results {
        for o in obs {
            if let c = o.topCandidates(1).first { out += c.string + "\n" }
        }
    }
}
print(out)
