import SwiftUI
import UIKit
import XCTest
@testable import FinalCut

/// Build-10 header fix: Upgrade must not wrap ('U / pg / ra / de') and the bar stays one row.
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

    func testHeaderIsSingleRowAtIPhoneSEWidth() {
        for type in sizes {
            let bar = TopBarView(
                photosPickerItem: .constant(nil),
                onExport: {},
                onUpgrade: {},
                exportVisible: true,
                showUpgrade: true,
                freeRemaining: 12
            )
            let size = fittingSize(bar, width: 375, type: type)
            XCTAssertLessThanOrEqual(size.height, 50, "\(type)")
        }
    }

    func testUpgradeDoesNotWrapWhenSqueezed() {
        // Even at 320 pt the capsule keeps its one-line height (the free label gives way).
        let bar = TopBarView(
            photosPickerItem: .constant(nil), onExport: {}, onUpgrade: {},
            exportVisible: true, showUpgrade: true, freeRemaining: 999
        )
        XCTAssertLessThanOrEqual(fittingSize(bar, width: 320, type: .xLarge).height, 50)
    }
}
