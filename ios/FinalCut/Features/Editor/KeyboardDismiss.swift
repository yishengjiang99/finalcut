import SwiftUI
import UIKit

/// Tapping anywhere outside a text input (preview, chat, empty space) dismisses the keyboard.
/// Installed once on the window; `cancelsTouchesInView = false` so buttons, the player and
/// scroll views still get every tap. Taps on the text field itself are ignored, so tapping
/// into the field keeps working (and still stops dictation).
struct KeyboardDismissInstaller: UIViewRepresentable {
    func makeUIView(context: Context) -> InstallerView { InstallerView() }
    func updateUIView(_ uiView: InstallerView, context: Context) {}

    final class InstallerView: UIView, UIGestureRecognizerDelegate {
        private weak var installedWindow: UIWindow?
        private lazy var tap: UITapGestureRecognizer = {
            let tap = UITapGestureRecognizer(target: self, action: #selector(dismiss))
            tap.cancelsTouchesInView = false
            tap.delegate = self
            return tap
        }()

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            isAccessibilityElement = false
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let window, window !== installedWindow else { return }
            installedWindow?.removeGestureRecognizer(tap)
            window.addGestureRecognizer(tap)
            installedWindow = window
        }

        @objc private func dismiss() {
            guard let window = installedWindow else { return }
            let point = tap.location(in: window)
            // SwiftUI text fields don't always hit-test as a UITextField/UITextView, so a tap
            // into the field could otherwise focus it and immediately end editing again.
            if Self.isTextInput(window.hitTest(point, with: nil)) { return }
            if let responder = Self.firstResponder(in: window),
               responder.convert(responder.bounds, to: window).insetBy(dx: -8, dy: -8).contains(point) {
                return
            }
            window.endEditing(true)
        }

        static func firstResponder(in view: UIView) -> UIView? {
            if view.isFirstResponder { return view }
            for sub in view.subviews {
                if let found = firstResponder(in: sub) { return found }
            }
            return nil
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            !Self.isTextInput(touch.view)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        static func isTextInput(_ view: UIView?) -> Bool {
            var current = view
            while let v = current {
                if v is UITextField || v is UITextView { return true }
                current = v.superview
            }
            return false
        }
    }
}
