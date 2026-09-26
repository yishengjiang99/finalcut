import SwiftUI
import XCTest
@testable import FinalCut

/// Design #94: the mic sits in the trailing slot whenever the field is empty, including at
/// 375 pt and before any permission prompt; denial keeps the mic and adds a Settings note.
@MainActor
final class ComposerMicTests: XCTestCase {
    func testMicWheneverTheFieldIsEmpty() {
        XCTAssertEqual(ComposerView.trailingControl(text: "", hasDictation: true, isListening: false), .mic)
        XCTAssertEqual(ComposerView.trailingControl(text: "   ", hasDictation: true, isListening: false), .mic)
        XCTAssertEqual(ComposerView.trailingControl(text: "make it red", hasDictation: true, isListening: false), .send)
        XCTAssertEqual(ComposerView.trailingControl(text: "make it", hasDictation: true, isListening: true), .stop)
        XCTAssertEqual(ComposerView.trailingControl(text: "", hasDictation: false, isListening: false), .send)
    }

    func testPermissionStatesKeepTheMicAndExplainDenial() {
        for status in [DictationController.Status.idle, .permissionDenied, .unavailable] {
            let dictation = DictationController(status: status)
            XCTAssertFalse(dictation.isListening)
            XCTAssertEqual(ComposerView.trailingControl(text: "", hasDictation: true, isListening: dictation.isListening), .mic,
                           "mic stays for \(status)")
        }
        XCTAssertNil(ComposerView.note(for: .idle), "no note before permission is asked")
        XCTAssertEqual(ComposerView.note(for: .permissionDenied), UXCopy.dictationPermissionDenied)
        XCTAssertEqual(ComposerView.note(for: .unavailable), UXCopy.dictationUnavailable)
    }

    func testComposerWithMicFitsNarrowPhones() {
        for width in [375.0, 320.0] {
            for status in [DictationController.Status.idle, .permissionDenied] {
                let view = ComposerView(text: .constant(""), photosPickerItem: .constant(nil), onSend: {},
                                        dictation: DictationController(status: status))
                let host = UIHostingController(rootView: view)
                let size = host.sizeThatFits(in: CGSize(width: width, height: 400))
                XCTAssertLessThanOrEqual(size.width, width + 0.5, "\(width) pt, \(status)")
                XCTAssertLessThan(size.height, 160, "\(width) pt, \(status)")
            }
        }
    }
}
