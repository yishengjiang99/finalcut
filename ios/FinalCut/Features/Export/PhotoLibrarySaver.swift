import Foundation
import Photos
import UniformTypeIdentifiers

/// Saves an edited photo to the library in its original format (JPEG/PNG bytes as-is).
enum PhotoLibrarySaver {
    enum SaveError: Error, Equatable {
        case notAuthorized
        case failed
    }

    /// Resource options for the file: the UTI comes from the real extension so Photos keeps
    /// the original format.
    static func resourceOptions(for url: URL) -> PHAssetResourceCreationOptions {
        let options = PHAssetResourceCreationOptions()
        options.uniformTypeIdentifier = UTType(filenameExtension: url.pathExtension.lowercased())?.identifier
        options.originalFilename = url.lastPathComponent
        return options
    }

    static func savePhoto(at url: URL) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw SaveError.notAuthorized }
        let data = try Data(contentsOf: url)
        let options = resourceOptions(for: url)
        do {
            try await PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: data, options: options)
            }
        } catch {
            throw SaveError.failed
        }
    }
}
