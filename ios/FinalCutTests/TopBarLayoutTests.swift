import SwiftUI
import UIKit
import XCTest
@testable import FinalCut

/// Build-10 header fix: Upgrade must not wrap ('U / pg / ra / de') and the bar stays one row,
/// now with Undo/Redo in it.
@MainActor
final class TopBarLayoutTests: XCTestCase {
    private let sizes: [DynamicTypeSize] = [.large, .xLarge, .xxxLarge]

    private func fittingSize<V: View>(_ view: V, width: CGFloat, type: DynamicTypeSize) -> CGSize {
        let host = UIHostingController(rootView: view.environment(\.dynamicTypeSize, type))
        return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    func testUpgradeButtonIsOneCompactRow() {
        for type in sizes {
            let size = fittingSize(UpgradeCapsuleButton(action: {}), width: 375, type: type)
            XCTAssertLessThanOrEqual(size.height, 40, "\(type)")
            XCTAssertGreaterThanOrEqual(size.height, 32, "\(type)")
        }
    }

    private func fullBar(freeRemaining: Int? = 12) -> TopBarView {
        TopBarView(
            photosPickerItem: .constant(nil),
            onExport: {},
            onUpgrade: {},
            exportVisible: true,
            showUpgrade: true,
            freeRemaining: freeRemaining,
            editControlsVisible: true,
            canUndo: true,
            canRedo: true
        )
    }

    func testHeaderIsSingleRowAtIPhoneSEWidth() {
        // Undo, Redo, Import, Export and Upgrade (with the free counter) at 375 pt.
        for type in sizes {
            let size = fittingSize(fullBar(), width: 375, type: type)
            XCTAssertLessThanOrEqual(size.height, 50, "\(type)")
            XCTAssertLessThanOrEqual(size.width, 375.5, "\(type): header overflows one row")
        }
    }

    func testHeaderWithoutMediaStaysOneRow() {
        let bar = TopBarView(photosPickerItem: .constant(nil), onExport: {}, onUpgrade: {},
                             showUpgrade: true, freeRemaining: 12)
        for type in sizes {
            let size = fittingSize(bar, width: 375, type: type)
            XCTAssertLessThanOrEqual(size.height, 50, "\(type)")
            XCTAssertLessThanOrEqual(size.width, 375.5, "\(type)")
        }
    }

    func testUpgradeDoesNotWrapWhenSqueezed() {
        // Even at 320 pt the capsule keeps its one-line height (the free label gives way).
        let bar = fullBar(freeRemaining: 999)
        XCTAssertLessThanOrEqual(fittingSize(bar, width: 320, type: .xLarge).height, 50)
    }
}
