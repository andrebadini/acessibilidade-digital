// macOS: render-promo.sh produces the Quick Look raster; this removes its canvas padding.
import Foundation
import CoreGraphics
import ImageIO

guard CommandLine.arguments.count == 3 else {
    fatalError("Uso: swift render-promo.swift entrada.png saida.png")
}
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
      let original = CGImageSourceCreateImageAtIndex(source, 0, nil),
      original.width == 440, original.height >= 280,
      let cropped = original.cropping(to: CGRect(x: 0, y: 0, width: 440, height: 280)),
      let canvas = CGContext(data: nil, width: 440, height: 280, bitsPerComponent: 8,
                             bytesPerRow: 440 * 4, space: CGColorSpaceCreateDeviceRGB(),
                             bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
    fatalError("Não foi possível ler o render 440×280 da arte SVG.")
}
canvas.draw(cropped, in: CGRect(x: 0, y: 0, width: 440, height: 280))
guard let rendered = canvas.makeImage(),
      let destination = CGImageDestinationCreateWithURL(output as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("Não foi possível preparar o PNG RGB.")
}
CGImageDestinationAddImage(destination, rendered, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Falha ao salvar o PNG.") }
